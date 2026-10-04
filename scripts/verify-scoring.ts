import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { closeDb, getPool, initializeCollectionSettings, initializeSiteSettings } from '@acm/db/server';
import { migrateSchema } from '../packages/db/src/schema-migrations';
import { changeScoringSettings, createTeam, getPersonalLeaderboard, getPersonalMember, getPersonalRecords, getScoringSettings, getTeamDetail, getTeamLeaderboard, hashPassword } from '../packages/core/src/application';
import { pointsSql } from '../packages/core/src/application/scores/query';
import { CF_BANDS, DEFAULT_SCORING_RULES, problemPoints } from '../packages/core/src/domain';

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error('DATABASE_URL required');
const database = `acm_scoring_verify_${randomUUID().replaceAll('-', '')}`;
assert.match(database, /^acm_scoring_verify_[a-f0-9]{32}$/);
const base = 'http://127.0.0.1:3004', password = 'scoring-fixture-only-password';
const checks: string[] = [], date = '2026-10-04', params = () => new URLSearchParams({ from: date, to: date });
let passed = false;
let server: ReturnType<typeof spawn> | undefined;
const { chromium } = createRequire(new URL('../packages/core/package.json', import.meta.url))('playwright-core') as typeof import('../packages/core/node_modules/playwright-core');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
interface Session { cookie: string; csrf: string }
async function api(path: string, session?: Session, method = 'GET', body?: unknown, override?: Record<string, string>) {
  return fetch(`${base}${path}`, { method, headers: { origin: base, 'content-type': 'application/json', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...override }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function login(username: string) {
  const response = await api('/api/auth/login', undefined, 'POST', { username, password }); assert.equal(response.status, 200);
  const data = await response.json() as { csrfToken: string };
  return { cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), csrf: data.csrfToken };
}
try {
  await getPool().query(`CREATE DATABASE "${database}"`); await closeDb();
  const target = new URL(baseUrl); target.pathname = `/${database}`; process.env.DATABASE_URL = target.href;
  await migrateSchema(); await initializeCollectionSettings(); await initializeSiteSettings();
  const pool = getPool();
  await pool.query('INSERT INTO collection_control(id) VALUES (1)');
  await pool.query('UPDATE collection_settings SET platforms=$1,score_range=$2 WHERE id=1', [['codeforces', 'luogu', 'qoj'], JSON.stringify({ kind: 'fixed', from: date, to: date })]);
  assert.deepEqual((await getScoringSettings()).rules, DEFAULT_SCORING_RULES);
  const passwordHash = await hashPassword(password);
  const users: string[] = [];
  for (const username of ['score_admin', 'score_a', 'score_b', 'score_c']) users.push((await pool.query<{ id: string }>('INSERT INTO users(username,password_hash,role) VALUES ($1,$2,$3) RETURNING id', [username, passwordHash, username === 'score_admin' ? 'admin' : 'member'])).rows[0]!.id);
  const [admin, a, b, c] = users as [string, string, string, string];
  async function account(userId: string, platform: string) {
    const handle = `score_${randomUUID()}`;
    const id = (await pool.query<{ id: string }>('INSERT INTO platform_accounts(platform,handle,identity_key) VALUES ($1,$2,$2) RETURNING id', [platform, handle])).rows[0]!.id;
    await pool.query('INSERT INTO platform_bindings(user_id,platform,account_id) VALUES ($1,$2,$3)', [userId, platform, id]); return id;
  }
  const aa = await account(a, 'codeforces'), ba = await account(b, 'codeforces'), cl = await account(c, 'luogu'), cq = await account(c, 'qoj');
  async function problem(platform: string, key: string, difficulty: number | null) {
    return (await pool.query<{ id: string }>('INSERT INTO problems(platform,problem_key,title,native_difficulty,source_url,difficulty_updated_at,observed_at) VALUES ($1,$2,$2,$3,$4,now(),now()) RETURNING id', [platform, key, difficulty, 'https://example.test/problem'])).rows[0]!.id;
  }
  async function ac(platform: string, problemId: string, attributions: [string, string][], divisor = 1, time = '2026-10-04T01:00:00Z') {
    const id = (await pool.query<{ id: string }>("INSERT INTO submissions(platform,external_submission_id,problem_id,submitted_at,verdict,subject_evidence,parser_version,observed_at) VALUES ($1,$2,$3,$4,'accepted','{}','fixture',now()) RETURNING id", [platform, randomUUID(), problemId, time])).rows[0]!.id;
    for (const [userId, accountId] of attributions) await pool.query("INSERT INTO submission_attributions(submission_id,user_id,account_id,method,share_divisor) VALUES ($1,$2,$3,'verified_person',$4)", [id, userId, accountId, divisor]);
  }
  const shared = await problem('codeforces', 'shared', 1800);
  await ac('codeforces', shared, [[a, aa], [b, ba]], 3);
  await ac('codeforces', shared, [[a, aa]], 1, '2026-10-04T02:00:00Z');
  await ac('codeforces', await problem('codeforces', 'easy', 900), [[b, ba]]);
  await ac('codeforces', await problem('codeforces', 'unknown', null), [[a, aa]]);
  const old = await problem('codeforces', 'old', 2900);
  await ac('codeforces', old, [[a, aa]], 1, '2026-10-03T01:00:00Z'); await ac('codeforces', old, [[a, aa]]);
  await ac('luogu', await problem('luogu', 'known', 5), [[c, cl]]);
  await ac('luogu', await problem('luogu', 'unknown', null), [[c, cl]]);
  await ac('qoj', await problem('qoj', 'qoj', null), [[c, cq]]);
  const team = await createTeam(a, { name: 'Scoring AB', memberIds: [a, b] });
  const beforeFacts = (await pool.query('SELECT (SELECT count(*) FROM submissions) AS submissions,(SELECT count(*) FROM problems) AS problems,(SELECT count(*) FROM submission_attributions) AS attributions')).rows[0];
  async function verifyScores(expected: [number, number, number], version: number) {
    const board = await getPersonalLeaderboard(params()); assert.equal(board.ruleVersion, `v2.${version}`);
    for (const [index, id] of [a, b, c].entries()) {
      const member = await getPersonalMember(id, params()), records = await getPersonalRecords(id, params(), false);
      assert.equal(board.items.find(row => row.id === id)!.points, expected[index]); assert.equal(member.points, expected[index]);
      assert.equal(records.items.reduce((sum, record) => sum + record.points, 0), expected[index]);
      assert.equal(member.calendar.reduce((sum, day) => sum + day.points, 0), expected[index]);
      assert.equal(member.solveCount, index === 2 ? 3 : 2);
    }
    const detail = await getTeamDetail(team.id, params()), teams = await getTeamLeaderboard(params());
    assert.equal(detail.points, expected[0] + expected[1]); assert.equal(detail.solveCount, 4);
    assert.equal(detail.members.reduce((sum, member) => sum + member.points, 0), detail.points);
    assert.equal(teams.items.find(row => row.id === team.id)!.points, detail.points);
    assert.equal((await getPersonalRecords(a, params(), false)).items.some(row => row.problemKey === 'old'), false);
    return board;
  }
  assert.equal((await verifyScores([5, 3, 14], 1)).items[0]!.id, c);
  const custom = structuredClone(DEFAULT_SCORING_RULES);
  custom.codeforces.points[5] = 60; custom.codeforces.points[0] = 0; custom.codeforces.unknownPoints = 0.125;
  custom.luogu.points[4] = 1.5; custom.luogu.unknownPoints = 0; custom.qoj.points = 2.5;
  await changeScoringSettings({ rules: custom, version: 1 }, admin);
  assert.equal((await verifyScores([20.125, 20, 4], 2)).items[0]!.id, a);
  await assert.rejects(changeScoringSettings({ rules: custom, version: 1 }, admin), error => (error as { status: number }).status === 409);
  for (const rules of [DEFAULT_SCORING_RULES, custom]) for (const [platform, values] of [
    ['codeforces', [null, NaN, Infinity, -Infinity, ...CF_BANDS.flatMap(([boundary]) => [boundary - 1, boundary]), 3500]],
    ['luogu', [null, NaN, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]], ['qoj', [null, 2000]],
  ] as [string, (number | null)[]][]) for (const difficulty of values) {
    const sql = await pool.query<{ points: string }>(`SELECT ${pointsSql(rules)} AS points FROM (SELECT $1::text AS platform,$2::float8 AS native_difficulty) p`, [platform, difficulty]);
    assert.equal(Number(sql.rows[0]!.points), problemPoints(platform, difficulty, rules));
  }
  checks.push('default and custom scores agree across SQL, functions, personal/team rankings, records and calendars; shared credit and first AC preserved');
  const concurrent = await Promise.allSettled([changeScoringSettings({ rules: custom, version: 2 }, admin), changeScoringSettings({ rules: custom, version: 2 }, admin)]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  await changeScoringSettings({ rules: DEFAULT_SCORING_RULES, version: 3 }, admin); await verifyScores([5, 3, 14], 4);
  assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM submissions) AS submissions,(SELECT count(*) FROM problems) AS problems,(SELECT count(*) FROM submission_attributions) AS attributions')).rows[0], beforeFacts);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM collection_audit_logs WHERE action='scoring_settings_updated'")).rows[0].n, 3);
  checks.push('atomic concurrent saves, restore defaults, audit records and unchanged submission facts');

  server = spawn(process.execPath, [fileURLToPath(new URL('../apps/web/node_modules/next/dist/bin/next', import.meta.url)), 'start', '--hostname', '127.0.0.1', '--port', '3004'], { cwd: fileURLToPath(new URL('../apps/web', import.meta.url)), env: { ...process.env, APP_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; server.stdout?.on('data', data => { output = (output + String(data)).slice(-5000); }); server.stderr?.on('data', data => { output = (output + String(data)).slice(-5000); });
  let ready = false;
  for (let i = 0; i < 60; i++) { if (server.exitCode !== null) throw new Error(`Web exited: ${output}`); try { if ((await fetch(`${base}/api/health/live`)).ok) { ready = true; break; } } catch { /* Starting. */ } await new Promise(resolve => setTimeout(resolve, 500)); }
  assert.ok(ready, output);
  const adminSession = await login('score_admin'), memberSession = await login('score_a'), endpoint = '/api/admin/scoring-settings';
  assert.equal((await api(endpoint)).status, 401); assert.equal((await api(endpoint, memberSession)).status, 403);
  const input = { rules: custom, version: 4 };
  assert.equal((await api(endpoint, memberSession, 'PUT', input)).status, 403);
  assert.equal((await api(endpoint, adminSession, 'PUT', input, { origin: 'https://wrong.test' })).status, 403);
  assert.equal((await api(endpoint, adminSession, 'PUT', input, { 'x-csrf-token': 'bad' })).status, 403);
  assert.equal((await api(endpoint, adminSession, 'PUT', { ...input, rules: {} })).status, 400);
  assert.equal((await api(endpoint, adminSession, 'PUT', input)).status, 200);
  assert.equal((await api(endpoint, adminSession, 'PUT', input)).status, 409);
  const response = await api(endpoint, adminSession); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json() as { version: number }).version, 5);
  const publicBoard = await (await api(`/api/leaderboard?${params()}`)).json() as { items: { id: string; points: number }[] };
  assert.equal(publicBoard.items.find(row => row.id === a)!.points, 20.125);
  checks.push('HTTP administrator/Origin/CSRF checks, invalid and stale updates, no-store and immediate public leaderboard recalculation');

  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.addCookies([{ name: 'acm_session', value: adminSession.cookie.split('=')[1]!, url: base }]);
  await page.goto(`${base}/admin/scoring`); await page.getByRole('heading', { name: '赋分设置', exact: true }).waitFor();
  const save = page.getByRole('button', { name: '保存并重新计算', exact: true });
  assert.equal(await save.isDisabled(), true);
  await page.locator('input[name="qoj"]').fill('10.75'); await save.click();
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.equal((await getScoringSettings()).rules.qoj.points, 10.75);
  await page.getByRole('cell', { name: '12.25', exact: true }).waitFor();
  await page.reload(); assert.equal(await page.locator('input[name="qoj"]').inputValue(), '10.75');
  await page.locator('input[name="qoj"]').fill(''); assert.equal(await page.evaluate('document.querySelector("form").checkValidity()'), false);
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  assert.equal(await page.locator('input[name="qoj"]').inputValue(), '3'); assert.equal((await getScoringSettings()).rules.qoj.points, 10.75);
  await save.click(); await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  await verifyScores([5, 3, 14], 7);
  const latest = await getScoringSettings(); await changeScoringSettings({ ...latest, rules: custom }, admin);
  await page.locator('input[name="qoj"]').fill('9'); await save.click(); await page.getByRole('alert').filter({ hasText: '其他管理员' }).waitFor();
  await page.getByRole('button', { name: '重新加载已保存规则', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已加载' }).waitFor(); assert.equal(await page.locator('input[name="qoj"]').inputValue(), '2.5');
  await page.getByRole('cell', { name: '20.125', exact: true }).waitFor();
  const screenshots = fileURLToPath(new URL('../.local/scoring-settings/', import.meta.url)); await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/mobile.png`, fullPage: true });
  assert.ok(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'));
  assert.deepEqual(errors, []);
  checks.push('browser save/reload, required input, restore defaults, conflict recovery, desktop/mobile layout and no page errors');
  passed = true; console.log(JSON.stringify({ event: 'scoring_verification_passed', checks }));
} finally {
  await browser?.close(); server?.kill(); await closeDb(); process.env.DATABASE_URL = baseUrl;
  if (passed) await getPool().query(`DROP DATABASE "${database}" WITH (FORCE)`);
  else console.error(JSON.stringify({ event: 'scoring_verification_failed', isolatedDatabase: database }));
  await closeDb();
}
