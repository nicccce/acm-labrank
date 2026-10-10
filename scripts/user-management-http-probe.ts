import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getPool } from '@acm/db/server';
import { hashPassword } from '../packages/core/src/application/auth';
import { createTeam } from '../packages/core/src/application/teams';
import type { Browser } from '../packages/core/node_modules/playwright-core';

if (!process.env.DATABASE_URL || !/^\/acm_user_verify_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Isolated user verification database required');
const base = 'http://127.0.0.1:3101', password = 'web_fixture_password_123';
const pool = getPool(), hash = await hashPassword(password);
const people = (await pool.query<{ id: string; username: string }>(`INSERT INTO users(username,real_name,password_hash,role,is_starred)
  SELECT name,name,$1,CASE WHEN name='web_admin' THEN 'admin' ELSE 'member' END,name='web_member' FROM unnest(ARRAY['web_admin','web_member','web_other','web_third']) name RETURNING id,username`, [hash])).rows;
const id = (name: string) => people.find(u => u.username === name)!.id;
const team = (await createTeam(id('web_member'), { name: '网页验证队伍', memberIds: [id('web_member'), id('web_other')] })).id;
const server = spawn(process.execPath, [fileURLToPath(new URL('../apps/web/node_modules/next/dist/bin/next', import.meta.url)), 'start', '--hostname', '127.0.0.1', '--port', '3101'], { cwd: fileURLToPath(new URL('../apps/web', import.meta.url)), env: { ...process.env, APP_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; server.stdout.on('data', data => { output = (output + String(data)).slice(-8000); }); server.stderr.on('data', data => { output = (output + String(data)).slice(-8000); });
interface Session { cookie: string; csrf: string; user: { id: string; username: string; role: string; mustChangePassword: boolean } }
async function api(path: string, session?: Session, method = 'GET', body?: unknown, overrides?: Record<string, string>) {
  return fetch(`${base}${path}`, { method, headers: { origin: base, 'content-type': 'application/json', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...overrides }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function login(username: string, currentPassword = password): Promise<Session> {
  const response = await api('/api/auth/login', undefined, 'POST', { username, password: currentPassword });
  assert.equal(response.status, 200);
  const body = await response.json() as { user: Session['user']; csrfToken: string };
  return { cookie: response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; '), csrf: body.csrfToken, user: body.user };
}
const { chromium } = createRequire(new URL('../packages/core/package.json', import.meta.url))('playwright-core') as typeof import('../packages/core/node_modules/playwright-core');
let browser: Browser | undefined;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`Verification Web exited: ${output}`);
    try { if ((await fetch(`${base}/api/health/live`)).ok) { ready = true; break; } } catch { /* Starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, `Web verification not ready: ${output}`);
  const admin = await login('web_admin'), member = await login('web_member'), other = await login('web_other');
  assert.equal((await api('/api/admin/users')).status, 401);
  assert.equal((await api('/api/admin/users', member)).status, 403);
  const memberPath = `/api/admin/users/${member.user.id}`;
  assert.equal((await api(memberPath, admin, 'PATCH', { isStarred: true }, { origin: 'https://wrong.example' })).status, 403);
  assert.equal((await api(memberPath, admin, 'PATCH', { isStarred: true }, { 'x-csrf-token': 'invalid' })).status, 403);
  assert.equal((await api(memberPath, admin, 'PATCH', { role: 'admin' })).status, 400);
  assert.equal((await api(`/api/admin/users/${admin.user.id}`, admin, 'DELETE')).status, 409);
  const list = await api('/api/admin/users?status=all&limit=1', admin);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const serialized = JSON.stringify(await list.json());
  assert.equal(/passwordHash|password_hash|temporaryPassword/.test(serialized), false);
  assert.equal((await api('/api/me/star', member, 'PUT', { isStarred: false })).status, 200);
  assert.equal((await api('/api/me/star', member, 'PUT', { isStarred: true })).status, 200);
  assert.equal((await api(`/api/teams/${team}/star`, other, 'PUT', { isStarred: true, version: 1 })).status, 200);
  assert.equal((await api(`/api/admin/teams/${team}/star`, admin, 'PUT', { isStarred: false, version: 1 })).status, 409);
  assert.equal((await api(`/api/admin/teams/${team}/star`, admin, 'PUT', { isStarred: false, version: 2 })).status, 200);

  const resetResponse = await api(`${memberPath}/reset-password`, admin, 'POST'); assert.equal(resetResponse.status, 200);
  const temporaryPassword = (await resetResponse.json() as { temporaryPassword: string }).temporaryPassword;
  assert.equal((await api('/api/me', member)).status, 401);
  const temporary = await login('web_member', temporaryPassword); assert.equal(temporary.user.mustChangePassword, true);
  for (const path of ['/api/me', '/api/members', '/api/teams', '/api/admin/users']) assert.equal((await api(path, temporary)).status, 403);
  assert.equal((await api('/api/auth/session', temporary)).status, 200);
  const overview = await (await api('/api/leaderboard', temporary)).json() as Record<string, unknown>;
  assert.equal('coverage' in overview, false);
  assert.equal((await api('/api/me/password', temporary, 'PUT', { currentPassword: temporaryPassword, newPassword: 'http_new_password_123' }, { 'x-csrf-token': 'invalid' })).status, 403);
  const changed = await api('/api/me/password', temporary, 'PUT', { currentPassword: temporaryPassword, newPassword: 'http_new_password_123' }); assert.equal(changed.status, 200);
  assert.equal((await api('/api/auth/session', temporary)).status, 401);
  assert.equal((await api(`${memberPath}/reset-password`, admin, 'POST')).status, 200);
  assert.equal((await api(`${memberPath}/restore`, member, 'POST')).status, 401);
  const otherPath = `/api/admin/users/${other.user.id}`;
  assert.equal((await api(otherPath, admin, 'DELETE')).status, 200);
  assert.equal((await (await api('/api/members?q=web_other', admin)).json() as { total: number }).total, 0);
  const detail = await (await api(`/api/teams/${team}`, admin)).json() as { team: { members: { id: string; username: string; displayName: string }[] } };
  const deleted = detail.team.members.find(u => u.id === other.user.id)!;
  assert.equal(deleted.displayName, '已删除成员'); assert.equal(deleted.username, '');
  assert.equal((await api(`${otherPath}/restore`, admin, 'POST')).status, 200);
  assert.equal((await api(otherPath, admin, 'PATCH', { active: false })).status, 200);
  assert.equal((await api('/api/me', other)).status, 401);
  assert.equal((await api(otherPath, admin, 'PATCH', { active: true })).status, 200);

  browser = await chromium.launch({ channel: process.env.VERIFY_BROWSER_CHANNEL === 'chromium' ? undefined : 'msedge', executablePath: process.env.VERIFY_BROWSER_EXECUTABLE, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/login`);
  await page.getByLabel('用户名').fill('web_admin'); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL(`${base}/`);
  const folder = fileURLToPath(new URL('../.local/user-management-qa/', import.meta.url)); await mkdir(folder, { recursive: true });
  await page.goto(`${base}/`); await page.locator('.starred-row').first().waitFor();
  const style = await page.locator('.starred-row td.name-column').first().evaluate(element => { const style = element.ownerDocument.defaultView!.getComputedStyle(element); return { color: style.color, size: parseFloat(style.fontSize) }; });
  const regularSize = await page.locator('tr:not(.starred-row) td.name-column').first().evaluate(element => parseFloat(element.ownerDocument.defaultView!.getComputedStyle(element).fontSize));
  assert.ok(style.size < regularSize); assert.equal(style.color, 'rgb(104, 113, 128)');
  await page.screenshot({ path: `${folder}leaderboard-desktop.png`, fullPage: true });
  await page.goto(`${base}/admin/users?q=web_other`);
  await page.getByLabel('web_other 的真实姓名').fill('网页姓名'); await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '操作已保存' }).waitFor();
  await page.getByRole('button', { name: '封禁', exact: true }).click(); await page.getByRole('button', { name: '确认封禁' }).click();
  await page.waitForFunction('!document.querySelector("dialog[open]")');
  await page.goto(`${base}/admin/users?q=web_other&status=banned`); await page.getByRole('button', { name: '解除封禁' }).click();
  await page.getByRole('status').filter({ hasText: '操作已保存' }).waitFor();
  await page.goto(`${base}/admin/users?q=web_other&status=active`); await page.getByRole('button', { name: '伪删除' }).click(); await page.getByRole('button', { name: '确认伪删除' }).click();
  await page.waitForFunction('!document.querySelector("dialog[open]")');
  await page.goto(`${base}/admin/users?q=web_other&status=deleted`); await page.getByRole('button', { name: '恢复账号' }).click();
  await page.getByRole('status').filter({ hasText: '操作已保存' }).waitFor();
  await page.goto(`${base}/admin/users?q=web_member&status=active`); await page.getByRole('button', { name: '重置密码' }).click(); await page.getByRole('button', { name: '确认重置密码' }).click();
  await page.getByLabel('临时密码', { exact: true }).waitFor();
  const browserPassword = await page.getByLabel('临时密码', { exact: true }).inputValue(); assert.equal(browserPassword.length, 24);
  await page.getByRole('button', { name: '已保存，关闭' }).click(); assert.equal(await page.getByLabel('临时密码', { exact: true }).count(), 0);
  await page.screenshot({ path: `${folder}users-desktop.png`, fullPage: true });
  await page.goto(`${base}/admin/teams?q=网页验证队伍`); await page.getByRole('button', { name: '设置打星', exact: true }).click(); await page.getByRole('button', { name: '取消打星', exact: true }).waitFor();
  await page.goto(`${base}/team-leaderboard`); await page.getByText('不参与排名', { exact: true }).first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [route, file] of [['/', 'leaderboard-mobile'], ['/admin/users?status=all', 'users-mobile'], ['/admin/teams', 'teams-mobile']] as const) {
    await page.goto(`${base}${route}`); assert.ok(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'));
    await page.screenshot({ path: `${folder}${file}.png`, fullPage: true });
  }
  const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 } }), memberPage = await memberContext.newPage();
  memberPage.on('pageerror', error => errors.push(error.message));
  await memberPage.goto(`${base}/login`); await memberPage.getByLabel('用户名').fill('web_member'); await memberPage.getByLabel('密码', { exact: true }).fill(browserPassword); await memberPage.getByRole('button', { name: '登录', exact: true }).click(); await memberPage.waitForURL(`${base}/change-password`);
  await memberPage.goto(`${base}/profile`); await memberPage.waitForURL(`${base}/change-password`);
  await memberPage.getByLabel('临时密码', { exact: true }).fill(browserPassword); await memberPage.getByLabel('新密码', { exact: true }).fill('browser_new_password_123'); await memberPage.getByLabel('确认新密码').fill('browser_new_password_123'); await memberPage.getByRole('button', { name: '保存新密码' }).click(); await memberPage.waitForURL(`${base}/`);
  await memberPage.goto(`${base}/profile`); await memberPage.getByRole('button', { name: '取消打星', exact: true }).click(); await memberPage.getByRole('button', { name: '设置打星', exact: true }).waitFor();
  await page.goto(`${base}/admin/users?q=web_admin&status=active`); await page.getByRole('button', { name: '重置密码' }).click(); await page.getByRole('button', { name: '确认重置密码' }).click();
  await page.getByLabel('临时密码', { exact: true }).waitFor();
  const selfPassword = await page.getByLabel('临时密码', { exact: true }).inputValue(); assert.equal(selfPassword.length, 24);
  assert.equal(new URL(page.url()).pathname, '/admin/users');
  await page.getByRole('button', { name: '已保存，关闭' }).click(); await page.waitForURL(`${base}/login`);
  await page.getByLabel('用户名').fill('web_admin'); await page.getByLabel('密码', { exact: true }).fill(selfPassword); await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL(`${base}/change-password`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ event: 'user_management_http_browser_verified', checks: ['API authentication, Origin/CSRF and strict inputs', 'forced-password exceptions and session rotation', 'browser rename/ban/delete/restore/reset and team star', 'mobile overflow and starred styles', 'browser forced-password redirect, personal star and administrator self-reset'], screenshots: folder }));
  await memberContext.close(); await context.close();
} finally {
  await browser?.close();
  server.kill();
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', () => resolve()); setTimeout(resolve, 5000).unref(); } });
}
