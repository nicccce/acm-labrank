import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from './api-request';
import { refreshConnectionSessions, verifyConnectionSession, type ConnectionCall } from './connection-session';

afterEach(() => vi.useRealTimers());
function requests(statuses: Record<string, string>, failQoj = false) {
  const call = vi.fn(async (url: string) => {
    if (url.endsWith('/verify-session')) {
      if (failQoj && url.includes('/qoj/')) throw new ApiRequestError('服务暂不可用');
      return { runId: url.includes('/qoj/') ? 'qoj' : 'luogu' };
    }
    if (url.startsWith('/api/admin/read-runs/')) return { status: statuses[url.split('/').at(-1)!] };
    return { items: ['luogu', 'qoj'].map(platform => ({ platform, connection: { state: 'ready', collector: `old-${platform}` } })) };
  });
  return { call, request: call as ConnectionCall };
}
describe('refreshing current connection sessions', () => {
  it('actively checks both platforms and removes stale ready identities when logged out', async () => {
    const f = requests({ luogu: 'auth_required', qoj: 'auth_required' });
    const result = await refreshConnectionSessions(f.request);
    expect(f.call).toHaveBeenCalledWith('/api/admin/connections/luogu/verify-session', 'POST');
    expect(f.call).toHaveBeenCalledWith('/api/admin/connections/qoj/verify-session', 'POST');
    expect(result.connections).toEqual({ luogu: { state: 'auth_required', collector: null }, qoj: { state: 'auth_required', collector: null } });
    expect(result.message).toContain('登录已过期，请重新登录');
  });
  it('keeps the confirmed platform usable when the other verification request fails', async () => {
    const f = requests({ luogu: 'completed' }, true);
    const result = await refreshConnectionSessions(f.request);
    expect(result.connections).toEqual({ luogu: { state: 'ready', collector: 'old-luogu' }, qoj: { state: 'unknown', collector: null } });
    expect(result.message).toContain('服务暂不可用');
  });
  it('does not mistake network failures or human challenges for an expired login', async () => {
    const f = requests({ luogu: 'failed', qoj: 'human_input_required' });
    const result = await refreshConnectionSessions(f.request);
    expect(result.connections).toEqual({ luogu: { state: 'unknown', collector: null }, qoj: { state: 'human_input_required', collector: null } });
    expect(result.message).not.toContain('登录已过期');
  });
  it('waits for queued verification to finish before accepting a connection', async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockResolvedValueOnce({ runId: 'qoj' }).mockResolvedValueOnce({ status: 'queued' }).mockResolvedValueOnce({ status: 'running' }).mockResolvedValueOnce({ status: 'completed', result: { collector: 'current' } });
    const pending = verifyConnectionSession('qoj', call);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toMatchObject({ status: 'completed', result: { collector: 'current' } });
  });
  it('bounds verification when a worker does not process the job', async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockResolvedValueOnce({ runId: 'qoj' }).mockResolvedValue({ status: 'queued' });
    const result = verifyConnectionSession('qoj', call).catch(error => error);
    await vi.advanceTimersByTimeAsync(131000);
    expect(await result).toMatchObject({ message: expect.stringContaining('核验等待超时') });
  });
});
