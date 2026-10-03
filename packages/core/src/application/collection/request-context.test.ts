import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRequestStore } from '@acm/db/server';
import { createRequestContext, parseRetryAfter } from './request-context';
import { ConnectorError } from '@acm/connectors/contracts';

function memoryStore(): PlatformRequestStore {
  let owner: string | null = null;
  let expires = 0;
  let nextAt = 0;
  return {
    async acquire(_platform, token, interval, lease) {
      const now = Date.now();
      if (now < nextAt || (owner && now < expires)) return { acquired: false, waitMs: Math.max(nextAt, expires) - now };
      owner = token; expires = now + lease; nextAt = now + interval;
      return { acquired: true, waitMs: 0 };
    },
    async owns(_platform, token) { return owner === token && Date.now() < expires; },
    async release(_platform, token, interval = 0) { if (owner !== token || Date.now() >= expires) return false; owner = null; nextAt = Math.max(nextAt, Date.now() + interval); return true; },
    async block(_platform, time) { nextAt = Math.max(nextAt, Date.parse(time)); },
  };
}
const url = new URL('https://codeforces.com/api/user.info?handles=ExampleUser');
const json = () => new Response('{}', { headers: { 'content-type': 'application/json' } });
afterEach(() => vi.useRealTimers());

describe('shared platform request context', () => {
  it('rechecks the collection guard after acquiring a lease and releases it without sending', async () => {
    const store = memoryStore(), release = vi.spyOn(store, 'release'), fetchImpl = vi.fn(async () => json());
    const ctx = createRequestContext({ platform: 'codeforces', signal: new AbortController().signal, store, fetchImpl, beforeRequest: async () => { throw new ConnectorError('CANCELLED', 'Platform was disabled while waiting'); } });
    await expect(ctx.request(url)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  });
  it('uses shared intervals and keeps the lease while the response body is in flight', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const started: number[] = [];
    const fetchImpl = vi.fn(async () => {
      started.push(Date.now());
      return new Response(new ReadableStream({ start(controller) {
        setTimeout(() => { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); }, started.length === 1 ? 3500 : 0);
      } }), { headers: { 'content-type': 'application/json' } });
    });
    const a = createRequestContext({ platform: 'codeforces', signal: new AbortController().signal, store, fetchImpl });
    const b = createRequestContext({ platform: 'codeforces', signal: new AbortController().signal, store, fetchImpl });
    const requests = Promise.all([a.request(url), b.request(url)]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4000);
    await requests;
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(5500);
  });

  it('honors numeric and date Retry-After across clients', async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const starts: number[] = [];
    const fetchImpl = vi.fn(async () => {
      starts.push(Date.now());
      return starts.length === 1 ? new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '5' } }) : json();
    });
    const ctx = createRequestContext({ platform: 'codeforces', signal: new AbortController().signal, store, fetchImpl });
    const request = ctx.request(url);
    await vi.advanceTimersByTimeAsync(4999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1001);
    await request;
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(5000);
    expect(parseRetryAfter('5', 0)).toBe('1970-01-01T00:00:05.000Z');
    expect(parseRetryAfter('Thu, 01 Oct 2026 00:00:00 GMT', 0)).toBe('2026-10-01T00:00:00.000Z');
    expect(parseRetryAfter('nonsense')).toBeUndefined();
  });

  it.each(['content-length', 'stream'])('limits %s response sizes', async (kind) => {
    const store = memoryStore();
    const fetchImpl = vi.fn(async () => new Response('123456', { headers: { 'content-type': 'application/json', ...(kind === 'content-length' ? { 'content-length': '6' } : {}) } }));
    const ctx = createRequestContext({ platform: 'codeforces', signal: new AbortController().signal, store, fetchImpl, maxResponseBytes: 5 });
    await expect(ctx.request(url)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(await store.acquire('codeforces', 'next', 0, 100)).toMatchObject({ acquired: false });
  });

  it('cancels body reads, releases ownership, and does not retry cancelled requests', async () => {
    const controller = new AbortController();
    const store = memoryStore();
    const release = vi.spyOn(store, 'release');
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start() { controller.abort(); } }), { headers: { 'content-type': 'application/json' } }));
    const ctx = createRequestContext({ platform: 'codeforces', signal: controller.signal, store, fetchImpl });
    await expect(ctx.request(url)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(release).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('enforces a hard timeout and bounds transient retries', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const ctx = createRequestContext({ platform: 'codeforces', signal: new AbortController().signal, store: memoryStore(), fetchImpl, timeoutMs: 100, leaseMs: 1000 });
    const check = expect(ctx.request(url)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10000);
    await check;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects a lost lease before publishing a late body', async () => {
    const store = memoryStore();
    vi.spyOn(store, 'owns').mockResolvedValue(false);
    const ctx = createRequestContext({ platform: 'codeforces', signal: new AbortController().signal, store, fetchImpl: async () => json() });
    await expect(ctx.request(url)).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });

  it('rejects foreign redirects, unsafe targets, unsupported methods and intervals below 2000ms', async () => {
    const ctx = createRequestContext({ platform: 'codeforces', signal: new AbortController().signal, store: memoryStore(), fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/' } }) });
    await expect(ctx.request(url)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(ctx.request(new URL('http://codeforces.com/api/user.info'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(ctx.request(url, { method: 'POST' })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect(() => createRequestContext({ platform: 'codeforces', signal: new AbortController().signal, minIntervalMs: 1999 })).toThrow();
  });
});
