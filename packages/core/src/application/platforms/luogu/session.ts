import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CookieJar } from 'tough-cookie';
import { ensureCollectionConnection, loadConnectorSession, saveConnectorSession } from '@acm/db/server';
import { ConnectorError } from '@acm/connectors/contracts';
import { luoguLogin } from '@acm/connectors/server';
import { createRequestContext } from '../../collection/request-context';

const PREFIX = 'luogu-session';
export function encryptLuoguSession(value: string, key: Buffer, id: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`${PREFIX}:${id}:1`));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, keyId: createHash('sha256').update(key).digest('hex').slice(0, 16), nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: data.toString('base64') });
}
export function decryptLuoguSession(value: string, key: Buffer, id: string) {
  const env = JSON.parse(value) as { version: number; keyId: string; nonce: string; tag: string; ciphertext: string };
  if (env.version !== 1 || env.keyId !== createHash('sha256').update(key).digest('hex').slice(0, 16)) throw new ConnectorError('AUTH_REQUIRED', '会话密钥版本不匹配，请重新登录');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'));
  decipher.setAAD(Buffer.from(`${PREFIX}:${id}:1`)); decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** Every jar read/update happens inside the application's shared platform lease. */
export async function createLuoguRequestContext(options: { connectionId: string; signal: AbortSignal; temporary?: boolean; initialJar?: string; fetchImpl?: typeof fetch; expectedGeneration?: number; beforeRequest?: () => Promise<void> }) {
  const generation = options.expectedGeneration ?? (await ensureCollectionConnection(options.connectionId, 'luogu')).generation;
  const file = process.env.SESSION_ENCRYPTION_KEY_FILE;
  if (!file) throw new Error('SESSION_ENCRYPTION_KEY_FILE_REQUIRED');
  const key = Buffer.from((await readFile(file, 'utf8')).trim(), 'hex');
  if (key.length !== 32) throw new Error('INVALID_SESSION_ENCRYPTION_KEY');
  let jar = options.initialJar ? CookieJar.deserializeSync(options.initialJar) : new CookieJar();
  // The private marker also binds captcha state to this request context.
  const marker = Object.freeze({ connectionId: options.connectionId });
  const ctx = createRequestContext({ platform: 'luogu', signal: options.signal, allowedMethods: ['GET', 'POST'], allowImages: true,
    maxResponseBytes: 4 * 1024 * 1024, fetchImpl: options.fetchImpl, beforeRequest: options.beforeRequest,
    sessionHooks: {
      async beforeRequest(_token, url, init) {
        if (new Headers(init.headers).has('cookie')) throw new ConnectorError('INVALID_INPUT', 'Cookie 必须由公共会话层管理');
        if (!options.temporary) {
          const saved = await loadConnectorSession(options.connectionId, 'luogu');
          if (!saved) throw new ConnectorError('AUTH_REQUIRED', '洛谷采集连接尚未登录');
          jar = CookieJar.deserializeSync(decryptLuoguSession(saved, key, options.connectionId));
        }
        const headers = new Headers(init.headers);
        headers.set('User-Agent', 'acm-labrank/1.0'); headers.set('Accept-Language', 'zh-CN,zh;q=0.9');
        const cookies = await jar.getCookieString(url.href); if (cookies) headers.set('Cookie', cookies);
        return { ...init, headers };
      },
      async afterResponse(token, url, response) {
        for (const cookie of response.headers.getSetCookie()) await jar.setCookie(cookie, url.href);
        if (!options.temporary) await saveConnectorSession(options.connectionId, 'luogu', encryptLuoguSession(JSON.stringify(await jar.serialize()), key, options.connectionId), token, options.signal, generation);
      },
    },
  });
  ctx.session = marker;
  return {
    ctx,
    exportJar: async () => JSON.stringify(await jar.serialize()),
    /** Promotion happens only after authenticated identity verification. Reading permission is separate. */
    async promote(expectedUid: string, attempt?: { id: string; version: number; sessionId: string }) {
      if (!options.temporary) throw new Error('ONLY_TEMPORARY_SESSION_CAN_BE_PROMOTED');
      // Trigger a final leased request and save before releasing that lease.
      const publishing = createRequestContext({ platform: 'luogu', signal: options.signal, maxResponseBytes: 4 * 1024 * 1024, fetchImpl: options.fetchImpl,
        sessionHooks: {
          async beforeRequest(_token, url, init) { const headers = new Headers(init.headers); headers.set('User-Agent', 'acm-labrank/1.0'); headers.set('Accept-Language', 'zh-CN,zh;q=0.9'); headers.set('Cookie', await jar.getCookieString(url.href)); return { ...init, headers }; },
          async afterResponse(token, url, response) {
            const singleResponseContext = { ...ctx, request: async () => response.clone() };
            const identity = await luoguLogin.verifySession(singleResponseContext);
            if (identity.uid !== expectedUid) throw new ConnectorError('AUTH_REQUIRED', '发布前登录身份发生变化');
            for (const cookie of response.headers.getSetCookie()) await jar.setCookie(cookie, url.href);
            await saveConnectorSession(options.connectionId, 'luogu', encryptLuoguSession(JSON.stringify(await jar.serialize()), key, options.connectionId), token, options.signal, generation, { collector: expectedUid, attempt });
          },
        },
      });
      await publishing.request(new URL('https://www.luogu.com.cn/'));
    },
  };
}
