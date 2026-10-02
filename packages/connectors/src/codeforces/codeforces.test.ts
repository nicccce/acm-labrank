import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountRef, ConnectorCheckpoint, ConnectorCursor, RequestContext, SubmissionScan } from '../contracts/index';
import { codeforcesConnector as connector, classifyFailure } from './index';
import { normalizeSubmission, normalizeVerdict, PARSER_VERSION, validated } from './parser';
import { submissionSchema } from './schemas';
import { submissionFixture } from './fixtures';

const account: AccountRef = { platform: 'codeforces', kind: 'person', handle: 'ExampleUser', externalId: null };
function context(result: unknown | ((url: URL) => unknown), status = 200): RequestContext {
  return {
    signal: new AbortController().signal, session: null,
    request: vi.fn(async (url: URL) => new Response(JSON.stringify(typeof result === 'function' ? result(url) : result), { status, headers: { 'content-type': 'application/json' } })),
  };
}
function listContext(ids: number[]) {
  return context((url: URL) => {
    const from = Number(url.searchParams.get('from'));
    const count = Number(url.searchParams.get('count'));
    return { status: 'OK', result: ids.slice(from - 1, from - 1 + count).map((id) => submissionFixture(id)) };
  });
}
const start = (mode: SubmissionScan['mode'] = 'backfill', checkpoint: ConnectorCheckpoint | null = null): SubmissionScan => ({ mode, cursor: null, checkpoint, pageSize: 3 });
afterEach(() => vi.useRealTimers());

