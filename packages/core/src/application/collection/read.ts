import { randomUUID } from 'node:crypto';
import { ConnectorError, type ConnectorErrorCode, type PlatformReadOutcome, type RequestContext, type SubmissionPage } from '@acm/connectors/contracts';
import { getConnector, luoguLogin } from '@acm/connectors/server';
import { createDirectReadRun, ensureCollectionConnection, finishReadRun, getReadRun, setCollectionConnectionFailure, startReadRun, verifyCollectionConnection, writeReadGeneration, writeReadProgress, type CollectionConnection } from '@acm/db/server';
import { createCodeforcesReadContext } from '../platforms/codeforces/read';
import { createLuoguRequestContext } from '../platforms/luogu/session';
import type { createQojReadWorker } from '../platforms/qoj/worker';
import { AccountReadError, readAccount, readCodeforcesContest } from './read-account';
import { parsePlatformReadRequest } from './contracts';
import { classifyReadFailure } from './errors';
import { holdConnectionTask } from './connection-task';

export interface ReadRuntimeOptions {
  signal: AbortSignal;
  qoj?: Pick<ReturnType<typeof createQojReadWorker>, 'execute' | 'connectionId'>;
  context?: RequestContext;
  onPage?: (page: SubmissionPage) => Promise<void>;
  runId?: string;
  job?: { id: string; queue: string };
  /** Explicit test/debug mode; API and deployed jobs always persist. */
  persist?: boolean;
}
export function readOutcomeSummary(outcome: PlatformReadOutcome): Omit<PlatformReadOutcome, 'data'> {
  const { data, ...summary } = outcome;
  void data;
  return summary;
}
export async function readPlatform(input: unknown, runtime: ReadRuntimeOptions): Promise<PlatformReadOutcome> {
  const request = parsePlatformReadRequest(input);
  const persist = runtime.persist !== false;
  if (runtime.runId && !persist) throw new ConnectorError('INVALID_INPUT', 'Persisted runs require durable execution');
  if (runtime.runId) {
    const recorded = await getReadRun(runtime.runId);
    if (!recorded || recorded.platform !== request.platform || JSON.stringify(parsePlatformReadRequest(recorded.input)) !== JSON.stringify(request)) throw new ConnectorError('INVALID_INPUT', 'Recorded read request mismatch');
  }
  const runId = runtime.runId ?? (persist ? await createDirectReadRun(request.platform, request.connectionId ?? null, request, runtime.job) : randomUUID());
  const outcome: PlatformReadOutcome = {
    runId, platform: request.platform, account: null, collector: null, status: 'completed', batchStatus: 'page_limit', stopReason: 'more', coverage: 'unknown', historyComplete: false,
    progress: { pages: 0, rawRecordCount: 0, uniqueRecordCount: 0, problemCount: 0 }, continuation: { cursor: request.cursor, checkpoint: request.checkpoint },
    data: { submissions: [], problems: [], profile: null, ratingHistory: null }, error: null,
  };
  let connection: CollectionConnection | undefined;
  let task: Awaited<ReturnType<typeof holdConnectionTask>> | undefined;
  let claimed = !persist;
  const budget = AbortSignal.timeout(request.maxDurationMs);
  let signal = AbortSignal.any([runtime.signal, budget]);
  const seen = new Set<string>();
  const problems = new Set<string>();
  try {
    if (persist) { claimed = await startReadRun(runId, null); if (!claimed) throw new ConnectorError('INVALID_INPUT', 'Read run is already claimed'); }
    if (persist && request.connectionId) connection = await ensureCollectionConnection(request.connectionId, request.platform);
    if (connection) {
      task = await holdConnectionTask(connection.id, signal);
      signal = task.signal;
      // Login/verification may have finished while this task waited for the connection lease.
      connection = await ensureCollectionConnection(connection.id, request.platform);
      await writeReadGeneration(runId, connection.generation);
      if (request.operation !== 'verify' && ['auth_required', 'human_input_required'].includes(connection.state)) throw new ConnectorError(connection.state === 'auth_required' ? 'AUTH_REQUIRED' : 'CHALLENGE_REQUIRED', 'Collecting connection is paused');
    }
    const onPage = async (page: SubmissionPage) => {
      signal.throwIfAborted();
      await runtime.onPage?.(page);
      const nextSeen = new Set(seen), nextProblems = new Set(problems);
      for (const row of page.submissions) nextSeen.add(row.externalSubmissionId);
      for (const row of page.problems) nextProblems.add(row.problemKey);
      const progress = { pages: outcome.progress.pages + 1, rawRecordCount: outcome.progress.rawRecordCount + page.submissions.length, uniqueRecordCount: nextSeen.size, problemCount: nextProblems.size };
      const continuation = { cursor: page.nextCursor, checkpoint: page.nextCheckpoint ?? outcome.continuation.checkpoint };
      if (persist) await writeReadProgress(runId, progress, continuation);
      for (const id of nextSeen) seen.add(id); for (const key of nextProblems) problems.add(key);
      outcome.progress = progress; outcome.continuation = continuation; outcome.coverage = page.coverage;
    };
    const connector = getConnector(request.platform);
    if ((request.withProfile && !connector.fetchProfile) || (request.withRating && !connector.fetchRatingHistory)) throw new ConnectorError('NOT_IMPLEMENTED', 'Unsupported optional capability');
    if (request.platform === 'qoj') {
      if (!['submissions', 'verify'].includes(request.operation) || request.pageSize !== undefined || request.contestId !== undefined) throw new ConnectorError('NOT_IMPLEMENTED', 'Unsupported QOJ read capability');
      if (!runtime.qoj) throw new ConnectorError('NOT_IMPLEMENTED', 'QOJ runtime is required');
      if (runtime.qoj.connectionId !== request.connectionId) throw new ConnectorError('INVALID_INPUT', 'QOJ runtime connection mismatch');
      const result = await runtime.qoj.execute({ target: request.target, operation: request.operation as 'submissions' | 'verify', mode: request.mode, cursor: request.cursor, checkpoint: request.checkpoint, maxPages: request.maxPages, maxDurationMs: request.maxDurationMs }, signal, onPage, connection?.generation);
      outcome.account = result.account;
      outcome.collector = result.collector;
      outcome.data.submissions = result.submissions; outcome.data.problems = result.problems;
      outcome.stopReason = result.stopReason;
      outcome.batchStatus = 'batchStatus' in result && result.batchStatus ? result.batchStatus : result.status === 'cancelled' ? 'cancelled' : result.status === 'timeout' ? 'budget_exhausted' : 'page_limit';
      if (result.status !== 'completed') {
        const classified = classifyReadFailure(new ConnectorError('code' in result ? result.code as ConnectorErrorCode : 'API_ERROR', 'QOJ read failed', { httpStatus: 'httpStatus' in result ? result.httpStatus : undefined, retryAt: 'retryAt' in result ? result.retryAt : undefined }), request.platform);
        outcome.status = classified.status; outcome.error = classified.error;
        if (result.status === 'human_input_required') { outcome.status = 'human_input_required'; outcome.error.action = 'human_verify'; }
      }
    } else {
      const rawCtx = runtime.context ?? (request.platform === 'luogu'
        ? (await createLuoguRequestContext({ connectionId: request.connectionId!, signal, expectedGeneration: connection?.generation })).ctx
        : createCodeforcesReadContext(signal));
      const ctx: RequestContext = { ...rawCtx, signal, request: (url, init) => rawCtx.request(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }) };
      if (request.platform === 'luogu') outcome.collector = (await luoguLogin.verifySession(ctx)).uid;
      if (!['submissions', 'verify'].includes(request.operation)) {
        if (request.platform !== 'codeforces') throw new ConnectorError('NOT_IMPLEMENTED', 'Unsupported platform auxiliary operation');
        outcome.data.auxiliary = await readCodeforcesContest({ operation: request.operation as 'contests' | 'standings' | 'problem', contestId: request.contestId, index: request.index }, ctx);
        outcome.batchStatus = 'complete';
      } else {
        const result = await readAccount({ ...request, handle: request.target }, ctx, onPage);
        outcome.account = result.account; outcome.data.submissions = result.submissions; outcome.data.problems = result.problems;
        outcome.data.profile = result.profile ?? null; outcome.data.ratingHistory = result.ratingHistory ?? null;
        outcome.batchStatus = result.batchStatus; outcome.stopReason = result.stopReason;
        if (result.batchStatus === 'cancelled') throw new ConnectorError('CANCELLED', 'Read cancelled');
        if (result.batchStatus === 'budget_exhausted') throw new ConnectorError('TIMEOUT', 'Read budget exhausted');
      }
    }
    signal.throwIfAborted();
    if (task) await task.check();
    if (connection && outcome.status === 'completed' && outcome.collector && (request.operation === 'verify' || connection.state !== 'ready')) {
      if (!await verifyCollectionConnection(connection.id, connection.generation, outcome.collector, task?.token)) throw new ConnectorError('LEASE_LOST', 'Connection changed before verification');
    }
  } catch (error) {
    if (!claimed) throw error;
    if (error instanceof AccountReadError) { outcome.account = error.progress.account; outcome.data.submissions = error.progress.submissions; outcome.data.problems = error.progress.problems; }
    const source = runtime.signal.aborted ? new ConnectorError('CANCELLED', 'Read cancelled') : task?.signal.reason instanceof ConnectorError ? task.signal.reason : budget.aborted ? new ConnectorError('TIMEOUT', 'Read budget exhausted') : error;
    Object.assign(outcome, classifyReadFailure(source, request.platform));
    if (outcome.status === 'cancelled') outcome.batchStatus = 'cancelled';
    if (outcome.status === 'timeout') outcome.batchStatus = 'budget_exhausted';
  } finally {
    try {
      if (connection && (outcome.status === 'auth_required' || outcome.status === 'human_input_required')) await setCollectionConnectionFailure(connection.id, connection.generation, outcome.status);
      outcome.historyComplete = request.operation === 'submissions' && outcome.status === 'completed' && outcome.stopReason === 'history_end';
      if (persist && claimed) await finishReadRun(runId, outcome, readOutcomeSummary(outcome));
    } finally { await task?.release(); }
  }
  return outcome;
}
