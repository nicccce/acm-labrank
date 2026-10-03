import { z } from 'zod';
import { getCollectionSettings, type CollectionSettings, type queryCoverage } from '@acm/db/server';
import { CF_BANDS, LUOGU_POINTS, SCORING_VERSION, dateRange } from '../../domain';
import { platformIds } from '@acm/connectors/metadata';
import { AppError } from '../errors';
const platforms = platformIds;
function pointsSql() {
  return `(CASE WHEN p.platform='codeforces' AND p.native_difficulty IS NOT NULL THEN CASE ${CF_BANDS.map(([boundary, points]) => `WHEN p.native_difficulty<${boundary} THEN ${points}`).join(' ')} ELSE 15 END WHEN p.platform='luogu' THEN CASE p.native_difficulty ${LUOGU_POINTS.map((points, i) => `WHEN ${i + 1} THEN ${points}`).join(' ')} ELSE 3 END ELSE 3 END)`;
}
export function parsePersonalQuery(params: URLSearchParams, now = new Date(), settings?: Pick<CollectionSettings, 'scoreRange' | 'platforms'>) {
  const parsed = z.object({ from: z.string().optional(), to: z.string().optional(), days: z.coerce.number().refine(n => n === 7 || n === 30).optional(), platform: z.enum(platforms).optional(), page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new AppError('INVALID_INPUT', '日期、平台或分页参数不合法', 400);
  if ((parsed.data.from && !parsed.data.to) || (!parsed.data.from && parsed.data.to) || (parsed.data.days && parsed.data.from)) throw new AppError('INVALID_INPUT', '自定义日期须同时提供 from、to，并与 days 二选一', 400);
  let range: ReturnType<typeof dateRange>;
  const defaults = settings?.scoreRange.kind === 'fixed' ? { from: settings.scoreRange.from, to: settings.scoreRange.to } : { days: settings?.scoreRange.kind === 'rolling' ? settings.scoreRange.days : 30 };
  try { range = dateRange(parsed.data.from || parsed.data.days ? parsed.data : defaults, now); } catch { throw new AppError('INVALID_INPUT', '日期无效或区间超过 366 天', 400); }
  const selected = settings?.platforms ?? [...platforms];
  return { range, page: parsed.data.page, query: { from: range.start, to: range.end, platforms: parsed.data.platform ? selected.filter(p => p === parsed.data.platform) : selected, limit: parsed.data.limit, offset: (parsed.data.page - 1) * parsed.data.limit, pointsSql: pointsSql() } };
}
export function queryMeta(parsed: ReturnType<typeof parsePersonalQuery>, coverage: Awaited<ReturnType<typeof queryCoverage>>) {
  return { ruleVersion: SCORING_VERSION, asOf: new Date().toISOString(), range: { from: parsed.range.from, to: parsed.range.to, timezone: parsed.range.timezone }, platforms: parsed.query.platforms, page: parsed.page, limit: parsed.query.limit, provisional: coverage.some(c => !c.historyComplete || c.coverage !== 'visible' || c.lastError), coverage };
}

export async function getScorePlatforms() { return (await getCollectionSettings()).platforms; }
