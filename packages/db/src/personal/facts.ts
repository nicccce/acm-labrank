import type { PoolClient } from 'pg';
import { assertCollectionAvailable, collectionTransaction as transaction } from '../collection/settings';
import { lockRunBinding } from './locks';
import type { BindingRow, SyncRow } from './types';
import { attributionInsertSql, authorKeysSql } from './attribution-sql';

export async function rebuildAttributions(client: PoolClient, platform: string, filter: { submissionIds?: string[]; accountIds?: string[] }) {
  if (!filter.submissionIds?.length && !filter.accountIds?.length) return;
  const pageOnly = !!filter.submissionIds?.length;
  const affected = pageOnly ? 's.external_submission_id=ANY($2::text[])' : `(
    EXISTS (SELECT 1 FROM platform_account_aliases a WHERE a.platform=s.platform AND a.account_id=ANY($2::uuid[]) AND a.key=ANY(${authorKeysSql}))
    OR EXISTS (SELECT 1 FROM submission_attributions prior WHERE prior.submission_id=s.id AND prior.account_id=ANY($2::uuid[]))
  )`;
  // Lock facts in a consistent order before replacing all member shares. The
  // fetching account never supplies author evidence; binding changes also
  // rebuild submissions where that account appears after the first member.
  const ids = (await client.query<{ id: string }>(`SELECT s.id FROM submissions s WHERE s.platform=$1 AND ${affected} ORDER BY s.id FOR UPDATE`, [platform, pageOnly ? filter.submissionIds : filter.accountIds])).rows.map(s => s.id);
  if (!ids.length) return;
  await client.query('DELETE FROM submission_attributions WHERE submission_id=ANY($1::uuid[])', [ids]);
  await client.query(attributionInsertSql, [ids]);
}
export interface FactPage {
  problems: { platform: string; problemKey: string; title: string; nativeDifficulty: number | null; difficultyObserved?: boolean; sourceUrl: string; observedAt?: string }[];
  submissions: { platform: string; externalSubmissionId: string; problemKey: string | null; submittedAt: string | null; verdict: string; nativeScore?: number | null; nativeResult?: string; nativeVerdict?: string | null; nativeStatus?: number | null; sourceUrl?: string; subjectEvidence: unknown; parserVersion: string; observedAt: string }[];
  nextCursor: unknown; nextCheckpoint: unknown; stopReason: string; coverage: string; observedAt: string;
}
export async function commitPersonalPage(runId: string, expectedCursorVersion: number, page: FactPage, connection?: { id: string; generation: number }) {
  return transaction(async client => {
    await lockRunBinding(client, runId);
    const run = (await client.query<SyncRow>('SELECT * FROM sync_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0]!;
    const binding = (await client.query<BindingRow>('SELECT b.* FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active AND u.deleted_at IS NULL WHERE b.id=$1 FOR UPDATE OF b', [run.binding_id])).rows[0];
    if (!binding || binding.version !== run.binding_version || binding.account_id !== run.account_id || run.status !== 'running') throw new Error('STALE_BINDING');
    await assertCollectionAvailable(binding.platform, run.collection_generation, client);
    const enabled = await client.query('SELECT 1 FROM collection_control WHERE id=1 AND enabled FOR SHARE');
    if (!enabled.rowCount) throw new Error('COLLECTION_PAUSED');
    if (connection && !(await client.query('SELECT 1 FROM platform_connections WHERE id=$1 AND generation=$2 FOR SHARE', [connection.id, connection.generation])).rowCount) throw new Error('STALE_CONNECTION');
    await client.query('SELECT id FROM sync_cursors WHERE account_id=$1 AND mode=$2 FOR UPDATE', [run.account_id, run.mode]);
    if (run.cursor_version !== expectedCursorVersion) throw new Error('STALE_CURSOR');
    const ids = new Map<string, string>();
    for (const p of page.problems) {
      if (p.platform !== binding.platform) throw new Error('FACT_PLATFORM_MISMATCH');
      const observed = p.observedAt ?? page.observedAt;
      const row = (await client.query<{ id: string }>(`INSERT INTO problems(platform,problem_key,title,native_difficulty,source_url,difficulty_updated_at,observed_at) VALUES ($1,$2,$3,$4,$5,$6,$6)
        ON CONFLICT(platform,problem_key) DO UPDATE SET title=EXCLUDED.title,source_url=EXCLUDED.source_url,native_difficulty=CASE WHEN $7 THEN EXCLUDED.native_difficulty ELSE problems.native_difficulty END,difficulty_updated_at=CASE WHEN $7 AND problems.native_difficulty IS DISTINCT FROM EXCLUDED.native_difficulty THEN EXCLUDED.observed_at ELSE problems.difficulty_updated_at END,observed_at=EXCLUDED.observed_at WHERE problems.observed_at<=EXCLUDED.observed_at RETURNING id`, [p.platform, p.problemKey, p.title, p.nativeDifficulty, p.sourceUrl, observed, p.difficultyObserved === true || p.nativeDifficulty !== null])).rows[0];
      ids.set(p.problemKey, row?.id ?? (await client.query<{ id: string }>('SELECT id FROM problems WHERE platform=$1 AND problem_key=$2', [p.platform, p.problemKey])).rows[0]!.id);
    }
    for (const s of page.submissions) {
      if (s.platform !== binding.platform) throw new Error('FACT_PLATFORM_MISMATCH');
      const problemId = s.problemKey ? ids.get(s.problemKey) ?? (await client.query<{ id: string }>('SELECT id FROM problems WHERE platform=$1 AND problem_key=$2', [s.platform, s.problemKey])).rows[0]?.id ?? null : null;
      const evidence = { ...(s.subjectEvidence as Record<string, unknown>) };
      for (const name of ['authorAccountKeys', 'authorMembers']) if (Array.isArray(evidence[name]) && (evidence[name] as unknown[]).length === 0) delete evidence[name];
      const verdictObserved = s.verdict !== 'unknown' || s.nativeVerdict != null || s.nativeStatus != null || s.nativeResult != null;
      await client.query(`INSERT INTO submissions(platform,external_submission_id,problem_id,submitted_at,verdict,native_score,native_result,source_url,subject_evidence,parser_version,observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(platform,external_submission_id) DO UPDATE SET problem_id=coalesce(EXCLUDED.problem_id,submissions.problem_id),submitted_at=coalesce(EXCLUDED.submitted_at,submissions.submitted_at),verdict=CASE WHEN $13 THEN EXCLUDED.verdict ELSE submissions.verdict END,native_score=CASE WHEN $12 THEN EXCLUDED.native_score ELSE submissions.native_score END,native_result=coalesce(EXCLUDED.native_result,submissions.native_result),source_url=coalesce(EXCLUDED.source_url,submissions.source_url),subject_evidence=submissions.subject_evidence||EXCLUDED.subject_evidence,parser_version=EXCLUDED.parser_version,observed_at=EXCLUDED.observed_at WHERE submissions.observed_at<=EXCLUDED.observed_at`, [s.platform, s.externalSubmissionId, problemId, s.submittedAt, s.verdict, s.nativeScore ?? null, s.nativeResult ?? s.nativeVerdict ?? null, s.sourceUrl ?? null, JSON.stringify(evidence), s.parserVersion, s.observedAt, Object.hasOwn(s, 'nativeScore'), verdictObserved]);
    }
    await rebuildAttributions(client, binding.platform, { submissionIds: page.submissions.map(s => s.externalSubmissionId) });
    const terminal = page.stopReason !== 'more';
    if (run.scope !== 'range' && terminal && !page.nextCheckpoint) throw new Error('MISSING_CHECKPOINT');
    // Diagnostic/per-run cursors never become the durable checkpoint mid-scan.
    await client.query(`UPDATE sync_cursors SET coverage=$3,last_success_at=CASE WHEN $4 THEN now() ELSE last_success_at END WHERE account_id=$1 AND mode=$2`, [run.account_id, run.mode, page.coverage, terminal]);
    if (run.scope !== 'range' && terminal) await client.query(`UPDATE sync_cursors SET cursor=NULL,checkpoint=$2,initialized_at=coalesce(initialized_at,now()),version=version+1,coverage=$3,last_success_at=now() WHERE account_id=$1 AND mode='incremental'`, [run.account_id, JSON.stringify(page.nextCheckpoint), page.coverage]);
    await client.query('UPDATE sync_runs SET pages=pages+1,records=records+$2,scan_cursor=$3,scan_checkpoint=CASE WHEN $4::jsonb IS NULL THEN scan_checkpoint ELSE $4::jsonb END,cursor_version=cursor_version+1,stop_reason=$5,range_complete=$6 WHERE id=$1', [runId, page.submissions.length, JSON.stringify(page.nextCursor), page.nextCheckpoint === null ? null : JSON.stringify(page.nextCheckpoint), page.stopReason, run.scope === 'range' && terminal]);
    return run.cursor_version + 1;
  });
}
