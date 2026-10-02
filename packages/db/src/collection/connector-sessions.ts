import { getPool } from '../client';

export async function loadConnectorSession(id: string, platform: string): Promise<string | null> {
  const r = await getPool().query('SELECT encrypted_session FROM connector_sessions WHERE id=$1 AND platform=$2', [id, platform]);
  return r.rows[0]?.encrypted_session ?? null;
}
export async function saveConnectorSession(id: string, platform: string, encryptedSession: string, leaseToken: string, signal?: AbortSignal, expectedGeneration?: number, promotion?: { collector: string }) {
  // Lock the live lease while storing the rotated jar. Losing ownership rejects the write.
  const client = await getPool().connect();
  try {
    signal?.throwIfAborted();
    await client.query('BEGIN');
    const lease = await client.query(`SELECT 1 FROM platform_request_limits WHERE platform=$1 AND lease_token=$2
      AND lease_expires_at>clock_timestamp() FOR UPDATE`, [platform, leaseToken]);
    if (lease.rowCount !== 1) throw new Error('SESSION_LEASE_LOST');
    const logicalId = platform === 'qoj' && id.endsWith(':browser') ? id.slice(0, -8) : id;
    if (expectedGeneration !== undefined) {
      const connection = await client.query('SELECT 1 FROM platform_connections WHERE id=$1 AND platform=$2 AND generation=$3 FOR UPDATE', [logicalId, platform, expectedGeneration]);
      if (connection.rowCount !== 1) throw new Error('SESSION_GENERATION_CHANGED');
    }
    signal?.throwIfAborted();
    const result = await client.query(`INSERT INTO connector_sessions(id,platform,encrypted_session) VALUES ($1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET encrypted_session=$3,updated_at=now() WHERE connector_sessions.platform=$2 RETURNING id`, [id, platform, encryptedSession]);
    if (result.rowCount !== 1) throw new Error('SESSION_PLATFORM_MISMATCH');
    if (expectedGeneration !== undefined) {
      await client.query(`UPDATE platform_connections SET cookie_revision=cookie_revision+1,updated_at=now()${promotion ? ",generation=generation+1,state='ready',verified_at=now(),collector=$2" : ''} WHERE id=$1`, promotion ? [logicalId, promotion.collector] : [logicalId]);
    }
    const valid = await client.query(`SELECT 1 FROM platform_request_limits WHERE platform=$1 AND lease_token=$2
      AND lease_expires_at>clock_timestamp()`, [platform, leaseToken]);
    if (valid.rowCount !== 1) throw new Error('SESSION_LEASE_LOST');
    signal?.throwIfAborted();
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
