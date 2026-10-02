import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Page, type Response as BrowserResponse } from 'playwright-core';
import { z } from 'zod';
import { Cookie } from 'tough-cookie';
import { loadConnectorSession, saveConnectorSession, type PlatformRequestStore } from '@acm/db/server';
import { ConnectorError } from '@acm/connectors/contracts';
import { qojResponseIssue } from '@acm/connectors/server';
import { createRequestContext } from './request-context';
import { decryptQojSession, encryptQojSession } from './qoj-session';
import { createAbortableLock } from './abortable-lock';

const origin = 'https://qoj.ac';
const maxBytes = 4 * 1024 * 1024;
const cookieSchema = z.object({ name: z.string(), value: z.string(), domain: z.string().refine(d => ['qoj.ac', '.qoj.ac'].includes(d)), path: z.string().startsWith('/'), expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']) });
const sessionSchema = z.object({ version: z.literal(1), userAgent: z.string(), cookies: z.array(cookieSchema) });
export function parseQojBrowserCookieHeader(header: string) {
  return header.split(';').filter(pair => pair.trim()).map(pair => {
    const cookie = Cookie.parse(pair.trim());
    if (!cookie || !cookie.key) throw new ConnectorError('INVALID_INPUT', 'Invalid QOJ Cookie request header');
    return { name: cookie.key, value: cookie.value, url: origin, secure: true, httpOnly: true };
  });
}
interface BrowserXHR {
  status: number; responseText: string; responseURL: string; timeout: number;
  onload: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null; ontimeout: (() => void) | null; onprogress: ((event: { loaded: number }) => void) | null;
  open(method: string, url: string): void; setRequestHeader(name: string, value: string): void; getAllResponseHeaders(): string; send(body: string): void; abort(): void;
}

export function validateQojBrowserTarget(input: string | URL) {
  const url = new URL(input);
  if (url.origin !== origin || url.username || url.password || !/^\/(?:$|login$|submissions$|user\/profile\/[^/]+$)/.test(url.pathname)) {
    throw new ConnectorError('FORBIDDEN', 'QOJ browser transport only permits login, identity and personal read pages');
  }
  return url;
}

export function validateQojBrowserProxyServer(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new ConnectorError('INVALID_INPUT', 'Invalid QOJ browser proxy endpoint'); }
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || url.username || url.password || !url.hostname || !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw new ConnectorError('INVALID_INPUT', 'QOJ browser proxy must be an endpoint without credentials or URL parameters');
  }
  return url.href;
}

export function validateQojBrowserCdpEndpoint(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new ConnectorError('INVALID_INPUT', 'Invalid QOJ browser CDP endpoint'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw new ConnectorError('INVALID_INPUT', 'QOJ browser CDP endpoint must be loopback-only and contain no credentials or URL parameters');
  }
  return url.href;
}

