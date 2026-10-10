import { getPool } from './client';
const firstAc = `WITH solves AS (
  SELECT DISTINCT ON (a.user_id,s.problem_id) a.user_id,s.problem_id,s.id AS submission_id,s.submitted_at AS first_ac_at,a.share_divisor
  FROM submissions s JOIN submission_attributions a ON a.submission_id=s.id
  WHERE s.verdict='accepted' AND a.user_id IS NOT NULL AND s.problem_id IS NOT NULL AND s.submitted_at IS NOT NULL
  ORDER BY a.user_id,s.problem_id,s.submitted_at,s.id
)`;
export interface QueryRange { from: Date; to: Date; platforms: string[]; limit: number; offset: number; pointsSql: string }
export interface PersonScoreRow {
  id: string; username: string; realName: string | null; verifiedCfHandle: string | null;
  isStarred: boolean;
  points: number; solveCount: number; platformSolveCounts: Record<string, number>; lastAcAt: Date | null;
}
function sharedPoints(q: QueryRange) { return `((${q.pointsSql})::numeric/s.share_divisor)`; }
export function personTotalsSql(q: QueryRange) {
  return `${firstAc}, selected AS (
    SELECT s.*,p.platform,${sharedPoints(q)} AS points FROM solves s JOIN problems p ON p.id=s.problem_id
    WHERE s.first_ac_at>=$1 AND s.first_ac_at<$2 AND p.platform=ANY($3)
  ), person_totals AS (
    SELECT u.id,u.username,u.real_name AS "realName",u.is_starred AS "isStarred",cf.handle AS "verifiedCfHandle",coalesce(sum(t.points),0)::double precision AS points,count(t.problem_id)::int AS "solveCount",jsonb_build_object('codeforces',count(t.problem_id) FILTER (WHERE t.platform='codeforces'),'luogu',count(t.problem_id) FILTER (WHERE t.platform='luogu'),'qoj',count(t.problem_id) FILTER (WHERE t.platform='qoj')) AS "platformSolveCounts",max(t.first_ac_at) AS "lastAcAt"
    FROM users u LEFT JOIN selected t ON t.user_id=u.id LEFT JOIN platform_bindings b ON b.user_id=u.id AND b.platform='codeforces' LEFT JOIN platform_accounts cf ON cf.id=b.account_id
    WHERE u.active AND u.deleted_at IS NULL GROUP BY u.id,cf.handle
  )`;
}
export async function queryLeaderboard(q: QueryRange) {
  return (await getPool().query<PersonScoreRow & { rank: number | null; total: number }>(`${personTotalsSql(q)}, eligible AS (SELECT id,rank() OVER (ORDER BY points DESC,"solveCount" DESC,"lastAcAt" DESC NULLS LAST)::int AS rank FROM person_totals WHERE NOT "isStarred"), ranked AS (SELECT p.*,e.rank,count(*) OVER()::int AS total FROM person_totals p LEFT JOIN eligible e USING(id))
  SELECT * FROM ranked ORDER BY points DESC,"solveCount" DESC,"lastAcAt" DESC NULLS LAST,id LIMIT $4 OFFSET $5`, [q.from, q.to, q.platforms, q.limit, q.offset])).rows;
}
export async function queryMemberRank(id: string, q: QueryRange): Promise<number | null> {
  return (await getPool().query(`${personTotalsSql(q)}, ranked AS (SELECT id,rank() OVER (ORDER BY points DESC,"solveCount" DESC,"lastAcAt" DESC NULLS LAST)::int AS rank FROM person_totals WHERE NOT "isStarred") SELECT rank FROM ranked WHERE id=$4`, [q.from, q.to, q.platforms, id])).rows[0]?.rank ?? null;
}
export async function queryLeaderboardCount(): Promise<number> { return (await getPool().query('SELECT count(*)::int AS total FROM users WHERE active AND deleted_at IS NULL')).rows[0].total; }
export async function queryMemberRecordCount(id: string, q: QueryRange, raw: boolean): Promise<number> {
  const result = raw ? await getPool().query(`SELECT count(*)::int AS total FROM submissions s JOIN submission_attributions a ON a.submission_id=s.id WHERE a.user_id=$1 AND s.submitted_at>=$2 AND s.submitted_at<$3 AND s.platform=ANY($4)`, [id, q.from, q.to, q.platforms]) : await getPool().query(`${firstAc} SELECT count(*)::int AS total FROM solves s JOIN problems p ON p.id=s.problem_id WHERE s.user_id=$1 AND s.first_ac_at>=$2 AND s.first_ac_at<$3 AND p.platform=ANY($4)`, [id, q.from, q.to, q.platforms]);
  return result.rows[0].total;
}
export async function queryMemberStats(id: string, q: QueryRange) {
  const stats = await getPool().query(`${firstAc} SELECT p.platform,count(*)::int AS "solveCount",sum(${sharedPoints(q)})::double precision AS points,max(s.first_ac_at) AS "lastAcAt" FROM solves s JOIN problems p ON p.id=s.problem_id WHERE s.user_id=$1 AND s.first_ac_at>=$2 AND s.first_ac_at<$3 AND p.platform=ANY($4) GROUP BY p.platform`, [id, q.from, q.to, q.platforms]);
  const calendar = await getPool().query(`${firstAc} SELECT to_char(s.first_ac_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS date,count(*)::int AS "solveCount",sum(${sharedPoints(q)})::double precision AS points FROM solves s JOIN problems p ON p.id=s.problem_id WHERE s.user_id=$1 AND s.first_ac_at>=$2 AND s.first_ac_at<$3 AND p.platform=ANY($4) GROUP BY date ORDER BY date`, [id, q.from, q.to, q.platforms]);
  const count = await getPool().query(`SELECT count(*)::int AS count FROM submissions s JOIN submission_attributions a ON a.submission_id=s.id WHERE a.user_id=$1 AND s.submitted_at>=$2 AND s.submitted_at<$3 AND s.platform=ANY($4)`, [id, q.from, q.to, q.platforms]);
  return { platforms: stats.rows, calendar: calendar.rows, submissionCount: count.rows[0].count as number };
}
export async function queryMemberRecords(id: string, q: QueryRange, raw: boolean) {
  if (raw) return (await getPool().query(`SELECT s.id,s.platform,s.external_submission_id AS "externalSubmissionId",s.submitted_at AS "submittedAt",s.verdict,s.native_score AS "nativeScore",s.native_result AS "nativeResult",s.source_url AS "sourceUrl",p.problem_key AS "problemKey",p.title,s.subject_evidence->>'participantType' AS "participantType",a.share_divisor AS "shareDivisor",count(*) OVER()::int AS total FROM submissions s JOIN submission_attributions a ON a.submission_id=s.id LEFT JOIN problems p ON p.id=s.problem_id WHERE a.user_id=$1 AND s.submitted_at>=$2 AND s.submitted_at<$3 AND s.platform=ANY($4) ORDER BY s.submitted_at DESC,s.id LIMIT $5 OFFSET $6`, [id, q.from, q.to, q.platforms, q.limit, q.offset])).rows;
  return (await getPool().query(`${firstAc} SELECT p.id,p.platform,p.problem_key AS "problemKey",p.title,p.native_difficulty AS "nativeDifficulty",p.difficulty_updated_at AS "difficultyUpdatedAt",p.source_url AS "sourceUrl",s.first_ac_at AS "firstAcAt",s.submission_id AS "submissionId",s.share_divisor AS "shareDivisor",${sharedPoints(q)}::double precision AS points,count(*) OVER()::int AS total FROM solves s JOIN problems p ON p.id=s.problem_id WHERE s.user_id=$1 AND s.first_ac_at>=$2 AND s.first_ac_at<$3 AND p.platform=ANY($4) ORDER BY s.first_ac_at DESC,p.id LIMIT $5 OFFSET $6`, [id, q.from, q.to, q.platforms, q.limit, q.offset])).rows;
}
export async function queryCoverage(platforms: string[], userIds?: string | string[]) {
  const ids = typeof userIds === 'string' ? [userIds] : userIds ?? null;
  return (await getPool().query(`SELECT b.user_id AS "userId",b.platform,a.handle,c.history_complete AS "historyComplete",coalesce(ci.coverage,c.coverage,'unknown') AS coverage,ci.initialized_at AS "initializedAt",(SELECT max(last_success_at) FROM sync_cursors WHERE account_id=b.account_id) AS "lastSuccessAt",b.candidate_state AS "candidateState",(SELECT error FROM sync_runs WHERE binding_id=b.id AND binding_version=b.version ORDER BY created_at DESC LIMIT 1) AS "lastError" FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active AND u.deleted_at IS NULL LEFT JOIN platform_accounts a ON a.id=b.account_id LEFT JOIN sync_cursors c ON c.account_id=b.account_id AND c.mode='backfill' LEFT JOIN sync_cursors ci ON ci.account_id=b.account_id AND ci.mode='incremental' WHERE b.platform=ANY($1) AND ($2::uuid[] IS NULL OR b.user_id=ANY($2::uuid[])) ORDER BY b.user_id,b.platform`, [platforms, ids])).rows;
}
