import { closeDb, createBoss, PROBE_QUEUE, writeWorkerHeartbeat, getPool, checkDatabaseReady } from '@acm/db/server';
import { getConfig } from '@acm/core/server';

const config = getConfig();
const boss = createBoss();
let heartbeat: ReturnType<typeof setInterval> | undefined;
let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (heartbeat) clearInterval(heartbeat);
  await boss.stop({ graceful: true, timeout: 15000 });
  await closeDb();
  process.exitCode = code;
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
try {
  if (!await checkDatabaseReady()) throw new Error('Schema is not ready');
  await boss.start();
  await boss.work<{ probeId: string }>(PROBE_QUEUE, { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => {
    for (const job of jobs) {
      console.log(JSON.stringify({ event: 'queue_probe_processed', jobId: job.id }));
    }
  });
  await writeWorkerHeartbeat();
  heartbeat = setInterval(() => {
    void writeWorkerHeartbeat().catch(() => {
      console.error(JSON.stringify({ code: 'WORKER_HEARTBEAT_FAILED' }));
      void shutdown(1);
    });
  }, 15000);
  // No platform tasks are scheduled until the P1 synchronization use case exists.
  await getPool().query("DELETE FROM auth_rate_limits WHERE reset_at < now() - interval '1 day'");
  await getPool().query("DELETE FROM sessions WHERE expires_at < now() - interval '30 days'");
  await getPool().query("DELETE FROM runtime_heartbeats WHERE updated_at < now() - interval '1 day'");
  console.log(JSON.stringify({ event: 'worker_ready', syncEnabled: config.SYNC_ENABLED === 'true', synchronizationImplemented: false }));
} catch {
  console.error(JSON.stringify({ code: 'WORKER_START_FAILED' }));
  await shutdown(1);
}
