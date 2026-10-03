import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Local administrator API acceptance; credentials and session tokens never enter output.
const base = process.env.APP_URL ?? 'http://localhost:3000';
const password = (await readFile('.secrets/admin-bootstrap-password', 'utf8')).trim();
async function authenticate() {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.ADMIN_BOOTSTRAP_USERNAME ?? 'admin', password }) });
    if (response.status !== 429 || attempt) return response;
    const error = await response.json() as { retryAt?: string };
    const wait = error.retryAt ? Date.parse(error.retryAt) - Date.now() + 1000 : NaN;
    assert.ok(Number.isFinite(wait) && wait > 0 && wait <= 901000, 'Login cooling period unavailable');
    console.log(JSON.stringify({ event: 'waiting_for_login_cooldown', retryAt: error.retryAt }));
    await delay(wait);
  }
  throw new Error('Login failed');
}
const login = await authenticate();
assert.equal(login.status, 200, 'Administrator login failed');
const session = await login.json() as { csrfToken: string };
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
async function api<T = unknown>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, { method, headers: { cookie, origin: base, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(result)}`);
  return result as T;
}
try {
  const action = process.argv[2] ?? 'identity';
  if (action === 'identity') {
    const job = await api<{ runId: string; jobId: string }>('/api/admin/connections/qoj/verify-session', 'POST');
    console.log(JSON.stringify({ event: 'session_verification_requested', ...job }));
    let done = false;
    for (let i = 0; i < 65; i++) {
      const run = await api<{ status: string }>(`/api/admin/read-runs/${job.runId}`);
      if (!['queued', 'running'].includes(run.status)) { console.log(JSON.stringify({ event: 'session_verification_finished', run })); assert.equal(run.status, 'completed'); done = true; break; }
      await delay(2000);
    }
    assert.ok(done, 'Session verification did not finish');
    console.log(JSON.stringify(await api('/api/admin/platforms')));
  } else if (action === 'enable' || action === 'pause') {
    const control = await api<{ version: number }>('/api/admin/collection-control');
    console.log(JSON.stringify(await api('/api/admin/collection-control', 'PUT', { enabled: action === 'enable', version: control.version })));
  } else if (action === 'sync') {
    console.log(JSON.stringify(await api('/api/admin/sync', 'POST', { mode: process.argv[3] ?? 'incremental', ...(process.argv[4] ? { accountIds: [process.argv[4]] } : {}), ...(process.argv[5] ? { from: process.argv[5], to: process.argv[6] } : {}) })));
  } else if (action === 'range-accept') {
    const argument = process.argv[3]!;
    const targets = JSON.parse(argument.startsWith('@') ? await readFile(argument.slice(1), 'utf8') : argument) as { accountId: string; platform: string; day: string }[];
    assert.ok(targets.length > 0 && targets.length <= 3);
    for (const target of targets) {
      for (const mode of ['backfill', 'incremental']) {
        const requested = await api<{ items: { runId: string; error?: unknown }[] }>('/api/admin/sync', 'POST', { accountIds: [target.accountId], mode, from: target.day, to: target.day });
        assert.equal(requested.items.length, 1); assert.ok(!requested.items[0]!.error);
        const id = requested.items[0]!.runId;
        let finished = false;
        for (let i = 0; i < 90; i++) {
          const run = await api<{ status: string; rangeComplete: boolean; stopReason: string; pages: number; recordsWithOverlap: number; range: { from: string; to: string }; error: unknown }>(`/api/admin/sync-jobs/${id}`);
          if (['failed', 'paused', 'cancelled'].includes(run.status)) throw new Error(`${target.platform}: ${JSON.stringify(run.error)}`);
          if (run.status === 'completed') {
            assert.equal(run.rangeComplete, true); assert.ok(['range_start', 'history_end', 'checkpoint_reached'].includes(run.stopReason));
            assert.equal(run.range.from, target.day); assert.equal(run.range.to, target.day); assert.ok(run.pages > 0 && run.pages <= 6);
            console.log(JSON.stringify({ event: 'live_range_completed', platform: target.platform, mode, day: target.day, stopReason: run.stopReason, pages: run.pages, recordsWithOverlap: run.recordsWithOverlap }));
            finished = true; break;
          }
          await delay(2000);
        }
        assert.ok(finished, `${target.platform} interval did not finish`);
      }
    }
  } else if (action === 'status') {
    console.log(JSON.stringify(await api('/api/admin/platforms')));
    console.log(JSON.stringify(await api('/api/leaderboard')));
  } else if (action === 'job') {
    console.log(JSON.stringify(await api(`/api/admin/sync-jobs/${process.argv[3]}`)));
  } else if (action === 'retry') {
    console.log(JSON.stringify(await api(`/api/admin/sync-jobs/${process.argv[3]}/retry`, 'POST')));
  } else if (action === 'member') {
    for (const suffix of ['', '/solves', '/submissions']) console.log(JSON.stringify({ endpoint: suffix || 'profile', result: await api(`/api/members/${process.argv[3]}${suffix}`) }));
  } else if (action === 'accept') {
    const identity = await api<{ runId: string }>('/api/admin/connections/qoj/verify-session', 'POST');
    let verified = false;
    for (let i = 0; i < 65; i++) {
      const run = await api<{ status: string; error: unknown; result: { collector: string } }>(`/api/admin/read-runs/${identity.runId}`);
      if (!['queued', 'running'].includes(run.status)) {
        console.log(JSON.stringify({ event: 'qoj_session_reverified', runId: identity.runId, ...run }));
        assert.equal(run.status, 'completed'); verified = true; break;
      }
      await delay(2000);
    }
    assert.ok(verified);
    let complete = false, previous = '';
    for (let i = 0; i < 120; i++) {
      const board = await api<{ provisional: boolean; coverage: { platform: string; handle: string | null; historyComplete: boolean; lastError: unknown }[]; items: unknown[] }>('/api/leaderboard');
      const summary = JSON.stringify(board.coverage);
      if (summary !== previous) { console.log(JSON.stringify({ event: 'coverage_progress', coverage: board.coverage })); previous = summary; }
      if (board.coverage.length >= 3 && board.coverage.every(item => item.historyComplete && !item.lastError)) {
        console.log(JSON.stringify({ event: 'all_backfills_complete', board })); complete = true; break;
      }
      await delay(10000);
    }
    assert.ok(complete, 'Backfill remains incomplete; see durable jobs');
    for (let round = 1; round <= 2; round++) {
      const request = await api<{ items: { runId: string }[] }>('/api/admin/sync', 'POST', { mode: 'incremental' });
      console.log(JSON.stringify({ event: 'incremental_requested', round, ...request }));
      let finished = false;
      for (let i = 0; i < 90; i++) {
        const runs = await Promise.all(request.items.map(item => api<{ status: string; pages: number; error: unknown }>(`/api/admin/sync-jobs/${item.runId}`)));
        if (runs.some(run => ['failed', 'paused', 'cancelled'].includes(run.status))) throw new Error(`Incremental interrupted: ${JSON.stringify(runs)}`);
        if (runs.every(run => run.status === 'completed')) { console.log(JSON.stringify({ event: 'incremental_completed', round, runs })); finished = true; break; }
        await delay(10000);
      }
      assert.ok(finished, 'Incremental remains incomplete');
    }
    console.log(JSON.stringify({ event: 'live_api_acceptance_passed', platforms: await api('/api/admin/platforms'), leaderboard: await api('/api/leaderboard') }));
  } else throw new Error('Unsupported acceptance action');
} finally { await api('/api/auth/logout', 'POST'); }
