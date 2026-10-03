import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { luoguLogin } from '@acm/connectors/server';
import { ConnectorError } from '@acm/connectors/contracts';
import type { LuoguLoginState } from '@acm/connectors/server';
import { claimLoginAttempt, createLoginAttempt, endLoginAttempt, ensureCollectionConnection, getLoginAttempt, saveLoginChallenge } from '@acm/db/server';
import { AppError } from '../../errors';
import { createLuoguRequestContext, decryptLuoguSession, encryptLuoguSession } from './session';

const versionSchema = z.object({ version: z.number().int().positive() }).strict();
const submitSchema = versionSchema.extend({ password: z.string().min(1).max(256), captcha: z.string().trim().min(1).max(32) });
const stale = () => new AppError('STALE_CHALLENGE', '登录尝试已失效或正在处理，请重新获取验证码', 409);
async function key() {
  const path = process.env.SESSION_ENCRYPTION_KEY_FILE;
  if (!path) throw new Error('SESSION_KEY_REQUIRED');
  const value = Buffer.from((await readFile(path, 'utf8')).trim(), 'hex');
  if (value.length !== 32) throw new Error('INVALID_SESSION_KEY');
  return value;
}
async function checkedAttempt(id: string, sessionId: string) {
  if (!z.uuid().safeParse(id).success) throw new AppError('INVALID_INPUT', '登录尝试 ID 不合法', 400);
  const attempt = await getLoginAttempt(id, sessionId);
  if (!attempt) throw new AppError('NOT_FOUND', '登录尝试不存在', 404);
  if (attempt.expires_at.getTime() <= Date.now() || !['processing', 'awaiting_input'].includes(attempt.state)) throw stale();
  return attempt;
}
async function safe<T>(fn: () => Promise<T>) {
  try { return await fn(); } catch (error) {
    if (error instanceof ConnectorError) {
      const message = ['NETWORK_ERROR', 'TIMEOUT', 'CANCELLED'].includes(error.code) ? '服务器连接洛谷失败或请求超时，请稍后重试' : error.message;
      const status = error.code === 'STALE_CHALLENGE' ? 409 : error.code === 'LOGIN_FAILED' ? 400 : error.code === 'UNSUPPORTED_FLOW' ? 422 : error.code === 'RATE_LIMITED' ? 429 : ['RISK_CONTROL', 'FORBIDDEN'].includes(error.code) ? 403 : error.code === 'PARSE_CHANGED' ? 502 : 503;
      if (error.httpStatus !== undefined) console.warn(JSON.stringify({ event: 'luogu_login_response_rejected', code: error.code, httpStatus: error.httpStatus }));
      throw new AppError(error.code, message, status, error.retryAt);
    }
    if (error instanceof Error && ['LOGIN_ATTEMPT_STALE', 'SESSION_GENERATION_CHANGED'].includes(error.message)) throw stale();
    throw error;
  }
}
function requestSignal(signal: AbortSignal) { return AbortSignal.any([signal, AbortSignal.timeout(60000)]); }
export async function beginWebLuoguLogin(input: unknown, sessionId: string, signal: AbortSignal) {
  const parsed = z.object({ username: z.string().trim().min(1).max(128) }).strict().safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '请输入洛谷登录账号', 400);
  const id = randomUUID(), connectionId = process.env.LUOGU_CONNECTION_ID ?? 'luogu-lab';
  const connection = await ensureCollectionConnection(connectionId, 'luogu');
  await createLoginAttempt({ id, sessionId, connectionId, generation: connection.generation });
  return safe(async () => {
    try {
      const context = await createLuoguRequestContext({ connectionId, signal: requestSignal(signal), temporary: true, expectedGeneration: connection.generation });
      const challenge = await luoguLogin.beginLogin(parsed.data.username, context.ctx);
      const encrypted = encryptLuoguSession(JSON.stringify({ state: { ...challenge.state, sessionBinding: null }, jar: await context.exportJar() }), await key(), `attempt:${id}`);
      if (!await saveLoginChallenge(id, sessionId, 1, { version: 1, context: encrypted, image: Buffer.from(challenge.image).toString('base64'), contentType: challenge.contentType })) throw stale();
      return { id, version: 1, state: 'awaiting_input', expiresAt: new Date(challenge.state.expiresAt).toISOString(), captchaUrl: `/api/admin/connections/luogu/login-attempts/${id}/captcha` };
    } catch (error) { await endLoginAttempt(id, sessionId, 'failed'); throw error; }
  });
}
export async function webLuoguCaptcha(id: string, sessionId: string) {
  const attempt = await checkedAttempt(id, sessionId);
  if (attempt.state !== 'awaiting_input' || !attempt.image || !attempt.content_type) throw stale();
  return { image: Buffer.from(attempt.image, 'base64'), contentType: attempt.content_type, version: attempt.version };
}
export async function advanceWebLuoguLogin(id: string, input: unknown, sessionId: string, signal: AbortSignal, refresh = false) {
  const parsed = (refresh ? versionSchema : submitSchema).safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '登录参数不合法', 400);
  const attempt = await checkedAttempt(id, sessionId);
  if (!attempt.encrypted_context || !await claimLoginAttempt(id, sessionId, parsed.data.version)) throw stale();
  return safe(async () => {
    try {
      const saved = JSON.parse(decryptLuoguSession(attempt.encrypted_context!, await key(), `attempt:${id}`)) as { state: LuoguLoginState; jar: string };
      const context = await createLuoguRequestContext({ connectionId: attempt.connection_id, signal: requestSignal(signal), temporary: true, initialJar: saved.jar, expectedGeneration: attempt.generation });
      saved.state.sessionBinding = context.ctx.session;
      if (refresh) {
        const challenge = await luoguLogin.refreshChallenge(saved.state, parsed.data.version, context.ctx);
        const encrypted = encryptLuoguSession(JSON.stringify({ state: { ...challenge.state, sessionBinding: null }, jar: await context.exportJar() }), await key(), `attempt:${id}`);
        if (!await saveLoginChallenge(id, sessionId, parsed.data.version, { version: challenge.state.version, context: encrypted, image: Buffer.from(challenge.image).toString('base64'), contentType: challenge.contentType })) throw stale();
        return { id, version: challenge.state.version, state: 'awaiting_input' };
      }
      const credentials = submitSchema.parse(input);
      const identity = await luoguLogin.advanceLogin(saved.state, credentials, context.ctx);
      await context.promote(identity.uid, { id, version: credentials.version, sessionId });
      return { id, state: 'succeeded', identity: { uid: identity.uid, name: identity.name }, readingPermission: 'unverified' };
    } catch (error) { await endLoginAttempt(id, sessionId, 'failed'); throw error; }
  });
}
export async function cancelWebLuoguLogin(id: string, sessionId: string) {
  await checkedAttempt(id, sessionId); await endLoginAttempt(id, sessionId, 'cancelled'); return { state: 'cancelled' };
}
