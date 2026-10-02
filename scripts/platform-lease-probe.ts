import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { closeDb, getPool, platformRequestStore as store } from '@acm/db/server';

const platform = `lease-probe:${randomUUID()}`;
try {
  const clients = await Promise.all([getPool().connect(), getPool().connect()]);
  try {
    const pids = await Promise.all(clients.map((client) => client.query('SELECT pg_backend_pid() AS pid')));
    assert.notEqual(pids[0]!.rows[0].pid, pids[1]!.rows[0].pid);
  } finally { clients.forEach((client) => client.release()); }
  const claims = await Promise.all([store.acquire(platform, 'a', 2000, 45000), store.acquire(platform, 'b', 2000, 45000)]);
  assert.equal(claims.filter((claim) => claim.acquired).length, 1);
  const owner = claims[0]!.acquired ? 'a' : 'b';
  assert.equal(await store.release(platform, 'stale'), false);
  assert.equal(await store.release(platform, owner), true);
  assert.equal((await store.acquire(platform, 'c', 0, 100)).acquired, false, 'start interval survives release');
  await delay(2050);
  assert.equal((await store.acquire(platform, 'c', 0, 100)).acquired, true);
  await delay(150);
  assert.equal((await store.acquire(platform, 'd', 0, 45000)).acquired, true, 'expired lease can be reclaimed');
  assert.equal(await store.release(platform, 'c'), false, 'old owner cannot release the new lease');
  assert.equal(await store.owns(platform, 'd'), true);
  const blocked = new Date(Date.now() + 1000).toISOString();
  await store.block(platform, blocked);
  await store.block(platform, new Date(Date.now()).toISOString());
  assert.equal(await store.release(platform, 'd'), true);
  assert.equal((await store.acquire(platform, 'e', 0, 45000)).acquired, false, 'Retry-After cannot be shortened by another client');
  console.log(JSON.stringify({ event: 'platform_lease_probe_passed', separateDatabaseSessions: true,
    exclusiveLease: true, sharedInterval: true, staleOwnerRejected: true, sharedRetryAfter: true }));
} finally {
  await getPool().query('DELETE FROM platform_request_limits WHERE platform = $1', [platform]);
  await closeDb();
}
