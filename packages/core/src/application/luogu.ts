import { getConnector, luoguLogin } from '@acm/connectors/server';
import type { ConnectorCheckpoint, ConnectorCursor, RequestContext, SubmissionPage } from '@acm/connectors/contracts';
import { ConnectorError } from '@acm/connectors/contracts';
import { createLuoguRequestContext } from './luogu-session';

/** Callable by Worker without leaking platform credentials into job payloads. */
export async function collectLuogu(options: {
  account: string; connectionId: string; mode: 'backfill' | 'incremental'; signal: AbortSignal;
  maxPages?: number; cursor?: ConnectorCursor | null; checkpoint?: ConnectorCheckpoint | null;
  context?: RequestContext; onPage?: (page: SubmissionPage) => Promise<void>;
}) {
  if (!Number.isSafeInteger(options.maxPages ?? 2) || (options.maxPages ?? 2) < 1 || (options.maxPages ?? 2) > 100) throw new ConnectorError('INVALID_INPUT', '洛谷采集批次页数必须在 1–100 之间');
  const ctx = options.context ?? (await createLuoguRequestContext({ connectionId: options.connectionId, signal: options.signal })).ctx;
  const identity = await luoguLogin.verifySession(ctx);
  const connector = getConnector('luogu');
  const account = await connector.resolveAccount(options.account, ctx);
  let cursor = options.cursor ?? null;
  let checkpoint: ConnectorCheckpoint | null = null;
  let pages = 0;
  let stopReason: SubmissionPage['stopReason'] = 'more';
  const submissions = new Map<string, SubmissionPage['submissions'][number]>();
  const problems = new Map<string, SubmissionPage['problems'][number]>();
  for (; pages < (options.maxPages ?? 2);) {
    const page = await connector.fetchSubmissionPage(account, { mode: options.mode, cursor, checkpoint: options.checkpoint ?? null }, ctx);
    await options.onPage?.(page);
    for (const row of page.submissions) submissions.set(row.externalSubmissionId, row);
    for (const row of page.problems) problems.set(row.problemKey, row);
    cursor = page.nextCursor; checkpoint = page.nextCheckpoint; stopReason = page.stopReason; pages++;
    if (!cursor) break;
  }
  return { account, collector: identity, pages, submissions: [...submissions.values()], problems: [...problems.values()], cursor, checkpoint, stopReason, coverage: 'visible' as const };
}

export async function beginLuoguLogin(options: { username: string; connectionId: string; signal: AbortSignal; target: string }) {
  const session = await createLuoguRequestContext({ connectionId: options.connectionId, signal: options.signal, temporary: true });
  let challenge = await luoguLogin.beginLogin(options.username, session.ctx);
  return {
    getChallenge: () => ({ image: challenge.image, contentType: challenge.contentType, version: challenge.state.version, expiresAt: challenge.state.expiresAt }),
    async refresh(version: number) { challenge = await luoguLogin.refreshChallenge(challenge.state, version, session.ctx); },
    async complete(input: { version: number; password: string; captcha: string; expectedHandle: string }) {
      const identity = await luoguLogin.advanceLogin(challenge.state, input, session.ctx);
      const result = await collectLuogu({ account: options.target, connectionId: options.connectionId, mode: 'backfill', signal: options.signal, maxPages: 2, context: session.ctx });
      if (result.collector.uid !== identity.uid) throw new Error('SESSION_IDENTITY_CHANGED');
      await session.promote(identity.uid);
      return result;
    },
  };
}
