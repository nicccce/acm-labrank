import { beforeEach, expect, it, vi } from 'vitest';
import { ConnectorError, type RequestContext } from '@acm/connectors/contracts';
import { luoguLogin } from '@acm/connectors/server';
import { collectionAvailability, finishReadRun, setCollectionConnectionFailure, verifyCollectionConnection } from '@acm/db/server';
import { readPlatform } from './read';

vi.mock('@acm/connectors/server', () => ({ getConnector: () => ({ capabilities: {} }), luoguLogin: { verifySession: vi.fn() } }));
vi.mock('@acm/db/server', async importOriginal => ({
  ...await importOriginal<typeof import('@acm/db/server')>(),
  collectionAvailability: vi.fn(async () => ({ reason: 'PLATFORM_DISABLED', generation: 1 })),
  createDirectReadRun: vi.fn(async () => 'run'),
  startReadRun: vi.fn(async () => true),
  ensureCollectionConnection: vi.fn(async (id: string, platform: string) => ({ id, platform, state: 'ready', generation: 4, collector: 'old', cookieRevision: 0, verifiedAt: new Date(), readingVerifiedAt: new Date() })),
  writeReadGeneration: vi.fn(),
  verifyCollectionConnection: vi.fn(async () => true),
  setCollectionConnectionFailure: vi.fn(),
  finishReadRun: vi.fn(),
}));
vi.mock('./connection-task', () => ({ holdConnectionTask: vi.fn(async (_id: string, signal: AbortSignal) => ({ signal, token: 'task', check: vi.fn(), release: vi.fn() })) }));
const ctx: RequestContext = { request: vi.fn(), signal: new AbortController().signal, session: null };
beforeEach(() => vi.clearAllMocks());
it('rechecks an old ready Luogu session and persists reauthentication without requiring collection to be enabled', async () => {
  vi.mocked(luoguLogin.verifySession).mockRejectedValueOnce(new ConnectorError('AUTH_REQUIRED', 'expired'));
  const result = await readPlatform({ platform: 'luogu', target: '__identity__', operation: 'verify_session' }, { signal: ctx.signal, context: ctx });
  expect(result).toMatchObject({ status: 'auth_required', collector: null, error: { code: 'AUTH_REQUIRED', action: 'reauthenticate' } });
  expect(collectionAvailability).not.toHaveBeenCalled();
  expect(verifyCollectionConnection).not.toHaveBeenCalled();
  expect(setCollectionConnectionFailure).toHaveBeenCalledWith('luogu-lab', 4, 'auth_required');
  expect(finishReadRun).toHaveBeenCalledWith('run', expect.objectContaining({ status: 'auth_required' }), expect.objectContaining({ status: 'auth_required' }));
});
it('records QOJ logout as an authentication failure for the current connection generation', async () => {
  const execute = vi.fn(async () => ({ status: 'auth_required', code: 'AUTH_REQUIRED', account: null, collector: null, submissions: [], problems: [], stopReason: 'more' as const }));
  const result = await readPlatform({ platform: 'qoj', target: '__identity__', operation: 'verify_session' }, { signal: ctx.signal, qoj: { connectionId: 'qoj-lab', execute } as unknown as NonNullable<Parameters<typeof readPlatform>[1]['qoj']> });
  expect(result).toMatchObject({ status: 'auth_required', collector: null, error: { action: 'reauthenticate' } });
  expect(setCollectionConnectionFailure).toHaveBeenCalledWith('qoj-lab', 4, 'auth_required');
});
it('promotes an actually confirmed identity and does not read profiles or submissions', async () => {
  vi.mocked(luoguLogin.verifySession).mockResolvedValueOnce({ uid: '777', name: 'current' });
  const result = await readPlatform({ platform: 'luogu', target: '__identity__', operation: 'verify_session' }, { signal: ctx.signal, context: ctx });
  expect(result).toMatchObject({ status: 'completed', collector: '777', account: null, progress: { pages: 0 } });
  expect(verifyCollectionConnection).toHaveBeenCalledWith('luogu-lab', 4, '777', 'task');
  expect(setCollectionConnectionFailure).not.toHaveBeenCalled();
});
