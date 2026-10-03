import { hostname } from 'node:os';
import { getPool } from './client';

// Increment when adding a business migration. Older/newer schemas require an explicit deployment.
export const EXPECTED_MIGRATIONS = 9;
// pg-boss 12.35.1 uses schema 43; update together with the locked library.
export const EXPECTED_QUEUE_SCHEMA = 43;

export async function checkDatabaseReady(): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(`SELECT to_regclass('public.users') AS users,
    to_regclass('public.sessions') AS sessions,
    to_regclass('public.runtime_heartbeats') AS heartbeats,
    to_regclass('public.platform_request_limits') AS platform_limits,
    to_regclass('public.connector_sessions') AS connector_sessions,
    to_regclass('public.platform_request_policies') AS platform_policies,
    to_regclass('public.platform_connections') AS platform_connections,
    to_regclass('public.platform_read_runs') AS platform_runs,
    to_regclass('public.collection_audit_logs') AS collection_audit,
    to_regclass('public.platform_login_attempts') AS login_attempts,
    to_regclass('public.collection_control') AS collection_control,
    to_regclass('public.collection_settings') AS collection_settings,
    to_regclass('public.collection_platform_state') AS collection_platform_state,
    to_regclass('public.collection_reset_requests') AS collection_reset_requests,
    to_regclass('public.submissions') AS submissions,
    to_regclass('public.sync_runs') AS sync_runs,
    to_regclass('public.teams') AS teams,
    to_regclass('public.team_memberships') AS team_memberships,
    to_regclass('public.team_events') AS team_events,
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

export async function cleanRuntimeHistory() {
  await getPool().query("DELETE FROM auth_rate_limits WHERE reset_at < now() - interval '1 day'");
  await getPool().query("DELETE FROM sessions WHERE expires_at < now() - interval '30 days'");
  await getPool().query("DELETE FROM runtime_heartbeats WHERE updated_at < now() - interval '1 day'");
}
