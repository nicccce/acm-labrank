import { randomUUID } from 'node:crypto';
import { platformRequestStore, type PlatformRequestStore } from '@acm/db/server';
import { ConnectorError, parseRetryAfter, type PlatformId, type RequestContext } from '@acm/connectors/contracts';
export { parseRetryAfter } from '@acm/connectors/contracts';

const hosts: Record<PlatformId, readonly string[]> = {
  codeforces: ['codeforces.com'], qoj: ['qoj.ac'], luogu: ['www.luogu.com.cn'],
};

interface RequestOptions {
  platform: PlatformId;
  signal: AbortSignal;
  minIntervalMs?: number;
  timeoutMs?: number;
  leaseMs?: number;
  maxResponseBytes?: number;
  allowImages?: boolean;
  /** Dependency injection for tests; deployed callers always use the PostgreSQL store. */
  store?: PlatformRequestStore;
  fetchImpl?: typeof fetch;
  allowedMethods?: readonly string[];
  maxRetries?: number;
  sessionHooks?: {
    beforeRequest(token: string, url: URL, init: RequestInit, signal: AbortSignal): Promise<RequestInit>;
    afterResponse(token: string, url: URL, response: Response, signal: AbortSignal): Promise<void>;
  };
}

export function createRequestContext(options: RequestOptions): RequestContext {
  const { platform, signal } = options;
  const store = options.store ?? platformRequestStore;
  const fetchImpl = options.fetchImpl ?? fetch;
  const interval = options.minIntervalMs ?? (platform === 'codeforces' ? Number(process.env.CF_MIN_INTERVAL_MS ?? 2000) : 3000);
  const timeoutMs = options.timeoutMs ?? 30000;
  const leaseMs = options.leaseMs ?? 45000;
  const maxBytes = options.maxResponseBytes ?? 32 * 1024 * 1024;
  const maxRetries = options.maxRetries ?? 2;
  if (!Number.isSafeInteger(interval) || interval < (platform === 'codeforces' ? 2000 : 1) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(leaseMs) || leaseMs <= timeoutMs ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
    throw new ConnectorError('INVALID_INPUT', 'Invalid platform HTTP limits');
  }

  function validateUrl(url: URL) {
    if (url.protocol !== 'https:' || !hosts[platform].includes(url.hostname) || url.username || url.password ||
        (url.port && url.port !== '443')) throw new ConnectorError('FORBIDDEN', 'Platform request target is not allowed');
  }
  async function pause(ms: number, requestSignal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(new ConnectorError('CANCELLED', 'Platform request cancelled')); };
      const timer = setTimeout(() => { requestSignal.removeEventListener('abort', cancel); resolve(); }, ms);
      if (requestSignal.aborted) cancel();
      else requestSignal.addEventListener('abort', cancel, { once: true });
    });
  }

  async function oneRequest(url: URL, init: RequestInit, parentSignal: AbortSignal): Promise<Response> {
    const token = randomUUID();
    while (true) {
      if (parentSignal.aborted) throw new ConnectorError('CANCELLED', 'Platform request cancelled');
      const lease = await store.acquire(platform, token, interval, leaseMs);
      if (lease.acquired) break;
      // Recheck frequently so a released lease does not impose its full expiry on a waiter.
      await pause(Math.min(500, Math.max(10, lease.waitMs)), parentSignal);
    }
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([parentSignal, controller.signal]);
    const timer = setTimeout(() => controller.abort(new ConnectorError('TIMEOUT', 'Platform HTTP timeout')), timeoutMs);
    let watching = false;
    const watchdog = setInterval(() => {
      if (watching) return;
      watching = true;
      void store.owns(platform, token).then((owned) => {
        if (!owned) controller.abort(new ConnectorError('LEASE_LOST', 'Platform HTTP lease lost'));
      }).catch(() => controller.abort(new ConnectorError('LEASE_LOST', 'Cannot validate platform HTTP lease')))
        .finally(() => { watching = false; });
    }, Math.min(1000, timeoutMs));
    let released = false;
    try {
      requestSignal.throwIfAborted();
      const prepared = options.sessionHooks ? await options.sessionHooks.beforeRequest(token, url, init, requestSignal) : init;
      requestSignal.throwIfAborted();
      const response = await fetchImpl(url, { ...prepared, redirect: 'manual', signal: requestSignal });
      const retryAt = parseRetryAfter(response.headers.get('retry-after'));
      if (retryAt || response.status === 429) {
        await store.block(platform, retryAt ?? new Date(Date.now() + Math.max(interval, 2000)).toISOString());
      }
      const length = response.headers.get('content-length');
      if (length && Number(length) > maxBytes) {
        await response.body?.cancel();
        throw new ConnectorError('RESPONSE_TOO_LARGE', 'Platform response exceeds byte limit');
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (response.ok && !/^(application\/json|text\/(html|plain))(?:;|$)/i.test(contentType) && !(options.allowImages && /^image\/(png|jpeg|gif|webp)(?:;|$)/i.test(contentType))) {
        await response.body?.cancel();
        throw new ConnectorError('PARSE_CHANGED', 'Unexpected platform content type');
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        const abortRead = () => { void reader.cancel().catch(() => undefined); };
        requestSignal.addEventListener('abort', abortRead, { once: true });
        try {
          while (true) {
            requestSignal.throwIfAborted();
            const chunk = await reader.read();
            requestSignal.throwIfAborted();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maxBytes) {
              await reader.cancel();
              throw new ConnectorError('RESPONSE_TOO_LARGE', 'Platform response exceeds byte limit');
            }
            chunks.push(chunk.value);
          }
        } finally { requestSignal.removeEventListener('abort', abortRead); reader.releaseLock(); }
      }
      requestSignal.throwIfAborted();
      if (!await store.owns(platform, token)) throw new ConnectorError('LEASE_LOST', 'Platform HTTP lease lost');
      const headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      const buffered = new Response([204, 205, 304].includes(response.status) ? null : new Uint8Array(Buffer.concat(chunks)), {
        status: response.status, statusText: response.statusText, headers,
      });
      Object.defineProperty(buffered, 'url', { value: response.url || url.href });
      await options.sessionHooks?.afterResponse(token, url, buffered, requestSignal);
      requestSignal.throwIfAborted();
      if (options.sessionHooks) buffered.headers.delete('set-cookie');
      released = await store.release(platform, token, interval);
      if (!released) throw new ConnectorError('LEASE_LOST', 'Platform HTTP lease lost before response publication');
      return buffered;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (parentSignal.aborted) throw new ConnectorError('CANCELLED', 'Platform request cancelled');
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError('NETWORK_ERROR', 'Platform network request failed', { cause: error });
    } finally {
      clearTimeout(timer);
      clearInterval(watchdog);
      controller.abort();
      if (!released) await store.release(platform, token, interval);
    }
  }

  return {
    signal, session: null,
    deferUntil: (retryAt) => store.block(platform, retryAt),
    async request(input, init = {}) {
      validateUrl(input);
      const method = (init.method ?? 'GET').toUpperCase();
      if (!(options.allowedMethods ?? ['GET']).includes(method)) throw new ConnectorError('NOT_IMPLEMENTED', 'HTTP method is not enabled for this context');
      const requestSignal = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
      let url = new URL(input);
      let redirects = 0;
      let retries = 0;
      while (true) {
        let response: Response;
        try { response = await oneRequest(url, init, requestSignal); }
        catch (error) {
          if (method !== 'GET' || !(error instanceof ConnectorError) || !['NETWORK_ERROR', 'TIMEOUT'].includes(error.code) || retries >= maxRetries) throw error;
          await pause(500 * 2 ** retries++ + Math.floor(Math.random() * 100), requestSignal);
          continue;
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (init.redirect === 'manual') return response;
          const location = response.headers.get('location');
          if (!location || ++redirects > 3) throw new ConnectorError('FORBIDDEN', 'Invalid platform redirect');
          url = new URL(location, url);
          validateUrl(url);
          continue;
        }
        if (method === 'GET' && (response.status === 429 || response.status >= 500) && retries < maxRetries) {
          await pause(500 * 2 ** retries++ + Math.floor(Math.random() * 100), requestSignal);
          continue;
        }
        return response;
      }
    },
  };
}
