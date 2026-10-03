import type { PoolClient } from 'pg';
import { getPool } from './client';
import { personTotalsSql, type PersonScoreRow, type QueryRange } from './personal-queries';

export interface TeamRow { id: string; name: string; ownerId: string; version: number; archivedAt: Date | null; createdAt: Date }
export interface TeamMemberRow { id: string; username: string; realName: string | null; verifiedCfHandle: string | null; active: boolean }
export class TeamStateError extends Error {
  constructor(public readonly code: string, public readonly teamId?: string) { super(code); }
}
const columns = `id,name,owner_id AS "ownerId",version,archived_at AS "archivedAt",created_at AS "createdAt"`;
async function transaction<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Team writes are short and serialized: exit, create and roster replacement
    // must agree on the same current member sets, even across different teams.
    await client.query('SELECT pg_advisory_xact_lock(73192410)');
    const result = await fn(client); await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function roster(client: PoolClient, id: string) {
  return (await client.query<{ userId: string }>('SELECT user_id AS "userId" FROM team_memberships WHERE team_id=$1 AND left_at IS NULL ORDER BY user_id', [id])).rows.map(r => r.userId);
}
const rosterKey = (ids: string[]) => [...ids].sort().join(',');
async function activeUsers(client: PoolClient, ids: string[]) {
  const found = await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) AND active FOR SHARE', [ids]);
  if (found.rowCount !== ids.length) throw new TeamStateError('INVALID_MEMBERS');
}
async function event(client: PoolClient, id: string, actorId: string, action: string, details: object) {
  await client.query('INSERT INTO team_events(team_id,actor_id,action,details,created_at) VALUES ($1,$2,$3,$4,clock_timestamp())', [id, actorId, action, JSON.stringify(details)]);
}
async function lockedTeam(client: PoolClient, id: string, version: number) {
  const team = (await client.query<TeamRow>(`SELECT ${columns} FROM teams WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!team) throw new TeamStateError('TEAM_NOT_FOUND');
  if (team.version !== version) throw new TeamStateError('TEAM_STALE');
  if (team.archivedAt) throw new TeamStateError('TEAM_ARCHIVED');
  return team;
}
export async function createTeamRecord(actorId: string, name: string, memberIds: string[]) {
  return transaction(async client => {
    await activeUsers(client, memberIds);
    const existing = (await client.query<{ id: string }>('SELECT id FROM teams WHERE roster_key=$1 AND archived_at IS NULL', [rosterKey(memberIds)])).rows[0];
    if (existing) return { id: existing.id, created: false };
    const team = (await client.query<{ id: string }>('INSERT INTO teams(name,owner_id,roster_key) VALUES ($1,$2,$3) RETURNING id', [name, actorId, rosterKey(memberIds)])).rows[0]!;
    await client.query('INSERT INTO team_memberships(team_id,user_id,joined_at) SELECT $1,unnest($2::uuid[]),clock_timestamp()', [team.id, memberIds]);
    await event(client, team.id, actorId, 'create', { memberIds });
    return { id: team.id, created: true };
  });
}
export async function updateTeamRecord(id: string, actorId: string, input: { name: string; memberIds: string[]; ownerId: string; version: number }) {
  return transaction(async client => {
    const team = await lockedTeam(client, id, input.version);
    if (team.ownerId !== actorId) throw new TeamStateError('TEAM_FORBIDDEN');
    await activeUsers(client, input.memberIds);
    const duplicate = (await client.query<{ id: string }>('SELECT id FROM teams WHERE roster_key=$1 AND archived_at IS NULL AND id<>$2', [rosterKey(input.memberIds), id])).rows[0];
    if (duplicate) throw new TeamStateError('TEAM_DUPLICATE', duplicate.id);
    const previous = await roster(client, id);
    await client.query('UPDATE team_memberships SET left_at=clock_timestamp() WHERE team_id=$1 AND left_at IS NULL AND NOT (user_id=ANY($2::uuid[]))', [id, input.memberIds]);
    await client.query('INSERT INTO team_memberships(team_id,user_id,joined_at) SELECT $1,m,clock_timestamp() FROM unnest($2::uuid[]) AS m WHERE NOT EXISTS (SELECT 1 FROM team_memberships WHERE team_id=$1 AND user_id=m AND left_at IS NULL)', [id, input.memberIds]);
    await client.query('UPDATE teams SET name=$2,owner_id=$3,roster_key=$4,version=version+1 WHERE id=$1', [id, input.name, input.ownerId, rosterKey(input.memberIds)]);
    await event(client, id, actorId, 'update', { before: previous, after: input.memberIds, previousOwnerId: team.ownerId, ownerId: input.ownerId });
    return { id };
  });
}
export async function archiveTeamRecord(id: string, actorId: string, version: number) {
  return transaction(async client => {
    const team = await lockedTeam(client, id, version);
    if (team.ownerId !== actorId) throw new TeamStateError('TEAM_FORBIDDEN');
    await client.query('UPDATE teams SET archived_at=clock_timestamp(),version=version+1 WHERE id=$1', [id]);
    await event(client, id, actorId, 'archive', { memberIds: await roster(client, id) });
    return { id, archived: true };
  });
}
export async function leaveTeamRecord(id: string, actorId: string, version: number) {
  return transaction(async client => {
    const team = await lockedTeam(client, id, version), previous = await roster(client, id);
    if (!previous.includes(actorId)) throw new TeamStateError('TEAM_FORBIDDEN');
    if (team.ownerId === actorId) throw new TeamStateError('TEAM_OWNER_EXIT');
    const remaining = previous.filter(member => member !== actorId);
    const duplicate = (await client.query<{ id: string }>('SELECT id FROM teams WHERE roster_key=$1 AND archived_at IS NULL AND id<>$2', [rosterKey(remaining), id])).rows[0];
    const archived = remaining.length < 2 || !!duplicate;
    await client.query('UPDATE team_memberships SET left_at=clock_timestamp() WHERE team_id=$1 AND user_id=$2 AND left_at IS NULL', [id, actorId]);
    await client.query('UPDATE teams SET roster_key=$2,archived_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,version=version+1 WHERE id=$1', [id, rosterKey(remaining), archived]);
    await event(client, id, actorId, 'leave', { before: previous, after: remaining, archived, duplicateTeamId: duplicate?.id ?? null });
    return { id, archived, duplicateTeamId: duplicate?.id ?? null };
  });
}
export async function getTeamRecord(id: string): Promise<TeamRow | null> {
  return (await getPool().query<TeamRow>(`SELECT ${columns} FROM teams WHERE id=$1`, [id])).rows[0] ?? null;
}
export async function getTeamMembersBatch(ids: string[]) {
  if (!ids.length) return new Map<string, TeamMemberRow[]>();
  const rows = (await getPool().query<TeamMemberRow & { teamId: string }>(`SELECT m.team_id AS "teamId",u.id,u.username,u.real_name AS "realName",u.active,a.handle AS "verifiedCfHandle" FROM team_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN platform_bindings b ON b.user_id=u.id AND b.platform='codeforces' LEFT JOIN platform_accounts a ON a.id=b.account_id WHERE m.team_id=ANY($1::uuid[]) AND m.left_at IS NULL ORDER BY m.team_id,u.id`, [ids])).rows;
  const result = new Map(ids.map(id => [id, [] as TeamMemberRow[]]));
  for (const { teamId, ...member } of rows) result.get(teamId)!.push(member);
  return result;
}
export async function getTeamMembers(id: string) { return (await getTeamMembersBatch([id])).get(id)!; }
export async function listTeamRecords(userId: string | null, archived: boolean, limit: number, offset: number) {
  const where = `(archived_at IS NOT NULL)=$1 AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM team_memberships m WHERE m.team_id=teams.id AND m.user_id=$2 AND (m.left_at IS NULL OR teams.archived_at IS NOT NULL)))`;
  const rows = (await getPool().query<TeamRow>(`SELECT ${columns} FROM teams WHERE ${where} ORDER BY created_at DESC,id LIMIT $3 OFFSET $4`, [archived, userId, limit, offset])).rows;
  const count = (await getPool().query<{ total: number }>(`SELECT count(*)::int AS total FROM teams WHERE ${where}`, [archived, userId])).rows[0]!.total;
  return { rows, total: count };
}
export async function searchMembers(search: string, limit: number, offset: number) {
  const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const where = `u.active AND (u.username ILIKE $1 OR u.real_name ILIKE $1 OR a.handle ILIKE $1)`;
  const from = `FROM users u LEFT JOIN platform_bindings b ON b.user_id=u.id AND b.platform='codeforces' LEFT JOIN platform_accounts a ON a.id=b.account_id`;
  const rows = (await getPool().query<TeamMemberRow>(`SELECT u.id,u.username,u.real_name AS "realName",a.handle AS "verifiedCfHandle",u.active ${from} WHERE ${where} ORDER BY u.username,u.id LIMIT $2 OFFSET $3`, [pattern, limit, offset])).rows;
  const total = (await getPool().query<{ total: number }>(`SELECT count(*)::int AS total ${from} WHERE ${where}`, [pattern])).rows[0]!.total;
  return { rows, total };
}
export interface TeamScoreRow { id: string; name: string; points: number; solveCount: number; platformSolveCounts: Record<string, number>; lastAcAt: Date | null; rank: number | null; total: number }
function teamTotalsSql(q: QueryRange) {
  return `${personTotalsSql(q)}, team_totals AS (
    SELECT t.id,t.name,coalesce(sum(p.points),0)::double precision AS points,coalesce(sum(p."solveCount"),0)::int AS "solveCount",
    jsonb_build_object('codeforces',coalesce(sum((p."platformSolveCounts"->>'codeforces')::int),0),'luogu',coalesce(sum((p."platformSolveCounts"->>'luogu')::int),0),'qoj',coalesce(sum((p."platformSolveCounts"->>'qoj')::int),0)) AS "platformSolveCounts",max(p."lastAcAt") AS "lastAcAt",t.archived_at
    FROM teams t LEFT JOIN team_memberships m ON m.team_id=t.id AND m.left_at IS NULL LEFT JOIN person_totals p ON p.id=m.user_id GROUP BY t.id
  ), ranked_teams AS (SELECT *,rank() OVER (ORDER BY points DESC,"solveCount" DESC,"lastAcAt" DESC NULLS LAST)::int AS rank,count(*) OVER()::int AS total FROM team_totals WHERE archived_at IS NULL)`;
}
export async function queryTeamLeaderboard(q: QueryRange) {
  return (await getPool().query<TeamScoreRow>(`${teamTotalsSql(q)} SELECT * FROM ranked_teams ORDER BY points DESC,"solveCount" DESC,"lastAcAt" DESC NULLS LAST,id LIMIT $4 OFFSET $5`, [q.from, q.to, q.platforms, q.limit, q.offset])).rows;
}
export async function queryTeamLeaderboardCount() {
  return (await getPool().query<{ total: number }>('SELECT count(*)::int AS total FROM teams WHERE archived_at IS NULL')).rows[0]!.total;
}
export async function queryTeamScore(id: string, q: QueryRange) {
  return (await getPool().query<TeamScoreRow>(`${teamTotalsSql(q)} SELECT t.*,r.rank,coalesce(r.total,0) AS total FROM team_totals t LEFT JOIN ranked_teams r ON r.id=t.id WHERE t.id=$4`, [q.from, q.to, q.platforms, id])).rows[0]!;
}
export async function queryTeamContributions(id: string, q: QueryRange) {
  return (await getPool().query<PersonScoreRow>(`${personTotalsSql(q)} SELECT p.* FROM person_totals p JOIN team_memberships m ON m.user_id=p.id AND m.left_at IS NULL WHERE m.team_id=$4 ORDER BY p.id`, [q.from, q.to, q.platforms, id])).rows;
}
