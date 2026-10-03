import assert from 'node:assert/strict';
import { closeDb, createBoss, getPool, getCollectionSettings, getSyncRun, readSyncCursor, requestPersonalSync, retryPersonalRun, setCollectionControl, getCollectionControl, saveCollectionSettings, type BindingRow } from '@acm/db/server';
import { executePersonalJob, type ReadRuntimeOptions } from '../packages/core/src/application/index';
import { ConnectorError } from '../packages/connectors/src/contracts/index';
import { submissionFixture } from '../packages/connectors/src/codeforces/fixtures';

if (!process.env.DATABASE_URL || !/^\/acm_personal_verify_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Isolated verification database required');
const pool = getPool(), boss = createBoss(), checks: string[] = [];
try {
  await boss.start();
  const admin = (await pool.query<{ id: string; password_hash: string }>("SELECT id,password_hash FROM users WHERE username='probe_admin'")).rows[0]!;
  async function binding(handle: string): Promise<BindingRow> {
    const user = (await pool.query<{ id: string }>('INSERT INTO users(username,password_hash) VALUES ($1,$2) RETURNING id', [handle.toLowerCase(), admin.password_hash])).rows[0]!;
    const account = (await pool.query<{ id: string }>("INSERT INTO platform_accounts(platform,handle,identity_key) VALUES ('codeforces',$1,$1) RETURNING id", [handle])).rows[0]!;
    await pool.query("INSERT INTO platform_account_aliases(platform,key,account_id) VALUES ('codeforces',$1,$2)", [handle.toLowerCase(), account.id]);
    return (await pool.query<BindingRow>("INSERT INTO platform_bindings(user_id,platform,account_id,verified_at) VALUES ($1,'codeforces',$2,now()) RETURNING *", [user.id, account.id])).rows[0]!;
  }
  const b = await binding('ContinuousFixture');
  const requested = await requestPersonalSync(b.id, 'incremental', boss), initial = (await getSyncRun(requested.runId))!;
  const midnight = Math.floor((Date.now() + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
  assert.equal(initial.scope, 'initial'); assert.equal(initial.initial_from!.getTime(), midnight - 29 * 86400000); assert.equal(initial.range_to, null);
  const start = initial.initial_from!.getTime() / 1000;
  let rows = Array.from({ length: 350 }, (_, index) => submissionFixture(50000 - index, { creationTimeSeconds: start + 350 - index }));
  // The terminal row is before the fixed initial lower bound.
  rows.push(submissionFixture(49000, { creationTimeSeconds: start - 1 }));
  const runtime = (target: string): ReadRuntimeOptions => ({ signal: new AbortController().signal, context: { signal: new AbortController().signal, session: null, request: async url => {
    assert.equal(url.hostname, 'codeforces.com');
    const result = url.pathname.endsWith('user.info') ? [{ handle: target }] : rows.slice(Number(url.searchParams.get('from')) - 1, Number(url.searchParams.get('from')) - 1 + Number(url.searchParams.get('count'))).map(row => ({ ...row, author: { members: [{ handle: target }], participantType: 'PRACTICE', ghost: false } }));
    return new Response(JSON.stringify({ status: 'OK', result }), { headers: { 'content-type': 'application/json' } });
  } } });
  async function execute(id: string, target = b.handle ?? 'ContinuousFixture') {
    const run = (await getSyncRun(id))!; await executePersonalJob(boss, { syncRunId: id, batch: run.batch }, run.job_id!, runtime(target));
    return (await getSyncRun(id))!;
  }
  const timeoutRuntime = runtime('ContinuousFixture'), request = timeoutRuntime.context!.request; let pageRequests = 0;
  timeoutRuntime.context!.request = async (url, init) => { if (url.pathname.endsWith('user.status') && ++pageRequests === 2) throw new ConnectorError('TIMEOUT', 'Fixture batch timeout'); return request(url, init); };
  await executePersonalJob(boss, { syncRunId: initial.id, batch: 0 }, initial.job_id!, timeoutRuntime);
  const timedOut = (await getSyncRun(initial.id))!; assert.equal(timedOut.status, 'queued'); assert.equal(timedOut.pages, 1); assert.equal(timedOut.retries, 0); assert.equal((await readSyncCursor(b.account_id!, 'incremental')).initialized_at, null);
  checks.push('timeout after one atomic page resumes without publishing a checkpoint or exhausting retries');
  let run = await execute(initial.id);
  assert.equal(run.status, 'queued'); assert.equal(run.pages - timedOut.pages, 3); assert.equal(run.batch, 2); assert.ok(run.scan_cursor); assert.equal(run.initial_from!.getTime(), initial.initial_from!.getTime());
  const unpublished = await readSyncCursor(b.account_id!, 'incremental'); assert.equal(unpublished.initialized_at, null); assert.equal(unpublished.checkpoint, null);
  checks.push('first window fixed at 30 Beijing days; 3-page batch is continuation, not completion');

  // Pausing and changing query dates must not replace the saved cursor or lower bound.
  let control = await getCollectionControl(); await setCollectionControl(false, control.version, admin.id);
  const settings = await getCollectionSettings();
  const queryOnly = await saveCollectionSettings({ ...settings, scoreRange: { kind: 'fixed', from: '2020-01-01', to: '2020-01-02' } }, admin.id, boss);
  assert.deepEqual(queryOnly.items, []);
  assert.deepEqual((await getSyncRun(run.id))!.scan_cursor, run.scan_cursor); assert.equal((await getSyncRun(run.id))!.status, 'queued');
  await execute(run.id); assert.equal((await getSyncRun(run.id))!.status, 'paused');
  control = await getCollectionControl(); await setCollectionControl(true, control.version, admin.id); await retryPersonalRun(run.id, boss);
  // New submissions after the scan started (including next-day timestamps) are
  // recovered by the following head scan, using the original head checkpoint.
  rows.unshift(submissionFixture(60000, { creationTimeSeconds: midnight / 1000 + 2 * 86400 }));
  for (let i = 0; i < 12 && (await getSyncRun(run.id))!.status === 'queued'; i++) run = await execute(run.id);
  assert.equal(run.status, 'completed'); assert.equal(run.initial_from!.getTime(), initial.initial_from!.getTime());
  const initialized = await readSyncCursor(b.account_id!, 'incremental'); assert.ok(initialized.initialized_at); assert.equal(initialized.history_complete, false);
  assert.equal((initialized.checkpoint!.data as { highWaterId: string }).highWaterId, '50000');
  const next = await requestPersonalSync(b.id, 'incremental', boss); const nextRun = (await getSyncRun(next.runId))!;
  assert.equal(nextRun.scope, 'incremental'); assert.equal(nextRun.initial_from, null); assert.equal(nextRun.range_from, null);
  for (let i = 0; i < 12 && (await getSyncRun(next.runId))!.status === 'queued'; i++) await execute(next.runId);
  assert.equal((await getSyncRun(next.runId))!.status, 'completed');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions WHERE platform='codeforces' AND external_submission_id='60000'")).rows[0].n, 1);
  checks.push('pause/retry and query-date edit retain progress; next head scan collects cross-day arrivals');

  const checkpoint = await readSyncCursor(b.account_id!, 'incremental');
  const historical = await requestPersonalSync(b.id, 'backfill', boss, { from: new Date((start - 100) * 1000), to: new Date(start * 1000) });
  for (let i = 0; i < 12 && (await getSyncRun(historical.runId))!.status === 'queued'; i++) await execute(historical.runId);
  assert.equal((await getSyncRun(historical.runId))!.status, 'completed');
  const after = await readSyncCursor(b.account_id!, 'incremental');
  assert.deepEqual(after.checkpoint, checkpoint.checkpoint); assert.equal(after.version, checkpoint.version); assert.equal(after.initialized_at!.getTime(), checkpoint.initialized_at!.getTime());
  checks.push('historical supplementation leaves the durable incremental checkpoint unchanged');

  // A 90-day outage must not turn incremental reads into a new 30-day window.
  const old = { ...checkpoint.checkpoint!, data: { ...(checkpoint.checkpoint!.data as Record<string, unknown>), highWaterId: '49000', startedAt: new Date(Date.now() - 90 * 86400000).toISOString() } };
  await pool.query("UPDATE sync_cursors SET checkpoint=$2,initialized_at=now()-interval '90 days' WHERE account_id=$1 AND mode='incremental'", [b.account_id, JSON.stringify(old)]);
  rows = [submissionFixture(65000, { creationTimeSeconds: Math.floor(Date.now() / 1000) - 60 * 86400 }), submissionFixture(49000, { creationTimeSeconds: Math.floor(Date.now() / 1000) - 100 * 86400 })];
  const catchup = await requestPersonalSync(b.id, 'incremental', boss); await execute(catchup.runId);
  assert.equal((await getSyncRun(catchup.runId))!.scope, 'incremental'); assert.equal((await getSyncRun(catchup.runId))!.status, 'completed');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions WHERE external_submission_id='65000'")).rows[0].n, 1);
  checks.push('90-day outage catches submissions older than 30 days without truncating');

  const empty = await binding('EmptyContinuousFixture'); rows = [];
  const emptyFirst = await requestPersonalSync(empty.id, 'incremental', boss); await execute(emptyFirst.runId, 'EmptyContinuousFixture');
  const emptyCursor = await readSyncCursor(empty.account_id!, 'incremental'); assert.ok(emptyCursor.initialized_at); assert.ok(emptyCursor.checkpoint); assert.equal((emptyCursor.checkpoint.data as { highWaterId: unknown }).highWaterId, null);
  const emptyNext = await requestPersonalSync(empty.id, 'incremental', boss); assert.equal((await getSyncRun(emptyNext.runId))!.scope, 'incremental'); await execute(emptyNext.runId, 'EmptyContinuousFixture');
  checks.push('normal empty account initializes once and continues incrementally');
  console.log(JSON.stringify({ event: 'continuous_sync_probe_passed', checks }));
} finally { await boss.stop(); await closeDb(); }
