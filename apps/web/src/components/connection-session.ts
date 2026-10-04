import { ApiRequestError, requestMessage } from './api-request';

export type Connection = { state: string; collector: string | null };
export type LoginPlatform = 'luogu' | 'qoj';
export type ConnectionCall = <T>(url: string, method?: string) => Promise<T>;
type SessionRun = { status: string; error?: { message?: string; code?: string }; result?: { collector?: string } };
const names = { luogu: '洛谷', qoj: 'QOJ' };

export async function verifyConnectionSession(platform: LoginPlatform, call: ConnectionCall, signal?: AbortSignal): Promise<SessionRun> {
  const queued = await call<{ runId: string }>(`/api/admin/connections/${platform}/verify-session`, 'POST');
  const deadline = Date.now() + 130000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const run = await call<SessionRun>(`/api/admin/read-runs/${queued.runId}`);
    if (!['queued', 'running'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new ApiRequestError(`${names[platform]}核验等待超时，请刷新状态后重试`);
}

export async function refreshConnectionSessions(call: ConnectionCall, signal?: AbortSignal) {
  const platforms = ['luogu', 'qoj'] as const;
  const results = await Promise.allSettled(platforms.map(platform => verifyConnectionSession(platform, call, signal)));
  signal?.throwIfAborted();
  const data = await call<{ items: { platform: string; connection: Connection }[] }>('/api/admin/platforms');
  const connections: Record<string, Connection> = Object.fromEntries(data.items.map(item => [item.platform, item.connection]));
  const messages = results.map((result, index) => {
    const platform = platforms[index]!;
    if (result.status === 'fulfilled') {
      const run = result.value;
      if (run.status === 'completed') return `${names[platform]}身份核验完成`;
      // A failed check cannot reaffirm an older successful database snapshot.
      const state = ['auth_required', 'human_input_required'].includes(run.status) ? run.status : 'unknown';
      connections[platform] = { state, collector: null };
      return run.status === 'auth_required' ? `${names[platform]}未登录或登录已过期，请重新登录` : `${names[platform]}：${run.error?.message ?? '暂时无法核验登录状态，请重试'}`;
    }
    connections[platform] = { state: 'unknown', collector: null };
    return `${names[platform]}：${requestMessage(result.reason)}`;
  });
  return { connections, message: messages.join('；') };
}
