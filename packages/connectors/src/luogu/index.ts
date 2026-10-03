import { z } from 'zod';
import { ConnectorError, rangeStartReached, filterSubmissionRange } from '../contracts/index';
import type { AccountRef, ReadConnector, RequestContext, SubmissionScan, SubmissionPage } from '../contracts/index';
import { accountSchema, idSchema, normalizeRecords, ORIGIN, PARSER_VERSION, parseContext, readResponse, userSchema, validated } from './parser';

const cursorSchema = z.object({ version: z.literal(1), data: z.object({
  parser: z.literal(PARSER_VERSION), uid: z.string(), mode: z.enum(['backfill', 'incremental']),
  page: z.number().int().min(2), count: z.number().int().nonnegative(), perPage: z.number().int().positive(),
  head: z.string().nullable(), previousOldest: z.string(), anchorSeen: z.boolean(), afterAnchorPages: z.number().int().nonnegative(),
}) });
const checkpointSchema = z.object({ version: z.literal(1), data: z.object({ parser: z.literal(PARSER_VERSION), uid: z.string(), head: z.string().nullable() }) });

async function card(input: string, ctx: RequestContext) {
  const url = new URL('/user/cardinfo', ORIGIN);
  url.searchParams.set('user', input);
  const data = await readResponse(await ctx.request(url, { headers: { Accept: 'application/json' } }));
  if (data.user === null) throw new ConnectorError('ACCOUNT_NOT_FOUND', '洛谷账号不存在');
  return validated(userSchema, data.user);
}

