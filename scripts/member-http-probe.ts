import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { closeDb, getPool } from '@acm/db/server';

if (!process.env.DATABASE_URL || !/^\/acm_personal_verify_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Isolated verification database required');
const base = 'http://127.0.0.1:3002', password = 'fixture-only-password-which-is-never-persisted';
const server = spawn(process.execPath, [fileURLToPath(new URL('../apps/web/node_modules/next/dist/bin/next', import.meta.url)), 'start', '--hostname', '127.0.0.1', '--port', '3002'], { cwd: fileURLToPath(new URL('../apps/web', import.meta.url)), env: { ...process.env, APP_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; server.stdout.on('data', d => { output = (output + String(d)).slice(-8000); }); server.stderr.on('data', d => { output = (output + String(d)).slice(-8000); });
interface Session { cookie: string; csrf: string; user: { id: string; role: string } }
async function login(username: string) {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }); assert.equal(response.status, 200);
  const body = await response.json() as { csrfToken: string; user: Session['user'] };
  return { cookie: response.headers.getSetCookie().map(c => c.split(';')[0]).join('; '), csrf: body.csrfToken, user: body.user };
}
async function api(path: string, session?: Session, method = 'GET', body?: unknown, override?: Record<string, string>) {
  return fetch(`${base}${path}`, { method, headers: { origin: base, 'content-type': 'application/json', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...override }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const { chromium } = createRequire(new URL('../packages/core/package.json', import.meta.url))('playwright-core');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) { if (server.exitCode !== null) throw new Error(`Web verification exited: ${output}`); try { if ((await fetch(`${base}/api/health/live`)).ok) { ready = true; break; } } catch { /* Starting. */ } await new Promise(resolve => setTimeout(resolve, 500)); }
  assert.ok(ready, `Web verification not ready: ${output}`);
  const a = await login('member_a'), b = await login('member_b'), e = await login('member_e'), f = await login('member_f');
  for (const path of ['/api/members', '/api/teams', '/api/team-leaderboard']) { assert.equal((await api(path)).status, 401); const response = await api(path, a); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); const data = JSON.stringify(await response.json()); assert.equal(/passwordHash|password_hash|encryptedSession|tokenHash|candidateError/.test(data), false); }
  assert.equal((await api('/api/admin/platforms', a)).status, 403);
  const input = { name: 'API EF', memberIds: [e.user.id, f.user.id] };
  assert.equal((await api('/api/teams', e, 'POST', input, { origin: 'https://wrong.example' })).status, 403);
  assert.equal((await api('/api/teams', e, 'POST', input, { 'x-csrf-token': 'bad' })).status, 403);
  assert.equal((await api('/api/teams', e, 'POST', { ...input, memberIds: [e.user.id, e.user.id] })).status, 400);
  const created = await api('/api/teams', e, 'POST', input); assert.equal(created.status, 201); const team = await created.json() as { id: string };
  const duplicate = await api('/api/teams', f, 'POST', { name: 'different name', memberIds: [...input.memberIds].reverse() }); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json() as { id: string }).id, team.id);
  assert.equal((await api(`/api/teams/${team.id}`, a, 'PUT', { ...input, ownerId: e.user.id, version: 1 })).status, 403);
  assert.equal((await api(`/api/teams/${team.id}`, a, 'DELETE', { version: 1 })).status, 403);
  assert.equal((await api(`/api/teams/${team.id}/members/me`, e, 'DELETE', { version: 1 })).status, 409);
  assert.equal((await api(`/api/teams/${team.id}`, e, 'PUT', { ...input, ownerId: e.user.id, version: 999 })).status, 409);
  assert.equal((await api('/api/teams/not-a-uuid', a)).status, 400); assert.equal((await api(`/api/teams/${randomUUID()}`, a)).status, 404);
  assert.equal((await api('/api/team-leaderboard?from=2026-02-30&to=2026-03-01', a)).status, 400);
  assert.equal((await api('/api/members?limit=0', a)).status, 400);
  const registered = await api('/api/auth/register', undefined, 'POST', { username: `reg_${randomUUID().slice(0, 8)}`, password, realName: '', role: 'admin' }); assert.equal(registered.status, 201); assert.equal((await registered.json() as { user: { role: string; realName: string | null } }).user.role, 'member');
  console.log(JSON.stringify({ event: 'member_http_probe_passed', checks: ['session/role/Origin/CSRF', 'safe DTO and no-store', 'register remains member', 'duplicate create returns existing', 'invalid/stale/missing records'] }));
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(`${base}/teams`); await page.waitForURL(`${base}/login`);
  await page.getByLabel('用户名', { exact: true }).fill('member_e'); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL(`${base}/`);
  assert.equal(await page.getByRole('link', { name: '采集与积分更新', exact: true }).count(), 0);
  await page.getByRole('link', { name: '我的资料', exact: true }).click();
  await page.getByLabel('真实姓名（选填）').fill('乙同学'); await page.getByRole('button', { name: '保存姓名', exact: true }).click(); await page.getByRole('status').getByText('已保存', { exact: true }).waitFor();
  assert.equal((await (await api('/api/me', e)).json() as { realName: string }).realName, '乙同学');
  await page.getByRole('link', { name: '我的队伍', exact: true }).click();
  await page.getByLabel('队伍名称').fill('UI EC'); await page.getByLabel('查找成员').fill('member_c'); await page.getByRole('button', { name: '搜索成员', exact: true }).click();
  await page.locator('.member-choice').filter({ hasText: 'member_c' }).getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('button', { name: '创建队伍', exact: true }).click(); await page.waitForURL(/\/teams\/[a-f0-9-]+$/); await page.getByRole('heading', { name: 'UI EC', exact: true }).waitFor();
  const uiId = new URL(page.url()).pathname.split('/').at(-1)!;
  await page.getByLabel('队伍名称').fill('UI EC changed'); await page.getByRole('button', { name: '保存队伍', exact: true }).click(); await page.getByRole('heading', { name: 'UI EC changed', exact: true }).waitFor();
  const c = (await (await api('/api/members?q=member_c', e)).json() as { items: { id: string }[] }).items[0]!;
  await page.getByLabel('负责人', { exact: true }).selectOption(c.id); await page.getByRole('button', { name: '保存队伍', exact: true }).click(); await page.getByRole('button', { name: '退出队伍', exact: true }).waitFor();
  await page.getByRole('button', { name: '退出队伍', exact: true }).click(); await page.getByRole('button', { name: '确认退出', exact: true }).click(); await page.waitForURL(`${base}/teams`);
  await page.getByRole('link', { name: '已归档', exact: true }).click(); await page.getByRole('link', { name: 'UI EC changed', exact: true }).waitFor();
  const archived = await (await api(`/api/teams/${uiId}`, e)).json() as { team: { archivedAt: string | null }; rank: number | null }; assert.ok(archived.team.archivedAt); assert.equal(archived.rank, null);
  await page.getByRole('link', { name: '团队榜', exact: true }).click();
  await page.getByLabel('日期', { exact: true }).selectOption('custom'); await page.getByLabel('开始日期').fill('2026-10-02'); await page.getByLabel('结束日期').fill('2026-10-02'); await page.getByRole('button', { name: '查询', exact: true }).click(); await page.waitForURL(/from=2026-10-02/);
  await mkdir('/tmp/member-probe', { recursive: true }); await page.screenshot({ path: '/tmp/member-probe/team-desktop.png', fullPage: true });
  for (const path of ['/', '/profile', '/teams', `/teams/${uiId}`, `/members/${b.user.id}`]) { await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${base}${path}`); assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, `${path} overflows mobile`); }
  await page.getByRole('link', { name: '提交记录', exact: true }).click(); await page.waitForURL(/view=submissions/); await page.getByRole('columnheader', { name: '原站得分', exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/member-probe/member-mobile.png', fullPage: true });
  const bContext = await browser.newContext(), bPage = await bContext.newPage(); bPage.on('pageerror', (error: Error) => errors.push(error.message));
  await bPage.goto(`${base}/login`); await bPage.getByLabel('用户名', { exact: true }).fill('member_b'); await bPage.getByLabel('密码', { exact: true }).fill(password); await bPage.getByRole('button', { name: '登录', exact: true }).click(); await bPage.waitForURL(`${base}/`);
  await bPage.goto(`${base}/profile`); const cf = bPage.locator('section').filter({ has: bPage.getByRole('heading', { name: 'Codeforces', exact: true }) });
  await cf.getByLabel('Codeforces 用户名').fill('MissingMemberCF'); await cf.getByRole('button', { name: '保存账号', exact: true }).click(); await cf.getByText(/验证中/).waitFor();
  await getPool().query("UPDATE platform_bindings SET candidate_state='not_found',candidate_error=$2 WHERE user_id=$1 AND platform='codeforces'", [b.user.id, JSON.stringify({ message: '账号不存在' })]);
  await cf.getByText(/MissingMemberCF · 账号不存在/).waitFor({ timeout: 15000 }); await cf.getByText('生效账号：MemberFixtureB', { exact: true }).waitFor();
  await cf.getByRole('button', { name: '解绑', exact: true }).click(); await cf.getByRole('button', { name: '确认解绑', exact: true }).click(); await cf.getByText('生效账号：未绑定', { exact: true }).waitFor();
  assert.equal((await (await api(`/api/members/${b.user.id}?from=2026-10-02&to=2026-10-02`, b)).json() as { points: number }).points, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ event: 'member_ui_probe_passed', checks: ['shared login', 'real-name editing', 'create/edit/transfer/exit/archive views', 'date filters', 'first-AC and raw tabs', 'candidate polling retains old binding then unbind', 'desktop/mobile without overflow or exceptions'], screenshots: '/tmp/member-probe' }));
} finally {
  await browser?.close(); await closeDb(); server.kill('SIGTERM');
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', () => resolve()); setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 5000).unref(); } });
}
