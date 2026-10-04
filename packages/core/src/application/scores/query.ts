import { z } from 'zod';
import { getCollectionSettings, type CollectionSettings, type queryCoverage } from '@acm/db/server';
import { CF_BANDS, DEFAULT_SCORING_RULES, SCORING_VERSION, dateRange, type ScoringRules, type ScoringSettings } from '../../domain';
import { scoringRulesSchema } from '../../domain/scoring-rules';
import { getScoringSettings } from '../scoring-settings';
import { platformIds } from '@acm/connectors/metadata';
import { AppError } from '../errors';
const platforms = platformIds;
export function pointsSql(input: ScoringRules = DEFAULT_SCORING_RULES) {
  // Validate before interpolating: only finite, bounded numbers can enter this SQL expression.
  const rules = scoringRulesSchema.parse(input), cf = rules.codeforces, lg = rules.luogu;
  const unknown = "p.native_difficulty IS NULL OR p.native_difficulty IN ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8)";
  return `(CASE WHEN p.platform='codeforces' THEN CASE WHEN ${unknown} THEN ${cf.unknownPoints} ${CF_BANDS.map(([boundary], i) => `WHEN p.native_difficulty<${boundary} THEN ${cf.points[i]}`).join(' ')} ELSE ${cf.points[CF_BANDS.length]} END WHEN p.platform='luogu' THEN CASE p.native_difficulty ${lg.points.map((points, i) => `WHEN ${i + 1} THEN ${points}`).join(' ')} ELSE ${lg.unknownPoints} END WHEN p.platform='qoj' THEN ${rules.qoj.points} ELSE 3 END)`;
}
export function parsePersonalQuery(params: URLSearchParams, now = new Date(), settings?: Pick<CollectionSettings, 'scoreRange' | 'platforms'>, scoring: ScoringSettings = { rules: DEFAULT_SCORING_RULES, version: 1 }) {
  const parsed = z.object({ from: z.string().optional(), to: z.string().optional(), days: z.coerce.number().refine(n => n === 7 || n === 30).optional(), platform: z.enum(platforms).optional(), page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new AppError('INVALID_INPUT', '日期、平台或分页参数不合法', 400);
  if ((parsed.data.from && !parsed.data.to) || (!parsed.data.from && parsed.data.to) || (parsed.data.days && parsed.data.from)) throw new AppError('INVALID_INPUT', '自定义日期须同时提供 from、to，并与 days 二选一', 400);
  let range: ReturnType<typeof dateRange>;
  const defaults = settings?.scoreRange.kind === 'fixed' ? { from: settings.scoreRange.from, to: settings.scoreRange.to } : { days: settings?.scoreRange.kind === 'rolling' ? settings.scoreRange.days : 30 };
  try { range = dateRange(parsed.data.from || parsed.data.days ? parsed.data : defaults, now); } catch { throw new AppError('INVALID_INPUT', '日期无效或区间超过 366 天', 400); }
  const selected = settings?.platforms ?? [...platforms];
  return { range, page: parsed.data.page, scoringVersion: scoring.version, query: { from: range.start, to: range.end, platforms: parsed.data.platform ? selected.filter(p => p === parsed.data.platform) : selected, limit: parsed.data.limit, offset: (parsed.data.page - 1) * parsed.data.limit, pointsSql: pointsSql(scoring.rules) } };
}
export async function loadScoreQuery(params: URLSearchParams) {
  const [settings, scoring] = await Promise.all([getCollectionSettings(), getScoringSettings()]);
  return parsePersonalQuery(params, new Date(), settings, scoring);
}
export function queryMeta(parsed: ReturnType<typeof parsePersonalQuery>, coverage: Awaited<ReturnType<typeof queryCoverage>>) {
  return { ruleVersion: `${SCORING_VERSION}.${parsed.scoringVersion}`, asOf: new Date().toISOString(), range: { from: parsed.range.from, to: parsed.range.to, timezone: parsed.range.timezone }, platforms: parsed.query.platforms, page: parsed.page, limit: parsed.query.limit, provisional: coverage.some(c => !c.historyComplete || c.coverage !== 'visible' || c.lastError), coverage };
}

export async function getScorePlatforms() { return (await getCollectionSettings()).platforms; }
