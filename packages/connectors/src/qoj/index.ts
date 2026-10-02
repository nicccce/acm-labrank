import { z } from 'zod';
import { ConnectorError, type ReadConnector, type SubmissionPage } from '../contracts/index';
import { getHtml, ORIGIN } from './http';
import { accountSchema, PARSER_VERSION, parseAccount, parseSubmissionHtml } from './parser';

const state = z.object({ account: z.string(), parser: z.literal(PARSER_VERSION), mode: z.enum(['backfill', 'incremental']), page: z.number().int().min(1), headId: z.string().regex(/^\d+$/).nullable(), anchor: z.string().regex(/^\d+$/).nullable(), crossedPage: z.number().int().min(1).nullable() });
const checkpoint = z.object({ account: z.string(), parser: z.literal(PARSER_VERSION), headId: z.string().regex(/^\d+$/).nullable() });
export const qojConnector: ReadConnector = {
  capabilities: { submissions: true, participations: 'none', teamEvidence: false },
  async resolveAccount(input, ctx) {
    if (!input || input.length > 100 || /[\s/?#\\]/.test(input)) throw new ConnectorError('ACCOUNT_NOT_FOUND', 'Invalid QOJ handle');
    return parseAccount(await getHtml(new URL(`/user/profile/${encodeURIComponent(input)}`, ORIGIN), ctx), input);
  },
  async fetchSubmissionPage(account, scan, ctx) {
    accountSchema.parse(account);
    if (account.kind !== 'person') throw new ConnectorError('NOT_IMPLEMENTED', 'QOJ team submissions are not supported');
    let anchor: string | null = null;
    if (scan.checkpoint) {
      const parsed = checkpoint.safeParse(scan.checkpoint.data);
      if (scan.checkpoint.version !== 1 || !parsed.success || parsed.data.account !== account.handle) throw new ConnectorError('INVALID_CURSOR', 'QOJ checkpoint is incompatible');
      anchor = parsed.data.headId;
    }
    let progress: z.infer<typeof state> = { account: account.handle, parser: PARSER_VERSION, mode: scan.mode, page: 1, headId: anchor, anchor, crossedPage: null };
    if (scan.cursor) {
      const parsed = state.safeParse(scan.cursor.data);
      if (scan.cursor.version !== 1 || !parsed.success || parsed.data.account !== account.handle || parsed.data.mode !== scan.mode || parsed.data.anchor !== anchor) throw new ConnectorError('INVALID_CURSOR', 'QOJ cursor does not match this scan');
      progress = parsed.data;
    }
    const makeUrl = (page: number) => {
      const url = new URL('/submissions', ORIGIN);
      url.searchParams.set('submitter', account.handle);
      if (page !== 1) url.searchParams.set('page', String(page));
      return url;
    };
    // Re-read the preceding page at every boundary; a resumed scan also overlaps.
    // Offset drift beyond one full page still requires a subsequent fresh incremental scan.
    const overlap = progress.page > 1 ? parseSubmissionHtml(await getHtml(makeUrl(progress.page - 1), ctx), account, progress.page - 1, new Date().toISOString()) : null;
    const url = makeUrl(progress.page);
    const html = await getHtml(url, ctx);
    const observedAt = new Date().toISOString();
    const current = parseSubmissionHtml(html, account, progress.page, observedAt);
    const submissions = [...new Map([...(overlap?.submissions ?? []), ...current.submissions].map(s => [s.externalSubmissionId, s])).values()];
    const problems = [...new Map([...(overlap?.problems ?? []), ...current.problems].map(p => [p.problemKey, p])).values()];
    for (const s of submissions) if (progress.headId === null || BigInt(s.externalSubmissionId) > BigInt(progress.headId)) progress.headId = s.externalSubmissionId;
    if (scan.mode === 'incremental' && anchor && current.submissions.some(s => BigInt(s.externalSubmissionId) <= BigInt(anchor))) progress.crossedPage ??= progress.page;
    const crossed = progress.crossedPage !== null && progress.page > progress.crossedPage && current.submissions.every(s => anchor !== null && BigInt(s.externalSubmissionId) <= BigInt(anchor));
    const stopReason = current.terminal ? 'history_end' : crossed ? 'checkpoint_reached' : 'more';
    const output: SubmissionPage = { submissions, problems, stopReason, coverage: 'visible', sourceUrl: url.href, observedAt,
      nextCursor: stopReason === 'more' ? { version: 1, data: { ...progress, page: progress.page + 1 } } : null,
      nextCheckpoint: stopReason === 'more' ? null : { version: 1, data: { account: account.handle, parser: PARSER_VERSION, headId: progress.headId } },
    };
    // Validate page framing as well as the individual records validated by the parser.
    z.object({ sourceUrl: z.url(), observedAt: z.iso.datetime(), coverage: z.enum(['visible', 'restricted']), stopReason: z.enum(['more', 'history_end', 'checkpoint_reached']) }).parse(output);
    return output;
  },
};
