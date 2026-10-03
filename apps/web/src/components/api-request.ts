export class ApiRequestError extends Error {
  constructor(message: string, public readonly teamId?: string, public readonly code?: string, public readonly status?: number) { super(message); }
}

export async function apiRequest<T>(path: string, csrfToken: string, method = 'GET', input?: unknown, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(70000);
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  let body: T & { message?: string; teamId?: string; code?: string };
  try { body = await response.json(); }
  catch { throw new ApiRequestError('服务器响应异常，请刷新后重试', undefined, 'INVALID_RESPONSE', response.status); }
  if (!response.ok) throw new ApiRequestError(body.message ?? '操作失败', body.teamId, body.code, response.status);
  return body;
}

export function requestMessage(error: unknown) {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error && error.name === 'TimeoutError') return '请求等待超时，请刷新状态后重试';
  return '网络连接失败，请重试';
}
