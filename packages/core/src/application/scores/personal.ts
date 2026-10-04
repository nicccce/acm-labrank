import { queryCoverage, queryLeaderboard, queryLeaderboardCount, queryMemberRecords, queryMemberRecordCount, queryMemberStats, queryMemberRank } from '@acm/db/server';
import { displayName } from '../../domain';
import { getMemberProfile, getMemberBindings } from '../members/profile';
import { loadScoreQuery, queryMeta } from './query';

export async function getPersonalLeaderboard(params: URLSearchParams) {
  const parsed = await loadScoreQuery(params);
  const [rows, coverage] = await Promise.all([queryLeaderboard(parsed.query), queryCoverage(parsed.query.platforms)]);
  return { ...queryMeta(parsed, coverage), total: rows[0]?.total ?? await queryLeaderboardCount(), items: rows.map(r => ({ id: r.id, displayName: displayName(r), points: r.points, solveCount: r.solveCount, platformSolveCounts: r.platformSolveCounts, lastAcAt: r.lastAcAt, rank: r.rank })) };
}
export async function getPersonalMember(id: string, params: URLSearchParams) {
  const member = await getMemberProfile(id), parsed = await loadScoreQuery(params);
  const [stats, coverage, rank, bindings] = await Promise.all([queryMemberStats(id, parsed.query), queryCoverage(parsed.query.platforms, id), queryMemberRank(id, parsed.query), getMemberBindings(id)]);
  const perPlatform = parsed.query.platforms.map(platform => stats.platforms.find(p => p.platform === platform) ?? { platform, points: 0, solveCount: 0, lastAcAt: null });
  return { ...queryMeta(parsed, coverage), member, rank, platformAccounts: bindings.items.filter(b => b.active).map(b => ({ platform: b.platform, ...b.active! })), points: perPlatform.reduce((n, p) => n + p.points, 0), solveCount: perPlatform.reduce((n, p) => n + p.solveCount, 0), submissionCount: stats.submissionCount, perPlatform, calendar: stats.calendar };
}
export async function getPersonalRecords(id: string, params: URLSearchParams, raw: boolean) {
  await getMemberProfile(id); const parsed = await loadScoreQuery(params);
  const [rows, coverage] = await Promise.all([queryMemberRecords(id, parsed.query, raw), queryCoverage(parsed.query.platforms, id)]);
  return { ...queryMeta(parsed, coverage), total: rows[0]?.total ?? await queryMemberRecordCount(id, parsed.query, raw), items: rows.map(row => { const { total, ...dto } = row; void total; return dto; }) };
}
