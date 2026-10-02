import { getConnector } from '@acm/connectors/server';
import { ConnectorError, type AccountRef, type ConnectorCheckpoint, type ConnectorCursor, type NormalizedProblem, type NormalizedSubmission, type PlatformId, type RequestContext, type SubmissionPage } from '@acm/connectors/contracts';

export interface ReadAccountOptions {
  platform: PlatformId;
  handle: string;
  mode: 'backfill' | 'incremental';
  cursor?: ConnectorCursor | null;
  checkpoint?: ConnectorCheckpoint | null;
  pageSize?: number;
  maxPages?: number;
  maxDurationMs?: number;
}
export interface AccountReadResult {
  account: AccountRef;
  pages: number;
  rawRecordCount: number;
  submissions: NormalizedSubmission[];
  problems: NormalizedProblem[];
  cursor: ConnectorCursor | null;
  checkpoint: ConnectorCheckpoint | null;
  stopReason: SubmissionPage['stopReason'];
  batchStatus: 'complete' | 'page_limit' | 'budget_exhausted' | 'cancelled';
}

export class AccountReadError extends ConnectorError {
  constructor(error: unknown, public readonly progress: AccountReadResult) {
    const source = error instanceof ConnectorError ? error : new ConnectorError('API_ERROR', 'Account page consumer failed', { cause: error });
    super(source.code, source.message, { cause: error, retryAt: source.retryAt, httpStatus: source.httpStatus });
  }
}

/** A read-only batch. onPage is the future transaction boundary for a persistence use case. */
export async function readAccount(options: ReadAccountOptions, ctx: RequestContext, onPage?: (page: SubmissionPage) => Promise<void>): Promise<AccountReadResult> {
  const maxPages = options.maxPages ?? 3;
  const maxDurationMs = options.maxDurationMs ?? 120000;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000 || !Number.isInteger(maxDurationMs) || maxDurationMs < 1) {
    throw new ConnectorError('INVALID_INPUT', 'Invalid account-read batch limits');
  }
  const deadline = Date.now() + maxDurationMs;
  const budgetSignal = AbortSignal.timeout(maxDurationMs);
  const signal = AbortSignal.any([ctx.signal, budgetSignal]);
  const batchCtx: RequestContext = {
    ...ctx, signal,
    request: (url, init) => ctx.request(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }),
  };
  const connector = getConnector(options.platform);
  const account = await connector.resolveAccount(options.handle, batchCtx);
  const result: AccountReadResult = {
    account, pages: 0, rawRecordCount: 0, submissions: [], problems: [], cursor: options.cursor ?? null,
    checkpoint: options.checkpoint ?? null, stopReason: 'more', batchStatus: 'page_limit',
  };
  const submissions = new Map<string, NormalizedSubmission>();
  const problems = new Map<string, NormalizedProblem>();
  try {
    while (result.pages < maxPages) {
      if (Date.now() >= deadline) { result.batchStatus = 'budget_exhausted'; break; }
      signal.throwIfAborted();
      const scan = { mode: options.mode, cursor: result.cursor, checkpoint: options.checkpoint ?? null, pageSize: options.pageSize };
      const page = await connector.fetchSubmissionPage(account, scan, batchCtx);
      signal.throwIfAborted();
      await onPage?.(page);
      // Only publish progress once the page consumer succeeds.
      result.pages++;
      result.rawRecordCount += page.submissions.length;
      for (const row of page.submissions) submissions.set(row.externalSubmissionId, row);
      for (const row of page.problems) problems.set(row.problemKey, row);
      result.cursor = page.nextCursor;
      result.stopReason = page.stopReason;
      if (page.nextCheckpoint) result.checkpoint = page.nextCheckpoint;
      if (page.stopReason !== 'more') { result.batchStatus = 'complete'; break; }
    }
  } catch (error) {
    if (!signal.aborted) {
      result.submissions = [...submissions.values()];
      result.problems = [...problems.values()];
      throw new AccountReadError(error, result);
    }
    result.batchStatus = ctx.signal.aborted ? 'cancelled' : 'budget_exhausted';
  }
  result.submissions = [...submissions.values()];
  result.problems = [...problems.values()];
  return result;
}