export async function resolveAccount(input: string, ctx: RequestContext): Promise<AccountRef> {
  const requested = input.trim();
  if (!requested || requested.length > 128 || [...requested].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new ConnectorError('INVALID_INPUT', '请输入洛谷用户名或正整数 UID');
  const numeric = /^\d+$/.test(requested);
  const query = numeric ? BigInt(requested).toString() : requested;
  if (numeric && !/^[1-9]\d*$/.test(query)) throw new ConnectorError('INVALID_INPUT', '洛谷 UID 必须为正整数');
  const user = await card(query, ctx);
  // cardinfo is an exact identity lookup, never select a fuzzy search's first row.
  if ((numeric && user.uid !== query) || (!numeric && user.name !== query)) throw new ConnectorError('ACCOUNT_AMBIGUOUS', '查询结果与请求账号不精确匹配');
  const url = new URL(`/user/${user.uid}`, ORIGIN);
  const profile = await readResponse(await ctx.request(url), 'user.show');
  const confirmed = validated(userSchema, profile.user);
  if (confirmed.uid !== user.uid || confirmed.name !== user.name) throw new ConnectorError('ACCOUNT_AMBIGUOUS', 'UID 对照资料与用户名查询不一致');
  return validated(accountSchema, { platform: 'luogu', kind: 'person', handle: confirmed.name, externalId: confirmed.uid });
}

async function recordPage(uid: string, page: number, ctx: RequestContext, observedAt: string) {
  const url = new URL('/record/list', ORIGIN);
  url.searchParams.set('user', uid); url.searchParams.set('page', String(page));
  // No status filter: fetch all native states. This is HTML with embedded JSON.
  const response = await ctx.request(url);
  const html = await response.clone().text();
  const data = await readResponse(response, 'record.list');
  if (html.trimStart().startsWith('<') && !parseContext(html, 'record.list').user) throw new ConnectorError('AUTH_REQUIRED', '提交页没有已登录的采集身份');
  return { ...normalizeRecords(data.records, uid, observedAt), url: url.toString() };
}

export async function fetchSubmissionPage(account: AccountRef, scan: SubmissionScan, ctx: RequestContext): Promise<SubmissionPage> {
  const target = validated(accountSchema, account);
  const uid = target.externalId;
  const cursor = scan.cursor ? validated(cursorSchema, scan.cursor).data : null;
  const checkpoint = scan.checkpoint ? validated(checkpointSchema, scan.checkpoint).data : null;
  if ((cursor && (cursor.uid !== uid || cursor.mode !== scan.mode)) || (checkpoint && checkpoint.uid !== uid)) throw new ConnectorError('INVALID_CURSOR', '游标所属目标或扫描模式不匹配');
  const page = cursor?.page ?? 1;
  const observedAt = new Date().toISOString();
  // Re-read one entire preceding page on resume; worker deduplicates by stable ID.
  const overlap = page > 1 ? await recordPage(uid, page - 1, ctx, observedAt) : null;
  const current = await recordPage(uid, page, ctx, observedAt);
  const { count, perPage, result } = current.records;
  if (cursor && (cursor.count !== count || cursor.perPage !== perPage || overlap?.records.count !== count)) throw new ConnectorError('PAGINATION_DRIFT', '分页总量或大小发生变化；保留已采集记录并从第一页重扫');
  if (!result.length && (page - 1) * perPage < count) throw new ConnectorError('PARSE_CHANGED', '非终止页没有记录，不能宣称历史完整');
  const submissions = [...new Map([...(overlap?.submissions ?? []), ...current.submissions].map(s => [s.externalSubmissionId, s])).values()];
  const problems = [...new Map([...(overlap?.problems ?? []), ...current.problems].map(p => [p.problemKey, p])).values()];
  if (cursor && !submissions.some(s => s.externalSubmissionId === cursor.previousOldest)) throw new ConnectorError('PAGINATION_DRIFT', '相邻页重叠锚点消失；需从第一页重扫');
  const head = cursor?.head ?? result[0]?.id ?? null;
  const sawAnchor = scan.mode === 'incremental' && checkpoint?.head !== null && checkpoint?.head !== undefined && current.submissions.some(s => s.externalSubmissionId === checkpoint.head);
  const anchorSeen = (cursor?.anchorSeen ?? false) || sawAnchor;
  const afterAnchorPages = cursor?.anchorSeen ? cursor.afterAnchorPages + 1 : 0;
  const checkpointReached = scan.mode === 'incremental' && anchorSeen && afterAnchorPages >= 2;
  const historyEnd = page * perPage >= count;
  const rangeReached = rangeStartReached(submissions, scan.range);
  if (historyEnd || checkpointReached || rangeReached) {
    // Prove the head/count stayed stable before advancing a durable checkpoint.
    const finalHead = page === 1 ? current : await recordPage(uid, 1, ctx, observedAt);
    if (finalHead.records.count !== count || finalHead.records.perPage !== perPage || (finalHead.records.result[0]?.id ?? null) !== head) throw new ConnectorError('PAGINATION_DRIFT', '扫描期间首页变化；不推进 checkpoint');
    return filterSubmissionRange({ submissions, problems, nextCursor: null, stopReason: rangeReached ? 'range_start' : checkpointReached ? 'checkpoint_reached' : 'history_end',
      nextCheckpoint: { version: 1, data: { parser: PARSER_VERSION, uid, head } }, coverage: 'visible', sourceUrl: current.url, observedAt }, scan.range);
  }
  return filterSubmissionRange({ submissions, problems, nextCursor: { version: 1, data: { parser: PARSER_VERSION, uid, mode: scan.mode, page: page + 1,
    count, perPage, head, previousOldest: result.at(-1)!.id, anchorSeen, afterAnchorPages } },
    nextCheckpoint: null, stopReason: 'more', coverage: 'visible', sourceUrl: current.url, observedAt }, scan.range);
}

/** Lists are coverage evidence only; no submission/first-AC dates are generated. */
export async function fetchPractice(account: AccountRef, ctx: RequestContext) {
  const target = validated(accountSchema, account);
  const url = new URL(`/user/${target.externalId}/practice`, ORIGIN);
  const data = await readResponse(await ctx.request(url), 'user.show');
  if (data.user) {
    const owner = validated(userSchema, data.user);
    if (owner.uid !== target.externalId) throw new ConnectorError('PARSE_CHANGED', 'practice 账号不匹配');
  }
  if (data.passed === undefined || data.submitted === undefined) throw new ConnectorError('PRIVACY_RESTRICTED', 'practice 题目列表不可见');
  const schema = z.array(z.object({ pid: z.string(), name: z.string(), difficulty: z.number().int().optional() }));
  return { passed: validated(schema, data.passed), triedButNotPassed: validated(schema, data.submitted), sourceUrl: url.toString(), parserVersion: PARSER_VERSION, observedAt: new Date().toISOString() };
}

export const luoguConnector: ReadConnector = { capabilities: { submissions: true, participations: 'none', teamEvidence: false }, resolveAccount, fetchSubmissionPage };
export { idSchema };
