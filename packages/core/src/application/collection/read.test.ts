import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorError, type AccountRef, type PlatformId, type ReadConnector, type RequestContext, type SubmissionPage } from '@acm/connectors/contracts';
import { getConnector, luoguLogin } from '@acm/connectors/server';
import { readPlatform, readOutcomeSummary } from './read';
import { createQojReadWorker } from '../platforms/qoj/worker';

vi.mock('@acm/connectors/server', () => ({ getConnector: vi.fn(), luoguLogin: { verifySession: vi.fn(async () => ({ uid: '777', name: 'collector' })) }, qojLogin: { verifySession: vi.fn(async () => 'collector') }, qojResponseIssue: vi.fn(() => null) }));
const ctx: RequestContext = { request: vi.fn(), signal: new AbortController().signal, session: null };
function page(platform: PlatformId, id: string, stopReason: SubmissionPage['stopReason']): SubmissionPage {
  return { submissions: [{ platform, externalSubmissionId: id, problemKey: 'P1', submittedAt: '2026-10-02T00:00:00.000Z', verdict: 'accepted', subjectEvidence: { authorAccountKeys: ['sample'] }, parserVersion: 'fixture-1', observedAt: '2026-10-02T00:00:00.000Z' }], problems: [{ platform, problemKey: 'P1', title: 'Sample', nativeDifficulty: null, sourceUrl: 'https://qoj.ac/problem/1' }], nextCursor: stopReason === 'more' ? { version: 1, data: { page: 2 } } : null, nextCheckpoint: null, stopReason, coverage: 'visible', sourceUrl: 'https://qoj.ac/submissions', observedAt: '2026-10-02T00:00:00.000Z' };
}
function setup(platform: PlatformId) {
  const account: AccountRef = { platform, kind: 'person', handle: 'sample', externalId: null };
  const adapter: ReadConnector = { capabilities: { submissions: true, participations: 'none', teamEvidence: false }, resolveAccount: vi.fn(async () => account), fetchSubmissionPage: vi.fn(async () => page(platform, '1', 'history_end')) };
  vi.mocked(getConnector).mockReturnValue(adapter);
  const qoj = createQojReadWorker({ transport: 'node', connectionId: 'qoj-lab', signal: ctx.signal, nodeFactory: async () => ctx });
  return { adapter, qoj, runtime: { signal: ctx.signal, context: ctx, qoj, persist: false } };
}
beforeEach(() => vi.clearAllMocks());
describe('uniform platform reads', () => {
  it.each(['codeforces', 'luogu', 'qoj'] as const)('passes collection dates through the %s runtime and does not claim complete history', async platform => {
    const f = setup(platform);
    const range = { from: '2026-10-01T16:00:00.000Z', to: '2026-10-02T16:00:00.000Z' };
    const result = await readPlatform({ platform, target: 'sample', range }, f.runtime);
    expect(result).toMatchObject({ status: 'completed', historyComplete: false });
    expect(f.adapter.fetchSubmissionPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ range }), expect.anything());
    await f.qoj.close();
  });

  it.each(['codeforces', 'luogu', 'qoj'] as const)('returns the same result contract for %s', async platform => {
    const f = setup(platform);
    const result = await readPlatform({ platform, target: 'sample' }, f.runtime);
    expect(result).toMatchObject({ platform, account: { handle: 'sample' }, status: 'completed', batchStatus: 'complete', stopReason: 'history_end', historyComplete: true, error: null, progress: { pages: 1, rawRecordCount: 1, uniqueRecordCount: 1, problemCount: 1 }, continuation: { cursor: null, checkpoint: null } });
    expect(result.data.submissions).toHaveLength(1);
    expect(readOutcomeSummary(result)).not.toHaveProperty('data');
    expect(Object.keys(result).sort()).toEqual(['account', 'batchStatus', 'collector', 'continuation', 'coverage', 'data', 'error', 'historyComplete', 'platform', 'progress', 'runId', 'status', 'stopReason'].sort());
    await f.qoj.close();
  });
  it('records resolution errors before any page and does not leak exception text', async () => {
    const f = setup('luogu');
    vi.mocked(f.adapter.resolveAccount).mockRejectedValue(new ConnectorError('AUTH_REQUIRED', 'Cookie=never-store', { httpStatus: 401 }));
    const result = await readPlatform({ platform: 'luogu', target: 'sample' }, f.runtime);
    expect(result).toMatchObject({ account: null, status: 'auth_required', progress: { pages: 0 }, error: { code: 'AUTH_REQUIRED', httpStatus: 401, action: 'reauthenticate' } });
    expect(JSON.stringify(result)).not.toContain('never-store');
  });
  it('preserves the preceding page when a later page fails', async () => {
    const f = setup('codeforces');
    vi.mocked(f.adapter.fetchSubmissionPage).mockResolvedValueOnce(page('codeforces', '1', 'more')).mockRejectedValueOnce(new ConnectorError('HTTP_ERROR', '503', { httpStatus: 503 }));
    const result = await readPlatform({ platform: 'codeforces', target: 'sample', maxPages: 2 }, f.runtime);
    expect(result).toMatchObject({ status: 'failed', progress: { pages: 1 }, continuation: { cursor: { data: { page: 2 } } }, error: { code: 'HTTP_ERROR', action: 'retry' } });
    expect(result.data.submissions).toHaveLength(1);
  });
  it('does not advance diagnostic progress when the page sink fails', async () => {
    const f = setup('codeforces');
    const result = await readPlatform({ platform: 'codeforces', target: 'sample' }, { ...f.runtime, onPage: async () => { throw new Error('fixture sink failed'); } });
    expect(result).toMatchObject({ status: 'failed', progress: { pages: 0 }, continuation: { cursor: null } });
  });
  it('rejects unsupported capabilities instead of returning empty success', async () => {
    const f = setup('luogu');
    const result = await readPlatform({ platform: 'luogu', target: 'sample', withRating: true }, f.runtime);
    expect(result).toMatchObject({ status: 'failed', error: { code: 'NOT_IMPLEMENTED', action: 'unsupported' } });
    expect(luoguLogin.verifySession).not.toHaveBeenCalled();
  });
  it('treats a page limit as bounded success rather than completed history', async () => {
    const f = setup('qoj');
    vi.mocked(f.adapter.fetchSubmissionPage).mockResolvedValue(page('qoj', '1', 'more'));
    const result = await readPlatform({ platform: 'qoj', target: 'sample', maxPages: 1 }, f.runtime);
    expect(result).toMatchObject({ status: 'completed', batchStatus: 'page_limit', stopReason: 'more', historyComplete: false });
    await f.qoj.close();
  });
});
