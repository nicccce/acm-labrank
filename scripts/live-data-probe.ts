import assert from 'node:assert/strict';
import { closeDb, getPool } from '@acm/db/server';
import { authorKeysSql } from '../packages/db/src/personal/attribution-sql';
// Read-only invariants on collected production facts; no quota or session changes.
try {
  const pool = getPool();
  const invalid = (await pool.query(`SELECT
    (SELECT count(*) FROM (SELECT platform,external_submission_id FROM submissions GROUP BY platform,external_submission_id HAVING count(*)>1) d)::int AS duplicates,
    (SELECT count(*) FROM submissions s JOIN problems p ON p.id=s.problem_id WHERE s.platform<>p.platform)::int AS cross_platform_problems,
    (SELECT count(*) FROM submissions s LEFT JOIN submission_attributions a ON a.submission_id=s.id WHERE a.submission_id IS NULL)::int AS missing_attributions,
    (SELECT count(*) FROM submission_attributions a JOIN submissions s ON s.id=a.submission_id WHERE a.user_id IS NOT NULL AND (
      coalesce(s.subject_evidence->>'ghost','false')='true'
      OR NOT EXISTS (SELECT 1 FROM platform_account_aliases alias JOIN platform_bindings b ON b.account_id=alias.account_id WHERE alias.platform=s.platform AND alias.key=ANY(${authorKeysSql}) AND b.account_id=a.account_id AND b.user_id=a.user_id)
      OR a.share_divisor<>CASE WHEN s.platform='codeforces' THEN cardinality(${authorKeysSql}) ELSE 1 END
      OR (s.platform<>'codeforces' AND (jsonb_array_length(coalesce(s.subject_evidence->'authorAccountKeys','[]'))<>1 OR s.subject_evidence ? 'teamId' OR s.subject_evidence ? 'teamName'))
    ))::int AS invalid_personal_credit`)).rows[0];
  for (const count of Object.values(invalid)) assert.equal(count, 0);
  const facts = (await pool.query(`SELECT s.platform,count(DISTINCT s.id)::int AS submissions,count(DISTINCT s.id) FILTER(WHERE a.user_id IS NOT NULL)::int AS assigned,count(DISTINCT s.id) FILTER(WHERE a.user_id IS NULL)::int AS unassigned,count(DISTINCT s.id) FILTER(WHERE s.verdict='accepted')::int AS accepted,min(s.submitted_at) AS oldest,max(s.submitted_at) AS newest FROM submissions s JOIN submission_attributions a ON a.submission_id=s.id GROUP BY s.platform ORDER BY s.platform`)).rows;
  const cursors = (await pool.query(`SELECT a.platform,a.handle,c.mode,c.history_complete,c.coverage,c.version,c.last_success_at FROM sync_cursors c JOIN platform_accounts a ON a.id=c.account_id ORDER BY a.platform,c.mode`)).rows;
  const runs = (await pool.query(`SELECT r.id,b.platform,r.kind,r.mode,r.status,r.batch,r.pages,r.records,r.error FROM sync_runs r JOIN platform_bindings b ON b.id=r.binding_id ORDER BY r.created_at`)).rows;
  console.log(JSON.stringify({ event: 'live_data_invariants_passed', invalid, facts, cursors, runs }));
} finally { await closeDb(); }