describe('Codeforces fixtures and evidence', () => {
  it.each([
    ['OK', 'accepted'], ['TESTING', 'pending'], ['SUBMITTED', 'pending'], ['PARTIAL', 'rejected'],
    ['FAILED', 'rejected'], ['COMPILATION_ERROR', 'rejected'], ['RUNTIME_ERROR', 'rejected'], ['WRONG_ANSWER', 'rejected'],
    ['TIME_LIMIT_EXCEEDED', 'rejected'], ['MEMORY_LIMIT_EXCEEDED', 'rejected'], ['IDLENESS_LIMIT_EXCEEDED', 'rejected'],
    ['SECURITY_VIOLATED', 'rejected'], ['CRASHED', 'rejected'], ['INPUT_PREPARATION_CRASHED', 'rejected'],
    ['CHALLENGED', 'rejected'], ['SKIPPED', 'rejected'], ['REJECTED', 'rejected'], ['NEW_VERDICT', 'unknown'], [undefined, 'unknown'],
  ])('maps %s to %s', (input, expected) => expect(normalizeVerdict(input)).toBe(expected));

  it('resolves canonical and historic handles without inventing a UID or leaking contact fields', async () => {
    const ctx = context({ status: 'OK', result: [{ handle: 'ExampleUser', email: 'private@example.invalid' }] });
    const result = await connector.resolveAccount('OldHandle', ctx);
    expect(result).toEqual({ ...account, resolutionEvidence: { requestedHandle: 'OldHandle', historicHandlesChecked: true } });
    expect(vi.mocked(ctx.request).mock.calls[0]![0].searchParams.get('checkHistoricHandles')).toBe('true');
    expect(JSON.stringify(result)).not.toContain('email');
  });

  it('preserves team VP evidence, IDs, points, UTC and stable problem keys without assigning a person', () => {
    const raw = validated(submissionSchema, submissionFixture(100, {
      points: 37.5, source: 'must not be retained', author: {
        members: [{ handle: 'ExampleUser' }, { handle: 'AnotherMember' }], teamId: 77,
        teamName: 'Fixture team', participantType: 'VIRTUAL', startTimeSeconds: 1700000000, ghost: false,
      },
    }));
    const record = normalizeSubmission(raw, 'https://codeforces.com/api/user.status', '2026-10-01T00:00:00.000Z');
    expect(record).toMatchObject({ externalSubmissionId: '100', problemKey: '566:A', nativeScore: 37.5, nativeVerdict: 'OK',
      subjectEvidence: { authorAccountKeys: ['ExampleUser', 'AnotherMember'], teamId: '77', participantType: 'VIRTUAL', startedAt: '2023-11-14T22:13:20.000Z' } });
    expect(record).not.toHaveProperty('personId');
    expect(record).not.toHaveProperty('participationId');
    expect(JSON.stringify(record)).not.toContain('must not be retained');
  });

  it('keeps solo VP independent of team evidence and does not derive a start time from relative time', () => {
    const raw = validated(submissionSchema, submissionFixture(100, { verdict: undefined,
      author: { members: [{ handle: 'ExampleUser' }], participantType: 'VIRTUAL' },
      problem: { index: '42', name: 'Duplicate title', problemsetName: 'acmsguru', type: 'PROGRAMMING', tags: [] },
    }));
    const record = normalizeSubmission(raw, 'https://codeforces.com/api/user.status', '2026-10-01T00:00:00.000Z');
    expect(record).toMatchObject({ problemKey: null, verdict: 'unknown', nativeVerdict: null });
    expect(record.subjectEvidence.startedAt).toBeUndefined();
    expect(record.subjectEvidence.teamId).toBeUndefined();
    expect(record.nativeScore).toBeUndefined();
  });

  it('retains the returned author independently of the query handle and reports the mismatch as evidence', async () => {
    const page = await connector.fetchSubmissionPage(account, start(), context({ status: 'OK', result: [submissionFixture(100,
      { author: { members: [{ handle: 'HistoricOrDifferentAuthor' }], participantType: 'PRACTICE' } })] }));
    expect(page.submissions[0]!.subjectEvidence).toMatchObject({ authorAccountKeys: ['HistoricOrDifferentAuthor'], queriedAccountMatchesAuthor: false });
    expect(page.submissions[0]).not.toHaveProperty('personId');
  });

  it('reads only rated history and a selected profile DTO', async () => {
    const profile = await connector.fetchProfile!(account, context({ status: 'OK', result: [{ handle: account.handle, rating: 1800, email: 'hidden' }] }));
    expect(profile.rating).toBe(1800);
    expect(profile).not.toHaveProperty('email');
    const ratings = await connector.fetchRatingHistory!(account, context({ status: 'OK', result: [{ contestId: 566, contestName: 'Fixture contest', handle: account.handle, rank: 10, oldRating: 1700, newRating: 1800, ratingUpdateTimeSeconds: 1700000000 }] }));
    expect(ratings).toMatchObject({ coverage: 'rated_contests_only', changes: [{ contestId: '566', updatedAt: '2023-11-14T22:13:20.000Z' }] });
  });

  it('requests regular standings with only contestId, returns null for an unofficial rank and allows targeted difficulty lookup', async () => {
    const ctx = context({ status: 'OK', result: {
      contest: { id: 566, name: 'Fixture contest', type: 'CF', phase: 'FINISHED', durationSeconds: 7200 },
      problems: [submissionFixture().problem], rows: [{ party: { members: [{ handle: account.handle }], participantType: 'VIRTUAL' }, rank: 10, points: 500, penalty: 0 }],
    } });
    const standings = await connector.fetchStandings!('566', ctx);
    expect(standings.rows[0]!.rank).toBeNull();
    expect([...vi.mocked(ctx.request).mock.calls[0]![0].searchParams.keys()]).toEqual(['contestId']);
    expect(await connector.fetchProblem!('566', 'A', ctx)).toMatchObject({ nativeDifficulty: 1200 });
    await expect(connector.fetchStandings!('100001', ctx)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('scopes contest submissions independently and rejects a response from a different contest', async () => {
    const ctx = listContext([100, 99, 98]);
    const page = await connector.fetchContestSubmissionPage!(account, '566', start(), ctx);
    expect(page.nextCursor).toMatchObject({ data: { scope: 'contest:566' } });
    const [url] = vi.mocked(ctx.request).mock.calls[0]!;
    expect(url.pathname).toBe('/api/contest.status');
    expect(url.searchParams.get('handle')).toBe(account.handle);
    expect(url.searchParams.get('contestId')).toBe('566');
    await expect(connector.fetchContestSubmissionPage!(account, '567', start(), ctx)).rejects.toMatchObject({ code: 'PARSE_CHANGED' });
  });

  it('normalizes the explicitly requested regular contest list', async () => {
    const ctx = context({ status: 'OK', result: [{ id: 566, name: 'Fixture contest', type: 'CF', phase: 'FINISHED', durationSeconds: 7200, startTimeSeconds: 1700000000 }] });
    const contests = await connector.fetchContests!(ctx);
    expect(contests[0]).toMatchObject({ externalContestId: '566', startedAt: '2023-11-14T22:13:20.000Z' });
    expect(vi.mocked(ctx.request).mock.calls[0]![0].searchParams.get('gym')).toBe('false');
  });
});

describe('Codeforces pagination', () => {
  it('reads overlapping pages, confirms a short tail with an empty page, and never asks for sources', async () => {
    const ctx = listContext([10, 9, 8, 7, 6, 5]);
    let scan = start();
    const seen: string[] = [];
    const sizes: number[] = [];
    let reason = 'more';
    for (let index = 0; index < 10 && reason === 'more'; index++) {
      const page = await connector.fetchSubmissionPage(account, scan, ctx);
      seen.push(...page.submissions.map((row) => row.externalSubmissionId));
      sizes.push(page.submissions.length);
      reason = page.stopReason;
      expect(page.nextCheckpoint).toBeNull();
      scan = { ...scan, cursor: page.nextCursor };
    }
    expect([...new Set(seen)]).toEqual(['10', '9', '8', '7', '6', '5']);
    expect(sizes).toEqual([3, 3, 2, 0]);
    expect(reason).toBe('history_end');
    for (const [url] of vi.mocked(ctx.request).mock.calls) expect(url.searchParams.has('includeSources')).toBe(false);
  });

  it.each(['insert', 'delete', 'remove-boundary'])('recovers %s offset drift by re-reading from the head', async (change) => {
    let ids = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const ctx = context((url: URL) => ({ status: 'OK', result: ids.slice(Number(url.searchParams.get('from')) - 1,
      Number(url.searchParams.get('from')) - 1 + Number(url.searchParams.get('count'))).map((id) => submissionFixture(id)) }));
    const first = await connector.fetchSubmissionPage(account, start(), ctx);
    ids = change === 'insert' ? [14, 13, 12, 11, ...ids] : change === 'delete' ? ids.slice(2) : ids.filter((id) => id !== 8);
    let scan = { ...start(), cursor: first.nextCursor };
    const seen = new Set<string>();
    for (let index = 0; index < 30; index++) {
      const page = await connector.fetchSubmissionPage(account, scan, ctx);
      for (const row of page.submissions) seen.add(row.externalSubmissionId);
      if (page.stopReason === 'history_end') break;
      scan = { ...scan, cursor: page.nextCursor };
    }
    expect(ids.filter((id) => id < 8).every((id) => seen.has(String(id)))).toBe(true);
    expect(vi.mocked(ctx.request).mock.calls.slice(1).some(([url]) => url.searchParams.get('from') === '1')).toBe(true);
  });

  it('does not stop at one old ID and only publishes a checkpoint after crossing two old pages', async () => {
    const checkpoint: ConnectorCheckpoint = { version: 1, data: { handle: account.handle, scope: 'user', parserVersion: PARSER_VERSION, highWaterId: '90', startedAt: '2026-10-01T00:00:00.000Z' } };
    const rows = [100, 99, 90, 89, 88, 87, 86, 85, 84].map((id) => submissionFixture(id, { creationTimeSeconds: id >= 88 ? 1790726400 : 1700000000, verdict: id === 89 ? 'WRONG_ANSWER' : 'OK' }));
    const ctx = context((url: URL) => ({ status: 'OK', result: rows.slice(Number(url.searchParams.get('from')) - 1, Number(url.searchParams.get('from')) - 1 + 3) }));
    let scan = start('incremental', checkpoint);
    let last;
    const seen: string[] = [];
    for (let index = 0; index < 10; index++) {
      last = await connector.fetchSubmissionPage(account, scan, ctx);
      seen.push(...last.submissions.map((row) => row.externalSubmissionId));
      if (last.stopReason !== 'more') break;
      expect(last.nextCheckpoint).toBeNull();
      scan = { ...scan, cursor: last.nextCursor };
    }
    expect(seen).toContain('89');
    expect(last!.stopReason).toBe('checkpoint_reached');
    expect(last!.nextCheckpoint).toMatchObject({ version: 1, data: { highWaterId: '100' } });
  });

  it('treats an empty visible history as success and seeds an incremental checkpoint', async () => {
    const page = await connector.fetchSubmissionPage(account, start('incremental'), listContext([]));
    expect(page).toMatchObject({ submissions: [], stopReason: 'history_end', nextCursor: null, nextCheckpoint: { version: 1 } });
  });

  it('rejects incompatible version, account, mode and scope rather than trusting arbitrary offsets', async () => {
    const ctx = listContext([10, 9, 8]);
    const page = await connector.fetchSubmissionPage(account, start(), ctx);
    const cursor = page.nextCursor as ConnectorCursor;
    await expect(connector.fetchSubmissionPage(account, { ...start(), cursor: { ...cursor, version: 2 } }, ctx)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(connector.fetchSubmissionPage({ ...account, handle: 'AnotherMember' }, { ...start(), cursor }, ctx)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(connector.fetchSubmissionPage(account, { ...start('incremental'), cursor }, ctx)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(connector.fetchContestSubmissionPage!(account, '566', { ...start(), cursor }, ctx)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
});

describe('Codeforces errors', () => {
  it.each([
    ['handles: User with handle unknown not found', 'ACCOUNT_NOT_FOUND'], ['Call limit exceeded', 'RATE_LIMITED'],
    ['Invalid API key', 'AUTH_REQUIRED'], ['Access denied', 'FORBIDDEN'], ['Some new failure', 'API_ERROR'],
    ['user.status: Contest not found', 'API_ERROR'], ['You do not have rights to view this contest', 'FORBIDDEN'],
  ])('classifies %s', (comment, code) => expect(classifyFailure(comment).code).toBe(code));
  it.each([[401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED'], [500, 'HTTP_ERROR']])('classifies HTTP %s', async (status, code) => {
    await expect(connector.resolveAccount(account.handle, context({}, status))).rejects.toMatchObject({ code, httpStatus: status });
  });
  it('rejects HTML, absent results, unsafe numeric IDs and missing required structure', async () => {
    const html = context({});
    html.request = async () => new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } });
    await expect(connector.resolveAccount(account.handle, html)).rejects.toMatchObject({ code: 'PARSE_CHANGED' });
    for (const body of [{ status: 'OK' }, { status: 'OK', result: [submissionFixture(Number.MAX_SAFE_INTEGER + 1)] }, { status: 'OK', result: [{}] }]) {
      await expect(connector.fetchSubmissionPage(account, start(), context(body))).rejects.toMatchObject({ code: 'PARSE_CHANGED' });
    }
  });
  it('shares API-level throttling and retries at most twice', async () => {
    vi.useFakeTimers();
    const ctx = context({ status: 'FAILED', comment: 'Call limit exceeded' });
    ctx.deferUntil = vi.fn(async () => undefined);
    const check = expect(connector.resolveAccount(account.handle, ctx)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAt: expect.any(String) });
    await vi.advanceTimersByTimeAsync(10000);
    await check;
    expect(ctx.request).toHaveBeenCalledTimes(3);
    expect(ctx.deferUntil).toHaveBeenCalledTimes(3);
  });
});
