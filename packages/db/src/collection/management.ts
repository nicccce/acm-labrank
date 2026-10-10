import type { PoolClient } from 'pg';
import type { PgBoss } from 'pg-boss';
import { getPool } from '../client';
import { enqueuePersonalInTransaction, type BindingRow } from '../personal';
import { collectionAvailability, collectionTransaction, configuredSyncRange, getCollectionSettings, type CollectionSettings, type SyncSource } from './settings';

export interface DispatchItem { bindingId: string; accountId: string | null; platform: string; runId?: string; jobId?: string | null; merged?: boolean; skipped?: string }
async function dispatchBindings(client: PoolClient, boss: PgBoss, bindings: BindingRow[], source: SyncSource, actorId?: string): Promise<DispatchItem[]> {
  const items: DispatchItem[] = [];
  for (const binding of bindings) {
    const item: DispatchItem = { bindingId: binding.id, accountId: binding.account_id, platform: binding.platform };
    const state = await collectionAvailability(binding.platform, client);
    if (state.reason) { items.push({ ...item, skipped: state.reason }); continue; }
    const kind = binding.candidate && binding.candidate_state === 'pending' ? 'verify' : 'sync';
    if (kind === 'sync' && !binding.account_id) { items.push({ ...item, skipped: 'NO_ACTIVE_BINDING' }); continue; }
    // Finish the saved scan before servicing another request for this binding.
    const active = await client.query<{ id: string; job_id: string | null }>("SELECT id,job_id FROM sync_runs WHERE binding_id=$1 AND status IN ('queued','running') LIMIT 1", [binding.id]);
    if (active.rows[0]) { items.push({ ...item, runId: active.rows[0].id, jobId: active.rows[0].job_id, merged: true }); continue; }
    items.push({ ...item, ...await enqueuePersonalInTransaction(client, boss, binding, kind, 'incremental', undefined, source, actorId) });
  }
  return items;
}
async function invalidatePlatforms(client: PoolClient, boss: PgBoss, platforms: string[]) {
  if (!platforms.length) return;
  await client.query('UPDATE collection_platform_state SET generation=generation+1 WHERE platform=ANY($1)', [platforms]);
  const jobs = (await client.query<{ queue: string; job_id: string | null }>(`UPDATE sync_runs r SET status='cancelled',finished_at=now(),error='{"code":"STALE_COLLECTION","message":"采集设置或数据已变化","action":"none"}'::jsonb
    FROM platform_bindings b WHERE r.binding_id=b.id AND b.platform=ANY($1) AND r.status IN ('queued','running','paused','failed') RETURNING r.queue,r.job_id`, [platforms])).rows;
  for (const queue of new Set(jobs.map(j => j.queue))) {
    const ids = jobs.filter(j => j.queue === queue && j.job_id).map(j => j.job_id!);
    if (ids.length) await boss.cancel(queue, ids, { db: { executeSql: (sql, values) => client.query(sql, values) } });
  }
  // A cancelled bounded scan cannot lend its checkpoint to a new generation.
  await client.query("UPDATE sync_cursors SET cursor=NULL,version=version+1 WHERE account_id IN (SELECT id FROM platform_accounts WHERE platform=ANY($1))", [platforms]);
  await client.query('UPDATE platform_bindings SET sync_requested=true,sync_blocked=NULL,next_sync_at=now() WHERE platform=ANY($1)', [platforms]);
}
export async function saveCollectionSettings(input: Omit<CollectionSettings, 'updatedAt'>, actorId: string, boss: PgBoss) {
  return collectionTransaction(async client => {
    const old = await getCollectionSettings(client);
    if (old.version !== input.version) throw new Error('VERSION_CONFLICT');
    const affected = ['codeforces', 'luogu', 'qoj'].filter(p => old.platforms.includes(p) !== input.platforms.includes(p));
    await client.query('UPDATE collection_settings SET platforms=$1,auto_sync_enabled=$2,sync_interval_minutes=$3,score_range=$4,version=version+1,updated_at=now(),updated_by=$5 WHERE id=1', [input.platforms, input.autoSyncEnabled, input.syncIntervalMinutes, JSON.stringify(input.scoreRange), actorId]);
    await invalidatePlatforms(client, boss, affected);
    if (old.syncIntervalMinutes !== input.syncIntervalMinutes) await client.query(`UPDATE platform_bindings b SET next_sync_at=coalesce((SELECT max(finished_at) FROM sync_runs WHERE binding_id=b.id AND kind='sync' AND status='completed'),now())+$1*interval '1 minute'
      WHERE sync_blocked IS NULL AND NOT sync_requested AND NOT EXISTS(SELECT 1 FROM sync_runs r WHERE r.binding_id=b.id AND r.status IN ('queued','running'))`, [input.syncIntervalMinutes]);
    if (!old.autoSyncEnabled && input.autoSyncEnabled) await client.query('UPDATE platform_bindings SET next_sync_at=now() WHERE account_id IS NOT NULL AND sync_blocked IS NULL');
    const bindings = (await client.query<BindingRow>(`SELECT b.* FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active AND u.deleted_at IS NULL WHERE b.platform=ANY($1) AND (b.sync_requested OR ($2 AND b.next_sync_at<=now() AND b.sync_blocked IS NULL)) ORDER BY b.id FOR UPDATE OF b`, [input.platforms, input.autoSyncEnabled])).rows;
    const schedulingChanged = affected.length > 0 || old.autoSyncEnabled !== input.autoSyncEnabled || old.syncIntervalMinutes !== input.syncIntervalMinutes;
    const items = schedulingChanged ? await dispatchBindings(client, boss, bindings, 'settings', actorId) : [];
    await client.query("INSERT INTO collection_audit_logs(actor_id,action,target,details) VALUES ($1,'collection_settings_updated','collection',$2)", [actorId, JSON.stringify({ ...input, version: old.version + 1 })]);
    return { settings: await getCollectionSettings(client), items };
  }, true);
}
export async function dispatchDueCollection(boss: PgBoss, now = new Date()) {
  return collectionTransaction(async client => {
    const settings = await getCollectionSettings(client);
    const bindings = (await client.query<BindingRow>(`SELECT b.* FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active AND u.deleted_at IS NULL
      WHERE b.platform=ANY($1) AND (b.account_id IS NOT NULL OR (b.candidate IS NOT NULL AND b.candidate_state='pending'))
      AND (b.sync_requested OR ($2 AND b.sync_blocked IS NULL AND b.next_sync_at<=$3))
      AND NOT EXISTS(SELECT 1 FROM sync_runs r WHERE r.binding_id=b.id AND r.status IN ('queued','running'))
      ORDER BY b.next_sync_at NULLS FIRST,b.id LIMIT 100 FOR UPDATE OF b SKIP LOCKED`, [settings.platforms, settings.autoSyncEnabled, now])).rows;
    return dispatchBindings(client, boss, bindings, 'scheduled');
  });
}
export async function collectionPlatformSummary() {
  return (await getPool().query(`SELECT p.platform,p.generation,
    (SELECT count(*)::int FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active AND u.deleted_at IS NULL WHERE b.platform=p.platform AND b.account_id IS NOT NULL) AS "bindingCount",
    (SELECT count(*)::int FROM problems WHERE platform=p.platform) AS "problemCount",
    (SELECT count(*)::int FROM submissions WHERE platform=p.platform) AS "submissionCount",
    (SELECT max(c.last_success_at) FROM sync_cursors c JOIN platform_accounts a ON a.id=c.account_id WHERE a.platform=p.platform) AS "lastSuccessAt",
    (SELECT min(b.next_sync_at) FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active AND u.deleted_at IS NULL WHERE b.platform=p.platform AND b.account_id IS NOT NULL AND b.sync_blocked IS NULL) AS "nextSyncAt",
    (SELECT count(*)::int FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active AND u.deleted_at IS NULL WHERE b.platform=p.platform AND b.sync_blocked IS NOT NULL) AS "blockedCount"
    FROM collection_platform_state p ORDER BY p.platform`)).rows;
}
export async function resetCollectionPlatforms(input: { platforms: string[]; version: number; requestId: string }, actorId: string, boss: PgBoss) {
  return collectionTransaction(async client => {
    const signature = { platforms: [...input.platforms].sort(), version: input.version };
    const previous = (await client.query<{ actor_id: string; input: typeof signature; result: unknown }>('SELECT actor_id,input,result FROM collection_reset_requests WHERE id=$1', [input.requestId])).rows[0];
    if (previous) {
      if (previous.actor_id !== actorId || JSON.stringify(previous.input.platforms) !== JSON.stringify(signature.platforms) || previous.input.version !== signature.version) throw new Error('RESET_REQUEST_CONFLICT');
      return previous.result;
    }
    const settings = await getCollectionSettings(client);
    if (settings.version !== input.version) throw new Error('VERSION_CONFLICT');
    // Preflight every selected platform before deleting any facts.
    const bindings = (await client.query<BindingRow>(`SELECT b.* FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active AND u.deleted_at IS NULL WHERE b.platform=ANY($1) AND b.account_id IS NOT NULL ORDER BY b.id FOR UPDATE OF b`, [input.platforms])).rows;
    for (const platform of input.platforms) {
      const available = await collectionAvailability(platform, client);
      if (available.reason) throw new Error(available.reason);
      if (!bindings.some(b => b.platform === platform)) throw new Error('NO_ACTIVE_BINDING');
    }
    await invalidatePlatforms(client, boss, input.platforms);
    const submissions = await client.query('DELETE FROM submissions WHERE platform=ANY($1)', [input.platforms]);
    const problems = await client.query('DELETE FROM problems WHERE platform=ANY($1)', [input.platforms]);
    await client.query('DELETE FROM sync_cursors WHERE account_id IN (SELECT id FROM platform_accounts WHERE platform=ANY($1))', [input.platforms]);
    const items: DispatchItem[] = [];
    const range = configuredSyncRange(settings);
    for (const binding of bindings) items.push({ bindingId: binding.id, accountId: binding.account_id, platform: binding.platform, ...await enqueuePersonalInTransaction(client, boss, binding, 'sync', 'backfill', range, 'rebuild', actorId) });
    const result = { requestId: input.requestId, platforms: input.platforms, deleted: { submissions: submissions.rowCount, problems: problems.rowCount }, items };
    await client.query('INSERT INTO collection_reset_requests(id,actor_id,input,result) VALUES ($1,$2,$3,$4)', [input.requestId, actorId, JSON.stringify(signature), JSON.stringify(result)]);
    await client.query("INSERT INTO collection_audit_logs(actor_id,action,target,details) VALUES ($1,'collection_reset','collection',$2)", [actorId, JSON.stringify(result)]);
    return result;
  }, true);
}
export async function listPersonalSyncRuns(input: { platform?: string; status?: string; limit: number; before?: { createdAt: string; id: string } }) {
  return (await getPool().query(`SELECT r.*,b.platform,a.handle,u.username FROM sync_runs r JOIN platform_bindings b ON b.id=r.binding_id JOIN users u ON u.id=b.user_id LEFT JOIN platform_accounts a ON a.id=r.account_id
    WHERE ($1::text IS NULL OR b.platform=$1) AND ($2::text IS NULL OR r.status=$2) AND ($3::timestamptz IS NULL OR (r.created_at,r.id)<($3,$4::uuid))
    ORDER BY r.created_at DESC,r.id DESC LIMIT $5`, [input.platform ?? null, input.status ?? null, input.before?.createdAt ?? null, input.before?.id ?? null, input.limit])).rows;
}
