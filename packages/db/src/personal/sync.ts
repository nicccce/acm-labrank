import type { PoolClient } from 'pg';
import type { PgBoss } from 'pg-boss';
import { getPool } from '../client';
import { PERSONAL_QUEUES } from '../queue';
import { assertCollectionAvailable, collectionTransaction as transaction, type SyncSource } from '../collection/settings';
import { lockRunBinding, assertRunCollection } from './locks';
import { defaultPersonalSyncRange, type BindingRow, type SyncRow, type CursorRow, type PersonalSyncRange } from './types';

async function sendRun(client: PoolClient, boss: PgBoss, run: Pick<SyncRow, 'id' | 'queue' | 'batch'>, delay = 0) {
  const id = await boss.send(run.queue, { version: 1, syncRunId: run.id, batch: run.batch }, { singletonKey: `${run.id}:${run.batch}`, expireInSeconds: 180, heartbeatSeconds: 30, ...(delay ? { startAfter: delay } : {}), db: { executeSql: (sql, values) => client.query(sql, values) } });
  if (!id) throw new Error('SYNC_QUEUE_CONFLICT');
  await client.query('UPDATE sync_runs SET job_id=$2 WHERE id=$1', [run.id, id]); return id;
}
export async function enqueuePersonalInTransaction(client: PoolClient, boss: PgBoss, binding: BindingRow, kind: 'verify' | 'sync', mode: 'incremental' | 'backfill', range?: PersonalSyncRange | null, source: SyncSource = 'binding', actorId?: string) {
  const generation = await assertCollectionAvailable(binding.platform, undefined, client);
  const explicitRange = range != null || (kind === 'sync' && mode === 'backfill');
  range = kind === 'verify' ? null : range ?? (mode === 'backfill' ? defaultPersonalSyncRange() : null);
  const old = (await client.query<SyncRow>("SELECT * FROM sync_runs WHERE binding_id=$1 AND status IN ('queued','running') FOR UPDATE", [binding.id])).rows[0];
  if (old) {
    if (explicitRange && old.kind === kind && (old.range_from?.getTime() !== range?.from.getTime() || old.range_to?.getTime() !== range?.to.getTime())) throw new Error('SYNC_RANGE_CONFLICT');
    if (kind === 'sync' && !range && old.scope === 'range') await client.query('UPDATE platform_bindings SET sync_requested=true WHERE id=$1', [binding.id]);
    return { runId: old.id, jobId: old.job_id, merged: true };
  }
  let scope: SyncRow['scope'] = 'range';
  let checkpoint: CursorRow['checkpoint'] = null;
  let initialFrom: Date | null = null;
  if (kind === 'sync' && !range) {
    await client.query("INSERT INTO sync_cursors(account_id,mode) VALUES ($1,'incremental') ON CONFLICT DO NOTHING", [binding.account_id]);
    const cursor = (await client.query<CursorRow>("SELECT * FROM sync_cursors WHERE account_id=$1 AND mode='incremental' FOR UPDATE", [binding.account_id])).rows[0]!;
    scope = cursor.initialized_at ? 'incremental' : 'initial';
    checkpoint = scope === 'incremental' ? cursor.checkpoint : null;
    initialFrom = scope === 'initial' ? defaultPersonalSyncRange().from : null;
  }
  const queue = PERSONAL_QUEUES[binding.platform];
  const run = (await client.query<SyncRow>(`INSERT INTO sync_runs(binding_id,binding_version,account_id,kind,mode,queue,range_from,range_to,scan_checkpoint,collection_generation,source,requested_by,scope,initial_from) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [binding.id, binding.version, binding.account_id, kind, mode, queue, range?.from ?? null, range?.to ?? null, checkpoint ? JSON.stringify(checkpoint) : null, generation, source, actorId ?? null, scope, initialFrom])).rows[0]!;
  await client.query('UPDATE platform_bindings SET next_sync_at=NULL,sync_blocked=NULL,sync_requested=false WHERE id=$1', [binding.id]);
  const jobId = await sendRun(client, boss, run); return { runId: run.id, jobId, merged: false };
}
export async function requestPersonalSync(bindingId: string, mode: 'backfill' | 'incremental', boss: PgBoss, range?: PersonalSyncRange, source: SyncSource = 'manual', actorId?: string) {
  return transaction(async client => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(user_id::text||':'||platform,73192405)) FROM platform_bindings WHERE id=$1`, [bindingId]);
    const binding = (await client.query<BindingRow>('SELECT b.* FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active WHERE b.id=$1 AND b.account_id IS NOT NULL FOR UPDATE OF b', [bindingId])).rows[0];
    if (!binding) throw new Error('NO_ACTIVE_BINDING');
    const result = await enqueuePersonalInTransaction(client, boss, binding, 'sync', mode, range, source, actorId);
    if (actorId) await client.query("INSERT INTO collection_audit_logs(actor_id,action,target,details) VALUES ($1,'sync_requested',$2,$3)", [actorId, binding.id, JSON.stringify({ ...result, source, mode })]);
    return result;
  });
}
export async function getSyncRun(id: string): Promise<SyncRow | null> { return (await getPool().query<SyncRow>('SELECT * FROM sync_runs WHERE id=$1', [id])).rows[0] ?? null; }
export async function claimSyncRun(id: string, batch: number, jobId: string) {
  return (await getPool().query("UPDATE sync_runs SET status='running',started_at=coalesce(started_at,now()) WHERE id=$1 AND batch=$2 AND job_id=$3 AND status='queued' RETURNING id", [id, batch, jobId])).rowCount === 1;
}
export async function getSyncCursor(accountId: string, mode: 'backfill' | 'incremental'): Promise<CursorRow | null> {
  return (await getPool().query<CursorRow>('SELECT * FROM sync_cursors WHERE account_id=$1 AND mode=$2', [accountId, mode])).rows[0] ?? null;
}
export async function readSyncCursor(accountId: string, mode: 'backfill' | 'incremental', runId?: string): Promise<CursorRow> {
  return transaction(async client => {
    if (runId) { await lockRunBinding(client, runId); await assertRunCollection(client, runId, accountId); }
    await client.query('INSERT INTO sync_cursors(account_id,mode) VALUES ($1,$2) ON CONFLICT DO NOTHING', [accountId, mode]);
    return (await client.query<CursorRow>('SELECT * FROM sync_cursors WHERE account_id=$1 AND mode=$2', [accountId, mode])).rows[0]!;
  });
}
export async function finishPersonalBatch(id: string, boss: PgBoss, options: { complete?: boolean; error?: unknown; paused?: boolean; retryDelay?: number; candidateState?: string }) {
  return transaction(async client => {
    await lockRunBinding(client, id);
    const run = (await client.query<SyncRow>('SELECT * FROM sync_runs WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
    if (run.status !== 'running') return;
    if (options.candidateState) await client.query('UPDATE platform_bindings SET candidate_state=$3,candidate_error=$4 WHERE id=$1 AND version=$2', [run.binding_id, run.binding_version, options.candidateState, JSON.stringify(options.error)]);
    if (options.complete || options.paused || (options.error && options.retryDelay === undefined)) {
      await client.query('UPDATE sync_runs SET status=$2,error=$3,finished_at=now() WHERE id=$1', [id, options.complete ? 'completed' : options.paused ? 'paused' : 'failed', options.error ? JSON.stringify(options.error) : null]);
      const code = options.error && typeof options.error === 'object' && 'code' in options.error ? String(options.error.code) : 'SYNC_FAILED';
      if (options.complete && run.kind === 'sync') await client.query(`UPDATE platform_bindings SET
        next_sync_at=CASE WHEN sync_requested OR ($3 AND NOT EXISTS (SELECT 1 FROM sync_cursors WHERE account_id=platform_bindings.account_id AND mode='incremental' AND initialized_at IS NOT NULL)) THEN now() ELSE now()+(SELECT sync_interval_minutes FROM collection_settings WHERE id=1)*interval '1 minute' END,
        sync_blocked=NULL,sync_requested=sync_requested OR (candidate IS NOT NULL AND candidate_state='pending') OR ($3 AND NOT EXISTS (SELECT 1 FROM sync_cursors WHERE account_id=platform_bindings.account_id AND mode='incremental' AND initialized_at IS NOT NULL))
        WHERE id=$1 AND version=$2`, [run.binding_id, run.binding_version, run.scope === 'range']);
      else if (!options.complete) await client.query('UPDATE platform_bindings SET next_sync_at=NULL,sync_blocked=$3 WHERE id=$1 AND version=$2', [run.binding_id, run.binding_version, code]);
      return;
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
    await assertCollectionAvailable(binding.platform, run.collection_generation, client);
    const active = (await client.query<SyncRow>("SELECT * FROM sync_runs WHERE binding_id=$1 AND kind=$2 AND status IN ('queued','running')", [run.binding_id, run.kind])).rows[0];
    if (active) {
      if (active.range_from?.getTime() !== run.range_from?.getTime() || active.range_to?.getTime() !== run.range_to?.getTime()) throw new Error('SYNC_RANGE_CONFLICT');
      return { runId: active.id, jobId: active.job_id, merged: true };
    }
    run.batch++;
    await client.query("UPDATE sync_runs SET status='queued',batch=$2,error=NULL,retries=$3,finished_at=NULL WHERE id=$1", [id, run.batch, resetRetries ? 0 : run.retries + 1]);
    if (run.kind === 'verify') await client.query("UPDATE platform_bindings SET candidate_state='pending',candidate_error=NULL WHERE id=$1", [run.binding_id]);
    await client.query('UPDATE platform_bindings SET sync_blocked=NULL,next_sync_at=NULL WHERE id=$1', [run.binding_id]);
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
      else if (changed.rowCount) await getPool().query("UPDATE platform_bindings SET next_sync_at=NULL,sync_blocked='INTERRUPTED' WHERE id=$1 AND version=$2", [run.binding_id, run.binding_version]);
    }
  }
  const recoverable = (await getPool().query<{ id: string }>(`SELECT r.id FROM sync_runs r JOIN platform_bindings b ON b.id=r.binding_id JOIN platform_connections c ON c.platform=b.platform AND c.id=CASE WHEN b.platform='qoj' THEN $1 ELSE $2 END WHERE r.status='paused' AND r.error->>'code' IN ('AUTH_REQUIRED','CHALLENGE_REQUIRED','RISK_CONTROL') AND c.state='ready' AND c.generation>coalesce((r.error->>'connectionGeneration')::int,-1) AND b.version=r.binding_version LIMIT 50`, [process.env.QOJ_CONNECTION_ID ?? 'qoj-lab', process.env.LUOGU_CONNECTION_ID ?? 'luogu-lab'])).rows;
  for (const row of recoverable) await retryPersonalRun(row.id, boss).catch(() => undefined);
  const resumed = (await getPool().query<{ id: string }>("SELECT id FROM sync_runs WHERE status='paused' AND error->>'code'='COLLECTION_PAUSED' LIMIT 50")).rows;
  for (const row of resumed) await retryPersonalRun(row.id, boss).catch(() => undefined);
}

export async function restartPersonalScan(id: string, incompatible = false) {
  await transaction(async client => {
    await lockRunBinding(client, id);
    await assertRunCollection(client, id);
    const run = (await client.query<SyncRow>('SELECT * FROM sync_runs WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
    if (incompatible && run.scope !== 'range') {
      await client.query("UPDATE sync_cursors SET initialized_at=NULL,checkpoint=NULL,cursor=NULL,version=version+1 WHERE account_id=$1 AND mode='incremental'", [run.account_id]);
      await client.query("UPDATE sync_runs SET scope='initial',initial_from=coalesce(initial_from,$2),scan_checkpoint=NULL WHERE id=$1", [id, defaultPersonalSyncRange().from]);
    } else if (incompatible) await client.query('UPDATE sync_runs SET scan_checkpoint=NULL WHERE id=$1', [id]);
    await client.query("UPDATE sync_runs SET scan_cursor=NULL,cursor_version=cursor_version+1,stop_reason='more',range_complete=false WHERE id=$1", [id]);
  });
}

/** Compatibility helper: bounded backfill checkpoints cannot initialize continuous sync. */
export async function seedIncrementalCheckpoint(accountId: string, runId?: string) {
  await transaction(async client => {
    if (runId) { await lockRunBinding(client, runId); await assertRunCollection(client, runId, accountId); }
    await client.query("INSERT INTO sync_cursors(account_id,mode) VALUES ($1,'incremental') ON CONFLICT DO NOTHING", [accountId]);
  });
}
