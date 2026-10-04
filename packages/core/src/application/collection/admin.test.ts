import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getAdminConnectionAlerts, getAdminPlatforms, requestAdminSessionVerification } from './admin';
import { getCollectionSettings, listCollectionConnections } from '@acm/db/server';
import { requestPlatformRead } from './jobs';
import { requireCollectionEnabled } from '../personal';

vi.mock('@acm/connectors/server', () => ({ getConnector: () => ({ capabilities: {} }) }));
vi.mock('@acm/db/server', () => ({ listPlatformPolicies: vi.fn(async () => []), listCollectionConnections: vi.fn(async () => []), latestReadFailures: vi.fn(async () => []), getCollectionSettings: vi.fn(async () => ({ platforms: ['luogu'] })), getCollectionControl: vi.fn(), setCollectionControl: vi.fn(), disconnectCollectionConnection: vi.fn(), dispatchDueCollection: vi.fn(), getReadRun: vi.fn(), listReadRuns: vi.fn(), updatePlatformPolicy: vi.fn() }));
vi.mock('./jobs', () => ({ requestPlatformRead: vi.fn(async () => ({ runId: 'verification' })), retryPlatformRead: vi.fn(), withReadQueue: vi.fn() }));
vi.mock('../personal', () => ({ requireCollectionEnabled: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());
it.each(['luogu', 'qoj'])('queues a current %s session check independently of the collection switch', async platform => {
  expect(await requestAdminSessionVerification(platform, 'admin')).toEqual({ runId: 'verification' });
  expect(requestPlatformRead).toHaveBeenCalledWith({ platform, target: '__identity__', operation: 'verify_session', maxDurationMs: 120000 }, { actorId: 'admin' });
  expect(requireCollectionEnabled).not.toHaveBeenCalled();
});
it('rejects verification for platforms without a login', async () => {
  await expect(requestAdminSessionVerification('codeforces', 'admin')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(requestPlatformRead).not.toHaveBeenCalled();
});
it('hides identity and old reading permission when the stored connection requires reauthentication', async () => {
  vi.stubEnv('LUOGU_CONNECTION_ID', 'luogu-lab');
  vi.mocked(listCollectionConnections).mockResolvedValueOnce([{ id: 'luogu-lab', platform: 'luogu', state: 'auth_required', collector: 'old-uid', generation: 1, cookieRevision: 1, verifiedAt: new Date(), readingVerifiedAt: new Date() }]);
  const platform = (await getAdminPlatforms()).items.find(platform => platform.platform === 'luogu');
  expect(platform).toMatchObject({ connection: { state: 'auth_required', collector: null }, authentication: { readingPermission: 'unverified' } });
  vi.unstubAllEnvs();
});
it.each(['auth_required', 'ready', 'human_input_required', 'unknown', 'disconnected'])('includes a homepage reminder only for an expired selected connection (%s)', async state => {
  vi.stubEnv('LUOGU_CONNECTION_ID', 'luogu-lab');
  vi.mocked(listCollectionConnections).mockResolvedValueOnce([{ id: 'luogu-lab', platform: 'luogu', state, collector: 'old-uid', generation: 1, cookieRevision: 1, verifiedAt: new Date(), readingVerifiedAt: null }]);
  expect(await getAdminConnectionAlerts()).toEqual({ items: state === 'auth_required' ? [{ platform: 'luogu', name: '洛谷' }] : [] });
  expect(requestPlatformRead).not.toHaveBeenCalled();
});
it('omits disabled platforms and other connections from homepage reminders', async () => {
  vi.stubEnv('LUOGU_CONNECTION_ID', 'active-luogu');
  vi.stubEnv('QOJ_CONNECTION_ID', 'qoj-lab');
  vi.mocked(listCollectionConnections).mockResolvedValueOnce(['luogu', 'qoj'].map(platform => ({ id: `${platform}-lab`, platform, state: 'auth_required', collector: null, generation: 1, cookieRevision: 1, verifiedAt: null, readingVerifiedAt: null })));
  expect(await getAdminConnectionAlerts()).toEqual({ items: [] });
  expect(getCollectionSettings).toHaveBeenCalled();
});
