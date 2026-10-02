import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AccountRef, RequestContext } from '../contracts/index';
import { qojConnector } from './index';
import { qojLogin } from './login';
import { parseAccount, parseSubmissionHtml } from './parser';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const account: AccountRef = { platform: 'qoj', kind: 'person', handle: 'sample_person', externalId: null };
const now = '2026-10-01T10:00:00.000Z';
const context = (html: string): RequestContext => ({ signal: new AbortController().signal, session: null, request: vi.fn(async () => new Response(html, { headers: { 'content-type': 'text/html' } })) });
describe('QOJ observed HTML parser', () => {
  it('keeps all states, string IDs, global problem IDs and UTC', () => {
    const page = parseSubmissionHtml(fixture('normal'), account, 1, now);
    expect(page.submissions).toHaveLength(2);
    expect(page.submissions[0]).toMatchObject({ externalSubmissionId: '9000003', problemKey: '197', verdict: 'rejected', submittedAt: '2026-10-01T10:12:21.000Z', parserVersion: 'qoj-html-1', observedAt: now });
    expect(page.submissions[1]).toMatchObject({ nativeScore: 25, verdict: 'unknown', nativeResult: '25' });
    expect(page.problems[0]?.nativeDifficulty).toBeNull();
    expect(page.terminal).toBe(false);
  });
  it('uses the explicit acceptance marker, never the score alone', () => {
    expect(parseSubmissionHtml(fixture('last'), account, 41, now).submissions[0]?.verdict).toBe('accepted');
    expect(parseSubmissionHtml(fixture('last').replace('100 ✓', '100'), account, 41, now).submissions[0]?.verdict).toBe('unknown');
  });
  it('accepts a structurally explicit empty terminal page', () => expect(parseSubmissionHtml(fixture('empty'), account, 1, now).terminal).toBe(true));
  it.each([['login', 'AUTH_REQUIRED'], ['permission', 'FORBIDDEN'], ['changed', 'PARSE_CHANGED'], ['challenge', 'CHALLENGE_REQUIRED'], ['challenge-200', 'CHALLENGE_REQUIRED']])('rejects %s rather than returning empty', (name, code) => {
    try { parseSubmissionHtml(fixture(name!), account, 1, now); throw new Error('Expected parse failure'); }
    catch (error) { expect(error).toMatchObject({ code }); }
  });
  it('rejects changed authors, timestamps, filters, pagination and clamped pages', () => {
    for (const html of [fixture('normal').replace('data-nickname="sample_person">sample_person', 'data-nickname="other">other'), fixture('normal').replace('T18:12:21+08:00', 'T18:12:21'), fixture('normal').replace('value="sample_person"', 'value="other"'), fixture('normal').replace('page=2', 'page=3')]) expect(() => parseSubmissionHtml(html, account, 1, now)).toThrow();
    expect(() => parseSubmissionHtml(fixture('last'), account, 999999, now)).toThrow();
  });
  it('resolves identity without manufacturing a UID and distinguishes teams', () => {
    const profile = '<h5 class="card-header">User profile</h5><h2><span class="uoj-username">sample_person</span><span class="uoj-favourite-block" data-type="U" data-id="sample_person"></span></h2><h4>Usergroup</h4>';
    expect(parseAccount(profile, 'sample_person')).toEqual(account);
    expect(parseAccount(profile + '<h4>Team Members</h4>', 'sample_person').kind).toBe('team');
    expect(() => parseAccount(profile, 'other')).toThrow();
  });
});
describe('QOJ connector scanning and login', () => {
  it('overlaps pages, preserves continuation and checkpoints only after completion', async () => {
    const ctx = context(fixture('normal'));
    const first = await qojConnector.fetchSubmissionPage(account, { mode: 'backfill', cursor: null, checkpoint: null }, ctx);
    expect(first.nextCursor).toMatchObject({ version: 1, data: { page: 2 } });
    expect(first.nextCheckpoint).toBeNull();
    const last = fixture('last').replace('>41<', '>2<');
    ctx.request = vi.fn(async url => new Response(url.searchParams.get('page') === '2' ? last : fixture('normal'), { headers: { 'content-type': 'text/html' } }));
    const second = await qojConnector.fetchSubmissionPage(account, { mode: 'backfill', cursor: first.nextCursor, checkpoint: null }, ctx);
    expect(second.submissions).toHaveLength(3);
    expect(second.stopReason).toBe('history_end');
    expect(second.nextCheckpoint).toMatchObject({ version: 1, data: { headId: '9000003' } });
    expect(ctx.request).toHaveBeenCalledTimes(2);
  });
  it('follows a real-shaped second-page link without treating a sliding page window as history_end', async () => {
    const first = await qojConnector.fetchSubmissionPage(account, { mode: 'backfill', cursor: null, checkpoint: null }, context(fixture('normal')));
    const ctx = context('');
    ctx.request = vi.fn(async url => new Response(fixture(url.searchParams.get('page') === '2' ? 'page2' : 'normal'), { headers: { 'content-type': 'text/html' } }));
    const second = await qojConnector.fetchSubmissionPage(account, { mode: 'backfill', cursor: first.nextCursor, checkpoint: null }, ctx);
    expect(second).toMatchObject({ stopReason: 'more', nextCursor: { data: { page: 3 } }, nextCheckpoint: null });
    expect(second.submissions.map(s => s.externalSubmissionId)).toEqual(['9000003', '9000002', '9000001', '9000000']);
  });
  it('does not stop incremental at the first old ID; crosses another full page', async () => {
    const cp = { version: 1, data: { account: account.handle, parser: 'qoj-html-1', headId: '9000003' } };
    const first = await qojConnector.fetchSubmissionPage(account, { mode: 'incremental', cursor: null, checkpoint: cp }, context(fixture('normal')));
    expect(first.stopReason).toBe('more');
    const next = fixture('normal').replace('>1<', '>2<').replace('page=2', 'page=3');
    const ctx = context(next);
    ctx.request = vi.fn(async url => new Response(url.searchParams.get('page') === '2' ? next : fixture('normal'), { headers: { 'content-type': 'text/html' } }));
    expect((await qojConnector.fetchSubmissionPage(account, { mode: 'incremental', cursor: first.nextCursor, checkpoint: cp }, ctx)).stopReason).toBe('checkpoint_reached');
  });
  it('rejects wrong-account/version cursors and unsupported teams', async () => {
    await expect(qojConnector.fetchSubmissionPage(account, { mode: 'backfill', cursor: { version: 9, data: {} }, checkpoint: null }, context(''))).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(qojConnector.fetchSubmissionPage({ ...account, kind: 'team' }, { mode: 'backfill', cursor: null, checkpoint: null }, context(''))).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });
  it('checks login redirects and non-HTML responses', async () => {
    const ctx = context('');
    ctx.request = vi.fn(async () => new Response('', { status: 302, headers: { location: '/login' } }));
    await expect(qojConnector.resolveAccount(account.handle, ctx)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(qojConnector.resolveAccount(account.handle, context('{}'))).rejects.toMatchObject({ code: 'PARSE_CHANGED' });
  });
  it('rejects a changed final submitter or extra server-side filtering', async () => {
    const ctx = context(fixture('normal'));
    ctx.request = vi.fn(async () => {
      const response = new Response(fixture('normal'), { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: 'https://qoj.ac/submissions?submitter=sample_person&min_score=100' });
      return response;
    });
    await expect(qojConnector.fetchSubmissionPage(account, { mode: 'backfill', cursor: null, checkpoint: null }, ctx)).rejects.toMatchObject({ code: 'PARSE_CHANGED' });
  });
  it('begins the actual AJAX flow and reports human challenges without sending passwords', async () => {
    expect(await qojLogin.beginLogin(context(fixture('login')))).toMatchObject({ kind: 'credentials' });
    expect(await qojLogin.beginLogin(context(fixture('challenge')))).toMatchObject({ kind: 'challenge', challenge: 'cloudflare' });
    await expect(qojLogin.verifySession(context(fixture('login')))).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('recognizes challenges from response headers even if Cloudflare changes the HTML title', async () => {
    const ctx = context('');
    ctx.request = vi.fn(async () => new Response('<html><title>Verification</title></html>', { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } }));
    await expect(qojConnector.resolveAccount(account.handle, ctx)).rejects.toMatchObject({ code: 'CHALLENGE_REQUIRED', httpStatus: 403 });
    expect(await qojLogin.beginLogin(ctx)).toMatchObject({ kind: 'challenge', challenge: 'cloudflare' });
    const step = await qojLogin.beginLogin(context(fixture('login')));
    expect(await qojLogin.advanceLogin(step, { username: 'sample_person', password: 'fixture-only' }, ctx)).toMatchObject({ kind: 'challenge', challenge: 'cloudflare' });
  });
  it('does not mistake injected Cloudflare JavaScript Detections for a challenge page', async () => {
    const script = '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>';
    expect(await qojLogin.beginLogin(context(fixture('login') + script))).toMatchObject({ kind: 'credentials' });
    const page = await qojConnector.fetchSubmissionPage(account, { mode: 'backfill', cursor: null, checkpoint: null }, context(fixture('normal') + script));
    expect(page.submissions).toHaveLength(2);
  });
});
