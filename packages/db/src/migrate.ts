import { closeDb, getPool } from './client';
import type { PoolClient } from 'pg';
import { inspectMigrations, migrateSchema, MIGRATION_LOCK, MigrationSafetyError } from './schema-migrations';
import { createBoss, PROBE_QUEUE, PLATFORM_READ_QUEUES, PERSONAL_QUEUES, QOJ_SESSION_QUEUE } from './queue';
import { initializePlatformPolicies } from './collection/policies';
import { initializeCollectionSettings } from './collection/settings';
import { initializeSiteSettings } from './site-settings';
import { checkDatabaseReady, EXPECTED_MIGRATIONS, EXPECTED_QUEUE_SCHEMA } from './health';

const checkOnly = process.argv.includes('--check');
let lock: PoolClient | undefined;
let boss: ReturnType<typeof createBoss> | undefined;
let locked = false;
try {
  if (process.argv.slice(2).some(arg => !['--check', '--require-paused'].includes(arg))) throw new MigrationSafetyError('INVALID_MIGRATION_ARGUMENT');
  lock = await getPool().connect();
  const result = await lock.query('SELECT pg_try_advisory_lock($1) AS locked', [MIGRATION_LOCK]);
  locked = result.rows[0].locked;
  if (!locked) throw new MigrationSafetyError('MIGRATION_ALREADY_RUNNING');
  const plan = await inspectMigrations(undefined, lock);
  if (plan.total !== EXPECTED_MIGRATIONS) throw new MigrationSafetyError('MIGRATION_COUNT_MISMATCH');
  const queueExists = (await lock.query("SELECT to_regclass('pgboss.version') AS version")).rows[0].version;
  if (queueExists && Number((await lock.query('SELECT version FROM pgboss.version')).rows[0]?.version) > EXPECTED_QUEUE_SCHEMA) {
    throw new MigrationSafetyError('QUEUE_SCHEMA_NEWER_THAN_CODE');
  }
  if (process.argv.includes('--require-paused')) {
    const paused = await lock.query(`SELECT
      EXISTS(SELECT 1 FROM collection_control WHERE id=1 AND enabled=false) AS paused,
      EXISTS(SELECT 1 FROM sync_runs WHERE status='running')
        OR EXISTS(SELECT 1 FROM platform_read_runs WHERE status='running')
        OR EXISTS(SELECT 1 FROM platform_login_attempts WHERE state='processing' AND expires_at>now()) AS busy`);
    if (!paused.rows[0].paused || paused.rows[0].busy) throw new MigrationSafetyError('PAUSE_COLLECTION_AND_DRAIN_TASKS');
  }
  console.log(JSON.stringify({ event: 'migration_plan', ...plan, checkOnly }));
  if (!checkOnly) {
    await migrateSchema(undefined, lock);
    await initializePlatformPolicies();
    await getPool().query(`INSERT INTO platform_connections(id,platform)
      SELECT DISTINCT CASE WHEN platform='qoj' AND right(id,8)=':browser' THEN left(id,length(id)-8) ELSE id END,platform
      FROM connector_sessions WHERE platform IN ('luogu','qoj') ON CONFLICT DO NOTHING`);
    boss = createBoss(true);
    await boss.start();
    await boss.createQueue(PROBE_QUEUE, { policy: 'exclusive', retryLimit: 2, retryDelay: 5, expireInSeconds: 60 });
    // Bounded reads with business outcomes; challenges must not become endless queue retries.
    await getPool().query('INSERT INTO collection_control(id) VALUES (1) ON CONFLICT DO NOTHING');
    await initializeCollectionSettings();
    await initializeSiteSettings();
    for (const queue of [...Object.values(PLATFORM_READ_QUEUES), ...Object.values(PERSONAL_QUEUES), QOJ_SESSION_QUEUE]) {
      await boss.createQueue(queue, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 960, heartbeatSeconds: 30 });
      await boss.updateQueue(queue, { retryLimit: 0, expireInSeconds: 960, heartbeatSeconds: 30 });
    }
    if (!await checkDatabaseReady()) throw new MigrationSafetyError('MIGRATION_READINESS_FAILED');
    console.log(JSON.stringify({ event: 'migrations_complete', appliedNow: plan.pending.length, total: plan.total }));
  }
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof MigrationSafetyError ? error.code : 'MIGRATION_FAILED', message: 'Upgrade stopped. Check database access, migration history, and deployment lock; do not reset the database.' }));
  process.exitCode = 1;
} finally {
  await boss?.stop();
  if (locked) await lock?.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
  lock?.release();
  await closeDb();
}
