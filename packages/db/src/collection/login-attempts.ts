import { getPool } from '../client';

export interface LoginAttempt {
  id: string; session_id: string; connection_id: string; generation: number; state: string; version: number;
  encrypted_context: string | null; image: string | null; content_type: string | null; expires_at: Date;
}
export async function createLoginAttempt(input: { id: string; sessionId: string; connectionId: string; generation: number }) {
  await getPool().query(`INSERT INTO platform_login_attempts(id,session_id,connection_id,generation,state,expires_at) VALUES ($1,$2,$3,$4,'processing',now()+interval '10 minutes')`, [input.id, input.sessionId, input.connectionId, input.generation]);
}
export async function getLoginAttempt(id: string, sessionId: string): Promise<LoginAttempt | null> {
  return (await getPool().query<LoginAttempt>(`SELECT a.* FROM platform_login_attempts a JOIN sessions s ON s.id=a.session_id JOIN users u ON u.id=s.user_id WHERE a.id=$1 AND a.session_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND u.role='admin'`, [id, sessionId])).rows[0] ?? null;
}
export async function claimLoginAttempt(id: string, sessionId: string, version: number) {
  return (await getPool().query(`UPDATE platform_login_attempts SET state='processing' WHERE id=$1 AND session_id=$2 AND version=$3 AND state='awaiting_input' AND expires_at>now() RETURNING id`, [id, sessionId, version])).rowCount === 1;
}
export async function saveLoginChallenge(id: string, sessionId: string, oldVersion: number, input: { version: number; context: string; image: string; contentType: string }) {
  return (await getPool().query(`UPDATE platform_login_attempts a SET state='awaiting_input',version=$4,encrypted_context=$5,image=$6,content_type=$7 WHERE id=$1 AND session_id=$2 AND version=$3 AND state='processing' AND expires_at>now() AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND u.role='admin') AND EXISTS (SELECT 1 FROM platform_connections c WHERE c.id=a.connection_id AND c.generation=a.generation) RETURNING id`, [id, sessionId, oldVersion, input.version, input.context, input.image, input.contentType])).rowCount === 1;
}
export async function endLoginAttempt(id: string, sessionId: string, state: 'cancelled' | 'failed') {
  await getPool().query(`UPDATE platform_login_attempts SET state=$3,version=version+1,encrypted_context=NULL,image=NULL,content_type=NULL WHERE id=$1 AND session_id=$2 AND state IN ('processing','awaiting_input')`, [id, sessionId, state]);
}
export async function expireLoginAttempts() {
  await getPool().query(`UPDATE platform_login_attempts a SET state='expired',encrypted_context=NULL,image=NULL,content_type=NULL WHERE state IN ('processing','awaiting_input') AND (expires_at<=now() OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id=a.session_id AND s.revoked_at IS NULL AND s.expires_at>now()))`);
  await getPool().query("DELETE FROM platform_login_attempts WHERE expires_at<now()-interval '1 day'");
}
export async function getCollectionControl() {
  await getPool().query('INSERT INTO collection_control(id) VALUES (1) ON CONFLICT DO NOTHING');
  return (await getPool().query<{ enabled: boolean; version: number }>('SELECT enabled,version FROM collection_control WHERE id=1')).rows[0]!;
}
export async function setCollectionControl(enabled: boolean, version: number, actorId: string) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('UPDATE collection_control SET enabled=$1,version=version+1,updated_at=now() WHERE id=1 AND version=$2 RETURNING enabled,version', [enabled, version]);
    if (result.rowCount) await client.query("INSERT INTO collection_audit_logs(actor_id,action,target,details) VALUES ($1,'collection_control','collection',$2)", [actorId, JSON.stringify({ enabled })]);
    await client.query('COMMIT'); return result.rows[0] ?? null;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export async function disconnectCollectionConnection(id: string, platform: string, actorId: string) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE platform_connections SET generation=generation+1,cookie_revision=cookie_revision+1,state='auth_required',collector=NULL,verified_at=NULL,reading_verified_at=NULL,updated_at=now() WHERE id=$1 AND platform=$2", [id, platform]);
    await client.query('DELETE FROM connector_sessions WHERE id IN ($1,$2) AND platform=$3', [id, `${id}:browser`, platform]);
    await client.query("UPDATE platform_login_attempts SET state='cancelled',version=version+1,encrypted_context=NULL,image=NULL WHERE connection_id=$1 AND state IN ('processing','awaiting_input')", [id]);
    await client.query("INSERT INTO collection_audit_logs(actor_id,action,target) VALUES ($1,'connection_disconnected',$2)", [actorId, id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
