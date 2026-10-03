import { getPool } from '../client';

export async function loadConnectorSession(id: string, platform: string): Promise<string | null> {
  const r = await getPool().query('SELECT encrypted_session FROM connector_sessions WHERE id=$1 AND platform=$2', [id, platform]);
  return r.rows[0]?.encrypted_session ?? null;
}
export async function saveConnectorSession(id: string, platform: string, encryptedSession: string, leaseToken: string, signal?: AbortSignal, expectedGeneration?: number, promotion?: { collector: string; attempt?: { id: string; version: number; sessionId: string } }) {
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
    if (promotion?.attempt) {
      const a = promotion.attempt;
      const active = await client.query(`SELECT a.id FROM platform_login_attempts a JOIN sessions s ON s.id=a.session_id JOIN users u ON u.id=s.user_id WHERE a.id=$1 AND a.version=$2 AND a.session_id=$3 AND a.state='processing' AND a.expires_at>clock_timestamp() AND a.connection_id=$4 AND a.generation=$5 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.active AND u.role='admin' FOR UPDATE OF a,s,u`, [a.id, a.version, a.sessionId, logicalId, expectedGeneration]);
      if (active.rowCount !== 1) throw new Error('LOGIN_ATTEMPT_STALE');
    }
    signal?.throwIfAborted();
    const result = await client.query(`INSERT INTO connector_sessions(id,platform,encrypted_session) VALUES ($1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET encrypted_session=$3,updated_at=now() WHERE connector_sessions.platform=$2 RETURNING id`, [id, platform, encryptedSession]);
    if (result.rowCount !== 1) throw new Error('SESSION_PLATFORM_MISMATCH');
    if (expectedGeneration !== undefined) {
      await client.query(`UPDATE platform_connections SET cookie_revision=cookie_revision+1,updated_at=now()${promotion ? ",generation=generation+1,state='ready',verified_at=now(),reading_verified_at=NULL,collector=$2" : ''} WHERE id=$1`, promotion ? [logicalId, promotion.collector] : [logicalId]);
    }
    const valid = await client.query(`SELECT 1 FROM platform_request_limits WHERE platform=$1 AND lease_token=$2
      AND lease_expires_at>clock_timestamp()`, [platform, leaseToken]);
    if (valid.rowCount !== 1) throw new Error('SESSION_LEASE_LOST');
    if (promotion?.attempt) {
      const active = await client.query(`UPDATE platform_login_attempts SET state='succeeded',encrypted_context=NULL,image=NULL,content_type=NULL WHERE id=$1 AND expires_at>clock_timestamp() RETURNING id`, [promotion.attempt.id]);
      if (active.rowCount !== 1) throw new Error('LOGIN_ATTEMPT_STALE');
    }
    signal?.throwIfAborted();
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
