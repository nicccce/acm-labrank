import { describe, expect, it, vi } from 'vitest';
import type { ConnectorCursor, RequestContext } from '@acm/connectors/contracts';
import { ConnectorError } from '@acm/connectors/contracts';
import { submissionFixture } from '../../../connectors/src/codeforces/fixtures';
import { AccountReadError, readAccount } from './read-account';

function context(ids: number[], signal = new AbortController().signal): RequestContext {
  return { signal, session: null, request: vi.fn(async (url: URL) => {
    const result = url.pathname.endsWith('user.info') ? [{ handle: 'ExampleUser' }] :
      ids.slice(Number(url.searchParams.get('from')) - 1, Number(url.searchParams.get('from')) - 1 + Number(url.searchParams.get('count'))).map((id) => submissionFixture(id));
    return new Response(JSON.stringify({ status: 'OK', result }), { headers: { 'content-type': 'application/json' } });
  }) };
}
const options = { platform: 'codeforces' as const, handle: 'ExampleUser', mode: 'backfill' as const, pageSize: 3, maxPages: 2 };
describe('account read orchestration', () => {
  it('deduplicates overlaps, returns resumable bounded progress, and finishes from that cursor', async () => {
    const ctx = context([10, 9, 8, 7, 6, 5]);
    const consume = vi.fn(async () => undefined);
    const first = await readAccount(options, ctx, consume);
    expect(first).toMatchObject({ pages: 2, rawRecordCount: 6, batchStatus: 'page_limit', stopReason: 'more', checkpoint: null });
    expect(first.submissions).toHaveLength(5);
    expect(consume).toHaveBeenCalledTimes(2);
    const resumed = await readAccount({ ...options, cursor: first.cursor }, ctx);
    expect(resumed).toMatchObject({ pages: 2, batchStatus: 'complete', stopReason: 'history_end', cursor: null });
  });

  it('cancellation preserves the last successfully consumed page and never publishes a new checkpoint', async () => {
    const controller = new AbortController();
    const data = await readAccount({ ...options, mode: 'incremental' }, context([10, 9, 8, 7], controller.signal), async () => { controller.abort(); });
    expect(data).toMatchObject({ pages: 1, batchStatus: 'cancelled', checkpoint: null, stopReason: 'more' });
    expect(data.cursor).not.toBeNull();
  });

  it('retains the prior cursor if parsing or the page consumer fails', async () => {
    let consumed: ConnectorCursor | null = null;
    let calls = 0;
    try {
      await readAccount(options, context([10, 9, 8, 7, 6, 5]), async (page) => {
        if (++calls === 2) throw new ConnectorError('PARSE_CHANGED', 'Fixture sink failed');
        consumed = page.nextCursor;
      });
      expect.fail('Expected consumer failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AccountReadError);
      expect(error).toMatchObject({ code: 'PARSE_CHANGED', progress: { pages: 1, cursor: consumed, checkpoint: null } });
    }
  });

  it('seeds a checkpoint only after an initial incremental scan completes and reuses it', async () => {
    const ctx = context([10, 9, 8, 7, 6, 5]);
    const first = await readAccount({ ...options, mode: 'incremental', maxPages: 10 }, ctx);
    expect(first.batchStatus).toBe('complete');
    expect(first.checkpoint).not.toBeNull();
    const second = await readAccount({ ...options, mode: 'incremental', maxPages: 10, checkpoint: first.checkpoint }, ctx);
    expect(second.stopReason).toBe('checkpoint_reached');
    expect(second.checkpoint).not.toBeNull();
  });
});
