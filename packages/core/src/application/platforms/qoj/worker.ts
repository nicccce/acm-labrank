import { z } from 'zod';
import { ConnectorError, type ConnectorCheckpoint, type ConnectorCursor, type NormalizedSubmission, type NormalizedProblem, type RequestContext, type SubmissionPage } from '@acm/connectors/contracts';
import { qojLogin, qojResponseIssue } from '@acm/connectors/server';
import { createQojBrowserRequestContext } from './browser';
import { createQojRequestContext } from './session';
import { createAbortableLock } from '../../collection/abortable-lock';
import { collectQojSubmissionPages } from './collection';
import { AccountReadError } from '../../collection/read-account';
import { waitForQojBrowserAttach } from './browser-attach';

const state = z.object({ version: z.number().int(), data: z.unknown() });
export const qojReadJobSchema = z.object({
  target: z.string().min(1).max(100).regex(/^[^\s/?#\\]+$/),
  mode: z.enum(['backfill', 'incremental']).default('backfill'),
  maxPages: z.number().int().min(1).max(1000).default(2),
  maxDurationMs: z.number().int().min(1).max(900000).default(120000),
  cursor: state.nullable().optional(), checkpoint: state.nullable().optional(),
  operation: z.enum(['submissions', 'verify']).optional(),
}).strict();
export type QojReadJob = z.input<typeof qojReadJobSchema>;
export interface QojHumanInput {
  kind: 'cloudflare' | 'login'; url: string; signal: AbortSignal;
}
type BrowserRuntime = Awaited<ReturnType<typeof createQojBrowserRequestContext>>;
export interface QojWorkerOptions {
  transport: 'node' | 'browser';
  connectionId: string;
  signal: AbortSignal;
  browser?: Omit<Parameters<typeof createQojBrowserRequestContext>[0], 'signal' | 'connectionId'>;
  browserAttach?: { file: string; id: string };
  humanTimeoutMs?: number;
  humanRetries?: number;
  expectedLoginHandle?: string;
  onHumanInput?: (input: QojHumanInput, screenshot: (path: string) => Promise<void>) => Promise<boolean>;
  diagnostic?: (data: { path: string; status: number; finalUrl: string; observedAt: string; bodySource: 'response-html'; issue: string | null; headers: Record<string, string> }) => void;
  /** Inject a transport without making connectors aware of browser lifecycle. */
  browserFactory?: typeof createQojBrowserRequestContext;
  nodeFactory?: typeof createQojRequestContext;
}

/** One dedicated context per configured connection, reused across bounded Worker jobs. */
export function createQojReadWorker(options: QojWorkerOptions) {
  const acquire = createAbortableLock();
  const lifetime = new AbortController();
  const lifetimeSignal = AbortSignal.any([options.signal, lifetime.signal]);
  let runtime: BrowserRuntime | undefined;
  let closed = false;
  let attachmentConfirmed = false;
  let attachmentIdentityVerified = false;
  const humanTimeout = options.humanTimeoutMs ?? 120000;
  const humanRetries = options.humanRetries ?? 2;
  if (!Number.isInteger(humanTimeout) || humanTimeout < 1 || humanTimeout > 600000 || !Number.isInteger(humanRetries) || humanRetries < 0 || humanRetries > 5) throw new ConnectorError('INVALID_INPUT', 'Invalid QOJ human input limits');

  async function execute(input: QojReadJob, taskSignal: AbortSignal, onPage: (page: SubmissionPage) => Promise<void> = async () => undefined, generation?: number) {
    const job = qojReadJobSchema.parse(input);
    const started = Date.now();
    const budget = AbortSignal.timeout(job.maxDurationMs);
    const signal = AbortSignal.any([lifetimeSignal, taskSignal, budget]);
    let release: (() => void) | undefined;
    let cursor: ConnectorCursor | null = job.cursor ?? null;
    let checkpoint: ConnectorCheckpoint | null = job.checkpoint ?? null;
    let pages = 0;
    let humanAttempts = 0;
    let humanTimedOut = false;
    let collector: string | null = null;
    let rawRecordCount = 0;
    let account: Awaited<ReturnType<typeof collectQojSubmissionPages>>['account'] | null = null;
    let coverage: SubmissionPage['coverage'] | 'unknown' = 'unknown';
    let lastResponse: Parameters<NonNullable<QojWorkerOptions['diagnostic']>>[0] | undefined;
    const seen = new Set<string>();
    const submissions = new Map<string, NormalizedSubmission>();
    const problems = new Map<string, NormalizedProblem>();
    const verdicts: Record<string, number> = {};
    const progress = () => ({ account, collector, pages, rawRecordCount, coverage, cursor, checkpoint, uniqueSubmissions: seen.size, verdicts, submissions: [...submissions.values()], problems: [...problems.values()], lastResponse, historyComplete: false });
    try {
      // The task owns the session throughout manual interaction; HTTP leases are not held while waiting.
      release = await acquire(signal);
      if (closed) throw new ConnectorError('CANCELLED', 'QOJ Worker closed');
      if (options.transport === 'browser' && !runtime && options.browserAttach && !attachmentConfirmed) {
        await waitForQojBrowserAttach(options.browserAttach, signal);
        attachmentConfirmed = true;
      }
      if (options.transport === 'browser' && !runtime) runtime = await (options.browserFactory ?? createQojBrowserRequestContext)({ ...options.browser, keepBrowserSession: attachmentConfirmed, connectionId: options.connectionId, signal: lifetimeSignal });
      const raw = runtime?.scopedContext(signal, generation) ?? await (options.nodeFactory ?? createQojRequestContext)({ connectionId: options.connectionId, signal, timeoutMs: options.browser?.timeoutMs, maxRetries: options.browser?.maxRetries, memoryStore: options.browser?.memoryStore, expectedGeneration: generation });
      async function human(kind: QojHumanInput['kind'], url: URL, requestSignal: AbortSignal) {
        if (!runtime || options.browser?.headed === false || !options.onHumanInput || humanAttempts++ >= humanRetries) throw new ConnectorError(kind === 'login' && !runtime ? 'AUTH_REQUIRED' : 'CHALLENGE_REQUIRED', 'QOJ requires human input; committed progress retained');
        const controller = new AbortController();
        const waitingSignal = AbortSignal.any([requestSignal, controller.signal]);
        const timer = setTimeout(() => { humanTimedOut = true; controller.abort(new ConnectorError('TIMEOUT', 'QOJ human input timed out')); }, humanTimeout);
        try {
          const accepted = await new Promise<boolean>((resolve, reject) => {
            const cancel = () => reject(controller.signal.aborted ? controller.signal.reason : new ConnectorError('CANCELLED', 'QOJ human input cancelled'));
            waitingSignal.addEventListener('abort', cancel, { once: true });
            Promise.resolve().then(() => options.onHumanInput!({ kind, url: url.href, signal: waitingSignal }, runtime!.screenshot)).then(resolve, reject).finally(() => waitingSignal.removeEventListener('abort', cancel));
            if (waitingSignal.aborted) cancel();
          });
          if (!accepted) throw new ConnectorError('CHALLENGE_REQUIRED', 'QOJ human input not confirmed');
          waitingSignal.throwIfAborted();
        } finally { clearTimeout(timer); controller.abort(); }
      }
      const ctx: RequestContext = { ...raw, async request(url, init) {
        const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
        while (true) {
          requestSignal.throwIfAborted();
          const response = await raw.request(url, { ...init, signal: requestSignal });
          const issue = qojResponseIssue(response, await response.clone().text());
          const finalUrl = new URL(response.url || url);
          // Only known read parameters enter diagnostics; no tokens, headers, HTML or Cookie values.
          const safeUrl = new URL(finalUrl.pathname, finalUrl.origin);
          for (const name of ['submitter', 'page']) if (finalUrl.searchParams.has(name)) safeUrl.searchParams.set(name, finalUrl.searchParams.get(name)!);
          const headers: Record<string, string> = {};
          for (const name of ['content-type', 'retry-after', 'cf-mitigated', 'date']) {
            const value = response.headers.get(name);
            if (value) headers[name] = value;
          }
          lastResponse = { path: url.pathname, status: response.status, finalUrl: safeUrl.href, observedAt: new Date().toISOString(), bodySource: 'response-html', issue, headers };
          options.diagnostic?.(lastResponse);
          if (!issue) return response;
          await human(issue, url, requestSignal);
          // A confirmation is not proof of success: verify the actual logged-in identity,
          // then navigate to the original URL again. Parsing validates the target and rows.
          const identity = await qojLogin.verifySession({ ...ctx, signal: requestSignal, request: (target, requestInit) => ctx.request(target, { ...requestInit, signal: requestSignal }) });
          collector = identity;
          if (options.expectedLoginHandle && identity !== options.expectedLoginHandle) throw new ConnectorError('AUTH_REQUIRED', 'QOJ collecting identity mismatch');
        }
      } };
      if (attachmentConfirmed && !attachmentIdentityVerified) {
        const identity = await qojLogin.verifySession(ctx);
        collector = identity;
        if (options.expectedLoginHandle && identity !== options.expectedLoginHandle) throw new ConnectorError('AUTH_REQUIRED', 'QOJ collecting identity mismatch');
        attachmentIdentityVerified = true;
      }
      if (job.operation === 'verify') {
        collector = await qojLogin.verifySession(ctx);
        if (options.expectedLoginHandle && collector !== options.expectedLoginHandle) throw new ConnectorError('AUTH_REQUIRED', 'QOJ collecting identity mismatch');
      }
      const result = await collectQojSubmissionPages({ handle: job.target, mode: job.mode, maxPages: job.maxPages, maxDurationMs: Math.max(1, job.maxDurationMs - (Date.now() - started)), cursor, checkpoint }, ctx, async page => {
        signal.throwIfAborted();
        await onPage(page);
        pages++;
        rawRecordCount += page.submissions.length;
        coverage = page.coverage;
        cursor = page.nextCursor;
        checkpoint = page.nextCheckpoint ?? checkpoint;
        for (const row of page.submissions) submissions.set(row.externalSubmissionId, row);
        for (const problem of page.problems) problems.set(problem.problemKey, problem);
        for (const row of page.submissions) if (!seen.has(row.externalSubmissionId)) {
          seen.add(row.externalSubmissionId);
          verdicts[row.verdict] = (verdicts[row.verdict] ?? 0) + 1;
        }
      });
      account = result.account;
      return { ...progress(), status: budget.aborted && !taskSignal.aborted && !lifetimeSignal.aborted ? 'timeout' : result.batchStatus === 'cancelled' ? 'cancelled' : result.batchStatus === 'budget_exhausted' ? 'timeout' : 'completed', stopReason: result.stopReason, batchStatus: result.batchStatus, historyComplete: result.stopReason === 'history_end' };
    } catch (error) {
      const code = budget.aborted && !taskSignal.aborted && !lifetimeSignal.aborted ? 'TIMEOUT' : error instanceof ConnectorError ? error.code : signal.aborted ? 'CANCELLED' : 'API_ERROR';
      const status = code === 'CHALLENGE_REQUIRED' || humanTimedOut ? 'human_input_required' : code === 'AUTH_REQUIRED' ? 'auth_required' : code === 'FORBIDDEN' ? 'restricted' : code === 'PARSE_CHANGED' ? 'parse_changed' : code === 'TIMEOUT' ? 'timeout' : code === 'CANCELLED' ? 'cancelled' : 'failed';
      // AccountReadError carries only committed pages. Never advance an unsuccessful page.
      if (error instanceof AccountReadError) { account = error.progress.account; cursor = error.progress.cursor; checkpoint = error.progress.checkpoint; }
      return { ...progress(), status, code, httpStatus: error instanceof ConnectorError ? error.httpStatus : undefined, retryAt: error instanceof ConnectorError ? error.retryAt : undefined, stopReason: 'more' as const };
    } finally {
      // Stop late user navigation before handing this context to another task.
      if (release && (signal.aborted || humanAttempts > 0)) await runtime?.cancelPage();
      release?.();
    }
  }
  return { connectionId: options.connectionId, execute, async close() {
    closed = true;
    lifetime.abort();
    const release = await acquire(new AbortController().signal);
    try { await runtime?.close(); } finally { release(); }
  } };
}
