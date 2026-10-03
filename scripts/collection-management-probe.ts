import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { activateBinding, assertPersonalRunAvailable, claimSyncRun, closeDb, collectionAvailability, configuredSyncRange, createBoss, dispatchDueCollection, ensureCollectionConnection, finishPersonalBatch, getCollectionControl, getCollectionSettings, getPool, getSyncRun, initializeCollectionSettings, listPersonalSyncRuns, readSyncCursor, refreshVerifiedIdentity, seedIncrementalCheckpoint, requestPersonalSync, resetCollectionPlatforms, retryPersonalRun, saveCollectionSettings, setCollectionControl, commitPersonalPage, type BindingRow, type CollectionSettings, type FactPage } from '@acm/db/server';
import { getPersonalMember, requestAdminSync, readPlatform, changeAdminCollectionControl } from '../packages/core/src/application/index';

if (!process.env.DATABASE_URL || !/^\/acm_personal_verify_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Isolated personal verification database required');
const pool = getPool(), boss = createBoss(), checks: string[] = [];
const originalFetch = globalThis.fetch;
let networkRequests = 0;
globalThis.fetch = async () => { networkRequests++; throw new Error('Unexpected live platform request'); };
const fixed = { kind: 'fixed' as const, from: '2026-10-02', to: '2026-10-02' };
function writable(s: CollectionSettings) { return { platforms: s.platforms, autoSyncEnabled: s.autoSyncEnabled, syncIntervalMinutes: s.syncIntervalMinutes, scoreRange: s.scoreRange, version: s.version }; }
try {
  await boss.start();
  const admin = (await pool.query<{ id: string; password_hash: string }>("SELECT id,password_hash FROM users WHERE username='probe_admin'")).rows[0]!;
  // Existing personal probes have finished. Keep their facts for deletion tests,
  // but exclude their bindings from this probe's scheduler targets.
  await pool.query('UPDATE users SET active=false WHERE id<>$1', [admin.id]);
  let control = await getCollectionControl(); if (!control.enabled) await setCollectionControl(true, control.version, admin.id);
  let settings = await getCollectionSettings();
  assert.deepEqual(settings.platforms, ['codeforces']); assert.equal(settings.syncIntervalMinutes, 360); assert.equal(settings.autoSyncEnabled, false);
  const member = (await pool.query<{ id: string }>("INSERT INTO users(username,password_hash) VALUES ('collection_member',$1) RETURNING id", [admin.password_hash])).rows[0]!;
  async function binding(platform: 'codeforces' | 'qoj' | 'luogu', handle: string) {
    const account = (await pool.query<{ id: string }>('INSERT INTO platform_accounts(platform,handle,identity_key) VALUES ($1,$2,$2) RETURNING id', [platform, handle])).rows[0]!;
    await pool.query('INSERT INTO platform_account_aliases(platform,key,account_id) VALUES ($1,$2,$3)', [platform, platform === 'codeforces' ? handle.toLowerCase() : handle, account.id]);
    return (await pool.query<BindingRow>('INSERT INTO platform_bindings(user_id,platform,account_id,verified_at) VALUES ($1,$2,$3,now()) RETURNING *', [member.id, platform, account.id])).rows[0]!;
  }
  const cf = await binding('codeforces', 'CollectionCF'), qoj = await binding('qoj', 'CollectionQOJ');
  const qojConnection = await ensureCollectionConnection('qoj-lab', 'qoj');
  await pool.query("INSERT INTO connector_sessions(id,platform,encrypted_session) VALUES ('qoj-lab','qoj','fixture-secret-preserve') ON CONFLICT(id) DO NOTHING");
  async function activeRun(b: BindingRow, mode: 'incremental' | 'backfill' = 'incremental') {
    const requested = await requestPersonalSync(b.id, mode, boss, configuredSyncRange(await getCollectionSettings()));
    const run = (await getSyncRun(requested.runId))!;
    if (run.status === 'queued') assert.equal(await claimSyncRun(run.id, run.batch, run.job_id!), true);
    await readSyncCursor(b.account_id!, run.mode);
    return (await getSyncRun(run.id))!;
  }
  function page(b: BindingRow, submission = `collection-${b.platform}-1`): FactPage {
    return { problems: [{ platform: b.platform, problemKey: b.platform === 'codeforces' ? '900:A' : '900', title: 'Fixture problem', nativeDifficulty: b.platform === 'codeforces' ? 1800 : null, sourceUrl: b.platform === 'codeforces' ? 'https://codeforces.com/contest/900/problem/A' : b.platform === 'qoj' ? 'https://qoj.ac/problem/900' : 'https://www.luogu.com.cn/problem/P900', observedAt: new Date().toISOString() }], submissions: [{ platform: b.platform, externalSubmissionId: submission, problemKey: b.platform === 'codeforces' ? '900:A' : '900', submittedAt: '2026-10-02T00:00:00.000Z', verdict: 'accepted', subjectEvidence: { authorAccountKeys: [b.platform === 'codeforces' ? 'CollectionCF' : b.platform === 'qoj' ? 'CollectionQOJ' : '123456'] }, parserVersion: 'fixture-v1', observedAt: new Date().toISOString() }], nextCursor: null, nextCheckpoint: { version: 1, data: { marker: submission } }, stopReason: 'range_start', coverage: 'visible', observedAt: new Date().toISOString() };
  }
  async function complete(b: BindingRow) {
    const run = await activeRun(b); await commitPersonalPage(run.id, run.cursor_version, page(b)); await finishPersonalBatch(run.id, boss, { complete: true }); return run;
  }
  const initial = await saveCollectionSettings({ ...writable(settings), scoreRange: fixed }, admin.id, boss); settings = initial.settings;
  await assert.rejects(saveCollectionSettings({ ...writable(settings), version: settings.version - 1 }, admin.id, boss), /VERSION_CONFLICT/);
  const completedCf = await complete(cf);
  const due = (await pool.query<{ next_sync_at: Date }>('SELECT next_sync_at FROM platform_bindings WHERE id=$1', [cf.id])).rows[0]!.next_sync_at;
  assert.ok(Math.abs(due.getTime() - Date.now() - 360 * 60000) < 5000);
  await initializeCollectionSettings(); assert.equal((await getCollectionSettings()).version, settings.version);
  checks.push('persistent defaults, setting CAS, fixed range and completion-based due time');

  const existingTask = await activeRun(cf);
  settings = (await saveCollectionSettings({ ...writable(settings), autoSyncEnabled: true, syncIntervalMinutes: 1, scoreRange: { kind: 'fixed', from: fixed.from, to: fixed.to } }, admin.id, boss)).settings;
  assert.equal((await getSyncRun(existingTask.id))!.status, 'running');
  assert.equal((await collectionAvailability('codeforces')).generation, existingTask.collection_generation);
  // The same fixed dates survive jsonb key reordering. Interval-only changes
  // preserve an active run; manual sync merges it rather than restarting it.
  await complete(cf);
  const shorterDue = (await pool.query<{ next_sync_at: Date }>('SELECT next_sync_at FROM platform_bindings WHERE id=$1', [cf.id])).rows[0]!.next_sync_at;
  assert.ok(Math.abs(shorterDue.getTime() - Date.now() - 60000) < 5000);
  await boss.stop(); await boss.start();
  assert.equal((await getCollectionSettings()).syncIntervalMinutes, 1);
  assert.equal((await pool.query<{ next_sync_at: Date }>('SELECT next_sync_at FROM platform_bindings WHERE id=$1', [cf.id])).rows[0]!.next_sync_at.getTime(), shorterDue.getTime());
  assert.ok(!(await dispatchDueCollection(boss)).some(item => item.bindingId === cf.id));
  await pool.query('UPDATE platform_bindings SET next_sync_at=now()-interval \'1 minute\' WHERE id=$1', [cf.id]);
  const [manual, scheduled] = await Promise.all([requestPersonalSync(cf.id, 'incremental', boss, configuredSyncRange(settings)), dispatchDueCollection(boss)]);
  if (scheduled[0]?.runId) assert.equal(scheduled[0].runId, manual.runId);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sync_runs WHERE binding_id=$1 AND status IN ('queued','running')", [cf.id])).rows[0].n, 1);
  const interrupted = await activeRun(cf);
  await finishPersonalBatch(interrupted.id, boss, { paused: true, error: { code: 'NETWORK_ERROR', message: 'fixture', action: 'retry' } });
  await pool.query('UPDATE platform_bindings SET next_sync_at=now()-interval \'1 minute\' WHERE id=$1', [cf.id]);
  assert.ok(!(await dispatchDueCollection(boss)).some(item => item.bindingId === cf.id));
  const retry = await retryPersonalRun(interrupted.id, boss); assert.notEqual(retry.jobId, interrupted.job_id);
  await complete(cf);
  assert.equal((await getPersonalMember(member.id, new URLSearchParams())).points, 6);
  const singleRange = await requestPersonalSync(cf.id, 'incremental', boss, { from: new Date('2026-09-30T16:00:00Z'), to: new Date('2026-10-01T16:00:00Z') });
  const implicit = await requestAdminSync({}, admin.id);
  assert.ok(implicit.items.some(item => 'runId' in item && item.runId === singleRange.runId && item.merged && item.range?.from === '2026-10-01'));
  await assert.rejects(requestPersonalSync(cf.id, 'incremental', boss, configuredSyncRange(settings)), /SYNC_RANGE_CONFLICT/);
  await claimSyncRun(singleRange.runId, 0, singleRange.jobId!); await finishPersonalBatch(singleRange.runId, boss, { complete: true });
  checks.push('manual/scheduled atomic merge, failure suspension, retry and duplicate-safe scoring');

  settings = (await saveCollectionSettings({ ...writable(settings), platforms: ['codeforces', 'qoj'] }, admin.id, boss)).settings;
  assert.equal((await collectionAvailability('qoj')).reason, 'AUTH_REQUIRED');
  assert.ok((await requestAdminSync({ platforms: ['qoj'] }, admin.id)).items.some(item => 'skipped' in item && item.skipped === 'AUTH_REQUIRED'));
  const unread = await readPlatform({ platform: 'qoj', target: 'CollectionQOJ' }, { signal: new AbortController().signal });
  assert.equal(unread.status, 'auth_required'); assert.equal(networkRequests, 0);
  await pool.query("UPDATE platform_connections SET state='ready',collector='FixtureCollector',generation=generation+1 WHERE id=$1", [qojConnection.id]);
  assert.ok((await dispatchDueCollection(boss)).some(item => item.bindingId === qoj.id));
  await complete(qoj);
  assert.equal((await getPersonalMember(member.id, new URLSearchParams())).points, 9);
  settings = (await saveCollectionSettings({ ...writable(settings), platforms: ['codeforces', 'qoj', 'luogu'] }, admin.id, boss)).settings;
  const luoguConnection = await ensureCollectionConnection('luogu-lab', 'luogu');
  // Earlier login probes intentionally left this connection ready.
  await pool.query("UPDATE platform_connections SET state='auth_required' WHERE id=$1", [luoguConnection.id]);
  const noLogin = await readPlatform({ platform: 'luogu', target: '123456' }, { signal: new AbortController().signal });
  assert.equal(noLogin.status, 'auth_required'); assert.equal(networkRequests, 0);
  await pool.query("UPDATE platform_connections SET state='ready',collector='FixtureLuogu',generation=generation+1 WHERE id=$1", [luoguConnection.id]);
  assert.ok((await requestAdminSync({ platforms: ['luogu'] }, admin.id)).items.some(item => 'skipped' in item && item.skipped === 'NO_ACTIVE_BINDING'));
  const luogu = await binding('luogu', '123456'); await complete(luogu);
  assert.equal((await getPersonalMember(member.id, new URLSearchParams())).points, 12);
  await pool.query("UPDATE platform_connections SET state='auth_required' WHERE id=$1", [qojConnection.id]);
  assert.equal((await getPersonalMember(member.id, new URLSearchParams())).points, 12);
  const mixed = await requestAdminSync({}, admin.id);
  assert.ok(mixed.items.some(item => 'platform' in item && item.platform === 'qoj' && 'skipped' in item && item.skipped === 'AUTH_REQUIRED'));
  assert.ok(mixed.items.some(item => 'platform' in item && item.platform === 'codeforces' && 'runId' in item));
  await pool.query("UPDATE platform_connections SET state='ready' WHERE id=$1", [qojConnection.id]);
  const oldQoj = await activeRun(qoj);
  settings = (await saveCollectionSettings({ ...writable(settings), platforms: ['codeforces'] }, admin.id, boss)).settings;
  await assert.rejects(assertPersonalRunAvailable(oldQoj.id), /STALE_COLLECTION/);
  assert.equal((await getPersonalMember(member.id, new URLSearchParams())).points, 6);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions WHERE platform='qoj'")).rows[0].n, 1);
  const disabled = await readPlatform({ platform: 'qoj', target: 'CollectionQOJ' }, { signal: new AbortController().signal });
  assert.equal(disabled.status, 'cancelled'); assert.equal(networkRequests, 0);
  checks.push('three-platform scoring, zero requests when unlogged/unbound/disabled, retained scores after login expiry and isolated failures');

  const countsBefore = (await pool.query("SELECT count(*)::int AS n FROM submissions WHERE platform='codeforces'")).rows[0].n;
  await assert.rejects(resetCollectionPlatforms({ platforms: ['codeforces', 'qoj'], version: settings.version, requestId: randomUUID() }, admin.id, boss), /PLATFORM_DISABLED/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions WHERE platform='codeforces'")).rows[0].n, countsBefore);
  await assert.rejects(resetCollectionPlatforms({ platforms: ['codeforces'], version: settings.version - 1, requestId: randomUUID() }, admin.id, boss), /VERSION_CONFLICT/);
  await pool.query("UPDATE platform_bindings SET sync_requested=false WHERE platform='qoj'");
  const oldCf = await activeRun(cf);
  const retained = async () => (await pool.query(`SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM sessions) AS sessions,
    (SELECT jsonb_agg(jsonb_build_array(id,account_id,version) ORDER BY id) FROM platform_bindings) AS bindings,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM connector_sessions c) AS secrets,
    (SELECT jsonb_agg(jsonb_build_array(id,generation,state,collector) ORDER BY id) FROM platform_connections) AS connections`)).rows[0];
  const preserved = await retained();
  const request = { platforms: ['codeforces'], version: settings.version, requestId: randomUUID() };
  const reset = await resetCollectionPlatforms(request, admin.id, boss) as { deleted: { submissions: number }; items: { runId: string }[] };
  assert.equal(reset.deleted.submissions, countsBefore); assert.deepEqual(await retained(), preserved);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions WHERE platform='codeforces'")).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions WHERE platform='qoj'")).rows[0].n, 1);
  await assert.rejects(commitPersonalPage(oldCf.id, oldCf.cursor_version, page(cf)), /STALE_BINDING|STALE_COLLECTION/);
  await assert.rejects(readSyncCursor(cf.account_id!, oldCf.mode, oldCf.id), /STALE_COLLECTION/);
  await assert.rejects(seedIncrementalCheckpoint(cf.account_id!, oldCf.id), /STALE_COLLECTION/);
  await assert.rejects(refreshVerifiedIdentity(cf.id, oldCf.binding_version, { platform: 'codeforces', kind: 'person', handle: 'LateRename', externalId: null, resolutionEvidence: { requestedHandle: 'CollectionCF', historicHandlesChecked: true } }, oldCf.id), /STALE_COLLECTION/);
  assert.deepEqual(await retained(), preserved);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sync_cursors WHERE account_id=$1', [cf.account_id])).rows[0].n, 0);
  await assert.rejects(retryPersonalRun(oldCf.id, boss), /SYNC_STATE_CONFLICT/);
  const rebuild = (await getSyncRun(reset.items[0]!.runId))!;
  assert.equal(rebuild.mode, 'backfill'); assert.equal(rebuild.source, 'rebuild'); assert.equal(rebuild.scan_checkpoint, null);
  assert.ok(rebuild.collection_generation > completedCf.collection_generation);
  await complete(cf);
  assert.deepEqual(await resetCollectionPlatforms(request, admin.id, boss), reset);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM submissions WHERE platform='codeforces'")).rows[0].n, 1);
  await assert.rejects(resetCollectionPlatforms({ ...request, platforms: ['qoj'] }, admin.id, boss), /RESET_REQUEST_CONFLICT/);
  const freshIncremental = await activeRun(cf);
  assert.ok(freshIncremental.scan_checkpoint); assert.equal(freshIncremental.collection_generation, rebuild.collection_generation);
  await finishPersonalBatch(freshIncremental.id, boss, { complete: true });
  checks.push('atomic selected-platform reset, preserved identities/secrets, stale writes/checkpoints and idempotent replay');

  control = await getCollectionControl(); await setCollectionControl(false, control.version, admin.id);
  settings = (await saveCollectionSettings({ ...writable(settings), scoreRange: { kind: 'fixed', from: '2026-10-01', to: '2026-10-02' } }, admin.id, boss)).settings;
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sync_runs WHERE binding_id=$1 AND status IN ('queued','running')", [cf.id])).rows[0].n, 0);
  await assert.rejects(resetCollectionPlatforms({ platforms: ['codeforces'], version: settings.version, requestId: randomUUID() }, admin.id, boss), /COLLECTION_PAUSED/);
  control = await getCollectionControl(); await changeAdminCollectionControl({ enabled: true, version: control.version }, admin.id);
  const expanded = await activeRun(cf); assert.equal(expanded.scan_checkpoint, null); assert.equal(expanded.range_from!.toISOString(), '2026-09-30T16:00:00.000Z');
  const paginated = await listPersonalSyncRuns({ limit: 1 }); assert.equal(paginated.length, 1); assert.ok(paginated[0].started_at);
  // Old verification results must not publish a binding after settings changed.
  await pool.query("UPDATE sync_runs SET kind='verify' WHERE id=$1", [expanded.id]);
  settings = (await saveCollectionSettings({ ...writable(settings), scoreRange: { kind: 'rolling', days: 30 }, autoSyncEnabled: false }, admin.id, boss)).settings;
  await assert.rejects(activateBinding(expanded.id, { platform: 'codeforces', kind: 'person', handle: 'CollectionCF', externalId: null }, boss), /STALE_BINDING/);
  control = await getCollectionControl(); await setCollectionControl(false, control.version, admin.id);
  checks.push('paused settings deferred until resume, expanded range head scan, task metadata and stale verification rejection');
  console.log(JSON.stringify({ event: 'collection_management_probe_passed', checks, livePlatformRequests: networkRequests }));
} finally { globalThis.fetch = originalFetch; await boss.stop(); await closeDb(); }
