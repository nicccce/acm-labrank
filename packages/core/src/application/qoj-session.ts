import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CookieJar } from 'tough-cookie';
import { loadConnectorSession, saveConnectorSession, type PlatformRequestStore } from '@acm/db/server';
import { createRequestContext } from './request-context';

export function encryptQojSession(value: string, key: Buffer, connection: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`qoj:${connection}:1`));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}
export function decryptQojSession(value: string, key: Buffer, connection: string) {
  const [version, iv, tag, ciphertext] = value.split('.');
  if (version !== '1' || !iv || !tag || !ciphertext) throw new Error('INVALID_SESSION_ENVELOPE');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(`qoj:${connection}:1`));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** Web login and Worker use the same platform lease; only encrypted jars cross processes. */
export async function createQojRequestContext(options: { connectionId: string; signal: AbortSignal; cookieHeader?: string; userAgent?: string; memoryStore?: PlatformRequestStore; fetchImpl?: typeof fetch; timeoutMs?: number; maxRetries?: number }) {
  let key: Buffer | undefined;
  if (!options.memoryStore) {
    const file = process.env.SESSION_ENCRYPTION_KEY_FILE;
    if (!file) throw new Error('SESSION_ENCRYPTION_KEY_FILE_REQUIRED');
    key = Buffer.from((await readFile(file, 'utf8')).trim(), 'hex');
    if (key.length !== 32) throw new Error('INVALID_SESSION_ENCRYPTION_KEY');
  }
  let jar = new CookieJar();
  let ua = options.userAgent ?? 'acm-labrank/1.0';
  let importHeader = options.cookieHeader;
  return createRequestContext({ platform: 'qoj', signal: options.signal, allowedMethods: ['GET', 'POST'], store: options.memoryStore, fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs, leaseMs: Math.max(45000, (options.timeoutMs ?? 30000) + 15000), maxRetries: options.maxRetries,
    minIntervalMs: Math.max(1000, Number(process.env.QOJ_MIN_INTERVAL_MS ?? 3000)),
    maxResponseBytes: 4 * 1024 * 1024,
    sessionHooks: {
      async beforeRequest(_token, url, init) {
        if (new Headers(init.headers).has('cookie')) throw new Error('COOKIE_MUST_USE_JAR');
        if (key) {
          const encrypted = await loadConnectorSession(options.connectionId, 'qoj');
          if (encrypted) {
            const saved = JSON.parse(decryptQojSession(encrypted, key, options.connectionId)) as { jar: string; userAgent: string };
            jar = CookieJar.deserializeSync(saved.jar);
            ua = options.userAgent ?? saved.userAgent;
          }
        }
        if (importHeader) {
          for (const pair of importHeader.split(';')) await jar.setCookie(`${pair.trim()}; Path=/; Secure`, 'https://qoj.ac');
          importHeader = undefined;
        }
        const headers = new Headers(init.headers);
        headers.set('user-agent', ua);
        headers.set('accept-language', 'en-US,en;q=0.9');
        headers.set('accept', headers.get('accept') ?? 'text/html');
        const cookies = await jar.getCookieString(url.href);
        if (cookies) headers.set('cookie', cookies);
        return { ...init, headers };
      },
      async afterResponse(token, url, response, requestSignal) {
        for (const cookie of response.headers.getSetCookie()) await jar.setCookie(cookie, url.href);
        requestSignal.throwIfAborted();
        if (key) await saveConnectorSession(options.connectionId, 'qoj', encryptQojSession(JSON.stringify({ jar: await jar.serialize(), userAgent: ua }), key, options.connectionId), token, requestSignal);
      },
    },
  });
}
