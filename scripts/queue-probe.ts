import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBoss, PROBE_QUEUE, getPool, closeDb } from '@acm/db/server';

const boss = createBoss();
try {
  await boss.start();
  const client = await getPool().connect();
  const db = { executeSql: (text: string, values?: unknown[]) => client.query(text, values) };
  let id: string | null;
  const probeId = randomUUID();
  try {
    await client.query('BEGIN');
    const rolledBack = await boss.send(PROBE_QUEUE, { probeId }, { singletonKey: 'rollback:' + probeId, db });
    assert.ok(rolledBack);
    await client.query('ROLLBACK');
    assert.equal(await boss.getJobById(PROBE_QUEUE, rolledBack), null, 'Rolled-back enqueue must leave no job');

    await client.query('BEGIN');
    id = await boss.send(PROBE_QUEUE, { probeId }, { singletonKey: probeId, db });
    const duplicate = await boss.send(PROBE_QUEUE, { probeId }, { singletonKey: probeId, db });
    assert.ok(id);
    assert.equal(duplicate, null, 'Exclusive policy must merge pending jobs with the same key');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }

  const deadline = Date.now() + 20000;
  let complete = false;
  while (Date.now() < deadline) {
    const job = await boss.getJobById(PROBE_QUEUE, id);
    if (job?.state === 'completed') { complete = true; break; }
    if (job?.state === 'failed') throw new Error('Worker failed to process probe');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!complete) throw new Error('Worker did not complete probe within 20 seconds');
  console.log(JSON.stringify({ event: 'queue_probe_verified', jobId: id, exclusiveDeduplication: true, transactionalRollback: true }));
} finally { await boss.stop(); await closeDb(); }
