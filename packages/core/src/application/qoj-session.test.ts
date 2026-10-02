import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createQojRequestContext, decryptQojSession, encryptQojSession } from './qoj-session';
import { createQojMemoryStore } from './qoj-memory-store';

it('authenticates encryption and binds sessions to their connection', () => {
  const key = randomBytes(32);
  const plaintext = randomBytes(48).toString('hex');
  const sealed = encryptQojSession(plaintext, key, 'connection-one');
  expect(sealed).not.toContain(plaintext);
  expect(decryptQojSession(sealed, key, 'connection-one')).toBe(plaintext);
  expect(() => decryptQojSession(sealed, key, 'connection-two')).toThrow();
  expect(() => decryptQojSession(sealed, randomBytes(32), 'connection-one')).toThrow();
});

it('uses and rotates the Cookie jar under the common request context without exposing Set-Cookie', async () => {
  const initial = randomBytes(24).toString('hex');
  const rotated = randomBytes(24).toString('hex');
  const cookies: string[] = [];
  const ctx = await createQojRequestContext({ connectionId: 'debug', signal: new AbortController().signal, cookieHeader: `session=${initial}`, memoryStore: createQojMemoryStore(),
    fetchImpl: async (_url, init) => {
      cookies.push(new Headers(init?.headers).get('cookie') ?? '');
      return new Response('<html></html>', { headers: { 'content-type': 'text/html', 'set-cookie': `session=${rotated}; Path=/; Secure; HttpOnly` } });
    },
  });
  expect((await ctx.request(new URL('https://qoj.ac/login'))).headers.has('set-cookie')).toBe(false);
  await ctx.request(new URL('https://qoj.ac/submissions'));
  expect(cookies).toEqual([`session=${initial}`, `session=${rotated}`]);
  await expect(ctx.request(new URL('https://other.example/login'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
