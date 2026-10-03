import { z } from 'zod';
import { archiveTeamRecord, createTeamRecord, getCollectionSettings, getTeamMembers, getTeamMembersBatch, getTeamRecord, leaveTeamRecord, listTeamRecords, queryCoverage, queryTeamContributions, queryTeamLeaderboard, queryTeamLeaderboardCount, queryTeamScore, searchMembers, TeamStateError, updateTeamRecord } from '@acm/db/server';
import { displayName } from '../domain';
import { AppError } from './errors';
import { parsePersonalQuery, queryMeta } from './scores/query';

const id = z.uuid().transform(v => v.toLowerCase());
export const createTeamSchema = z.object({ name: z.string().trim().min(1).max(64), memberIds: z.array(id).min(2).max(3) }).strict();
const updateTeamSchema = createTeamSchema.extend({ ownerId: id, version: z.number().int().positive() }).strict();
const versionSchema = z.object({ version: z.number().int().positive() }).strict();
function validId(value: string) {
  const parsed = id.safeParse(value); if (!parsed.success) throw new AppError('INVALID_INPUT', '队伍 ID 不合法', 400); return parsed.data;
}
function validateRoster(ids: string[], ownerId: string) {
  if (new Set(ids).size !== ids.length) throw new AppError('INVALID_INPUT', '不能重复选择成员', 400);
  if (!ids.includes(ownerId)) throw new AppError('INVALID_INPUT', '负责人必须是队伍成员', 400);
}
async function call<T>(fn: () => Promise<T>) {
  try { return await fn(); } catch (error) {
    if (!(error instanceof TeamStateError)) throw error;
    const messages: Record<string, string> = { INVALID_MEMBERS: '成员不存在或已停用', TEAM_NOT_FOUND: '队伍不存在', TEAM_FORBIDDEN: '无权操作该队伍', TEAM_STALE: '队伍已变化，请刷新', TEAM_ARCHIVED: '队伍已归档', TEAM_DUPLICATE: '已存在相同成员的队伍', TEAM_OWNER_EXIT: '请先转移负责人或归档队伍' };
    throw new AppError(error.code, messages[error.code] ?? '队伍操作失败', error.code === 'TEAM_NOT_FOUND' ? 404 : error.code === 'TEAM_FORBIDDEN' ? 403 : error.code === 'INVALID_MEMBERS' ? 400 : 409, undefined, error.teamId);
  }
}
export async function createTeam(actorId: string, input: unknown) {
  const parsed = createTeamSchema.safeParse(input); if (!parsed.success) throw new AppError('INVALID_INPUT', '请输入队名并选择 2—3 位不重复的成员', 400);
  validateRoster(parsed.data.memberIds, actorId);
  return call(() => createTeamRecord(actorId, parsed.data.name, parsed.data.memberIds));
}
export async function updateTeam(teamId: string, actorId: string, input: unknown) {
  const parsed = updateTeamSchema.safeParse(input); if (!parsed.success) throw new AppError('INVALID_INPUT', '队伍资料或版本不合法', 400);
  validateRoster(parsed.data.memberIds, parsed.data.ownerId);
  return call(() => updateTeamRecord(validId(teamId), actorId, parsed.data));
}
export async function archiveTeam(teamId: string, actorId: string, input: unknown) {
  const parsed = versionSchema.safeParse(input); if (!parsed.success) throw new AppError('INVALID_INPUT', '队伍版本不合法', 400);
  return call(() => archiveTeamRecord(validId(teamId), actorId, parsed.data.version));
}
export async function leaveTeam(teamId: string, actorId: string, input: unknown) {
  const parsed = versionSchema.safeParse(input); if (!parsed.success) throw new AppError('INVALID_INPUT', '队伍版本不合法', 400);
  return call(() => leaveTeamRecord(validId(teamId), actorId, parsed.data.version));
}
export async function getTeamProfile(teamId: string) {
  const team = await getTeamRecord(validId(teamId)); if (!team) throw new AppError('TEAM_NOT_FOUND', '队伍不存在', 404);
  const members = await getTeamMembers(team.id);
  return { ...team, createdAt: team.createdAt.toISOString(), archivedAt: team.archivedAt?.toISOString() ?? null, members: members.map(m => ({ id: m.id, username: m.username, displayName: displayName(m), active: m.active })) };
}
export async function getTeamDetail(teamId: string, params: URLSearchParams) {
  const team = await getTeamProfile(teamId), parsed = parsePersonalQuery(params, new Date(), await getCollectionSettings());
  const [score, contributions, coverage] = await Promise.all([queryTeamScore(team.id, parsed.query), queryTeamContributions(team.id, parsed.query), queryCoverage(parsed.query.platforms, team.members.map(m => m.id))]);
  return { ...queryMeta(parsed, coverage), team, points: score.points, solveCount: score.solveCount, platformSolveCounts: score.platformSolveCounts, lastAcAt: score.lastAcAt, rank: score.rank,
    members: team.members.map(member => { const c = contributions.find(c => c.id === member.id); return { ...member, points: c?.points ?? 0, solveCount: c?.solveCount ?? 0, platformSolveCounts: c?.platformSolveCounts ?? { codeforces: 0, luogu: 0, qoj: 0 }, lastAcAt: c?.lastAcAt ?? null }; }) };
}
export async function getTeamLeaderboard(params: URLSearchParams) {
  const parsed = parsePersonalQuery(params, new Date(), await getCollectionSettings());
  const rows = await queryTeamLeaderboard(parsed.query);
  const grouped = await getTeamMembersBatch(rows.map(r => r.id));
  const rosters = rows.map(r => grouped.get(r.id)!);
  const allCoverage = await queryCoverage(parsed.query.platforms, [...new Set(rosters.flatMap(members => members.map(m => m.id)))]);
  const items = rows.map((r, i) => {
    const members = rosters[i]!, coverage = allCoverage.filter(c => members.some(m => m.id === c.userId));
    return { id: r.id, name: r.name, rank: r.rank, points: r.points, solveCount: r.solveCount, platformSolveCounts: r.platformSolveCounts, lastAcAt: r.lastAcAt, provisional: queryMeta(parsed, coverage).provisional, members: members.map(m => ({ id: m.id, displayName: displayName(m) })) };
  });
  return { ...queryMeta(parsed, allCoverage), total: rows[0]?.total ?? await queryTeamLeaderboardCount(), items };
}
export async function getTeams(params: URLSearchParams, viewerId: string) {
  const parsed = z.object({ mine: z.enum(['1', '0']).default('0'), status: z.enum(['active', 'archived']).default('active'), page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new AppError('INVALID_INPUT', '队伍列表参数不合法', 400);
  const { page, limit } = parsed.data, result = await listTeamRecords(parsed.data.mine === '1' ? viewerId : null, parsed.data.status === 'archived', limit, (page - 1) * limit);
  const grouped = await getTeamMembersBatch(result.rows.map(r => r.id));
  return { page, limit, total: result.total, items: result.rows.map(team => ({ ...team, createdAt: team.createdAt.toISOString(), archivedAt: team.archivedAt?.toISOString() ?? null, members: grouped.get(team.id)!.map(m => ({ id: m.id, username: m.username, displayName: displayName(m), active: m.active })) })) };
}
export async function getMembers(params: URLSearchParams) {
  const parsed = z.object({ q: z.string().trim().max(64).default(''), page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new AppError('INVALID_INPUT', '成员查询参数不合法', 400);
  const { q, page, limit } = parsed.data, result = await searchMembers(q, limit, (page - 1) * limit);
  return { page, limit, total: result.total, items: result.rows.map(m => ({ id: m.id, username: m.username, displayName: displayName(m) })) };
}
