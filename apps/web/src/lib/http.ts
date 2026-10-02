import 'server-only';
import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { AppError, getConfig, getSession, validateCsrf } from '@acm/core/server';

export const SESSION_COOKIE = 'acm_session';
export async function currentSession() {
  return getSession((await cookies()).get(SESSION_COOKIE)?.value);
}
export function checkOrigin(request: Request) {
  if (request.headers.get('origin') !== new URL(getConfig().APP_URL).origin) {
    throw new AppError('INVALID_ORIGIN', '请求来源不受信任', 403);
  }
}
export async function readJson(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    throw new AppError('INVALID_CONTENT_TYPE', '请使用 JSON 请求', 400);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('INVALID_INPUT', '请求体不能为空', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new AppError('BODY_TOO_LARGE', '请求体过大', 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_JSON', 'JSON 格式错误', 400);
  } finally { reader.releaseLock(); }
}
export async function requireSession(request?: Request) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await getSession(token);
  if (!session || !token) throw new AppError('UNAUTHENTICATED', '请先登录', 401);
  if (request && !validateCsrf(token, request.headers.get('x-csrf-token'))) {
    throw new AppError('INVALID_CSRF', '会话校验失败，请刷新页面', 403);
  }
  return { token, session };
}
export async function requireAdmin(request?: Request) {
  if (request) checkOrigin(request);
  const authenticated = await requireSession(request);
  if (authenticated.session.user.role !== 'admin') throw new AppError('FORBIDDEN', '仅管理员可以执行此操作', 403);
  return authenticated;
}
export async function api(handler: () => Promise<NextResponse>) {
  const requestId = randomUUID();
  try {
    const response = await handler();
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Request-Id', requestId);
    return response;
  } catch (error) {
    const known = error instanceof AppError;
    if (!known) console.error(JSON.stringify({ code: 'INTERNAL_ERROR', requestId }));
    return NextResponse.json({
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : '服务暂不可用，请稍后重试',
      requestId,
      ...(known && error.retryAt ? { retryAt: error.retryAt } : {}),
    }, { status: known ? error.status : 500, headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } });
  }
}
export function sessionResponse(result: Awaited<ReturnType<typeof import('@acm/core/server').login>>, status = 200) {
  const response = NextResponse.json({ user: result.user, csrfToken: result.csrfToken }, { status });
  response.cookies.set(SESSION_COOKIE, result.token, {
    httpOnly: true, sameSite: 'lax', secure: new URL(getConfig().APP_URL).protocol === 'https:',
    path: '/', expires: result.expiresAt,
  });
  return response;
}
