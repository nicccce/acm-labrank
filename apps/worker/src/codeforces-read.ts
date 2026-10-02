import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { closeDb, checkDatabaseReady } from '@acm/db/server';
import { AccountReadError, ConnectorError, createRequestContext, readAccount, readCodeforcesContest } from '@acm/core/reads';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
function numberArg(input: string | undefined, fallback: number): number {
  const value = input === undefined ? fallback : Number(input);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid numeric argument');
  return value;
}
async function stateFile(path: string | undefined) {
  return path ? JSON.parse(await readFile(path, 'utf8')) : null;
}
function maskedHandle(handle: string): string {
  return createHash('sha256').update(handle).digest('hex').slice(0, 12);
}
// Cursor JSON is resumable protocol state; publish it only to the caller, with handles redacted in logs.
function publicState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicState);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, key === 'handle' && typeof item === 'string' ? `sha256:${maskedHandle(item)}` : publicState(item)]));
  return value;
}
function restoreState(value: unknown, handle: string): unknown {
  if (!value || typeof value !== 'object') return value;
  // Accept only the exact matching redaction, never arbitrary account substitution.
  const state = value as { version?: number; data?: Record<string, unknown> };
  if (state.data?.handle === `sha256:${maskedHandle(handle)}`) return { ...state, data: { ...state.data, handle } };
  return value;
}
function validationPaths(error: unknown): unknown {
  let cause = error;
  for (let depth = 0; depth < 5 && cause && typeof cause === 'object'; depth++) {
    const typed = cause as { issues?: { path: (string | number)[]; code: string }[]; cause?: unknown };
    if (Array.isArray(typed.issues)) return typed.issues.slice(0, 8).map((issue) => ({ path: issue.path.join('.'), code: issue.code }));
    cause = typed.cause;
  }
}
try {
  const { values } = parseArgs({ options: {
    handle: { type: 'string' }, mode: { type: 'string', default: 'backfill' }, 'page-size': { type: 'string' },
    'max-pages': { type: 'string' }, 'budget-ms': { type: 'string' }, cursor: { type: 'string' }, checkpoint: { type: 'string' },
    'with-profile': { type: 'boolean' }, 'with-rating': { type: 'boolean' }, 'contest-id': { type: 'string' },
    operation: { type: 'string', default: 'submissions' }, index: { type: 'string' },
  } });
  if (!await checkDatabaseReady()) throw new Error('Database schema is not ready; run pnpm db:migrate');
  const ctx = createRequestContext({ platform: 'codeforces', signal: controller.signal });
  if (['standings', 'contests', 'problem'].includes(values.operation)) {
    const budget = AbortSignal.timeout(numberArg(values['budget-ms'], 120000));
    const auxCtx = { ...ctx, signal: AbortSignal.any([ctx.signal, budget]), request: (url: URL, init?: RequestInit) => ctx.request(url, { ...init, signal: budget }) };
    const data = await readCodeforcesContest({ operation: values.operation as 'standings' | 'contests' | 'problem', contestId: values['contest-id'], index: values.index }, auxCtx);
    console.log(JSON.stringify({ event: 'codeforces_auxiliary_read', operation: values.operation, count: Array.isArray(data) ? data.length : data && 'rows' in data ? data.rows.length : data ? 1 : 0,
      sample: Array.isArray(data) ? data.slice(0, 2) : data && 'contest' in data ? { contest: data.contest, problemCount: data.problems.length, coverage: data.coverage } : data }));
  } else {
    if (values.operation !== 'submissions' || !values.handle || !['backfill', 'incremental'].includes(values.mode)) throw new Error('Use --handle HANDLE --mode backfill|incremental');
    const cursor = restoreState(await stateFile(values.cursor), values.handle);
    const checkpoint = restoreState(await stateFile(values.checkpoint), values.handle);
    const data = await readAccount({
      platform: 'codeforces', handle: values.handle, mode: values.mode as 'backfill' | 'incremental',
      cursor: cursor as Parameters<typeof readAccount>[0]['cursor'], checkpoint: checkpoint as Parameters<typeof readAccount>[0]['checkpoint'],
      pageSize: values['page-size'] === undefined ? undefined : numberArg(values['page-size'], 100),
      maxPages: numberArg(values['max-pages'], 3), maxDurationMs: numberArg(values['budget-ms'], 120000),
      withProfile: values['with-profile'], withRating: values['with-rating'], contestId: values['contest-id'],
    }, ctx);
    console.log(JSON.stringify({
      event: 'codeforces_account_read', account: maskedHandle(data.account.handle), pages: data.pages,
      rawRecordCount: data.rawRecordCount, uniqueRecordCount: data.submissions.length, problemCount: data.problems.length,
      samples: data.submissions.slice(0, 2).map((row) => ({ id: row.externalSubmissionId, problemKey: row.problemKey,
        submittedAt: row.submittedAt, verdict: row.verdict, nativeVerdict: row.nativeVerdict, nativeScore: row.nativeScore,
        memberCount: row.subjectEvidence.authorMembers?.length, hasTeamId: row.subjectEvidence.teamId !== undefined,
        queriedAccountMatchesAuthor: row.subjectEvidence.queriedAccountMatchesAuthor,
        participantType: row.subjectEvidence.participantType, startedAt: row.subjectEvidence.startedAt,
        parserVersion: row.parserVersion, observedAt: row.observedAt })),
      profile: data.profile ? { rating: data.profile.rating, maxRating: data.profile.maxRating, rank: data.profile.rank } : undefined,
      ratingHistory: data.ratingHistory ? { coverage: data.ratingHistory.coverage, count: data.ratingHistory.changes.length } : undefined,
      batchStatus: data.batchStatus, stopReason: data.stopReason, cursor: publicState(data.cursor), checkpoint: publicState(data.checkpoint),
      persistenceImplemented: false,
    }));
    if (data.batchStatus === 'cancelled') process.exitCode = 130;
  }
} catch (error) {
  const typed = error as { code?: string; retryAt?: string; httpStatus?: number };
  console.error(JSON.stringify({ event: 'codeforces_read_failed', code: typed.code ?? 'READ_FAILED', retryAt: typed.retryAt, httpStatus: typed.httpStatus,
    message: error instanceof ConnectorError ? error.message : undefined, validation: validationPaths(error),
    progress: error instanceof AccountReadError ? { pages: error.progress.pages, rawRecordCount: error.progress.rawRecordCount,
      uniqueRecordCount: error.progress.submissions.length, cursor: publicState(error.progress.cursor), checkpoint: publicState(error.progress.checkpoint) } : undefined }));
  process.exitCode = 1;
} finally { await closeDb(); }
