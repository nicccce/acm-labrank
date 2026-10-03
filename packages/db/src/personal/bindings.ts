import { getPool } from '../client';
import { collectionAvailability, assertCollectionAvailable, collectionTransaction as transaction } from '../collection/settings';
import { enqueuePersonalInTransaction } from './sync';
import { rebuildAttributions } from './facts';
import { lockRunBinding, assertRunCollection } from './locks';
import { accountKey, type BindingRow, type SyncRow, type PersonalPlatform } from './types';
import type { PgBoss } from 'pg-boss';

export async function memberProfile(id: string) {
  return (await getPool().query<{ id: string; username: string; realName: string | null; verifiedCfHandle: string | null; role: 'member' | 'admin' }>(`SELECT u.id,u.username,u.real_name AS "realName",u.role,a.handle AS "verifiedCfHandle" FROM users u LEFT JOIN platform_bindings b ON b.user_id=u.id AND b.platform='codeforces' LEFT JOIN platform_accounts a ON a.id=b.account_id WHERE u.id=$1 AND u.active`, [id])).rows[0] ?? null;
}
export async function updateMemberName(id: string, name: string | null) { await getPool().query('UPDATE users SET real_name=$2 WHERE id=$1', [id, name]); }
export async function listBindings(userId: string) {
  return (await getPool().query(`SELECT b.*,a.handle,a.external_id,c.cursor,c.history_complete,coalesce(ci.coverage,c.coverage,'unknown') AS coverage,c.last_success_at,ci.initialized_at,(SELECT initial_from FROM sync_runs WHERE account_id=b.account_id AND scope='initial' ORDER BY created_at DESC LIMIT 1) AS initial_from,(SELECT scope FROM sync_runs WHERE binding_id=b.id AND kind='sync' ORDER BY created_at DESC LIMIT 1) AS latest_scope,(SELECT max(last_success_at) FROM sync_cursors WHERE account_id=b.account_id) AS latest_success FROM platform_bindings b LEFT JOIN platform_accounts a ON a.id=b.account_id LEFT JOIN sync_cursors c ON c.account_id=b.account_id AND c.mode='backfill' LEFT JOIN sync_cursors ci ON ci.account_id=b.account_id AND ci.mode='incremental' WHERE b.user_id=$1 ORDER BY b.platform`, [userId])).rows;
}
export async function getBinding(id: string): Promise<BindingRow | null> { return (await getPool().query<BindingRow>('SELECT b.*,a.handle,a.external_id FROM platform_bindings b LEFT JOIN platform_accounts a ON a.id=b.account_id WHERE b.id=$1', [id])).rows[0] ?? null; }
export async function listSyncTargets(accountIds?: string[], platforms?: string[]): Promise<BindingRow[]> {
  return (await getPool().query<BindingRow>(`SELECT b.*,a.handle,a.external_id FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active JOIN platform_accounts a ON a.id=b.account_id WHERE ($1::uuid[] IS NULL OR b.account_id=ANY($1)) AND ($2::text[] IS NULL OR b.platform=ANY($2)) ORDER BY b.id`, [accountIds ?? null, platforms ?? null])).rows;
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
    const available = await collectionAvailability(platform, client);
    if (available.reason) { await client.query('UPDATE platform_bindings SET sync_requested=true,next_sync_at=now() WHERE id=$1', [binding.id]); return { bindingId: binding.id, version: binding.version, state: 'pending', runId: null, jobId: null, merged: false, skipped: available.reason }; }
    return { bindingId: binding.id, version: binding.version, state: 'pending', ...await enqueuePersonalInTransaction(client, boss, binding, 'verify', 'backfill') };
  });
}
export async function activateBinding(runId: string, account: { platform: string; kind: string; handle: string; externalId: string | null; resolutionEvidence?: { requestedHandle: string; historicHandlesChecked: boolean } }, boss: PgBoss) {
  return transaction(async client => {
    await lockRunBinding(client, runId);
    const run = (await client.query<SyncRow>('SELECT * FROM sync_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0]!;
    const binding = (await client.query<BindingRow>('SELECT b.* FROM platform_bindings b JOIN users u ON u.id=b.user_id AND u.active WHERE b.id=$1 FOR UPDATE OF b', [run.binding_id])).rows[0];
    if (!binding || binding.version !== run.binding_version || run.status !== 'running') throw new Error('STALE_BINDING');
    await assertCollectionAvailable(binding.platform, run.collection_generation, client);
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
    await rebuildAttributions(client, binding.platform, { accountIds: [...new Set([binding.account_id, accountId].filter((id): id is string => !!id))] });
    await client.query("UPDATE sync_runs SET status='completed',account_id=$2,finished_at=now() WHERE id=$1", [runId, accountId]);
    binding.account_id = accountId;
    return enqueuePersonalInTransaction(client, boss, binding, 'sync', 'incremental');
  });
}
export async function unbindAccount(userId: string, platform: string) {
  await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,73192405))', [`${userId}:${platform}`]);
    const previous = (await client.query<{ account_id: string | null }>('SELECT account_id FROM platform_bindings WHERE user_id=$1 AND platform=$2 FOR UPDATE', [userId, platform])).rows[0];
    await client.query('UPDATE platform_bindings SET account_id=NULL,candidate=NULL,candidate_state=NULL,candidate_error=NULL,version=version+1,next_sync_at=NULL,sync_requested=false,sync_blocked=NULL WHERE user_id=$1 AND platform=$2', [userId, platform]);
    await client.query("UPDATE sync_runs SET status='cancelled',finished_at=now() WHERE binding_id IN (SELECT id FROM platform_bindings WHERE user_id=$1 AND platform=$2) AND status IN ('queued','running','paused','failed')", [userId, platform]);
    await rebuildAttributions(client, platform, { accountIds: previous?.account_id ? [previous.account_id] : [] });
  });
}
export async function refreshVerifiedIdentity(bindingId: string, version: number, account: { platform: string; kind: string; handle: string; externalId: string | null; resolutionEvidence?: { requestedHandle: string; historicHandlesChecked: boolean } }, runId?: string) {
  return transaction(async client => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(user_id::text||':'||platform,73192405)) FROM platform_bindings WHERE id=$1`, [bindingId]);
    if (runId) await assertRunCollection(client, runId);
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
      await client.query("UPDATE sync_cursors SET cursor=NULL,checkpoint=NULL,initialized_at=NULL,history_complete=false,version=version+1 WHERE account_id=$1", [binding.account_id]);
      await client.query("UPDATE sync_runs SET scan_cursor=NULL,scan_checkpoint=NULL,cursor_version=cursor_version+1,stop_reason='more',range_complete=false,scope=CASE WHEN scope='range' THEN scope ELSE 'initial' END,initial_from=CASE WHEN scope='range' THEN NULL ELSE (date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai')-interval '29 days') AT TIME ZONE 'Asia/Shanghai' END WHERE account_id=$1 AND status IN ('queued','running','paused','failed')", [binding.account_id]);
    }
    await client.query('UPDATE platform_accounts SET handle=$2 WHERE id=$1', [binding.account_id, account.handle]);
    await rebuildAttributions(client, binding.platform, { accountIds: [binding.account_id!] });
    return account.platform === 'codeforces';
  });
}
