import type { PoolClient } from 'pg';
import { assertCollectionAvailable } from '../collection/settings';

export async function lockRunBinding(client: PoolClient, id: string) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(b.user_id::text||':'||b.platform,73192405)) FROM sync_runs r JOIN platform_bindings b ON b.id=r.binding_id WHERE r.id=$1`, [id]);
}
export async function assertRunCollection(client: PoolClient, id: string, accountId?: string) {
  const row = (await client.query<{ platform: string; collection_generation: number; account_id: string | null }>(`SELECT b.platform,r.collection_generation,r.account_id FROM sync_runs r JOIN platform_bindings b ON b.id=r.binding_id JOIN users u ON u.id=b.user_id AND u.active AND u.deleted_at IS NULL
    WHERE r.id=$1 AND r.status='running' AND r.binding_version=b.version AND r.account_id IS NOT DISTINCT FROM b.account_id`, [id])).rows[0];
  if (!row || (accountId !== undefined && row.account_id !== accountId)) throw new Error('STALE_COLLECTION');
  await assertCollectionAvailable(row.platform, row.collection_generation, client);
}
