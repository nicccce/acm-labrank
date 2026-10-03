export class MemberRequestError extends Error {
  constructor(message: string, public readonly teamId?: string) { super(message); }
}
export async function memberRequest<T>(path: string, csrfToken: string, method = 'GET', input?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method, cache: 'no-store', signal, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const body = await response.json() as T & { message?: string; teamId?: string };
  if (!response.ok) throw new MemberRequestError(body.message ?? '操作失败', body.teamId);
  return body;
}
export function requestMessage(error: unknown) { return error instanceof MemberRequestError ? error.message : '网络连接失败，请重试'; }
