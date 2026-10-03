import { describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/records.json';
import { fetchSubmissionPage, resolveAccount } from './index';
import { mapDifficulty, mapStatus, normalizeRecords, parseContext, readResponse } from './parser';
import { luoguLogin } from './login';
import type { RequestContext, ConnectorCheckpoint } from '../contracts/index';

const account = { platform: 'luogu', kind: 'person', handle: 'target_fixture', externalId: '900002' } as const;
function html(value: unknown) { return `<!doctype html><script id="lentille-context" type="application/json">${JSON.stringify(value)}</script>`; }
function ctx(request: RequestContext['request']): RequestContext { return { request, signal: AbortSignal.timeout(10000), session: { attempt: 'fixture' } }; }
function page(number: number, count = 5) {
  const copy = structuredClone(fixture);
  copy.data.records.count = count;
  copy.data.records.result = number === 1 ? copy.data.records.result : number === 2
    ? copy.data.records.result.map((r, i) => ({ ...r, id: 103 - i })) : [{ ...copy.data.records.result[0]!, id: 101 }];
  return html(copy);
}
function pagesContext(count = 5) { return ctx(vi.fn(async (url) => new Response(page(Number(url.searchParams.get('page')), count)))); }

describe('Luogu account lookup', () => {
  it('uses exact card lookup, then checks the UID profile; never hardcodes identities', async () => {
    const request = vi.fn(async (url: URL) => new Response(url.pathname === '/user/cardinfo'
      ? JSON.stringify({ user: { uid: 900002, name: 'target_fixture' } })
      : html({ template: 'user.show', status: 200, data: { user: { uid: 900002, name: 'target_fixture' } }, user: null })));
    expect(await resolveAccount('target_fixture', ctx(request))).toEqual(account);
    expect(request.mock.calls[0]![0].toString()).toBe('https://www.luogu.com.cn/user/cardinfo?user=target_fixture');
    expect(request.mock.calls[1]![0].pathname).toBe('/user/900002');
    expect(await resolveAccount('0900002', ctx(request))).toEqual(account);
  });
  it('separates missing, ambiguous, changed profile and temporarily unavailable accounts', async () => {
    await expect(resolveAccount('missing', ctx(async () => new Response('{"user":null}')))).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    await expect(resolveAccount('prefix', ctx(async () => new Response('{"user":{"uid":900002,"name":"prefix_suffix"}}')))).rejects.toMatchObject({ code: 'ACCOUNT_AMBIGUOUS' });
    await expect(resolveAccount('target_fixture', ctx(async url => new Response(url.pathname === '/user/cardinfo' ? '{"user":{"uid":900002,"name":"target_fixture"}}' : html({ template: 'user.show', status: 200, data: { user: { uid: 900003, name: 'target_fixture' } } }))))).rejects.toMatchObject({ code: 'ACCOUNT_AMBIGUOUS' });
    await expect(resolveAccount('target_fixture', ctx(async () => new Response('Unavailable', { status: 503 })))).rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' });
  });
});

describe('Luogu raw submissions', () => {
  it('cuts a first scan at the requested start and verifies the head without reading older pages', async () => {
    const context = pagesContext();
    const result = await fetchSubmissionPage(account, { mode: 'backfill', cursor: null, checkpoint: null, range: { from: '2026-05-21T08:20:45.000Z', to: '2026-05-22T00:00:00.000Z' } }, context);
    expect(result).toMatchObject({ stopReason: 'range_start', nextCursor: null, nextCheckpoint: { data: { head: '105' } } });
    expect(result.submissions.map(row => row.externalSubmissionId)).toEqual(['105']);
    expect(result.problems.map(row => row.problemKey)).toEqual(['P1097']);
    expect(context.request).toHaveBeenCalledTimes(1);
  });

  it('preserves native status/score, author and source; maps seconds to UTC without offset guesses', () => {
    const result = normalizeRecords(fixture.data.records, '900002', '2026-10-01T10:00:00.000Z');
    expect(result.submissions[0]).toMatchObject({ externalSubmissionId: '105', verdict: 'accepted', nativeScore: 100, nativeStatus: 12,
      submittedAt: '2026-05-21T08:20:45.000Z', sourceUrl: 'https://www.luogu.com.cn/record/105', subjectEvidence: { authorAccountKeys: ['900002'], authorHandle: 'target_fixture' } });
    expect(result.submissions[1]).not.toHaveProperty('nativeScore');
    expect(result.submissions[1]?.verdict).toBe('rejected');
    const row = { ...fixture.data.records.result[0]!, status: 6, score: 100, contest: { id: 60001, name: 'visible contest', mode: 'ICPC' } };
    expect(normalizeRecords({ count: 1, perPage: 20, result: [row] }, '900002', '2026-10-01T10:00:00.000Z').submissions[0]).toMatchObject({ verdict: 'rejected', subjectEvidence: { contestId: '60001' } });
  });
  it('maps only verified statuses/difficulties; protects author identity and safe ID precision', () => {
    expect([12, 14, 0, 1, -1, 11, 21, 999].map(mapStatus)).toEqual(['accepted', 'rejected', 'pending', 'pending', 'unknown', 'unknown', 'unknown', 'unknown']);
    expect([0, 1, 8, 9, null, undefined].map(mapDifficulty)).toEqual([null, 1, 8, null, null, null]);
    expect(() => normalizeRecords(fixture.data.records, 'different', '2026-10-01T10:00:00Z')).toThrow(expect.objectContaining({ code: 'PARSE_CHANGED' }));
    expect(() => normalizeRecords({ count: 1, perPage: 20, result: [{ ...fixture.data.records.result[0], user: null }] }, '900002', '2026-10-01T10:00:00Z')).toThrow(expect.objectContaining({ code: 'PRIVACY_RESTRICTED' }));
    expect(() => normalizeRecords({ count: 1, perPage: 20, result: [{ ...fixture.data.records.result[0], id: Number.MAX_SAFE_INTEGER + 1 }] }, '900002', '2026-10-01T10:00:00Z')).toThrow();
  });
  it('reads real perPage/count, overlaps resumed pages and advances checkpoint only at a stable end', async () => {
    const context = pagesContext();
    const first = await fetchSubmissionPage(account, { mode: 'backfill', cursor: null, checkpoint: null }, context);
    expect(first.stopReason).toBe('more'); expect(first.nextCheckpoint).toBeNull();
    const second = await fetchSubmissionPage(account, { mode: 'backfill', cursor: first.nextCursor, checkpoint: null }, context);
    expect(second.submissions.map(s => s.externalSubmissionId)).toEqual(['105', '104', '103', '102']);
    const third = await fetchSubmissionPage(account, { mode: 'backfill', cursor: second.nextCursor, checkpoint: null }, context);
    expect(third.stopReason).toBe('history_end'); expect(third.nextCursor).toBeNull();
    expect(third.nextCheckpoint).toMatchObject({ version: 1, data: { uid: '900002', head: '105' } });
    expect((context.request as ReturnType<typeof vi.fn>).mock.calls.map(call => Number(call[0].searchParams.get('page')))).toEqual([1, 1, 2, 2, 3, 1]);
  });
  it('requires two whole pages past an incremental anchor and does not equate an old row with completion', async () => {
    const context = ctx(async url => {
      const n = Number(url.searchParams.get('page')); const copy = structuredClone(fixture);
      copy.data.records.count = 10; copy.data.records.result = copy.data.records.result.map((r, i) => ({ ...r, id: 105 - 2 * (n - 1) - i }));
      return new Response(html(copy));
    });
    const checkpoint: ConnectorCheckpoint = { version: 1, data: { parser: 'luogu-lentille/1', uid: '900002', head: '104' } };
    const first = await fetchSubmissionPage(account, { mode: 'incremental', cursor: null, checkpoint }, context);
    const second = await fetchSubmissionPage(account, { mode: 'incremental', cursor: first.nextCursor, checkpoint }, context);
    expect(second.stopReason).toBe('more');
    const third = await fetchSubmissionPage(account, { mode: 'incremental', cursor: second.nextCursor, checkpoint }, context);
    expect(third.stopReason).toBe('checkpoint_reached');
  });
  it('rejects pagination drift and malformed nonterminal empty pages', async () => {
    const first = await fetchSubmissionPage(account, { mode: 'backfill', cursor: null, checkpoint: null }, pagesContext());
    await expect(fetchSubmissionPage(account, { mode: 'backfill', cursor: first.nextCursor, checkpoint: null }, pagesContext(6))).rejects.toMatchObject({ code: 'PAGINATION_DRIFT' });
    const empty = structuredClone(fixture); empty.data.records.result = [];
    await expect(fetchSubmissionPage(account, { mode: 'backfill', cursor: null, checkpoint: null }, ctx(async () => new Response(html(empty))))).rejects.toMatchObject({ code: 'PARSE_CHANGED' });
    await expect(fetchSubmissionPage(account, { mode: 'backfill', cursor: { version: 999, data: {} }, checkpoint: null }, pagesContext())).rejects.toMatchObject({ code: 'PARSE_CHANGED' });
  });
  it('allows an explicitly normal visible empty history', async () => {
    const empty = structuredClone(fixture); empty.data.records.count = 0; empty.data.records.result = [];
    const result = await fetchSubmissionPage(account, { mode: 'backfill', cursor: null, checkpoint: null }, ctx(async () => new Response(html(empty))));
    expect(result.stopReason).toBe('history_end'); expect(result.submissions).toEqual([]);
  });
});

describe('Luogu error pages and login challenges', () => {
  const password = 'fixture-private-password', captcha = 'fixture-private-captcha';
  async function submitResponse(response: Response, user: { uid: number; name: string } | null = { uid: 900001, name: 'collector_fixture' }) {
    const request = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/do-auth/password') {
        expect(new Headers(init?.headers).get('accept')).toBe('application/json');
        expect(new Headers(init?.headers).get('x-csrf-token')).toBe('fixture-csrf');
        expect(JSON.parse(String(init?.body))).toEqual({ username: 'collector_fixture', password, captcha });
        return response;
      }
      expect(url.pathname).toBe('/');
      return new Response(html({ template: 'home', status: 200, data: {}, user }));
    });
    const context = ctx(request);
    const credentials = { version: 1, password, captcha };
    const result = luoguLogin.advanceLogin({ attemptId: 'fixture', version: 1, username: 'collector_fixture', csrf: 'fixture-csrf', expiresAt: Date.now() + 60000, consumed: false, sessionBinding: context.session }, credentials, context);
    try { return await result; }
    finally { expect(credentials.password).toBe(''); expect(credentials.captcha).toBe(''); }
  }
  it.each([
    [400, { errorType: 'CaptchaNotValidException', errorMessage: `Invalid captcha ${captcha}` }, 'LOGIN_FAILED', '图形验证码'],
    [400, { errorType: 'BadCredentialsException', errorMessage: `Wrong password ${password}` }, 'LOGIN_FAILED', '账号或密码'],
    [400, { errorType: 'InvalidCsrfTokenException' }, 'STALE_CHALLENGE', '校验令牌'],
    [400, { errorType: 'TwoFactorRequiredException' }, 'UNSUPPORTED_FLOW', '两步验证'],
    [400, { errorType: 'RequestFormError', errorData: { fields: [{ message: `验证码错误 ${captcha}` }] } }, 'LOGIN_FAILED', '图形验证码'],
    [403, { errorMessage: `unknown rejection ${password}` }, 'FORBIDDEN', 'HTTP 403'],
    [429, {}, 'RATE_LIMITED', '登录频率'],
    [503, {}, 'TEMP_UNAVAILABLE', '暂不可用'],
    [400, { errorMessage: `unknown rejection ${password}` }, 'LOGIN_FAILED', '未识别'],
  ])('classifies HTTP %s login failures without exposing platform echoes', async (status, body, code, explanation) => {
    const result = submitResponse(new Response(JSON.stringify(body), { status: Number(status), headers: { 'content-type': 'application/json' } }));
    await expect(result).rejects.toMatchObject({ code, httpStatus: status, message: expect.stringContaining(String(explanation)) });
    await expect(result).rejects.not.toHaveProperty('message', expect.stringContaining(password));
    await expect(result).rejects.not.toHaveProperty('message', expect.stringContaining(captcha));
  });
  it('uses authenticated identity for successful JSON responses with or without redirectTo', async () => {
    for (const body of [{ redirectTo: '/' }, { success: true }]) {
      expect(await submitResponse(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }))).toEqual({ uid: '900001', name: 'collector_fixture' });
    }
  });
  it('refuses a nominally successful response without an authenticated identity', async () => {
    await expect(submitResponse(new Response('{"success":true}'), null)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('distinguishes HTML security challenges and malformed success responses from bad credentials', async () => {
    await expect(submitResponse(new Response('<title>Just a moment...</title><div id="cf-chl"></div>', { status: 403 }))).rejects.toMatchObject({ code: 'RISK_CONTROL' });
    await expect(submitResponse(new Response('<title>Changed response</title>'))).rejects.toMatchObject({ code: 'PARSE_CHANGED' });
    await expect(submitResponse(new Response('[]'))).rejects.toMatchObject({ code: 'PARSE_CHANGED' });
  });
  it.each([
    [html({ template: 'login', status: 200, data: {}, user: null }), 'AUTH_REQUIRED'],
    [html({ template: 'error', status: 403, data: { errorType: 'PrivacyException', errorMessage: '隐私保护' } }), 'PRIVACY_RESTRICTED'],
    [html({ template: 'error', status: 403, data: { errorType: 'PermissionDenied' } }), 'FORBIDDEN'],
    ['<title>Just a moment...</title><div id="cf-chl"></div>', 'RISK_CONTROL'],
    ['<title>Records</title><script id="changed">{}</script>', 'PARSE_CHANGED'],
  ])('classifies abnormal pages separately from empty history', (body, code) => {
    expect(() => parseContext(body, 'record.list')).toThrow(expect.objectContaining({ code }));
  });
  it('recognizes expired-session JSON and login redirects', async () => {
    await expect(readResponse(new Response('{"errorType":"UserUnloginException"}'))).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(readResponse(new Response(null, { status: 302, headers: { Location: '/auth/login' } }))).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const methods = new Response('{"default":"password","available":["password"]}');
    Object.defineProperty(methods, 'url', { value: 'https://www.luogu.com.cn/auth/login-methods?login=fixture' });
    await expect(readResponse(methods)).resolves.toMatchObject({ default: 'password' });
  });
  it('refresh invalidates the old challenge and refuses stale or differently bound submissions before POST', async () => {
    const request = vi.fn(async (url: URL) => {
      if (url.pathname === '/auth/login') return new Response('<meta name="csrf-token" content="fixture-only">' + html({ template: 'login', status: 200, data: {}, user: null }));
      if (url.pathname === '/_lfe/config/auth') return new Response(JSON.stringify({ route: { 'auth.login_methods': '/auth/login-methods', 'do_auth.password': '/do-auth/password', captcha: '/lg4/captcha' } }));
      if (url.pathname === '/auth/login-methods') return new Response('{"default":"password","available":["password"]}');
      return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/png' } });
    });
    const context = ctx(request);
    const first = await luoguLogin.beginLogin('collector_fixture', context);
    const second = await luoguLogin.refreshChallenge(first.state, 1, context);
    expect(second.state.version).toBe(2);
    await expect(luoguLogin.advanceLogin(first.state, { version: 1, password: 'test-only', captcha: 'test-only', expectedHandle: 'collector_fixture' }, context)).rejects.toMatchObject({ code: 'STALE_CHALLENGE' });
    await expect(luoguLogin.advanceLogin(second.state, { version: 2, password: 'test-only', captcha: 'test-only', expectedHandle: 'collector_fixture' }, ctx(request))).rejects.toMatchObject({ code: 'STALE_CHALLENGE' });
    expect(request.mock.calls.every(call => call[0].pathname !== '/do-auth/password')).toBe(true);
  });
});
