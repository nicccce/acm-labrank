import assert from 'node:assert/strict';
import type { Route } from '../packages/core/node_modules/playwright-core';
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
  for (const path of ['/api/members', '/api/teams']) { assert.equal((await api(path)).status, 401); const response = await api(path, a); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); const data = JSON.stringify(await response.json()); assert.equal(/passwordHash|password_hash|encryptedSession|tokenHash|candidateError/.test(data), false); }
  for (const path of ['/api/leaderboard', '/api/team-leaderboard']) { const response = await api(path); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); const data = await response.json() as Record<string, unknown>; assert.equal('coverage' in data, false); }
  for (const path of [`/api/members/${a.user.id}`, `/api/members/${a.user.id}/solves`, `/api/members/${a.user.id}/submissions`]) assert.equal((await api(path)).status, 401);
  assert.equal((await api('/api/admin/platforms', a)).status, 403);
  const input = { name: 'API EF', memberIds: [e.user.id, f.user.id] };
  assert.equal((await api('/api/teams', e, 'POST', input, { origin: 'https://wrong.example' })).status, 403);
  assert.equal((await api('/api/teams', e, 'POST', input, { 'x-csrf-token': 'bad' })).status, 403);
  assert.equal((await api('/api/teams', e, 'POST', { ...input, memberIds: [e.user.id, e.user.id] })).status, 400);
  const created = await api('/api/teams', e, 'POST', input); assert.equal(created.status, 201); const team = await created.json() as { id: string };
  assert.equal((await api(`/api/teams/${team.id}`)).status, 401);
  const duplicate = await api('/api/teams', f, 'POST', { name: 'different name', memberIds: [...input.memberIds].reverse() }); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json() as { id: string }).id, team.id);
  assert.equal((await api(`/api/teams/${team.id}`, a, 'PUT', { ...input, version: 1 })).status, 403);
  assert.equal((await api(`/api/teams/${team.id}`, a, 'DELETE', { version: 1 })).status, 403);
  assert.equal((await api(`/api/teams/${team.id}/archive`, a, 'POST', { version: 1 })).status, 403);
  assert.equal((await api(`/api/teams/${team.id}/members/me`, a, 'DELETE', { version: 1 })).status, 403);
  assert.equal((await api(`/api/teams/${team.id}`, f, 'PUT', { ...input, name: 'API EF shared', version: 1 })).status, 200);
  assert.equal((await api(`/api/teams/${team.id}`, e, 'PUT', { ...input, version: 999 })).status, 409);
  const shared = await (await api(`/api/teams/${team.id}`, e)).json() as { team: { name: string; version: number; ownerId?: string } };
  assert.equal(shared.team.name, 'API EF shared'); assert.equal(shared.team.ownerId, undefined);
  assert.equal((await api(`/api/teams/${team.id}/archive`, f, 'POST', { version: 2 }, { 'x-csrf-token': 'bad' })).status, 403);
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
  assert.equal(await page.getByRole('link', { name: '采集管理', exact: true }).count(), 0);
  await page.getByLabel('账户菜单', { exact: true }).click();
  await page.getByRole('link', { name: '资料与账号', exact: true }).click();
  await page.getByLabel('真实姓名（选填）').fill('乙同学'); await page.getByRole('button', { name: '保存姓名', exact: true }).click(); await page.getByRole('status').getByText('已保存', { exact: true }).waitFor();
  assert.equal((await (await api('/api/me', e)).json() as { realName: string }).realName, '乙同学');
  await page.getByRole('link', { name: '我的队伍', exact: true }).click();
  if (!await page.getByLabel('队伍名称').isVisible()) await page.getByText('＋ 创建队伍', { exact: true }).click();
  let releaseSearch: (() => void) | undefined;
  const delayedSearch = new Promise<void>(resolve => { releaseSearch = resolve; });
  await page.route('**/api/members?*', async (route: Route) => {
    if (new URL(route.request().url()).searchParams.get('q') === 'member_f') { const old = await route.fetch(); await delayedSearch; await route.fulfill({ response: old }).catch(() => undefined); }
    else await route.continue();
  });
  await page.getByLabel('查找成员').fill('member_f'); await page.getByRole('button', { name: '搜索成员', exact: true }).click();
  await page.getByLabel('查找成员').fill('member_c'); await page.getByLabel('查找成员').press('Enter');
  await page.locator('.member-choice').filter({ hasText: 'member_c' }).waitFor();
  releaseSearch!(); await page.waitForTimeout(300); assert.equal(await page.locator('.member-choice').filter({ hasText: 'member_f' }).count(), 0);
  await page.unroute('**/api/members?*');
  await page.getByLabel('队伍名称').fill('UI EC'); await page.getByLabel('查找成员').fill('member_c'); await page.getByRole('button', { name: '搜索成员', exact: true }).click();
  await page.locator('.member-choice').filter({ hasText: 'member_c' }).getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('button', { name: '创建队伍', exact: true }).click(); await page.waitForURL(/\/teams\/[a-f0-9-]+$/); await page.getByRole('heading', { name: 'UI EC', exact: true }).waitFor();
  const uiId = new URL(page.url()).pathname.split('/').at(-1)!;
  await page.goto(`${base}/teams`);
  await page.getByText('＋ 创建队伍', { exact: true }).click();
  await page.getByLabel('队伍名称').fill('duplicate name'); await page.getByLabel('查找成员').fill('member_c'); await page.getByRole('button', { name: '搜索成员', exact: true }).click();
  await page.locator('.member-choice').filter({ hasText: 'member_c' }).getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('button', { name: '创建队伍', exact: true }).click(); await page.getByRole('status').getByText(/已存在相同成员/).waitFor();
  await page.getByRole('link', { name: '查看已有队伍', exact: true }).click(); await page.waitForURL(`${base}/teams/${uiId}`); await page.getByRole('heading', { name: 'UI EC', exact: true }).waitFor();
  await page.getByText('编辑队伍', { exact: true }).click();
  await page.getByLabel('队伍名称').fill('UI EC changed'); await page.getByRole('button', { name: '保存队伍', exact: true }).click(); await page.getByRole('heading', { name: 'UI EC changed', exact: true }).waitFor();
  assert.equal(await page.getByLabel('负责人', { exact: true }).count(), 0);
  const cContext = await browser.newContext(), cPage = await cContext.newPage(); cPage.on('pageerror', (error: Error) => errors.push(error.message));
  await cPage.goto(`${base}/login`); await cPage.getByLabel('用户名', { exact: true }).fill('member_c'); await cPage.getByLabel('密码', { exact: true }).fill(password); await cPage.getByRole('button', { name: '登录', exact: true }).click(); await cPage.waitForURL(`${base}/`);
  await cPage.goto(`${base}/teams/${uiId}`);
  await cPage.getByText('编辑队伍', { exact: true }).click();
  await cPage.getByLabel('队伍名称').fill('UI EC shared'); await cPage.getByRole('button', { name: '保存队伍', exact: true }).click(); await cPage.getByRole('heading', { name: 'UI EC shared', exact: true }).waitFor();
  await cPage.getByLabel('查找成员').fill('member_f'); await cPage.getByRole('button', { name: '搜索成员', exact: true }).click();
  await cPage.locator('.member-choice').filter({ hasText: 'member_f' }).getByRole('button', { name: '添加', exact: true }).click();
  await cPage.getByLabel('队伍名称').fill('UI ECF shared'); await cPage.getByRole('button', { name: '保存队伍', exact: true }).click(); await cPage.getByRole('heading', { name: 'UI ECF shared', exact: true }).waitFor();
  await cPage.locator('.member-choice').filter({ hasText: 'member_f' }).getByRole('button', { name: '移除', exact: true }).click();
  await cPage.getByLabel('队伍名称').fill('UI EC shared'); await cPage.getByRole('button', { name: '保存队伍', exact: true }).click(); await cPage.getByRole('heading', { name: 'UI EC shared', exact: true }).waitFor();
  for (const name of ['归档队伍', '退出队伍', '删除队伍']) await cPage.getByRole('button', { name, exact: true }).waitFor();
  await mkdir('/tmp/member-probe', { recursive: true }); await cPage.screenshot({ path: '/tmp/member-probe/team-shared-actions-desktop.png', fullPage: true });
  await cPage.setViewportSize({ width: 390, height: 844 }); assert.equal(await cPage.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  await cPage.screenshot({ path: '/tmp/member-probe/team-shared-actions-mobile.png', fullPage: true });
  await cPage.getByRole('button', { name: '归档队伍', exact: true }).click(); await cPage.getByRole('button', { name: '确认归档队伍', exact: true }).click(); await cPage.waitForURL(`${base}/teams`);
  await page.goto(`${base}/teams`);
  await page.getByRole('link', { name: '已归档', exact: true }).click(); await page.getByRole('link', { name: 'UI EC shared', exact: true }).waitFor();
  const archived = await (await api(`/api/teams/${uiId}`, e)).json() as { team: { archivedAt: string | null }; rank: number | null }; assert.ok(archived.team.archivedAt); assert.equal(archived.rank, null);
  await page.getByRole('link', { name: '团队榜', exact: true }).click();
  await page.getByRole('button', { name: '自定义', exact: true }).click(); await page.getByLabel('开始日期').fill('2026-10-02'); await page.getByLabel('结束日期').fill('2026-10-02'); await page.getByRole('button', { name: '应用筛选', exact: true }).click(); await page.waitForURL(/from=2026-10-02/);
  await mkdir('/tmp/member-probe', { recursive: true }); await page.screenshot({ path: '/tmp/member-probe/team-desktop.png', fullPage: true });
  for (const path of ['/', '/profile', '/teams', `/teams/${uiId}`, `/members/${b.user.id}`]) { await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${base}${path}`); assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, `${path} overflows mobile`); }
  await page.getByRole('link', { name: '提交记录', exact: true }).click(); await page.waitForURL(/view=submissions/); await page.getByRole('columnheader', { name: '原站得分', exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/member-probe/member-mobile.png', fullPage: true });
  const bContext = await browser.newContext(), bPage = await bContext.newPage(); bPage.on('pageerror', (error: Error) => errors.push(error.message));
  await bPage.goto(`${base}/login`); await bPage.getByLabel('用户名', { exact: true }).fill('member_b'); await bPage.getByLabel('密码', { exact: true }).fill(password); await bPage.getByRole('button', { name: '登录', exact: true }).click(); await bPage.waitForURL(`${base}/`);
  await bPage.goto(`${base}/profile`); const cf = bPage.locator('section').filter({ has: bPage.getByRole('heading', { name: 'Codeforces', exact: true }) });
  await cf.getByLabel('Codeforces 用户名').fill('MissingMemberCF'); await cf.getByRole('button', { name: '保存账号', exact: true }).click(); await cf.getByText(/验证中|等待验证/).waitFor();
  await getPool().query("UPDATE platform_bindings SET candidate_state='not_found',candidate_error=$2 WHERE user_id=$1 AND platform='codeforces'", [b.user.id, JSON.stringify({ message: '账号不存在' })]);
  await cf.getByText(/MissingMemberCF · 账号不存在/).waitFor({ timeout: 15000 }); await cf.getByText('生效账号：MemberFixtureB', { exact: true }).waitFor();
  await cf.getByRole('button', { name: '解绑', exact: true }).click(); await cf.getByRole('button', { name: '确认解绑', exact: true }).click(); await cf.getByText('生效账号：未绑定', { exact: true }).waitFor();
  assert.equal((await (await api(`/api/members/${b.user.id}?from=2026-10-02&to=2026-10-02`, b)).json() as { points: number }).points, 0);
  assert.deepEqual(errors, []);
  await page.goto(`${base}/teams/${uiId}`); await page.getByRole('button', { name: '删除队伍', exact: true }).click(); await page.getByRole('button', { name: '确认删除队伍', exact: true }).click(); await page.waitForURL(`${base}/teams`);
  assert.equal((await api(`/api/teams/${uiId}`, e)).status, 404);
  assert.equal((await api(`/api/teams/${team.id}/archive`, f, 'POST', { version: 2 })).status, 200);
  const archivedDuplicate = await api('/api/teams', e, 'POST', { ...input, name: 'Archived duplicate' }); assert.equal(archivedDuplicate.status, 200); assert.equal((await archivedDuplicate.json() as { id: string }).id, team.id);
  assert.equal((await api(`/api/teams/${team.id}`, e, 'DELETE', { version: 3 })).status, 200);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ event: 'member_ui_probe_passed', checks: ['superseded member search cannot replace latest results', 'duplicate create visibly returns existing team', 'shared login', 'real-name editing', 'any member edits and archives, archived delete', 'archived roster deduplication', 'date filters', 'first-AC and raw tabs', 'candidate polling retains old binding then unbind', 'desktop/mobile without overflow or exceptions'], screenshots: '/tmp/member-probe' }));
} finally {
  await browser?.close(); await closeDb(); server.kill('SIGTERM');
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', () => resolve()); setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 5000).unref(); } });
}
