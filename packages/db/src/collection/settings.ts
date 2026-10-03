import type { PoolClient } from 'pg';
import { getPool } from '../client';

export type ScoreRange = { kind: 'rolling'; days: 7 | 30 } | { kind: 'fixed'; from: string; to: string };
export interface CollectionSettings { platforms: string[]; autoSyncEnabled: boolean; syncIntervalMinutes: number; scoreRange: ScoreRange; version: number; updatedAt: Date }
export type SyncSource = 'manual' | 'scheduled' | 'binding' | 'settings' | 'rebuild';
const columns = 'platforms,auto_sync_enabled AS "autoSyncEnabled",sync_interval_minutes AS "syncIntervalMinutes",score_range AS "scoreRange",version,updated_at AS "updatedAt"';

// All personal writes take the shared lock first. Settings changes and resets take
// the exclusive lock, so no page can cross a generation change or a deletion.
export async function collectionTransaction<T>(fn: (client: PoolClient) => Promise<T>, exclusive = false): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(exclusive ? 'SELECT pg_advisory_xact_lock(73192407)' : 'SELECT pg_advisory_xact_lock_shared(73192407)');
    const value = await fn(client); await client.query('COMMIT'); return value;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export async function getCollectionSettings(client: Pick<PoolClient, 'query'> = getPool()): Promise<CollectionSettings> {
  const row = (await client.query<CollectionSettings>(`SELECT ${columns} FROM collection_settings WHERE id=1`)).rows[0];
  if (!row) throw new Error('COLLECTION_SETTINGS_MISSING'); return row;
}
export async function initializeCollectionSettings() {
  await getPool().query('INSERT INTO collection_settings(id,auto_sync_enabled) VALUES (1,$1) ON CONFLICT DO NOTHING', [process.env.SYNC_ENABLED === 'true']);
  await getPool().query("INSERT INTO collection_platform_state(platform) VALUES ('codeforces'),('luogu'),('qoj') ON CONFLICT DO NOTHING");
}
export function configuredSyncRange(settings: Pick<CollectionSettings, 'scoreRange'>, now = new Date()) {
  const range = settings.scoreRange;
  const midnight = Math.floor((now.getTime() + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
  return range.kind === 'rolling'
    ? { from: new Date(midnight - (range.days - 1) * 86400000), to: new Date(midnight + 86400000) }
    : { from: new Date(`${range.from}T00:00:00+08:00`), to: new Date(Date.parse(`${range.to}T00:00:00+08:00`) + 86400000) };
}
export function collectionConnectionId(platform: string) {
  return process.env[platform === 'qoj' ? 'QOJ_CONNECTION_ID' : 'LUOGU_CONNECTION_ID'] ?? `${platform}-lab`;
}
export async function collectionAvailability(platform: string, client: Pick<PoolClient, 'query'> = getPool(), expectedGeneration?: number): Promise<{ reason: string | null; generation: number }> {
  const row = (await client.query<{ enabled: boolean; selected: boolean; generation: number; state: string | null }>(`SELECT c.enabled,$1=ANY(s.platforms) AS selected,p.generation,pc.state
    FROM collection_control c CROSS JOIN collection_settings s JOIN collection_platform_state p ON p.platform=$1
    LEFT JOIN platform_connections pc ON pc.platform=$1 AND pc.id=$2 WHERE c.id=1 AND s.id=1`, [platform, collectionConnectionId(platform)])).rows[0];
  if (!row) throw new Error('COLLECTION_SETTINGS_MISSING');
  const reason = !row.enabled ? 'COLLECTION_PAUSED' : !row.selected ? 'PLATFORM_DISABLED' : expectedGeneration !== undefined && expectedGeneration !== row.generation ? 'STALE_COLLECTION' : platform !== 'codeforces' && row.state !== 'ready' ? 'AUTH_REQUIRED' : null;
  return { reason, generation: row.generation };
}
export async function assertCollectionAvailable(platform: string, generation?: number, client: Pick<PoolClient, 'query'> = getPool()) {
  const state = await collectionAvailability(platform, client, generation);
  if (state.reason) throw new Error(state.reason); return state.generation;
}
export async function assertPersonalRunAvailable(id: string) {
  const row = (await getPool().query<{ platform: string; collection_generation: number; status: string }>('SELECT b.platform,r.collection_generation,r.status FROM sync_runs r JOIN platform_bindings b ON b.id=r.binding_id WHERE r.id=$1', [id])).rows[0];
  if (!row || row.status !== 'running') throw new Error('STALE_COLLECTION');
  await assertCollectionAvailable(row.platform, row.collection_generation);
}
