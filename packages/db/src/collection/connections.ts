import { getPool } from '../client';

export interface CollectionConnection { id: string; platform: string; state: string; generation: number; cookieRevision: number; collector: string | null; verifiedAt: Date | null }
const columns = 'id,platform,state,generation,cookie_revision AS "cookieRevision",collector,verified_at AS "verifiedAt"';
export async function ensureCollectionConnection(id: string, platform: string): Promise<CollectionConnection> {
  await getPool().query('INSERT INTO platform_connections(id,platform) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, platform]);
  const result = await getPool().query<CollectionConnection>(`SELECT ${columns} FROM platform_connections WHERE id=$1 AND platform=$2`, [id, platform]);
  if (!result.rowCount) throw new Error('CONNECTION_PLATFORM_MISMATCH');
  return result.rows[0]!;
}
export async function listCollectionConnections(): Promise<CollectionConnection[]> {
  return (await getPool().query<CollectionConnection>(`SELECT ${columns} FROM platform_connections ORDER BY platform,id`)).rows;
}
export async function acquireConnectionTask(id: string, token: string, leaseMs = 45000): Promise<boolean> {
  const result = await getPool().query(`UPDATE platform_connections SET task_token=$2,task_expires_at=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 AND (task_token IS NULL OR task_expires_at<=clock_timestamp()) RETURNING id`, [id, token, leaseMs]);
  return result.rowCount === 1;
}
export async function renewConnectionTask(id: string, token: string, leaseMs = 45000): Promise<boolean> {
  const result = await getPool().query(`UPDATE platform_connections SET task_expires_at=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 AND task_token=$2 AND task_expires_at>clock_timestamp() RETURNING id`, [id, token, leaseMs]);
  return result.rowCount === 1;
}
export async function releaseConnectionTask(id: string, token: string) {
  await getPool().query('UPDATE platform_connections SET task_token=NULL,task_expires_at=NULL WHERE id=$1 AND task_token=$2', [id, token]);
}
export async function verifyCollectionConnection(id: string, generation: number, collector: string, token?: string): Promise<boolean> {
  const result = await getPool().query(`UPDATE platform_connections SET state='ready',generation=generation+1,collector=$3,verified_at=now(),updated_at=now() WHERE id=$1 AND generation=$2 AND ($4::text IS NULL OR (task_token=$4 AND task_expires_at>clock_timestamp())) RETURNING id`, [id, generation, collector, token ?? null]);
  return result.rowCount === 1;
}
export async function setCollectionConnectionFailure(id: string, generation: number, state: 'auth_required' | 'human_input_required') {
  await getPool().query('UPDATE platform_connections SET state=$3,updated_at=now() WHERE id=$1 AND generation=$2', [id, generation, state]);
}
