import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = process.env.APP_URL ?? 'http://localhost:3000';
const password = (await readFile('.secrets/member-test-password', 'utf8')).trim();
const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'test_member', password }) });
assert.equal(login.status, 200);
const session = await login.json() as { user: { id: string }; csrfToken: string };
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const headers = { cookie, origin: base, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' };
async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(!/password_hash|token_hash|ciphertext|nonce|cookie_revision/.test(JSON.stringify(body)), 'Private database fields leaked');
  return body as T;
}
try {
  const me = await get<{ displayName: string }>('/api/me');
  const bindings = await get<{ items: { platform: string; version: number; active: { accountId: string; handle: string; externalId: string | null } | null }[] }>('/api/me/platform-accounts');
  assert.equal(bindings.items.length, 3);
  assert.ok(bindings.items.every(binding => binding.active));
  assert.equal(me.displayName, bindings.items.find(binding => binding.platform === 'codeforces')!.active!.handle);
  for (const binding of bindings.items) {
    const response = await fetch(`${base}/api/me/platform-accounts/${binding.platform}`, { method: 'PUT', headers, body: JSON.stringify({ target: binding.platform === 'luogu' ? binding.active!.externalId : binding.active!.handle }) });
    assert.equal(response.status, 202);
    const unchanged = await response.json() as { unchanged: boolean; version: number };
    assert.equal(unchanged.unchanged, true); assert.equal(unchanged.version, binding.version);
  }
  type Solve = { platform: string; points: number; firstAcAt: string };
  type Records<T> = { total: number; items: T[] };
  const profile = await get<{ points: number; solveCount: number; submissionCount: number; provisional: boolean }>(`/api/members/${session.user.id}`);
  const solves = await get<Records<Solve>>(`/api/members/${session.user.id}/solves?limit=100`);
  assert.equal(solves.total, profile.solveCount);
  if (solves.total <= 100) assert.equal(solves.items.reduce((sum, item) => sum + item.points, 0), profile.points);
  for (const solve of solves.items) if (solve.platform === 'qoj') assert.equal(solve.points, 3);
  const raw = await get<Records<{ id: string }>>(`/api/members/${session.user.id}/submissions?limit=100`);
  assert.equal(raw.total, profile.submissionCount); assert.equal(new Set(raw.items.map(item => item.id)).size, raw.items.length);
  const outside = await get<Records<Solve>>(`/api/members/${session.user.id}/solves?page=100000&limit=100`);
  assert.equal(outside.items.length, 0); assert.equal(outside.total, solves.total);
  assert.equal((await fetch(`${base}/api/admin/collection-control`, { headers })).status, 403);
  console.log(JSON.stringify({ event: 'live_member_api_passed', displayName: me.displayName, activePlatforms: bindings.items.map(binding => binding.platform), points: profile.points, solveCount: profile.solveCount, submissionCount: profile.submissionCount, provisional: profile.provisional, checks: ['confirmed binding is unchanged', 'member role restriction', 'DTO secret isolation', 'statistics match solve and submission totals', 'QOJ default points', 'empty pagination preserves total'] }));
} finally { await fetch(`${base}/api/auth/logout`, { method: 'POST', headers }); }
