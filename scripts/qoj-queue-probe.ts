import { access } from 'node:fs/promises';
import { createBoss, closeDb, QOJ_READ_QUEUE } from '@acm/db/server';

// Opt-in live cancellation check. Requires a dedicated local Worker in browser mode.
const boss = createBoss();
let id: string | null = null;
try {
  await boss.start();
  id = await boss.send(QOJ_READ_QUEUE, { target: 'muhammad', mode: 'backfill', maxPages: 2, maxDurationMs: 180000 }, { singletonKey: 'live-cancellation-probe', expireInSeconds: 960, heartbeatSeconds: 30 });
  if (!id) throw new Error('PROBE_ALREADY_RUNNING');
  const deadline = Date.now() + 60000;
  let challenged = false;
  while (Date.now() < deadline) {
    const job = await boss.getJobById(QOJ_READ_QUEUE, id);
    if (job?.state === 'completed' || job?.state === 'failed') throw new Error('PROBE_FINISHED_BEFORE_CANCEL');
    if (job?.state === 'active') {
      try { await access('.local/qoj-worker-challenge.png'); challenged = true; break; } catch { /* Wait for the actual challenge. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!challenged) throw new Error('NO_REAL_CHALLENGE_OBSERVED');
  await boss.cancel(QOJ_READ_QUEUE, id);
  const state = (await boss.getJobById(QOJ_READ_QUEUE, id))?.state;
  if (state !== 'cancelled') throw new Error('CANCEL_NOT_RECORDED');
  console.log(JSON.stringify({ event: 'qoj_real_queue_cancelled', jobId: id, state, message: 'Also check Worker emits cancelled and releases its dedicated page via job.signal.' }));
} catch (error) { console.error(JSON.stringify({ event: 'qoj_cancel_probe_failed', code: error instanceof Error ? error.message : 'PROBE_FAILED' })); process.exitCode = 1; }
finally { if (id) await boss.cancel(QOJ_READ_QUEUE, id); await boss.stop(); await closeDb(); }
