import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeDb, createBoss, ensureCollectionConnection, getPool, getReadRun, listPlatformPolicies, platformRequestStore, acquireConnectionTask, renewConnectionTask, releaseConnectionTask, saveConnectorSession, verifyCollectionConnection } from '@acm/db/server';
import { changeAdminRateLimit, ConnectorError, getAdminReadRuns, hashPassword, maintainReadQueue, parsePlatformReadRequest, readPlatform, requestPlatformRead, retryPlatformRead } from '../packages/core/src/application/index';
import { submissionFixture } from '../packages/connectors/src/codeforces/fixtures';
import type { RequestContext } from '../packages/connectors/src/contracts/index';

// This probe deliberately changes quota clocks and creates queue tasks. Never use a live database.
if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== '/acm_architecture_verify') throw new Error('Probe requires the isolated acm_architecture_verify database');
const pool = getPool();
const boss = createBoss();
const signal = new AbortController().signal;
async function resetQuota(platform: string) {
  await pool.query("UPDATE platform_request_limits SET next_request_at=clock_timestamp(),blocked_until=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL WHERE platform=$1", [platform]);
}
try {
  await boss.start();
  await pool.query('UPDATE collection_control SET enabled=true WHERE id=1');
  assert.equal(Number((await pool.query('SELECT count(*) FROM platform_read_runs')).rows[0].count), 0, 'Probe requires a fresh isolated database; recreate acm_architecture_verify before rerunning');
  const password = randomUUID() + randomUUID();
  const passwordHash = await hashPassword(password);
  const admin = (await pool.query<{ id: string }>("INSERT INTO users(username,password_hash,role) VALUES ('collection_probe_admin',$1,'admin') ON CONFLICT(username) DO UPDATE SET password_hash=$1 RETURNING id", [passwordHash])).rows[0]!;
  await pool.query("INSERT INTO users(username,password_hash,role) VALUES ('collection_probe_member',$1,'member') ON CONFLICT(username) DO UPDATE SET password_hash=$1", [passwordHash]);

  const policies = await listPlatformPolicies();
  assert.equal(policies.length, 3);
  const qoj = policies.find(policy => policy.platform === 'qoj')!;
  const changed = await changeAdminRateLimit('qoj', { minIntervalMs: 1000, maxIntervalMs: 1500, version: qoj.version }, admin.id);
  await assert.rejects(changeAdminRateLimit('qoj', { minIntervalMs: 1000, maxIntervalMs: 1500, version: qoj.version }, admin.id), error => (error as { status?: number }).status === 409);
  await assert.rejects(changeAdminRateLimit('codeforces', { minIntervalMs: 1999, maxIntervalMs: 3000, version: 1 }, admin.id));
  await resetQuota('qoj'); await resetQuota('codeforces');

  const [first, competitor, cf] = await Promise.all([
    platformRequestStore.acquire('qoj', 'owner', 0, 45000),
    platformRequestStore.acquire('qoj', 'competitor', 0, 45000),
    platformRequestStore.acquire('codeforces', 'cf-owner', 0, 45000),
  ]);
  assert.equal(Number(first.acquired) + Number(competitor.acquired), 1);
  assert.equal(cf.acquired, true, 'A QOJ request must not block Codeforces');
  const owner = first.acquired ? 'owner' : 'competitor';
  const selected = first.acquired ? first.intervalMs! : competitor.intervalMs!;
  assert.ok(selected >= 1000 && selected <= 1500);
  await changeAdminRateLimit('qoj', { minIntervalMs: 2000, maxIntervalMs: 2000, version: changed.version }, admin.id);
  assert.equal(await platformRequestStore.release('qoj', 'stale-owner', 0), false);
  assert.equal(await platformRequestStore.release('qoj', owner, 0), true);
  const runtime = (await pool.query('SELECT lease_interval_ms,extract(epoch FROM (next_request_at-clock_timestamp()))*1000 AS wait_ms FROM platform_request_limits WHERE platform=$1', ['qoj'])).rows[0];
  assert.equal(runtime.lease_interval_ms, selected, 'Release must use the acquired policy snapshot');
  assert.ok(Number(runtime.wait_ms) > selected - 250);
  await resetQuota('qoj');
  assert.equal((await platformRequestStore.acquire('qoj', 'next-policy', 0, 45000)).intervalMs, 2000, 'The next request must observe the DB update');
  await platformRequestStore.block('qoj', new Date(Date.now() + 30000).toISOString());
  await platformRequestStore.block('qoj', new Date(Date.now() - 1000).toISOString());
  await platformRequestStore.release('qoj', 'next-policy');
  assert.equal((await platformRequestStore.acquire('qoj', 'blocked', 0, 45000)).acquired, false);
  await platformRequestStore.release('codeforces', 'cf-owner');

  const connection = await ensureCollectionConnection('qoj-probe', 'qoj');
  assert.equal(await acquireConnectionTask(connection.id, 'task-a'), true);
  assert.equal(await acquireConnectionTask(connection.id, 'task-b'), false);
  assert.equal(await renewConnectionTask(connection.id, 'task-a'), true);
  await releaseConnectionTask(connection.id, 'task-b');
  assert.equal(await renewConnectionTask(connection.id, 'task-a'), true);
  await releaseConnectionTask(connection.id, 'task-a');
  await resetQuota('qoj');
  await platformRequestStore.acquire('qoj', 'cookie-owner', 0, 45000);
  await saveConnectorSession(connection.id, 'qoj', 'fixture-encrypted-session', 'cookie-owner', signal, connection.generation);
  assert.equal(await verifyCollectionConnection(connection.id, connection.generation, 'collector'), true);
  await assert.rejects(saveConnectorSession(connection.id, 'qoj', 'stale-session', 'cookie-owner', signal, connection.generation), /SESSION_GENERATION_CHANGED/);
  assert.equal((await pool.query('SELECT encrypted_session FROM connector_sessions WHERE id=$1', [connection.id])).rows[0].encrypted_session, 'fixture-encrypted-session');
  await platformRequestStore.release('qoj', 'cookie-owner');

  let pages = 0;
  const ctx: RequestContext = { signal, session: null, async request(url) {
    if (url.pathname.endsWith('user.info')) return new Response(JSON.stringify({ status: 'OK', result: [{ handle: 'ExampleUser' }] }), { headers: { 'content-type': 'application/json' } });
    if (++pages === 2) throw new ConnectorError('HTTP_ERROR', 'Fixture 503 with Cookie=not-persisted', { httpStatus: 503 });
    return new Response(JSON.stringify({ status: 'OK', result: [submissionFixture(10), submissionFixture(9)] }), { headers: { 'content-type': 'application/json' } });
  } };
  const partial = await readPlatform({ platform: 'codeforces', target: 'ExampleUser', pageSize: 2, maxPages: 2 }, { signal, context: ctx });
  assert.equal(partial.status, 'failed');
  assert.equal(partial.progress.pages, 1);
  assert.notEqual(partial.continuation.cursor, null);
  const partialRow = (await getReadRun(partial.runId))!;
  assert.equal(partialRow.status, 'failed');
  assert.ok(!JSON.stringify(partialRow).includes('not-persisted'));
  assert.ok(!Object.hasOwn(partialRow.result as object, 'data'));
  const retried = await retryPlatformRead(partial.runId, admin.id, boss);
  assert.equal((await getReadRun(retried.runId))!.input && (parsePlatformReadRequest((await getReadRun(retried.runId))!.input)).cursor, null, 'Retry must replay the original cursor, not the diagnostic page');
  const duplicates = await Promise.all([requestPlatformRead({ platform: 'codeforces', target: 'ExampleUser', pageSize: 2, maxPages: 2 }, { boss }), retryPlatformRead(partial.runId, admin.id, boss)]);
  assert.ok(duplicates.every(result => result.runId === retried.runId && result.jobId === retried.jobId && result.merged));
  assert.deepEqual((await boss.getJobById('platform.codeforces.read', retried.jobId))!.data, { version: 1, runId: retried.runId });

  const expired: RequestContext = { signal, session: null, request: async () => { throw new ConnectorError('AUTH_REQUIRED', 'Cookie=must-not-store'); } };
  const blocked = await readPlatform({ platform: 'luogu', target: '123', connectionId: 'luogu-probe' }, { signal, context: expired });
  assert.equal(blocked.status, 'auth_required');
  assert.equal((await getReadRun(blocked.runId))!.recoveryState, 'waiting');
  const expiredConnection = await ensureCollectionConnection('luogu-probe', 'luogu');
  assert.equal(expiredConnection.state, 'auth_required');
  await maintainReadQueue(boss);
  assert.equal((await getReadRun(blocked.runId))!.resolvedBy, null);
  assert.equal(await verifyCollectionConnection(expiredConnection.id, expiredConnection.generation, '777'), true);
  await Promise.all([maintainReadQueue(boss), maintainReadQueue(boss)]);
  const recovered = (await getReadRun(blocked.runId))!;
  assert.equal(recovered.recoveryState, 'requeued');
  assert.ok(recovered.resolvedBy);
  const replacement = (await getReadRun(recovered.resolvedBy))!;
  assert.equal(replacement.retryOf, blocked.runId);
  assert.equal(parsePlatformReadRequest(replacement.input).cursor, null);
  const fetched = await boss.fetch('platform.luogu.read', { batchSize: 1 });
  assert.equal(fetched[0]!.id, replacement.jobId);
  const replacementOutcome = await readPlatform(replacement.input, { signal, context: expired, runId: replacement.id });
  await boss.complete('platform.luogu.read', replacement.jobId!, { status: replacementOutcome.status });
  assert.equal(replacementOutcome.status, 'auth_required');
  await maintainReadQueue(boss);
  assert.equal((await getReadRun(replacement.id))!.resolvedBy, null, 'Repeated authentication failure must await a new verified generation');

  const list = await getAdminReadRuns(new URLSearchParams({ limit: '1' }));
  assert.equal(list.items.length, 1);
  assert.ok(list.nextCursor);
  const next = await getAdminReadRuns(new URLSearchParams({ limit: '1', cursor: list.nextCursor! }));
  assert.notEqual(next.items[0]!.id, list.items[0]!.id);

  if (process.argv.includes('--http')) {
    const base = 'http://localhost:3001';
    assert.equal((await fetch(base + '/api/admin/platforms')).status, 401);
    async function login(username: string) {
      const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
      assert.equal(response.status, 200);
      const dto = await response.json() as { csrfToken: string };
      const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      return { cookie, csrfToken: dto.csrfToken };
    }
    const member = await login('collection_probe_member');
    assert.equal((await fetch(base + '/api/admin/platforms', { headers: { cookie: member.cookie } })).status, 403);
    const auth = await login('collection_probe_admin');
    const headers = { cookie: auth.cookie, origin: base, 'x-csrf-token': auth.csrfToken, 'content-type': 'application/json' };
    const overview = await fetch(base + '/api/admin/platforms', { headers });
    assert.equal(overview.status, 200);
    assert.equal(overview.headers.get('cache-control'), 'no-store');
    const overviewText = await overview.text();
    assert.ok(!overviewText.includes('fixture-encrypted-session'));
    assert.equal((await fetch(base + '/api/admin/read-runs', { method: 'POST', headers: { cookie: auth.cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'codeforces', target: 'probe' }) })).status, 403);
    assert.equal((await fetch(base + '/api/admin/read-runs', { method: 'POST', headers, body: JSON.stringify({ platform: 'codeforces', target: 'probe', password }) })).status, 400);
    const sent = await fetch(base + '/api/admin/read-runs', { method: 'POST', headers, body: JSON.stringify({ platform: 'codeforces', target: 'api_probe' }) });
    assert.equal(sent.status, 202);
    const sentDto = await sent.json() as { runId: string; jobId: string };
    assert.ok(sentDto.runId && sentDto.jobId);
    assert.equal((await fetch(base + '/api/admin/read-runs/' + sentDto.runId, { headers })).status, 200);
  }
  console.log(JSON.stringify({ event: 'collection_probe_passed', databasePolicies: true, sharedLeases: true, generationProtection: true, failurePersistence: true, originalBatchReplay: true, automaticAuthRecovery: true, deduplication: true, http: process.argv.includes('--http') }));
} finally { await boss.stop(); await closeDb(); }
