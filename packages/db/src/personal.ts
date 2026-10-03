import type { PoolClient } from 'pg';
import type { PgBoss } from 'pg-boss';
import { getPool } from './client';
import { PERSONAL_QUEUES } from './queue';

export type PersonalPlatform = keyof typeof PERSONAL_QUEUES;
export interface BindingRow { id: string; user_id: string; platform: PersonalPlatform; account_id: string | null; candidate: string | null; candidate_state: string | null; candidate_error: string | null; version: number; handle?: string; external_id?: string | null }
export interface SyncRow { id: string; binding_id: string; binding_version: number; account_id: string | null; kind: 'verify' | 'sync'; mode: 'backfill' | 'incremental'; status: string; batch: number; job_id: string | null; queue: string; pages: number; records: number; retries: number; error: unknown; created_at: Date; finished_at: Date | null; range_from: Date | null; range_to: Date | null; scan_cursor: CursorRow['cursor']; scan_checkpoint: CursorRow['checkpoint']; cursor_version: number; stop_reason: string; range_complete: boolean }
export interface PersonalSyncRange { from: Date; to: Date }
export function defaultPersonalSyncRange(now = new Date()): PersonalSyncRange {
  const midnight = Math.floor((now.getTime() + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
  return { from: new Date(midnight - 29 * 86400000), to: new Date(midnight + 86400000) };
}
export interface CursorRow { id: string; cursor: { version: number; data: unknown } | null; checkpoint: { version: number; data: unknown } | null; version: number; history_complete: boolean; coverage: string; last_success_at: Date | null }
async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export const accountKey = (platform: string, handle: string) => platform === 'codeforces' ? handle.toLowerCase() : handle;
export async function memberProfile(id: string) {
  return (await getPool().query<{ id: string; username: string; realName: string | null; verifiedCfHandle: string | null; role: 'member' | 'admin' }>(`SELECT u.id,u.username,u.real_name AS "realName",u.role,a.handle AS "verifiedCfHandle" FROM users u LEFT JOIN platform_bindings b ON b.user_id=u.id AND b.platform='codeforces' LEFT JOIN platform_accounts a ON a.id=b.account_id WHERE u.id=$1 AND u.active`, [id])).rows[0] ?? null;
}
export async function updateMemberName(id: string, name: string | null) { await getPool().query('UPDATE users SET real_name=$2 WHERE id=$1', [id, name]); }
export async function listBindings(userId: string) {
  return (await getPool().query(`SELECT b.*,a.handle,a.external_id,c.cursor,c.history_complete,c.coverage,c.last_success_at,(SELECT max(last_success_at) FROM sync_cursors WHERE account_id=b.account_id) AS latest_success FROM platform_bindings b LEFT JOIN platform_accounts a ON a.id=b.account_id LEFT JOIN sync_cursors c ON c.account_id=b.account_id AND c.mode='backfill' WHERE b.user_id=$1 ORDER BY b.platform`, [userId])).rows;
}
export async function getBinding(id: string): Promise<BindingRow | null> { return (await getPool().query<BindingRow>('SELECT b.*,a.handle,a.external_id FROM platform_bindings b LEFT JOIN platform_accounts a ON a.id=b.account_id WHERE b.id=$1', [id])).rows[0] ?? null; }
export async function listSyncTargets(accountIds?: string[], platforms?: string[]): Promise<BindingRow[]> {
  return (await getPool().query<BindingRow>(`SELECT b.*,a.handle,a.external_id FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active JOIN platform_accounts a ON a.id=b.account_id WHERE ($1::uuid[] IS NULL OR b.account_id=ANY($1)) AND ($2::text[] IS NULL OR b.platform=ANY($2)) ORDER BY b.id`, [accountIds ?? null, platforms ?? null])).rows;
}
async function sendRun(client: PoolClient, boss: PgBoss, run: Pick<SyncRow, 'id' | 'queue' | 'batch'>, delay = 0) {
  const id = await boss.send(run.queue, { version: 1, syncRunId: run.id, batch: run.batch }, { singletonKey: `${run.id}:${run.batch}`, expireInSeconds: 180, heartbeatSeconds: 30, ...(delay ? { startAfter: delay } : {}), db: { executeSql: (sql, values) => client.query(sql, values) } });
  if (!id) throw new Error('SYNC_QUEUE_CONFLICT');
  await client.query('UPDATE sync_runs SET job_id=$2 WHERE id=$1', [run.id, id]); return id;
}
async function enqueueInTransaction(client: PoolClient, boss: PgBoss, binding: BindingRow, kind: 'verify' | 'sync', mode: 'incremental' | 'backfill', range = kind === 'sync' ? defaultPersonalSyncRange() : null) {
  const old = (await client.query<SyncRow>("SELECT * FROM sync_runs WHERE binding_id=$1 AND kind=$2 AND mode=$3 AND status IN ('queued','running') FOR UPDATE", [binding.id, kind, mode])).rows[0];
  if (old) {
    if (old.range_from?.getTime() !== range?.from.getTime() || old.range_to?.getTime() !== range?.to.getTime()) throw new Error('SYNC_RANGE_CONFLICT');
    return { runId: old.id, jobId: old.job_id, merged: true };
  }
  const queue = PERSONAL_QUEUES[binding.platform];
  // An expanded earlier interval must scan from the head without the old stop checkpoint.
  const previous = range && mode === 'incremental' ? (await client.query<SyncRow>(`SELECT * FROM sync_runs WHERE binding_id=$1 AND binding_version=$2 AND account_id=$3 AND status='completed' AND range_complete AND scan_checkpoint IS NOT NULL AND range_from<=$4 AND (range_to>=$5 OR (range_to>=created_at AND range_to>=$4)) ORDER BY finished_at DESC LIMIT 1`, [binding.id, binding.version, binding.account_id, range.from, range.to])).rows[0] : null;
  const run = (await client.query<SyncRow>(`INSERT INTO sync_runs(binding_id,binding_version,account_id,kind,mode,queue,range_from,range_to,scan_checkpoint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [binding.id, binding.version, binding.account_id, kind, mode, queue, range?.from ?? null, range?.to ?? null, previous?.scan_checkpoint ? JSON.stringify(previous.scan_checkpoint) : null])).rows[0]!;
  const jobId = await sendRun(client, boss, run); return { runId: run.id, jobId, merged: false };
}
export async function saveBindingCandidate(userId: string, platform: PersonalPlatform, target: string, boss: PgBoss) {
  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,73192405))', [`${userId}:${platform}`]);
    const key = accountKey(platform, target);
    const unchanged = (await client.query<BindingRow>(`SELECT b.* FROM platform_bindings b JOIN platform_account_aliases a ON a.account_id=b.account_id AND a.platform=b.platform WHERE b.user_id=$1 AND b.platform=$2 AND a.key=$3 AND b.candidate IS NULL`, [userId, platform, key])).rows[0];
    if (unchanged) return { bindingId: unchanged.id, version: unchanged.version, state: 'verified', unchanged: true, runId: null, jobId: null, merged: false };
    const occupied = await client.query(`SELECT 1 FROM platform_account_aliases a JOIN platform_bindings b ON b.account_id=a.account_id WHERE a.platform=$1 AND a.key=$2 AND b.user_id<>$3`, [platform, key, userId]);
    if (occupied.rowCount) throw new Error('ACCOUNT_OCCUPIED');
    await client.query("UPDATE sync_runs SET status='cancelled',finished_at=now() WHERE binding_id IN (SELECT id FROM platform_bindings WHERE user_id=$1 AND platform=$2) AND status IN ('queued','running','paused','failed')", [userId, platform]);
    const binding = (await client.query<BindingRow>(`INSERT INTO platform_bindings(user_id,platform,candidate,candidate_state) VALUES ($1,$2,$3,'pending') ON CONFLICT(user_id,platform) DO UPDATE SET candidate=$3,candidate_state='pending',candidate_error=NULL,version=platform_bindings.version+1 RETURNING *`, [userId, platform, target])).rows[0]!;
    return { bindingId: binding.id, version: binding.version, state: 'pending', ...await enqueueInTransaction(client, boss, binding, 'verify', 'backfill') };
  });
}
async function rebuildAttributions(client: PoolClient, platform: string) {
  // Query target is never author evidence. Explicit team evidence always wins.
  await client.query(`INSERT INTO submission_attributions(submission_id,user_id,account_id,method)
    SELECT s.id,b.user_id,b.account_id,CASE WHEN b.user_id IS NULL THEN 'unassigned' ELSE 'verified_person' END
    FROM submissions s LEFT JOIN platform_account_aliases a ON a.platform=s.platform AND a.key=CASE WHEN s.platform='codeforces' THEN lower(s.subject_evidence->'authorAccountKeys'->>0) ELSE s.subject_evidence->'authorAccountKeys'->>0 END
      AND jsonb_array_length(coalesce(s.subject_evidence->'authorAccountKeys','[]'))=1
      AND NOT (s.subject_evidence ? 'teamId') AND NOT (s.subject_evidence ? 'teamName')
      AND (NOT (s.subject_evidence ? 'authorMembers') OR jsonb_array_length(s.subject_evidence->'authorMembers')=1)
    LEFT JOIN platform_bindings b ON b.account_id=a.account_id
    WHERE s.platform=$1
    ON CONFLICT(submission_id) DO UPDATE SET user_id=EXCLUDED.user_id,account_id=EXCLUDED.account_id,method=EXCLUDED.method`, [platform]);
}
async function lockRunBinding(client: PoolClient, id: string) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(b.user_id::text||':'||b.platform,73192405)) FROM sync_runs r JOIN platform_bindings b ON b.id=r.binding_id WHERE r.id=$1`, [id]);
}
export async function activateBinding(runId: string, account: { platform: string; kind: string; handle: string; externalId: string | null; resolutionEvidence?: { requestedHandle: string; historicHandlesChecked: boolean } }, boss: PgBoss) {
  return transaction(async client => {
    await lockRunBinding(client, runId);
    const run = (await client.query<SyncRow>('SELECT * FROM sync_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0]!;
    const binding = (await client.query<BindingRow>('SELECT b.* FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active WHERE b.id=$1 FOR UPDATE OF b', [run.binding_id])).rows[0];
    if (!binding || binding.version !== run.binding_version || run.status !== 'running') throw new Error('STALE_BINDING');
    if (account.kind !== 'person') throw new Error('TEAM_ACCOUNT_UNSUPPORTED');
    const identity = account.externalId ?? accountKey(account.platform, account.handle);
    const aliases = [...new Set([...(account.platform === 'luogu' ? [] : [accountKey(account.platform, account.handle)]), ...(account.externalId ? [account.externalId] : []), ...(account.resolutionEvidence?.historicHandlesChecked ? [accountKey(account.platform, account.resolutionEvidence.requestedHandle)] : [])])];
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,73192406))', [account.platform]);
    const existing = (await client.query<{ account_id: string }>('SELECT account_id FROM platform_account_aliases WHERE platform=$1 AND key=ANY($2)', [account.platform, aliases])).rows;
    if (new Set(existing.map(r => r.account_id)).size > 1) throw new Error('ACCOUNT_OCCUPIED');
    let accountId = existing[0]?.account_id;
    if (!accountId) accountId = (await client.query<{ id: string }>(`INSERT INTO platform_accounts(platform,external_id,handle,identity_key) VALUES ($1,$2,$3,$4) ON CONFLICT(platform,identity_key) DO UPDATE SET handle=$3 RETURNING id`, [account.platform, account.externalId, account.handle, identity])).rows[0]!.id;
    if ((await client.query('SELECT 1 FROM platform_bindings WHERE account_id=$1 AND id<>$2', [accountId, binding.id])).rowCount) throw new Error('ACCOUNT_OCCUPIED');
    await client.query('UPDATE platform_accounts SET handle=$2 WHERE id=$1', [accountId, account.handle]);
    for (const alias of aliases) await client.query('INSERT INTO platform_account_aliases(platform,key,account_id) VALUES ($1,$2,$3) ON CONFLICT(platform,key) DO NOTHING', [account.platform, alias, accountId]);
    await client.query("UPDATE platform_bindings SET account_id=$2,candidate=NULL,candidate_state='verified',candidate_error=NULL,verified_at=now() WHERE id=$1", [binding.id, accountId]);
    await rebuildAttributions(client, binding.platform);
    await client.query("UPDATE sync_runs SET status='completed',account_id=$2,finished_at=now() WHERE id=$1", [runId, accountId]);
    binding.account_id = accountId;
    return enqueueInTransaction(client, boss, binding, 'sync', 'backfill');
  });
}
export async function unbindAccount(userId: string, platform: string) {
  await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,73192405))', [`${userId}:${platform}`]);
    await client.query('UPDATE platform_bindings SET account_id=NULL,candidate=NULL,candidate_state=NULL,candidate_error=NULL,version=version+1 WHERE user_id=$1 AND platform=$2', [userId, platform]);
    await client.query("UPDATE sync_runs SET status='cancelled',finished_at=now() WHERE binding_id IN (SELECT id FROM platform_bindings WHERE user_id=$1 AND platform=$2) AND status IN ('queued','running','paused','failed')", [userId, platform]);
    await rebuildAttributions(client, platform);
  });
}
export async function requestPersonalSync(bindingId: string, mode: 'backfill' | 'incremental', boss: PgBoss, range = defaultPersonalSyncRange()) {
  return transaction(async client => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(user_id::text||':'||platform,73192405)) FROM platform_bindings WHERE id=$1`, [bindingId]);
    const binding = (await client.query<BindingRow>('SELECT b.* FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active WHERE b.id=$1 AND b.account_id IS NOT NULL FOR UPDATE OF b', [bindingId])).rows[0];
    if (!binding) throw new Error('NO_ACTIVE_BINDING');
    return enqueueInTransaction(client, boss, binding, 'sync', mode, range);
  });
}
export async function refreshVerifiedIdentity(bindingId: string, version: number, account: { platform: string; kind: string; handle: string; externalId: string | null; resolutionEvidence?: { requestedHandle: string; historicHandlesChecked: boolean } }) {
  return transaction(async client => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(user_id::text||':'||platform,73192405)) FROM platform_bindings WHERE id=$1`, [bindingId]);
    const binding = (await client.query<BindingRow>('SELECT b.*,a.handle,a.external_id FROM platform_bindings b JOIN platform_accounts a ON a.id=b.account_id WHERE b.id=$1 FOR UPDATE OF b,a', [bindingId])).rows[0];
    if (!binding || binding.version !== version || binding.platform !== account.platform || account.kind !== 'person' || account.externalId !== binding.external_id) throw new Error('STALE_BINDING');
    if (accountKey(account.platform, account.handle) === accountKey(binding.platform, binding.handle!)) return false;
    if (account.platform === 'qoj' || (account.platform === 'codeforces' && (!account.resolutionEvidence?.historicHandlesChecked || accountKey(account.platform, account.resolutionEvidence.requestedHandle) !== accountKey(binding.platform, binding.handle!)))) throw new Error('ACCOUNT_IDENTITY_CHANGED');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,73192406))', [account.platform]);
    if (account.platform === 'codeforces') {
      const alias = accountKey(account.platform, account.handle);
      if ((await client.query('SELECT 1 FROM platform_account_aliases WHERE platform=$1 AND key=$2 AND account_id<>$3', [account.platform, alias, binding.account_id])).rowCount) throw new Error('ACCOUNT_OCCUPIED');
      await client.query('INSERT INTO platform_account_aliases(platform,key,account_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [account.platform, alias, binding.account_id]);
      // Handles occur inside connector cursors. Restart safely after a confirmed rename.
      await client.query("UPDATE sync_cursors SET cursor=NULL,checkpoint=NULL,history_complete=false,version=version+1 WHERE account_id=$1", [binding.account_id]);
      await client.query("UPDATE sync_runs SET scan_cursor=NULL,scan_checkpoint=NULL,cursor_version=cursor_version+1,stop_reason='more',range_complete=false WHERE account_id=$1 AND status IN ('queued','running','paused','failed')", [binding.account_id]);
    }
    await client.query('UPDATE platform_accounts SET handle=$2 WHERE id=$1', [binding.account_id, account.handle]);
    await rebuildAttributions(client, binding.platform);
    return account.platform === 'codeforces';
  });
}
export async function getSyncRun(id: string): Promise<SyncRow | null> { return (await getPool().query<SyncRow>('SELECT * FROM sync_runs WHERE id=$1', [id])).rows[0] ?? null; }
export async function claimSyncRun(id: string, batch: number, jobId: string) {
  return (await getPool().query("UPDATE sync_runs SET status='running' WHERE id=$1 AND batch=$2 AND job_id=$3 AND status='queued' RETURNING id", [id, batch, jobId])).rowCount === 1;
}
export async function readSyncCursor(accountId: string, mode: 'backfill' | 'incremental'): Promise<CursorRow> {
  await getPool().query('INSERT INTO sync_cursors(account_id,mode) VALUES ($1,$2) ON CONFLICT DO NOTHING', [accountId, mode]);
  return (await getPool().query<CursorRow>('SELECT * FROM sync_cursors WHERE account_id=$1 AND mode=$2', [accountId, mode])).rows[0]!;
}
export async function seedIncrementalCheckpoint(accountId: string) {
  await getPool().query(`INSERT INTO sync_cursors(account_id,mode,checkpoint) SELECT account_id,'incremental',checkpoint FROM sync_cursors WHERE account_id=$1 AND mode='backfill' ON CONFLICT(account_id,mode) DO UPDATE SET checkpoint=EXCLUDED.checkpoint WHERE sync_cursors.checkpoint IS NULL AND sync_cursors.cursor IS NULL`, [accountId]);
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
    const binding = (await client.query<BindingRow>('SELECT b.* FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active WHERE b.id=$1 FOR UPDATE OF b', [run.binding_id])).rows[0];
    if (!binding || binding.version !== run.binding_version || binding.account_id !== run.account_id || run.status !== 'running') throw new Error('STALE_BINDING');
    const enabled = await client.query('SELECT 1 FROM collection_control WHERE id=1 AND enabled FOR SHARE');
    if (!enabled.rowCount) throw new Error('COLLECTION_PAUSED');
    if (connection && !(await client.query('SELECT 1 FROM platform_connections WHERE id=$1 AND generation=$2 FOR SHARE', [connection.id, connection.generation])).rowCount) throw new Error('STALE_CONNECTION');
    const cursor = (await client.query<CursorRow>('SELECT * FROM sync_cursors WHERE account_id=$1 AND mode=$2 FOR UPDATE', [run.account_id, run.mode])).rows[0]!;
    const bounded = run.range_from !== null;
    if ((bounded ? run.cursor_version : cursor.version) !== expectedCursorVersion) throw new Error('STALE_CURSOR');
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
    await rebuildAttributions(client, binding.platform);
    const complete = !bounded && page.stopReason === 'history_end';
    await client.query(`UPDATE sync_cursors SET cursor=$3,checkpoint=coalesce($4,checkpoint),version=version+1,history_complete=history_complete OR ($5 AND mode='backfill'),coverage=$6,last_success_at=CASE WHEN $7 THEN now() ELSE last_success_at END WHERE account_id=$1 AND mode=$2`, [run.account_id, run.mode, bounded ? null : JSON.stringify(page.nextCursor), bounded || page.nextCheckpoint === null ? null : JSON.stringify(page.nextCheckpoint), complete, page.coverage, page.stopReason !== 'more']);
    await client.query('UPDATE sync_runs SET pages=pages+1,records=records+$2,scan_cursor=$3,scan_checkpoint=coalesce($4,scan_checkpoint),cursor_version=cursor_version+1,stop_reason=$5,range_complete=$6 WHERE id=$1', [runId, page.submissions.length, JSON.stringify(page.nextCursor), page.nextCheckpoint === null ? null : JSON.stringify(page.nextCheckpoint), page.stopReason, bounded && page.stopReason !== 'more']);
    return (bounded ? run.cursor_version : cursor.version) + 1;
  });
}
export async function finishPersonalBatch(id: string, boss: PgBoss, options: { complete?: boolean; error?: unknown; paused?: boolean; retryDelay?: number; candidateState?: string }) {
  return transaction(async client => {
    await lockRunBinding(client, id);
    const run = (await client.query<SyncRow>('SELECT * FROM sync_runs WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
    if (run.status !== 'running') return;
    if (options.candidateState) await client.query('UPDATE platform_bindings SET candidate_state=$3,candidate_error=$4 WHERE id=$1 AND version=$2', [run.binding_id, run.binding_version, options.candidateState, JSON.stringify(options.error)]);
    if (options.complete || options.paused || (options.error && options.retryDelay === undefined)) {
      await client.query('UPDATE sync_runs SET status=$2,error=$3,finished_at=now() WHERE id=$1', [id, options.complete ? 'completed' : options.paused ? 'paused' : 'failed', options.error ? JSON.stringify(options.error) : null]); return;
    }
    run.batch++;
    await client.query("UPDATE sync_runs SET status='queued',batch=$2,error=$3,retries=retries+$4 WHERE id=$1", [id, run.batch, options.error ? JSON.stringify(options.error) : null, options.error ? 1 : 0]);
    await sendRun(client, boss, run, options.retryDelay);
  });
}
export async function retryPersonalRun(id: string, boss: PgBoss, resetRetries = true) {
  return transaction(async client => {
    await lockRunBinding(client, id);
    const run = (await client.query<SyncRow>('SELECT * FROM sync_runs WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!run || !['failed', 'paused'].includes(run.status)) throw new Error('SYNC_STATE_CONFLICT');
    const binding = (await client.query<BindingRow>('SELECT b.* FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active WHERE b.id=$1 FOR UPDATE OF b', [run.binding_id])).rows[0];
    if (!binding || binding.version !== run.binding_version) throw new Error('STALE_BINDING');
    const active = (await client.query<SyncRow>("SELECT * FROM sync_runs WHERE binding_id=$1 AND kind=$2 AND mode=$3 AND status IN ('queued','running')", [run.binding_id, run.kind, run.mode])).rows[0];
    if (active) {
      if (active.range_from?.getTime() !== run.range_from?.getTime() || active.range_to?.getTime() !== run.range_to?.getTime()) throw new Error('SYNC_RANGE_CONFLICT');
      return { runId: active.id, jobId: active.job_id, merged: true };
    }
    run.batch++;
    await client.query("UPDATE sync_runs SET status='queued',batch=$2,error=NULL,retries=$3,finished_at=NULL WHERE id=$1", [id, run.batch, resetRetries ? 0 : run.retries + 1]);
    if (run.kind === 'verify') await client.query("UPDATE platform_bindings SET candidate_state='pending',candidate_error=NULL WHERE id=$1", [run.binding_id]);
    return { runId: id, jobId: await sendRun(client, boss, run), merged: false };
  });
}
export async function maintainPersonalRuns(boss: PgBoss) {
  const rows = (await getPool().query<SyncRow>("SELECT * FROM sync_runs WHERE status IN ('queued','running') AND created_at<now()-interval '30 seconds' ORDER BY created_at LIMIT 100")).rows;
  for (const run of rows) {
    const job = run.job_id ? await boss.getJobById(run.queue, run.job_id) : null;
    if (!job || ['failed', 'cancelled', 'completed'].includes(job.state)) {
      const changed = await getPool().query("UPDATE sync_runs SET status='paused',error=$2,finished_at=now() WHERE id=$1 AND job_id=$3 AND status IN ('queued','running') RETURNING id", [run.id, JSON.stringify({ code: 'INTERRUPTED', action: 'retry', message: '任务中断，已提交页面和游标保留' }), run.job_id]);
      if (changed.rowCount && job?.state !== 'cancelled' && run.retries < 3) await retryPersonalRun(run.id, boss, false).catch(() => undefined);
    }
  }
  const recoverable = (await getPool().query<{ id: string }>(`SELECT r.id FROM sync_runs r JOIN platform_bindings b ON b.id=r.binding_id JOIN platform_connections c ON c.platform=b.platform AND c.id=CASE WHEN b.platform='qoj' THEN $1 ELSE $2 END WHERE r.status='paused' AND r.error->>'code' IN ('AUTH_REQUIRED','CHALLENGE_REQUIRED','RISK_CONTROL') AND c.state='ready' AND c.generation>coalesce((r.error->>'connectionGeneration')::int,-1) AND b.version=r.binding_version LIMIT 50`, [process.env.QOJ_CONNECTION_ID ?? 'qoj-lab', process.env.LUOGU_CONNECTION_ID ?? 'luogu-lab'])).rows;
  for (const row of recoverable) await retryPersonalRun(row.id, boss).catch(() => undefined);
  const resumed = (await getPool().query<{ id: string }>("SELECT id FROM sync_runs WHERE status='paused' AND error->>'code'='COLLECTION_PAUSED' LIMIT 50")).rows;
  for (const row of resumed) await retryPersonalRun(row.id, boss).catch(() => undefined);
}