/** Actual browser network, rather than Playwright APIRequestContext (which uses Node HTTP). */
export function createQojBrowserTransport(context: BrowserContext, diagnostic?: (data: { path: string; status: number; resourceType: string; challenge: boolean; failurePhase?: string; failureType?: string }) => void) {
  let page: Page | undefined;
  const acquire = createAbortableLock();
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = validateQojBrowserTarget(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && !(method === 'POST' && url.pathname === '/login')) throw new ConnectorError('FORBIDDEN', 'Unsupported QOJ browser operation');
    if (new Headers(init.headers).has('cookie')) throw new ConnectorError('INVALID_INPUT', 'Browser cookies must stay in the browser context');
    const signal = init.signal;
    signal?.throwIfAborted();
    const release = await acquire(signal ?? new AbortController().signal);
    let current: Page | undefined;
    let closing: Promise<void> | undefined;
    let failurePhase = 'page';
    const abort = () => {
      if (!current) return;
      if (page === current) page = undefined;
      closing = current.close().catch(() => undefined);
    };
    try {
      failurePhase = 'new_page';
      page ??= await context.newPage();
      current = page;
      const active = current;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); signal.throwIfAborted(); }
      if (method === 'GET') {
        let cleared: BrowserResponse | undefined;
        const isFinalDocument = (response: BrowserResponse) => response.request().resourceType() === 'document' && response.request().frame() === active.mainFrame() && ![301, 302, 303, 307, 308].includes(response.status()) && response.headers()['cf-mitigated'] !== 'challenge';
        const observe = (response: BrowserResponse) => {
          const responseUrl = new URL(response.url());
          if (responseUrl.origin === origin && (response.request().resourceType() === 'document' || responseUrl.pathname === url.pathname)) diagnostic?.({ path: responseUrl.pathname, status: response.status(), resourceType: response.request().resourceType(), challenge: response.headers()['cf-mitigated'] === 'challenge' });
          if (isFinalDocument(response)) cleared = response;
        };
        current.on('response', observe);
        let response: BrowserResponse | null;
        try {
          failurePhase = 'navigation';
          response = await current.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
          // Cloudflare's normal browser JS can reload the initial 403 into a successful document.
          // Return that actual network response, never the challenge or a fabricated DOM snapshot.
          if (response?.headers()['cf-mitigated'] === 'challenge') {
            response = cleared ?? await current.waitForResponse(isFinalDocument, { timeout: 15000 }).catch(() => response);
          }
        } finally { current.off('response', observe); }
        if (!response) throw new ConnectorError('NETWORK_ERROR', 'QOJ browser navigation returned no response');
        failurePhase = 'read_final_url';
        const responseUrl = response.url();
        failurePhase = 'validate_final_url';
        validateQojBrowserTarget(responseUrl);
        failurePhase = 'response_headers';
        const browserHeaders = await response.allHeaders();
        const headers = new Headers();
        for (const name of ['content-type', 'content-length', 'retry-after', 'cf-mitigated', 'date', 'cache-control', 'etag', 'last-modified']) {
          const value = browserHeaders[name];
          if (value) headers.set(name, value);
        }
        if (Number(headers.get('content-length')) > maxBytes) throw new ConnectorError('RESPONSE_TOO_LARGE', 'QOJ browser response exceeds byte limit');
        failurePhase = 'response_body';
        const body = await response.body();
        if (body.length > maxBytes) throw new ConnectorError('RESPONSE_TOO_LARGE', 'QOJ browser response exceeds byte limit');
        headers.delete('content-length');
        const output = new Response(Uint8Array.from(body).buffer, { status: response.status(), headers });
        Object.defineProperty(output, 'url', { value: responseUrl });
        return output;
      }
      failurePhase = 'login_xhr';
      if (new URL(current.url()).origin !== origin || !(init.body instanceof URLSearchParams)) throw new ConnectorError('INVALID_INPUT', 'QOJ login requires its loaded browser origin and verified form body');
      const headers = [...new Headers(init.headers).entries()].filter(([name]) => !['user-agent', 'origin', 'referer', 'host', 'accept-encoding', 'content-length'].includes(name) && !name.startsWith('sec-') && !name.startsWith(':'));
      const result = await current.evaluate(async ({ href, body, headers, limit }) => {
        // QOJ's observed $.post uses XMLHttpRequest. Preserve that actual request type.
        const XHR = (globalThis as unknown as { XMLHttpRequest: new () => BrowserXHR }).XMLHttpRequest;
        return new Promise<{ status: number; headers: [string, string][]; text: string; url: string; tooLarge: boolean }>((resolve, reject) => {
          const xhr = new XHR();
          let tooLarge = false;
          xhr.open('POST', href);
          xhr.timeout = 25000;
          for (const [name, value] of headers) xhr.setRequestHeader(name, value);
          xhr.onload = () => {
            const text = xhr.responseText;
            const responseHeaders: [string, string][] = xhr.getAllResponseHeaders().trim().split(/[\r\n]+/).filter(Boolean).map(line => { const colon = line.indexOf(':'); return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]; });
            resolve({ status: xhr.status, headers: responseHeaders, text, url: xhr.responseURL, tooLarge: new TextEncoder().encode(text).length > limit });
          };
          xhr.onprogress = event => { if (event.loaded > limit) { tooLarge = true; xhr.abort(); } };
          xhr.onabort = () => tooLarge ? resolve({ status: 0, headers: [], text: '', url: href, tooLarge: true }) : reject(new Error('QOJ_XHR_CANCELLED'));
          xhr.onerror = () => reject(new Error('QOJ_XHR_NETWORK_ERROR'));
          xhr.ontimeout = () => reject(new Error('QOJ_XHR_TIMEOUT'));
          xhr.send(body);
        });
      }, { href: url.href, body: init.body.toString(), headers, limit: maxBytes });
      if (result.tooLarge) throw new ConnectorError('RESPONSE_TOO_LARGE', 'QOJ browser response exceeds byte limit');
      validateQojBrowserTarget(result.url);
      const challenge = new Headers(result.headers).get('cf-mitigated') === 'challenge';
      diagnostic?.({ path: url.pathname, status: result.status, resourceType: 'xhr', challenge });
      return new Response(result.text, { status: result.status, headers: result.headers });
    } catch (error) {
      diagnostic?.({ path: url.pathname, status: 0, resourceType: 'transport', challenge: false, failurePhase,
        failureType: error instanceof ConnectorError ? error.code : error instanceof Error ? error.name : 'UnknownError' });
      throw error;
    } finally { signal?.removeEventListener('abort', abort); await closing; release(); }
  };
  return { fetchImpl, async screenshot(path: string) { if (page && !page.isClosed()) { await page.locator('body').waitFor({ state: 'visible', timeout: 10000 }); await page.screenshot({ path, animations: 'disabled' }); } },
    async cancelPage() { const active = page; page = undefined; await active?.close().catch(() => undefined); } };
}

