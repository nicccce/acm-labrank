import { closeDb, createBoss, PROBE_QUEUE, writeWorkerHeartbeat, getPool, checkDatabaseReady, cleanCollectionHistory, getCollectionControl, expireLoginAttempts, maintainPersonalRuns, PLATFORM_READ_QUEUES, PERSONAL_QUEUES } from '@acm/db/server';
import { createQojReadWorker, getConfig, maintainReadQueue } from '@acm/core/server';
import { qojHumanInput } from '../cli/qoj-human';
import { registerPlatformQueues, registerPersonalQueues, registerSessionQueue } from './queues';

const config = getConfig();
const boss = createBoss();
const controller = new AbortController();
const qoj = createQojReadWorker({ transport: config.QOJ_TRANSPORT, connectionId: config.QOJ_CONNECTION_ID, signal: controller.signal,
  browser: { headed: config.QOJ_BROWSER_HEADED === 'true', channel: config.QOJ_BROWSER_CHANNEL, executablePath: config.QOJ_BROWSER_EXECUTABLE, proxyServer: config.QOJ_BROWSER_PROXY_SERVER, cdpEndpoint: config.QOJ_BROWSER_CDP_ENDPOINT, timeoutMs: config.QOJ_HTTP_TIMEOUT_MS, maxRetries: config.QOJ_HTTP_RETRIES },
  ...(config.QOJ_BROWSER_ATTACH_FILE && config.QOJ_BROWSER_ATTACH_ID ? { browserAttach: { file: config.QOJ_BROWSER_ATTACH_FILE, id: config.QOJ_BROWSER_ATTACH_ID } } : {}),
  humanTimeoutMs: config.QOJ_HUMAN_TIMEOUT_MS, humanRetries: config.QOJ_HUMAN_RETRIES, expectedLoginHandle: config.QOJ_LOGIN_HANDLE,
  onHumanInput: qojHumanInput({ image: '.local/qoj-worker-challenge.png', confirmationFile: config.QOJ_HUMAN_CONFIRM_FILE }),
});
let heartbeat: ReturnType<typeof setInterval> | undefined;
let stopping = false;
let maintenanceRunning = false;
let maintenanceTicks = 0;
let collectionRegistered = false;
async function maintainCollection() {
  const enabled = (await getCollectionControl()).enabled;
  if (enabled && !collectionRegistered) {
    await registerPlatformQueues(boss, { qoj, signal: controller.signal }, config.QOJ_CONNECTION_ID);
    await registerPersonalQueues(boss, { qoj, signal: controller.signal }); collectionRegistered = true;
  } else if (!enabled && collectionRegistered) {
    for (const queue of [...Object.values(PLATFORM_READ_QUEUES), ...Object.values(PERSONAL_QUEUES)]) await boss.offWork(queue, { wait: false });
    collectionRegistered = false;
  }
  await expireLoginAttempts();
  if (enabled) { await maintainReadQueue(boss); await maintainPersonalRuns(boss); }
}
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  controller.abort();
  if (heartbeat) clearInterval(heartbeat);
  await boss.stop({ graceful: true, timeout: 15000 });
  await qoj.close();
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
  await registerSessionQueue(boss, { qoj, signal: controller.signal });
  await maintainCollection();
  await writeWorkerHeartbeat();
  heartbeat = setInterval(() => {
    void writeWorkerHeartbeat().catch(() => {
      console.error(JSON.stringify({ code: 'WORKER_HEARTBEAT_FAILED' }));
      void shutdown(1);
    });
    if (!maintenanceRunning) {
      maintenanceRunning = true;
      void maintainCollection().then(async () => { if (++maintenanceTicks % 240 === 0) await cleanCollectionHistory(); })
        .catch(() => console.error(JSON.stringify({ code: 'READ_MAINTENANCE_FAILED' }))).finally(() => { maintenanceRunning = false; });
    }
  }, 15000);
  // Only authentication recovery runs here; periodic synchronization is still separate.
  await getPool().query("DELETE FROM auth_rate_limits WHERE reset_at < now() - interval '1 day'");
  await getPool().query("DELETE FROM sessions WHERE expires_at < now() - interval '30 days'");
  await getPool().query("DELETE FROM runtime_heartbeats WHERE updated_at < now() - interval '1 day'");
  console.log(JSON.stringify({ event: 'worker_ready', syncEnabled: config.SYNC_ENABLED === 'true', synchronizationImplemented: false }));
} catch {
  console.error(JSON.stringify({ code: 'WORKER_START_FAILED' }));
  await shutdown(1);
}
