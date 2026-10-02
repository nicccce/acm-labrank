import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb, getPool } from './client';
import { createBoss, PROBE_QUEUE, PLATFORM_READ_QUEUES } from './queue';
import { initializePlatformPolicies } from './collection/policies';

const lock = await getPool().connect();
const boss = createBoss(true);
let locked = false;
try {
  const result = await lock.query('SELECT pg_try_advisory_lock(73192401) AS locked');
  locked = result.rows[0].locked;
  if (!locked) throw new Error('Another migration is already running');
  await migrate(getDb(), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  await initializePlatformPolicies();
  await getPool().query(`INSERT INTO platform_connections(id,platform)
    SELECT DISTINCT CASE WHEN platform='qoj' AND right(id,8)=':browser' THEN left(id,length(id)-8) ELSE id END,platform
    FROM connector_sessions WHERE platform IN ('luogu','qoj') ON CONFLICT DO NOTHING`);
  await boss.start();
  await boss.createQueue(PROBE_QUEUE, { policy: 'exclusive', retryLimit: 2, retryDelay: 5, expireInSeconds: 60 });
  // Bounded reads with business outcomes; challenges must not become endless queue retries.
  for (const queue of Object.values(PLATFORM_READ_QUEUES)) {
    await boss.createQueue(queue, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 960, heartbeatSeconds: 30 });
    await boss.updateQueue(queue, { retryLimit: 0, expireInSeconds: 960, heartbeatSeconds: 30 });
  }
  console.log(JSON.stringify({ event: 'migrations_complete' }));
} catch {
  console.error(JSON.stringify({ code: 'MIGRATION_FAILED', message: 'Check database access, migration files, and deployment lock.' }));
  process.exitCode = 1;
} finally {
  await boss.stop();
  if (locked) await lock.query('SELECT pg_advisory_unlock(73192401)');
  lock.release();
  await closeDb();
}
