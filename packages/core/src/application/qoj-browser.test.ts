import { expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import { createQojBrowserTransport, parseQojBrowserCookieHeader, validateQojBrowserTarget, validateQojBrowserProxyServer, validateQojBrowserCdpEndpoint } from './qoj-browser';

function fakeBrowser(status = 200, finalUrl = 'https://qoj.ac/submissions?submitter=sample_person', extraHeaders: Record<string, string> = {}) {
  const response = { url: () => finalUrl, headers: () => ({ 'cf-mitigated': status === 403 ? 'challenge' : undefined }), allHeaders: async () => ({ 'content-type': 'text/html', 'set-cookie': 'test-secret', 'cf-mitigated': status === 403 ? 'challenge' : '', ...extraHeaders }), status: () => status, body: async () => Buffer.from('<html>raw response</html>') };
  const close = vi.fn(async () => undefined);
  const goto = vi.fn(async () => response);
  const page = { goto, close, on: vi.fn(), off: vi.fn(), waitForResponse: vi.fn(async () => { throw new Error('Unsolved challenge'); }), url: () => finalUrl } as unknown as Page;
  const newPage = vi.fn(async () => page);
  return { context: { newPage } as unknown as BrowserContext, close, goto, newPage };
}
it('restricts browser navigation and login writes to the QOJ read flow', async () => {
  for (const url of ['https://other.example/login', 'https://qoj.ac/logout', 'https://qoj.ac/contest/1/finish', 'http://qoj.ac/login', 'https://name:secret@qoj.ac/login']) expect(() => validateQojBrowserTarget(url)).toThrow();
  const fake = fakeBrowser();
  const { fetchImpl } = createQojBrowserTransport(fake.context);
  await expect(fetchImpl('https://qoj.ac/submissions', { method: 'POST' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(fetchImpl('https://qoj.ac/login', { headers: { cookie: 'never-import' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(fake.newPage).not.toHaveBeenCalled();
});
it('accepts a browser proxy endpoint but rejects credentials and query secrets before launch', () => {
  expect(validateQojBrowserProxyServer('http://host.docker.internal:3875')).toBe('http://host.docker.internal:3875/');
  for (const input of ['invalid', 'file:///tmp/proxy', 'http://name:secret@proxy:8080', 'http://proxy:8080/?token=secret', 'http://proxy:8080/path', 'http://proxy:8080/#secret']) {
    expect(() => validateQojBrowserProxyServer(input)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  }
});
it('only permits loopback CDP endpoints without embedded secrets', () => {
  expect(validateQojBrowserCdpEndpoint('http://127.0.0.1:9222')).toBe('http://127.0.0.1:9222/');
  expect(validateQojBrowserCdpEndpoint('ws://localhost:9222')).toBe('ws://localhost:9222/');
  for (const input of ['http://host.docker.internal:9222', 'http://0.0.0.0:9222', 'http://name:secret@127.0.0.1:9222', 'http://127.0.0.1:9222/json/version', 'http://127.0.0.1:9222/?token=secret']) {
    expect(() => validateQojBrowserCdpEndpoint(input)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  }
});
it('imports a Cookie header only into the QOJ origin and preserves values containing equals signs', () => {
  expect(parseQojBrowserCookieHeader('a=value==; b=other')).toEqual([
    { name: 'a', value: 'value==', url: 'https://qoj.ac', secure: true, httpOnly: true },
    { name: 'b', value: 'other', url: 'https://qoj.ac', secure: true, httpOnly: true },
  ]);
  expect(() => parseQojBrowserCookieHeader('bad')).toThrow();
});
it('returns the original navigation response and challenge header without exposing Cookie', async () => {
  const fake = fakeBrowser(403);
  const { fetchImpl } = createQojBrowserTransport(fake.context);
  const r = await fetchImpl('https://qoj.ac/submissions?submitter=sample_person');
  expect(r.status).toBe(403);
  expect(r.url).toBe('https://qoj.ac/submissions?submitter=sample_person');
  expect(r.headers.get('cf-mitigated')).toBe('challenge');
  expect(r.headers.has('set-cookie')).toBe(false);
  expect(await r.text()).toBe('<html>raw response</html>');
});
it('validates redirect targets before returning data', async () => {
  const fake = fakeBrowser(200, 'https://other.example/');
  await expect(createQojBrowserTransport(fake.context).fetchImpl('https://qoj.ac/login')).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('publishes a final login response despite unrelated browser headers invalid for Fetch Headers', async () => {
  const fake = fakeBrowser(200, 'https://qoj.ac/login', { ':status': '200', 'date': 'Fri, 02 Oct 2026 05:18:21 GMT', 'x-private-metadata': 'synthetic' });
  const response = await createQojBrowserTransport(fake.context).fetchImpl('https://qoj.ac/user/profile/sample_person');
  expect(response.status).toBe(200);
  expect(response.url).toBe('https://qoj.ac/login');
  expect(response.headers.get('date')).toBe('Fri, 02 Oct 2026 05:18:21 GMT');
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(response.headers.has('x-private-metadata')).toBe(false);
});
it('closes an in-flight browser page on cancellation rather than leaving a late login running', async () => {
  const fake = fakeBrowser();
  fake.goto.mockImplementationOnce(() => new Promise((_resolve, reject) => { fake.close.mockImplementationOnce(async () => { reject(new Error('Page closed')); }); }));
  const controller = new AbortController();
  const request = createQojBrowserTransport(fake.context).fetchImpl('https://qoj.ac/login', { signal: controller.signal });
  await vi.waitFor(() => expect(fake.goto).toHaveBeenCalled());
  controller.abort();
  await expect(request).rejects.toThrow('Page closed');
  expect(fake.close).toHaveBeenCalledOnce();
});
it('serializes direct navigations and cancellation of a waiter leaves its owner running', async () => {
  const fake = fakeBrowser();
  let finish!: () => void;
  const original = await fake.goto();
  fake.goto.mockClear();
  fake.goto.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(original); }));
  const transport = createQojBrowserTransport(fake.context);
  const owner = transport.fetchImpl('https://qoj.ac/submissions?submitter=owner');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const controller = new AbortController();
  const waiter = transport.fetchImpl('https://qoj.ac/submissions?submitter=waiter', { signal: controller.signal });
  controller.abort();
  await expect(waiter).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(fake.goto).toHaveBeenCalledOnce();
  expect(fake.close).not.toHaveBeenCalled();
  finish();
  await owner;
  await transport.fetchImpl('https://qoj.ac/submissions?submitter=next');
  expect(fake.goto).toHaveBeenCalledTimes(2);
  expect(fake.newPage).toHaveBeenCalledOnce();
});
