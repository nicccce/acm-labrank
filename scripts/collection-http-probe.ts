import assert from 'node:assert/strict';
import type { Route } from '../packages/core/node_modules/playwright-core';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

if (!process.env.DATABASE_URL || !/^\/acm_personal_verify_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Isolated verification database required');
const base = 'http://127.0.0.1:3001', password = 'fixture-only-password-which-is-never-persisted';
const server = spawn(process.execPath, [fileURLToPath(new URL('../apps/web/node_modules/next/dist/bin/next', import.meta.url)), 'start', '--hostname', '127.0.0.1', '--port', '3001'], { cwd: fileURLToPath(new URL('../apps/web', import.meta.url)), env: { ...process.env, APP_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', data => { serverOutput = (serverOutput + String(data)).slice(-8000); });
server.stderr.on('data', data => { serverOutput = (serverOutput + String(data)).slice(-8000); });
type Session = { cookie: string; csrf: string };
async function login(username: string): Promise<Session> {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(response.status, 200, 'Fixture login failed');
  return { cookie: response.headers.getSetCookie().map(c => c.split(';')[0]).join('; '), csrf: (await response.json() as { csrfToken: string }).csrfToken };
}
async function api(path: string, session?: Session, method = 'GET', body?: unknown, override?: Record<string, string>) {
  return fetch(`${base}${path}`, { method, headers: { origin: base, 'content-type': 'application/json', ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...override }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const { chromium } = createRequire(new URL('../packages/core/package.json', import.meta.url))('playwright-core');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`Verification web exited: ${serverOutput}`);
    try { const response = await fetch(`${base}/api/health/live`); if (response.ok) { ready = true; break; } } catch { /* Startup in progress. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, `Verification web did not start: ${serverOutput}`);
  const admin = await login('probe_admin'), member = await login('collection_member');
  for (const path of ['/api/admin/collection-settings', '/api/admin/sync-jobs']) {
    assert.equal((await api(path)).status, 401); assert.equal((await api(path, member)).status, 403);
    assert.equal((await api(path, admin)).headers.get('cache-control'), 'no-store');
  }
  const settings = await (await api('/api/admin/collection-settings', admin)).json() as { version: number };
  const body = { platforms: ['codeforces'], autoSyncEnabled: false, syncIntervalMinutes: 360, scoreRange: { kind: 'fixed', from: '2026-10-02', to: '2026-10-02' }, version: settings.version };
  assert.equal((await api('/api/admin/collection-settings', member, 'PUT', body)).status, 403);
  assert.equal((await api('/api/admin/collection-settings', admin, 'PUT', body, { origin: 'http://wrong-origin.example' })).status, 403);
  assert.equal((await api('/api/admin/collection-settings', admin, 'PUT', body, { 'x-csrf-token': 'invalid' })).status, 403);
  assert.equal((await api('/api/admin/collection-settings', admin, 'PUT', { ...body, platforms: ['qoj', 'qoj'] })).status, 400);
  assert.equal((await api('/api/admin/collection-settings', admin, 'PUT', { ...body, scoreRange: { kind: 'fixed', from: '2026-02-30', to: '2026-03-01' } })).status, 400);
  const saved = await api('/api/admin/collection-settings', admin, 'PUT', body); assert.equal(saved.status, 200);
  const savedData = await saved.json() as { settings: { version: number }; items: { skipped: string }[] }; assert.ok(savedData.items.every(item => item.skipped === 'COLLECTION_PAUSED'));
  assert.equal((await api('/api/admin/collection-settings', admin, 'PUT', body)).status, 409);
  assert.equal((await api('/api/admin/sync', admin, 'POST', {})).status, 409);
  assert.equal((await api('/api/admin/sync-jobs?cursor=invalid', admin)).status, 400);
  assert.equal((await api('/api/admin/sync-jobs?limit=0', admin)).status, 400);
  const jobs = await (await api('/api/admin/sync-jobs?limit=1', admin)).json() as { items: { id: string }[]; nextCursor: string }; assert.equal(jobs.items.length, 1); assert.ok(jobs.nextCursor);
  const next = await (await api(`/api/admin/sync-jobs?limit=1&cursor=${encodeURIComponent(jobs.nextCursor)}`, admin)).json() as { items: { id: string }[] }; assert.notEqual(next.items[0]!.id, jobs.items[0]!.id);
  const detail = await api(`/api/admin/sync-jobs/${jobs.items[0]!.id}`, admin); assert.equal(detail.status, 200); assert.ok('queueState' in (await detail.json() as Record<string, unknown>));
  for (const session of [undefined, member]) assert.equal((await api('/api/admin/collection-reset', session, 'POST', { platforms: ['codeforces'], version: savedData.settings.version, requestId: '00000000-0000-4000-8000-000000000000' })).status, session ? 403 : 401);
  assert.equal((await api('/api/admin/collection-reset', admin, 'POST', { platforms: [], version: savedData.settings.version, requestId: 'invalid' })).status, 400);
  console.log(JSON.stringify({ event: 'collection_http_probe_passed', checks: ['admin/member/anonymous authorization', 'Origin and CSRF', 'invalid ranges/platforms', 'setting CAS', 'paused sync', 'task pagination and queue detail', 'reset authorization', 'no-store'] }));

  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(`${base}/admin/collection`);
  await page.getByLabel('用户名').fill('probe_admin'); await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL(`${base}/`);
  await page.getByLabel('账户菜单', { exact: true }).click();
  await page.getByRole('link', { name: '采集管理', exact: true }).click();
  await page.getByRole('heading', { name: '采集管理', exact: true }).waitFor();
  await page.getByText('同步与计分设置', { exact: true }).click();
  await page.locator('article').filter({ has: page.getByRole('heading', { name: 'Codeforces', exact: true }) }).getByText('请求间隔', { exact: true }).click();
  assert.equal(await page.getByLabel('Codeforces', { exact: true }).isChecked(), true);
  assert.equal(await page.getByLabel('QOJ', { exact: true }).isChecked(), false);
  let releaseOld: (() => void) | undefined, held = false, delayed = false;
  const oldResponse = new Promise<void>(resolve => { releaseOld = resolve; });
  await page.route('**/api/admin/collection-settings', async (route: Route) => {
    if (route.request().method() === 'GET' && !delayed) { delayed = true; const old = await route.fetch(); held = true; await oldResponse; await route.fulfill({ response: old }).catch(() => undefined); }
    else await route.continue();
  });
  await page.locator('#score-range').selectOption('7');
  await page.getByLabel('Codeforces最小请求间隔').fill('2300');
  await page.waitForTimeout(6200);
  assert.ok(held, 'A delayed poll must overlap the following save');
  assert.equal(await page.locator('#score-range').inputValue(), '7');
  assert.equal(await page.getByLabel('Codeforces最小请求间隔').inputValue(), '2300');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('status').getByText(/设置已保存/).waitFor();
  releaseOld!(); await page.waitForTimeout(500);
  assert.deepEqual(await page.locator('main [role=alert]').allTextContents(), [], 'Cancelled stale polls must not show an error');
  await page.unroute('**/api/admin/collection-settings');
  await page.locator('#score-range').selectOption('fixed');
  await page.getByLabel('开始日期', { exact: true }).fill('2026-10-02'); await page.getByLabel('结束日期', { exact: true }).fill('2026-10-02');
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.getByRole('status').getByText(/设置已保存/).waitFor();
  const cf = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Codeforces', exact: true }) });
  await page.getByLabel('Codeforces最小请求间隔').fill('2200'); await page.getByLabel('Codeforces最大请求间隔').fill('3200');
  await cf.getByRole('button', { name: '保存请求间隔', exact: true }).click(); await page.getByRole('status').getByText('Codeforces请求间隔已保存。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '启用采集', exact: true }).click(); await page.getByRole('button', { name: '暂停采集', exact: true }).waitFor();
  await page.getByRole('button', { name: '立即同步', exact: true }).click(); await page.getByRole('status').getByText(/合并 .* 个已有任务/).waitFor();
  await page.getByText('补采历史', { exact: true }).click();
  await page.getByLabel('补采开始日期', { exact: true }).fill('2026-09-01'); await page.getByLabel('补采结束日期', { exact: true }).fill('2026-09-02');
  const supplementalRequest = page.waitForRequest((r: { url(): string; method(): string }) => r.url().endsWith('/api/admin/sync') && r.method() === 'POST');
  await page.getByRole('button', { name: '补采所选历史区间', exact: true }).click();
  assert.deepEqual((await supplementalRequest).postDataJSON(), { mode: 'backfill', from: '2026-09-01', to: '2026-09-02' });
  await page.getByRole('status').getByText(/已有其他日期范围的同步任务/).waitFor();
  await mkdir('/tmp/collection-probe', { recursive: true }); await page.screenshot({ path: '/tmp/collection-probe/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'Mobile page must not overflow horizontally');
  await page.screenshot({ path: '/tmp/collection-probe/mobile.png', fullPage: true });
  await page.getByText('清空与重爬', { exact: true }).click();
  await page.getByRole('button', { name: '选择重爬平台…', exact: true }).click();
  await page.getByRole('dialog').waitFor(); await page.screenshot({ path: '/tmp/collection-probe/reset-confirmation.png', fullPage: false });
  const request = page.waitForRequest((r: { url(): string; method(): string }) => r.url().endsWith('/api/admin/collection-reset') && r.method() === 'POST');
  const response = page.waitForResponse((r: { url(): string }) => r.url().endsWith('/api/admin/collection-reset'));
  await page.getByRole('button', { name: '确认清空并重爬', exact: true }).click();
  const input = (await request).postDataJSON(); const rebuilt = await response; assert.equal(rebuilt.status(), 202);
  await page.getByRole('status').getByText(/已清空并开始重爬/).waitFor();
  const replay = await api('/api/admin/collection-reset', admin, 'POST', input); assert.equal(replay.status, 202); assert.deepEqual(await replay.json(), await rebuilt.json());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ event: 'collection_ui_probe_passed', checks: ['cancelled old poll cannot overwrite saved state', 'history form sends explicit dates and displays concurrency conflict', 'polling preserves unsaved date/rate forms', 'login and navigation', 'rolling/fixed settings', 'rate-limit save', 'manual sync', 'desktop and mobile layout', 'reset confirmation and idempotent replay', 'no browser exceptions'], screenshots: '/tmp/collection-probe' }));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', () => resolve()); setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 5000).unref(); } });
}
