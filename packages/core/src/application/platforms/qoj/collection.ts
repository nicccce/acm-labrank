import type { ConnectorCheckpoint, ConnectorCursor, RequestContext, SubmissionPage } from '@acm/connectors/contracts';
import { readAccount } from '../../collection/read-account';
export { qojLogin } from '@acm/connectors/server';
export { ConnectorError } from '@acm/connectors/contracts';
export type { ConnectorCheckpoint, ConnectorCursor } from '@acm/connectors/contracts';
export { createQojMemoryStore } from './memory-store';

export async function collectQojSubmissionPages(input: { handle: string; mode: 'backfill' | 'incremental'; cursor?: ConnectorCursor | null; checkpoint?: ConnectorCheckpoint | null; maxPages: number; maxDurationMs?: number }, ctx: RequestContext, commitPage: (page: SubmissionPage) => Promise<void>) {
  let coverage: SubmissionPage['coverage'] = 'visible';
  const result = await readAccount({ ...input, platform: 'qoj' }, ctx, async page => {
    await commitPage(page);
    coverage = page.coverage;
  });
  return { ...result, nextCheckpoint: result.stopReason === 'more' ? null : result.checkpoint, coverage };
}