/** Browser sessions use a separate encrypted DB slot; no persistent browser profile or Cookie file. */
export async function createQojBrowserRequestContext(options: { connectionId: string; signal: AbortSignal; headed?: boolean; channel?: 'msedge' | 'chrome' | 'chromium'; executablePath?: string; proxyServer?: string; cdpEndpoint?: string; keepBrowserSession?: boolean; cookieHeader?: string; userAgent?: string; memoryStore?: PlatformRequestStore; timeoutMs?: number; maxRetries?: number; diagnostic?: Parameters<typeof createQojBrowserTransport>[1] }) {
  const proxy = options.proxyServer ? { server: validateQojBrowserProxyServer(options.proxyServer) } : undefined;
  let key: Buffer | undefined;
  if (!options.memoryStore) {
    const file = process.env.SESSION_ENCRYPTION_KEY_FILE;
    if (!file) throw new Error('SESSION_ENCRYPTION_KEY_FILE_REQUIRED');
    key = Buffer.from((await readFile(file, 'utf8')).trim(), 'hex');
    if (key.length !== 32) throw new Error('INVALID_SESSION_ENCRYPTION_KEY');
  }
  const connection = `${options.connectionId}:browser`;
  options.signal.throwIfAborted();
  // A container may own a long-running Chromium process and expose CDP on loopback.
  // Otherwise prefer an installed browser. No persistent userDataDir is created here.
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  if (options.cdpEndpoint) {
    browser = await chromium.connectOverCDP(validateQojBrowserCdpEndpoint(options.cdpEndpoint));
    context = browser.contexts()[0];
    if (!context) {
      await browser.close(); // connectOverCDP close disconnects; it does not kill the external process.
      throw new ConnectorError('UNSUPPORTED_FLOW', 'QOJ CDP browser has no default context');
    }
  } else if (options.channel || options.executablePath) {
    browser = await chromium.launch({ channel: options.channel, headless: options.headed === false, executablePath: options.executablePath, proxy });
  } else {
    for (const channel of ['msedge', 'chrome', 'chromium'] as const) {
      try { browser = await chromium.launch({ channel, headless: options.headed === false, proxy }); break; }
      catch { options.signal.throwIfAborted(); }
    }
    if (!browser) throw new ConnectorError('UNSUPPORTED_FLOW', 'Install Edge or Chromium for QOJ browser transport');
  }
  if (!browser) throw new ConnectorError('UNSUPPORTED_FLOW', 'Install Edge or Chromium for QOJ browser transport');
  try {
    options.signal.throwIfAborted();
    const activeContext = context ?? await browser.newContext({ acceptDownloads: false });
    // Do not route or block subresources here. Request interception disables parts of the
    // normal browser cache/network behaviour and can prevent challenge scripts, workers,
    // or redirects from completing. The transport still validates every requested and
    // returned main-document URL, and the dedicated context refuses downloads.
    const identityPage = await activeContext.newPage();
    const userAgent: string = await identityPage.evaluate('navigator.userAgent');
    await identityPage.close();
    const transport = createQojBrowserTransport(activeContext, options.diagnostic);
    let loaded: string | null = null;
    // A container-owned CDP context is the authoritative live session. Attaching a
    // new script must not clear its cookies or replay a database snapshot.
    const keepBrowserSession = Boolean(options.cdpEndpoint) || options.keepBrowserSession === true;
    let importHeader = options.cookieHeader;
    const scopedContext = (signal: AbortSignal) => createRequestContext({ platform: 'qoj', signal, store: options.memoryStore, allowedMethods: ['GET', 'POST'], fetchImpl: transport.fetchImpl,
      timeoutMs: options.timeoutMs, leaseMs: Math.max(45000, (options.timeoutMs ?? 30000) + 15000), maxRetries: options.maxRetries,
      minIntervalMs: Math.max(1000, Number(process.env.QOJ_MIN_INTERVAL_MS ?? 3000)), maxResponseBytes: maxBytes,
      sessionHooks: {
        async beforeRequest(_token, _url, init) {
          if (key && !keepBrowserSession) {
            const encrypted = await loadConnectorSession(connection, 'qoj');
            if (encrypted && encrypted !== loaded) {
              const saved = sessionSchema.parse(JSON.parse(decryptQojSession(encrypted, key, connection)));
              // Restore the actual Cookie state without overriding this browser's identity.
              // Browser upgrades may invalidate Cloudflare clearance; the real page decides.
              await activeContext.clearCookies();
              await activeContext.addCookies(saved.cookies);
              loaded = encrypted;
            }
          }
          if (importHeader) {
            const cookies = parseQojBrowserCookieHeader(importHeader);
            await activeContext.clearCookies();
            await activeContext.addCookies(cookies);
            importHeader = undefined;
          }
          return init;
        },
        async afterResponse(token, _url, response, requestSignal) {
          requestSignal.throwIfAborted();
          // A failed login/challenge is not a replacement for the last usable encrypted session.
          const html = await response.clone().text();
          if (response.status !== 200 || qojResponseIssue(response, html)) return;
          if (key) {
            const saved = sessionSchema.parse({ version: 1, userAgent, cookies: (await activeContext.cookies()).filter(c => ['qoj.ac', '.qoj.ac'].includes(c.domain)) });
            const encrypted = encryptQojSession(JSON.stringify(saved), key, connection);
            requestSignal.throwIfAborted();
            await saveConnectorSession(connection, 'qoj', encrypted, token, requestSignal);
            loaded = encrypted;
          }
        },
      },
    });
    return { ctx: scopedContext(options.signal), scopedContext, transport: 'browser-chromium' as const, screenshot: transport.screenshot, cancelPage: transport.cancelPage,
      // For connectOverCDP, Browser.close closes the connection, not the container's browser.
      // Never close the external default context: that would terminate its persistent browser.
      close: async () => { await transport.cancelPage(); await browser.close(); } };
  } catch (error) { await browser.close(); throw error; }
}
