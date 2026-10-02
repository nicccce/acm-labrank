import { luoguLogin } from '@acm/connectors/server';
import type { ConnectorCheckpoint, ConnectorCursor, RequestContext, SubmissionPage } from '@acm/connectors/contracts';
import { ConnectorError } from '@acm/connectors/contracts';
import { createLuoguRequestContext } from './session';
import { readAccount } from '../../collection/read-account';

/** Callable by Worker without leaking platform credentials into job payloads. */
export async function collectLuogu(options: {
  account: string; connectionId: string; mode: 'backfill' | 'incremental'; signal: AbortSignal;
  maxPages?: number; cursor?: ConnectorCursor | null; checkpoint?: ConnectorCheckpoint | null;
  maxDurationMs?: number;
  context?: RequestContext; onPage?: (page: SubmissionPage) => Promise<void>;
}) {
  if (!Number.isSafeInteger(options.maxPages ?? 2) || (options.maxPages ?? 2) < 1 || (options.maxPages ?? 2) > 100) throw new ConnectorError('INVALID_INPUT', '洛谷采集批次页数必须在 1–100 之间');
  const ctx = options.context ?? (await createLuoguRequestContext({ connectionId: options.connectionId, signal: options.signal })).ctx;
  const identity = await luoguLogin.verifySession(ctx);
  const result = await readAccount({ platform: 'luogu', handle: options.account, mode: options.mode, maxPages: options.maxPages ?? 2, maxDurationMs: options.maxDurationMs, cursor: options.cursor, checkpoint: options.checkpoint }, ctx, options.onPage);
  return { ...result, collector: identity, coverage: 'visible' as const };
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
