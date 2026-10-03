import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeDb, createBoss, getPool, createSession, createLoginAttempt, getLoginAttempt, claimLoginAttempt, saveLoginChallenge, endLoginAttempt, ensureCollectionConnection, saveBindingCandidate, getSyncRun, claimSyncRun, activateBinding, readSyncCursor, commitPersonalPage, finishPersonalBatch, retryPersonalRun, refreshVerifiedIdentity, unbindAccount, getBinding, setCollectionControl, getCollectionControl, requestPersonalSync } from '@acm/db/server';
import { getPersonalLeaderboard, getPersonalMember, getPersonalRecords, beginWebLuoguLogin, webLuoguCaptcha, advanceWebLuoguLogin, cancelWebLuoguLogin, hashPassword, executePersonalJob, type ReadRuntimeOptions } from '../packages/core/src/application/index';
import type { FactPage } from '@acm/db/server';
import { checkDatabaseReady } from '@acm/db/server';
import { submissionFixture } from '../packages/connectors/src/codeforces/fixtures';

if (!process.env.DATABASE_URL || !/^\/acm_personal_verify_[a-z0-9_]+$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Isolated personal verification database required');
const pool = getPool(), boss = createBoss();
const originalFetch = globalThis.fetch;
const checks: string[] = [];
const query = () => new URLSearchParams({ from: '2026-10-02', to: '2026-10-02' });
const password = 'fixture-only-password-which-is-never-persisted';
try {
  await boss.start();
  assert.equal(await checkDatabaseReady(), true);
  const hashed = await hashPassword(password);
  const users = (await pool.query<{ id: string; username: string }>(`INSERT INTO users(username,password_hash,role) VALUES ('probe_admin',$1,'admin'),('probe_one',$1,'member'),('probe_two',$1,'member'),('probe_zero',$1,'member') RETURNING id,username`, [hashed])).rows;
  const admin = users[0]!, one = users[1]!, two = users[2]!, zero = users[3]!;
  await createSession(admin.id, randomUUID(), new Date(Date.now() + 3600000));
  const sid = (await pool.query<{ id: string }>('SELECT id FROM sessions WHERE user_id=$1', [admin.id])).rows[0]!.id;
  const control = await getCollectionControl(); assert.equal(control.enabled, false);
  await setCollectionControl(true, control.version, admin.id);

  const candidate = await saveBindingCandidate(one.id, 'codeforces', 'Original', boss);
  let run = (await getSyncRun(candidate.runId!))!;
  assert.equal(await claimSyncRun(run.id, 0, run.job_id!), true);
  const backfill = await activateBinding(run.id, { platform: 'codeforces', kind: 'person', handle: 'Original', externalId: null }, boss);
  run = (await getSyncRun(backfill.runId))!;
  await claimSyncRun(run.id, 0, run.job_id!);
  const cursor = await readSyncCursor(run.account_id!, 'backfill');
  const fixturePage = (verdict = 'accepted', observedAt = '2026-10-02T12:00:00.000Z'): FactPage => ({
    problems: [{ platform: 'codeforces', problemKey: '1:A', title: 'Fixture A', nativeDifficulty: 1800, sourceUrl: 'https://codeforces.com/contest/1/problem/A', observedAt }],
    submissions: [{ platform: 'codeforces', externalSubmissionId: '1', problemKey: '1:A', submittedAt: '2026-10-01T16:00:00.000Z', verdict, nativeScore: 100, subjectEvidence: { authorAccountKeys: ['Original'] }, parserVersion: 'fixture-v1', observedAt }],
    nextCursor: { version: 1, data: { page: 2 } }, nextCheckpoint: null, stopReason: 'more', coverage: 'visible', observedAt,
  });
  let version = await commitPersonalPage(run.id, cursor.version, fixturePage());
  version = await commitPersonalPage(run.id, version, fixturePage());
  assert.equal(Number((await pool.query('SELECT count(*) FROM submissions')).rows[0].count), 1);
  assert.equal((await getPersonalMember(one.id, query())).points, 6);
  checks.push('duplicate pages preserve one fact and one solve');
  await assert.rejects(commitPersonalPage(run.id, version - 1, fixturePage()), /STALE_CURSOR/);
  const invalid = fixturePage(); invalid.problems.push({ ...invalid.problems[0]!, platform: 'qoj', problemKey: 'bad' });
  await assert.rejects(commitPersonalPage(run.id, version, invalid), /FACT_PLATFORM_MISMATCH/);
  assert.equal((await getSyncRun(run.id))!.cursor_version, version);
  const unpublished = await readSyncCursor(run.account_id!, 'incremental'); assert.equal(unpublished.checkpoint, null); assert.equal(unpublished.initialized_at, null);
  checks.push('stale cursor and failed page transaction do not advance');

  const earlier = fixturePage('accepted', '2026-10-02T13:00:00.000Z');
  earlier.submissions[0]!.externalSubmissionId = '2'; earlier.submissions[0]!.submittedAt = '2026-09-30T16:00:00.000Z';
  version = await commitPersonalPage(run.id, version, earlier);
  assert.equal((await getPersonalMember(one.id, query())).solveCount, 0);
  version = await commitPersonalPage(run.id, version, { ...earlier, submissions: [{ ...earlier.submissions[0]!, verdict: 'rejected', observedAt: '2026-10-02T14:00:00.000Z' }] });
  assert.equal((await getPersonalMember(one.id, query())).points, 6);
  version = await commitPersonalPage(run.id, version, fixturePage('rejected', '2026-10-02T15:00:00.000Z'));
  assert.equal((await getPersonalMember(one.id, query())).solveCount, 0);
  version = await commitPersonalPage(run.id, version, fixturePage('accepted', '2026-10-02T15:01:00.000Z'));
  version = await commitPersonalPage(run.id, version, fixturePage('rejected', '2026-10-02T14:30:00.000Z'));
  assert.equal((await getPersonalMember(one.id, query())).points, 6);
  checks.push('all-history first AC, rejudging and older observations');
  const team = fixturePage('accepted', '2026-10-02T15:02:00.000Z');
  team.submissions[0]!.externalSubmissionId = '3'; team.submissions[0]!.subjectEvidence = { authorAccountKeys: ['Original', 'Other'], teamId: '11' };
  version = await commitPersonalPage(run.id, version, team);
  assert.equal((await getPersonalMember(one.id, query())).submissionCount, 1);
  assert.equal((await pool.query("SELECT user_id FROM submission_attributions a JOIN submissions s ON s.id=a.submission_id WHERE s.external_submission_id='3'")).rows[0].user_id, null);
  checks.push('team evidence never becomes personal credit');
  const partial = fixturePage('unknown', '2026-10-02T15:03:00.000Z'); partial.problems[0]!.nativeDifficulty = null; partial.submissions[0]!.submittedAt = null; delete partial.submissions[0]!.nativeScore;
  version = await commitPersonalPage(run.id, version, partial);
  assert.equal((await getPersonalMember(one.id, query())).points, 6);
  assert.equal((await getPersonalRecords(one.id, query(), true)).items[0]!.nativeScore, 100);
  checks.push('unobserved metadata does not erase known facts');
  const explicitUnknown = fixturePage('unknown', '2026-10-02T15:03:01.000Z'); explicitUnknown.submissions[0]!.nativeVerdict = 'NEW_PLATFORM_STATUS';
  version = await commitPersonalPage(run.id, version, explicitUnknown);
  assert.equal((await getPersonalMember(one.id, query())).solveCount, 0);
  version = await commitPersonalPage(run.id, version, fixturePage('accepted', '2026-10-02T15:03:02.000Z'));
  checks.push('explicit unrecognized rejudge removes AC credit');

  await finishPersonalBatch(run.id, boss, {});
  const continued = (await getSyncRun(run.id))!;
  assert.equal(continued.batch, 1); assert.notEqual(continued.job_id, run.job_id);
  await claimSyncRun(run.id, 1, continued.job_id!);
  await finishPersonalBatch(run.id, boss, { error: { code: 'NETWORK_ERROR' }, paused: true });
  const retry = await retryPersonalRun(run.id, boss); assert.notEqual(retry.jobId, continued.job_id);
  await claimSyncRun(run.id, 2, retry.jobId!);
  checks.push('bounded continuation and retry have distinct jobs');

  const second = await saveBindingCandidate(two.id, 'codeforces', 'Second', boss);
  const secondVerify = (await getSyncRun(second.runId!))!; await claimSyncRun(secondVerify.id, 0, secondVerify.job_id!);
  const secondSync = await activateBinding(secondVerify.id, { platform: 'codeforces', kind: 'person', handle: 'Second', externalId: null }, boss);
  const secondRun = (await getSyncRun(secondSync.runId))!; await claimSyncRun(secondRun.id, 0, secondRun.job_id!);
  const secondCursor = await readSyncCursor(secondRun.account_id!, 'backfill');
  const secondPage = fixturePage('accepted', '2026-10-02T15:04:00.000Z'); secondPage.submissions[0]!.externalSubmissionId = '4'; secondPage.submissions[0]!.subjectEvidence = { authorAccountKeys: ['Second'] };
  await commitPersonalPage(secondRun.id, secondCursor.version, secondPage);
  const ranks = (await getPersonalLeaderboard(query())).items;
  assert.equal(ranks.find(r => r.id === one.id)!.rank, 1); assert.equal(ranks.find(r => r.id === two.id)!.rank, 1); assert.equal(ranks.find(r => r.id === zero.id)!.rank, 3);
  assert.equal((await getPersonalLeaderboard(new URLSearchParams({ from: '2026-10-02', to: '2026-10-02', limit: '1' }))).items.length, 1);
  assert.equal((await getPersonalLeaderboard(new URLSearchParams({ from: '2026-10-02', to: '2026-10-02', page: '99' }))).total, 4);
  assert.equal((await getPersonalRecords(one.id, new URLSearchParams({ from: '2026-10-02', to: '2026-10-02', page: '99' }), false)).total, 1);
  checks.push('SQL aggregation before pagination and competition ranks');
  await assert.rejects(pool.query("UPDATE platform_bindings SET platform='qoj' WHERE id=$1", [candidate.bindingId]), e => (e as { code?: string }).code === '23503');
  const renamed = await refreshVerifiedIdentity(candidate.bindingId, run.binding_version, { platform: 'codeforces', kind: 'person', handle: 'Renamed', externalId: null, resolutionEvidence: { requestedHandle: 'Original', historicHandlesChecked: true } });
  assert.equal(renamed, true); assert.equal((await getBinding(candidate.bindingId))!.account_id, run.account_id);
  assert.equal((await getPersonalMember(one.id, query())).points, 6);
  assert.equal((await readSyncCursor(run.account_id!, 'backfill')).cursor, null);
  checks.push('cross-platform FK and evidenced rename preserve identity and restart cursors');
  await assert.rejects(saveBindingCandidate(two.id, 'codeforces', 'original', boss), /ACCOUNT_OCCUPIED/);
  assert.equal((await saveBindingCandidate(one.id, 'codeforces', 'ORIGINAL', boss)).state, 'verified');
  await unbindAccount(one.id, 'codeforces');
  await assert.rejects(commitPersonalPage(run.id, version, fixturePage()), /STALE_BINDING/);
  assert.equal((await getPersonalMember(one.id, query())).points, 0);
  assert.equal((await getBinding(candidate.bindingId))!.account_id, null);
  checks.push('account occupancy, unchanged binding and stale unbind task');

  // A connector fixture goes through the real worker orchestration without the Internet.
  const runtime: ReadRuntimeOptions = { signal: new AbortController().signal, context: { signal: new AbortController().signal, session: null, request: async url => {
    assert.equal(url.hostname, 'codeforces.com');
    if (url.pathname.endsWith('user.info')) return new Response(JSON.stringify({ status: 'OK', result: [{ handle: 'WorkerFixture' }] }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ status: 'OK', result: [] }), { headers: { 'content-type': 'application/json' } });
  } } };
  const workerCandidate = await saveBindingCandidate(one.id, 'codeforces', 'WorkerFixture', boss);
  const workerRun = (await getSyncRun(workerCandidate.runId!))!;
  await executePersonalJob(boss, { syncRunId: workerRun.id, batch: 0 }, workerRun.job_id!, runtime);
  assert.equal((await getSyncRun(workerRun.id))!.status, 'completed');
  const next = (await pool.query<{ id: string; job_id: string }>("SELECT id,job_id FROM sync_runs WHERE binding_id=$1 AND kind='sync' AND status='queued'", [workerRun.binding_id])).rows[0]!;
  await executePersonalJob(boss, { syncRunId: next.id, batch: 0 }, next.job_id, runtime);
  assert.equal((await getSyncRun(next.id))!.status, 'completed');
  checks.push('real worker service validates and completes empty visible history');

  const rangeUser = (await pool.query<{ id: string }>("INSERT INTO users(username,password_hash) VALUES ('probe_range',$1) RETURNING id", [hashed])).rows[0]!;
  const rangeCandidate = await saveBindingCandidate(rangeUser.id, 'codeforces', 'RangeFixture', boss);
  const rangeVerify = (await getSyncRun(rangeCandidate.runId!))!;
  await claimSyncRun(rangeVerify.id, 0, rangeVerify.job_id!);
  const automatic = await activateBinding(rangeVerify.id, { platform: 'codeforces', kind: 'person', handle: 'RangeFixture', externalId: null }, boss);
  assert.equal((await getSyncRun(automatic.runId))!.scope, 'initial'); assert.ok((await getSyncRun(automatic.runId))!.initial_from); assert.equal((await getSyncRun(automatic.runId))!.range_from, null);
  await pool.query("UPDATE sync_runs SET status='cancelled' WHERE id=$1", [automatic.runId]);
  const range = { from: new Date('2026-10-01T16:00:00.000Z'), to: new Date('2026-10-02T16:00:00.000Z') };
  const initial = await requestPersonalSync(rangeCandidate.bindingId, 'incremental', boss, range);
  assert.equal((await requestPersonalSync(rangeCandidate.bindingId, 'incremental', boss, range)).merged, true);
  await assert.rejects(requestPersonalSync(rangeCandidate.bindingId, 'incremental', boss, { ...range, from: new Date('2026-09-01T16:00:00.000Z') }), /SYNC_RANGE_CONFLICT/);
  const initialRun = (await getSyncRun(initial.runId))!; assert.equal(initialRun.scan_checkpoint, null);
  const readRequests: string[] = [];
  const rangeRuntime: ReadRuntimeOptions = { signal: new AbortController().signal, context: { signal: new AbortController().signal, session: null, request: async url => {
    readRequests.push(url.pathname);
    const result = url.pathname.endsWith('user.info') ? [{ handle: 'RangeFixture' }] : [
      submissionFixture(995, { creationTimeSeconds: range.to.getTime() / 1000 }),
      submissionFixture(994, { creationTimeSeconds: range.to.getTime() / 1000 - 1 }),
      submissionFixture(993, { creationTimeSeconds: range.from.getTime() / 1000 }),
      submissionFixture(992, { creationTimeSeconds: range.from.getTime() / 1000 - 1 }),
    ].map(row => ({ ...row, author: { members: [{ handle: 'RangeFixture' }], participantType: 'PRACTICE', ghost: false } }));
    return new Response(JSON.stringify({ status: 'OK', result }), { headers: { 'content-type': 'application/json' } });
  } } };
  await executePersonalJob(boss, { syncRunId: initialRun.id, batch: 0 }, initialRun.job_id!, rangeRuntime);
  const bounded = (await getSyncRun(initialRun.id))!;
  assert.equal(bounded.status, 'completed'); assert.equal(bounded.stop_reason, 'range_start'); assert.equal(bounded.range_complete, true);
  assert.equal(bounded.pages, 1); assert.equal(bounded.batch, 0); assert.equal(bounded.records, 2);
  assert.equal(readRequests.filter(path => path.endsWith('user.status')).length, 1);
  const boundedCursor = await readSyncCursor(bounded.account_id!, 'incremental'); assert.equal(boundedCursor.history_complete, false); assert.equal(boundedCursor.checkpoint, null); assert.equal(boundedCursor.initialized_at, null);
  assert.equal((await getPersonalMember(rangeUser.id, query())).submissionCount, 2);
  assert.equal((await getPersonalMember(rangeUser.id, query())).provisional, true);
  const rawIds = (await getPersonalRecords(rangeUser.id, query(), true)).items.map(row => row.externalSubmissionId).sort();
  assert.deepEqual(rawIds, ['993', '994']);
  checks.push('explicit range stops at requested dates, includes Beijing boundaries and never claims full history');

  const reused = await requestPersonalSync(rangeCandidate.bindingId, 'incremental', boss, range);
  assert.equal((await getSyncRun(reused.runId))!.scan_checkpoint, null);
  await pool.query("UPDATE sync_runs SET status='cancelled' WHERE id=$1", [reused.runId]);
  const wider = await requestPersonalSync(rangeCandidate.bindingId, 'incremental', boss, { ...range, from: new Date('2026-09-01T16:00:00.000Z') });
  assert.equal((await getSyncRun(wider.runId))!.scan_checkpoint, null);
  await pool.query("UPDATE sync_runs SET status='cancelled' WHERE id=$1", [wider.runId]);
  checks.push('range merges are exact and supplemental scans never reuse continuous checkpoints');

  const terminal = await requestPersonalSync(rangeCandidate.bindingId, 'backfill', boss, range);
  const terminalRun = (await getSyncRun(terminal.runId))!; await claimSyncRun(terminalRun.id, 0, terminalRun.job_id!);
  await readSyncCursor(terminalRun.account_id!, 'backfill');
  const terminalPage = { ...fixturePage(), submissions: [], problems: [], nextCursor: null, nextCheckpoint: bounded.scan_checkpoint, stopReason: 'range_start' };
  const failedPage = { ...terminalPage, problems: [{ ...fixturePage().problems[0]!, platform: 'qoj' }] };
  await assert.rejects(commitPersonalPage(terminalRun.id, terminalRun.cursor_version, failedPage), /FACT_PLATFORM_MISMATCH/);
  assert.equal((await getSyncRun(terminalRun.id))!.cursor_version, terminalRun.cursor_version);
  await commitPersonalPage(terminalRun.id, terminalRun.cursor_version, terminalPage);
  await assert.rejects(commitPersonalPage(terminalRun.id, terminalRun.cursor_version, terminalPage), /STALE_CURSOR/);
  await finishPersonalBatch(terminalRun.id, boss, { error: { code: 'INTERRUPTED' }, paused: true });
  const resumedTerminal = await retryPersonalRun(terminalRun.id, boss);
  const beforeRetry = readRequests.length;
  await executePersonalJob(boss, { syncRunId: terminalRun.id, batch: 1 }, resumedTerminal.jobId!, rangeRuntime);
  assert.equal(readRequests.length, beforeRetry); assert.equal((await getSyncRun(terminalRun.id))!.status, 'completed');
  assert.equal((await readSyncCursor(terminalRun.account_id!, 'backfill')).history_complete, false);
  checks.push('failed range transactions retain run cursors and retry after a committed terminal page makes no platform requests');

  const requested: string[] = [];
  let delayed = false, release: (() => void) | undefined;
  const contextHtml = (template: string, user: unknown) => `<meta name="csrf-token" content="fixture-csrf"><script id="lentille-context">${JSON.stringify({ template, status: 200, data: {}, user })}</script>`;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requested.push(url.pathname);
    assert.equal(url.hostname, 'www.luogu.com.cn');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('user-agent'), 'acm-labrank/1.0');
    assert.equal(headers.get('accept-language'), 'zh-CN,zh;q=0.9');
    if (url.pathname !== '/auth/login') assert.ok(headers.get('cookie')?.includes('fixture-session'));
    if (url.pathname === '/auth/login') return new Response(contextHtml('login', null), { headers: { 'content-type': 'text/html', 'set-cookie': 'fixture-session=one; Path=/; Secure; HttpOnly' } });
    if (url.pathname === '/_lfe/config/auth') return new Response(JSON.stringify({ route: { 'auth.login_methods': '/auth/login-methods', 'do_auth.password': '/do-auth/password', captcha: '/lg4/captcha' } }), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/auth/login-methods') return new Response(JSON.stringify({ default: 'password', available: ['password'] }), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/lg4/captcha') return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    if (url.pathname === '/do-auth/password') {
      if (delayed) await new Promise<void>(resolve => { release = resolve; });
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(body.captcha === 'bad' ? { error: 'fixture' } : { redirectTo: '/' }), { headers: { 'content-type': 'application/json' } });
    }
    assert.equal(url.pathname, '/'); return new Response(contextHtml('home', { uid: 99001, name: 'FixtureCollector' }), { headers: { 'content-type': 'text/html' } });
  };
  await pool.query("UPDATE platform_request_policies SET min_interval_ms=1000,max_interval_ms=1000 WHERE platform='luogu'");
  async function freshAttempt() { await pool.query("UPDATE platform_request_limits SET next_request_at=now(),blocked_until=now() WHERE platform='luogu'"); return beginWebLuoguLogin({ username: 'fixture-login' }, sid, new AbortController().signal); }
  const attempt = await freshAttempt();
  const image = await webLuoguCaptcha(attempt.id, sid); assert.deepEqual(image.image, Buffer.from([1, 2, 3]));
  const readsBefore = requested.length; await webLuoguCaptcha(attempt.id, sid); assert.equal(requested.length, readsBefore);
  const refreshed = await advanceWebLuoguLogin(attempt.id, { version: 1 }, sid, new AbortController().signal, true);
  await assert.rejects(advanceWebLuoguLogin(attempt.id, { version: 1, password, captcha: 'good' }, sid, new AbortController().signal), e => (e as { status?: number }).status === 409);
  const completed = await advanceWebLuoguLogin(attempt.id, { version: refreshed.version, password, captcha: 'good' }, sid, new AbortController().signal);
  assert.equal(completed.state, 'succeeded');
  const connection = await ensureCollectionConnection('luogu-lab', 'luogu'); assert.equal(connection.collector, '99001');
  assert.ok(requested.every(p => !p.includes('record') && !p.includes('practice')));
  assert.equal((await getLoginAttempt(attempt.id, sid))!.encrypted_context, null);
  checks.push('persistent captcha, stable image, refresh version, identity-only login');
  const wrong = await freshAttempt();
  await assert.rejects(advanceWebLuoguLogin(wrong.id, { version: 1, password, captcha: 'bad' }, sid, new AbortController().signal));
  assert.equal((await ensureCollectionConnection('luogu-lab', 'luogu')).generation, connection.generation);
  const expired = await freshAttempt(); await pool.query("UPDATE platform_login_attempts SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
  await assert.rejects(webLuoguCaptcha(expired.id, sid));
  const otherSid = randomUUID(); await assert.rejects(webLuoguCaptcha(attempt.id, otherSid));
  const late = await freshAttempt(); delayed = true;
  const pending = advanceWebLuoguLogin(late.id, { version: 1, password, captcha: 'good' }, sid, new AbortController().signal);
  pending.catch(() => undefined);
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  await cancelWebLuoguLogin(late.id, sid); release(); await assert.rejects(pending);
  assert.equal((await ensureCollectionConnection('luogu-lab', 'luogu')).generation, connection.generation);
  const secretRows = await pool.query('SELECT encrypted_context FROM platform_login_attempts WHERE encrypted_context IS NOT NULL');
  assert.ok(secretRows.rows.every(row => !row.encrypted_context.includes(password)));
  checks.push('wrong/expired/cross-session challenges and cancelled late login preserve old session');
  async function rejectedLateLogin(change: (id: string) => Promise<void>) {
    release = undefined; const trial = await freshAttempt();
    const lateRequest = advanceWebLuoguLogin(trial.id, { version: 1, password, captcha: 'good' }, sid, new AbortController().signal); lateRequest.catch(() => undefined);
    while (!release) await new Promise(resolve => setTimeout(resolve, 10));
    await change(trial.id); (release as unknown as () => void)(); await assert.rejects(lateRequest);
    assert.equal((await ensureCollectionConnection('luogu-lab', 'luogu')).generation, connection.generation);
  }
  await rejectedLateLogin(async id => { await pool.query("UPDATE platform_login_attempts SET expires_at=now()-interval '1 second' WHERE id=$1", [id]); });
  await rejectedLateLogin(async () => { await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [sid]); });
  await pool.query('UPDATE sessions SET revoked_at=NULL WHERE id=$1', [sid]);
  checks.push('expiry and session revocation block late successful responses');
  // Claim primitive refuses concurrent submissions even before reaching the connector.
  const id = randomUUID(); await createLoginAttempt({ id, sessionId: sid, connectionId: connection.id, generation: connection.generation });
  await saveLoginChallenge(id, sid, 1, { version: 1, context: 'fixture-encrypted', image: 'AQID', contentType: 'image/png' });
  const claims = await Promise.all([claimLoginAttempt(id, sid, 1), claimLoginAttempt(id, sid, 1)]); assert.equal(claims.filter(Boolean).length, 1); await endLoginAttempt(id, sid, 'cancelled');
  checks.push('atomic challenge claiming');
  console.log(JSON.stringify({ event: 'personal_probe_passed', checks }));
} finally { globalThis.fetch = originalFetch; await boss.stop(); await closeDb(); }
