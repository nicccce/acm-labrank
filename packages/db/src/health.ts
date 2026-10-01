import { hostname } from 'node:os';
import { getPool } from './client';

// Increment when adding a business migration. Older/newer schemas require an explicit deployment.
export const EXPECTED_MIGRATIONS = 1;
// pg-boss 12.35.1 uses schema 43; update together with the locked library.
export const EXPECTED_QUEUE_SCHEMA = 43;

export async function checkDatabaseReady(): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(`SELECT to_regclass('public.users') AS users,
    to_regclass('public.sessions') AS sessions,
    to_regclass('public.runtime_heartbeats') AS heartbeats,
    to_regclass('pgboss.version') AS queue,
    to_regclass('drizzle.__drizzle_migrations') AS migrations`);
  if (Object.values(result.rows[0]).some((value) => value === null)) return false;
  const count = await pool.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations');
  const queue = await pool.query('SELECT version FROM pgboss.version');
  return count.rows[0].count === EXPECTED_MIGRATIONS && Number(queue.rows[0]?.version) === EXPECTED_QUEUE_SCHEMA;
}
export async function writeWorkerHeartbeat() {
  await getPool().query(`INSERT INTO runtime_heartbeats(instance_id, service, updated_at)
    VALUES ($1, 'worker', now()) ON CONFLICT(instance_id) DO UPDATE SET updated_at = now()`, [hostname()]);
}
export async function checkWorkerReady() {
  if (!await checkDatabaseReady()) return false;
  const result = await getPool().query(`SELECT 1 FROM runtime_heartbeats
    WHERE instance_id = $1 AND service = 'worker' AND updated_at > now() - interval '45 seconds'`, [hostname()]);
  return result.rowCount === 1;
}
