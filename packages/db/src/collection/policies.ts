import { getPool } from '../client';

export interface PlatformPolicy { platform: string; minIntervalMs: number; maxIntervalMs: number; version: number; updatedAt: Date }
const columns = 'platform,min_interval_ms AS "minIntervalMs",max_interval_ms AS "maxIntervalMs",version,updated_at AS "updatedAt"';
export async function listPlatformPolicies(): Promise<PlatformPolicy[]> {
  return (await getPool().query<PlatformPolicy>(`SELECT ${columns} FROM platform_request_policies ORDER BY platform`)).rows;
}
export async function initializePlatformPolicies() {
  for (const [platform, env, floor, maximum] of [['codeforces', 'CF_MIN_INTERVAL_MS', 2000, 3000], ['luogu', 'LUOGU_MIN_INTERVAL_MS', 3000, 5000], ['qoj', 'QOJ_MIN_INTERVAL_MS', 3000, 5000]] as const) {
    const minimum = Number(process.env[env] ?? floor);
    if (!Number.isSafeInteger(minimum) || minimum < (platform === 'codeforces' ? 2000 : 1000) || minimum > 60000) throw new Error('INVALID_INITIAL_PLATFORM_POLICY');
    await getPool().query('INSERT INTO platform_request_policies(platform,min_interval_ms,max_interval_ms) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [platform, minimum, Math.max(minimum, maximum)]);
  }
}
export async function updatePlatformPolicy(input: { platform: string; minIntervalMs: number; maxIntervalMs: number; version: number; actorId: string }): Promise<PlatformPolicy | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<PlatformPolicy>(`UPDATE platform_request_policies SET min_interval_ms=$2,max_interval_ms=$3,version=version+1,updated_at=now(),updated_by=$5 WHERE platform=$1 AND version=$4 RETURNING ${columns}`, [input.platform, input.minIntervalMs, input.maxIntervalMs, input.version, input.actorId]);
    if (result.rowCount) await client.query('INSERT INTO collection_audit_logs(actor_id,action,target,details) VALUES ($1,$2,$3,$4)', [input.actorId, 'rate_limit_updated', input.platform, JSON.stringify({ minIntervalMs: input.minIntervalMs, maxIntervalMs: input.maxIntervalMs, version: result.rows[0]!.version })]);
    await client.query('COMMIT');
    return result.rows[0] ?? null;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
