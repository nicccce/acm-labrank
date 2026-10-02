import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { ConnectorError, type RequestContext } from '../contracts/index';
import { assertHtml, getHtml, isCloudflareChallenge, ORIGIN, siteUrl } from './http';

export type LoginStep = { kind: 'credentials'; csrf: string; expiresAt: number } | { kind: 'challenge'; challenge: 'cloudflare' | 'two_factor' | 'external_verification'; url: string; message: string } | { kind: 'authenticated'; handle: string };
export const qojLogin = {
  async beginLogin(ctx: RequestContext): Promise<LoginStep> {
    const r = await ctx.request(new URL('/login', ORIGIN), { redirect: 'manual' });
    const html = await r.text();
    if (isCloudflareChallenge(r, html)) return { kind: 'challenge', challenge: 'cloudflare', url: `${ORIGIN}/login`, message: 'Complete the actual challenge in the browser, then retry with the same browser session.' };
    if (r.status === 302 || r.status === 303) return { kind: 'authenticated', handle: await this.verifySession(ctx) };
    if (r.status !== 200) throw new ConnectorError('LOGIN_FAILED', 'Unexpected QOJ login response');
    const $ = load(html);
    const script = $('script').toArray().map(e => $(e).text()).find(s => s.includes('function submitLoginPost()'));
    const csrf = script?.match(/_token\s*:\s*['"]([A-Za-z0-9]+)['"]/)?.[1];
    // This is the actual QOJ 4.5.46 AJAX form observed on 2026-10-01.
    if ($('#form-login').attr('method')?.toLowerCase() !== 'post' || !csrf || !script?.includes("$.post('/login'") || !/password\s*:\s*md5\(/.test(script) || !$('#input-username[name=username]').length || !$('#input-password[name=password]').length) {
      throw new ConnectorError('PARSE_CHANGED', 'QOJ login form changed; do not send credentials');
    }
    return { kind: 'credentials', csrf, expiresAt: Date.now() + 5 * 60_000 };
  },
  async advanceLogin(step: LoginStep, input: { username: string; password: string }, ctx: RequestContext): Promise<LoginStep> {
    if (step.kind !== 'credentials' || Date.now() >= step.expiresAt) throw new ConnectorError('LOGIN_FAILED', 'Refresh the QOJ login attempt before sending credentials');
    const body = new URLSearchParams({ _token: step.csrf, login: '', username: input.username, password: createHash('md5').update(input.password).digest('hex'), trust: '' });
    const r = await ctx.request(new URL('/login', ORIGIN), { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', origin: ORIGIN, referer: `${ORIGIN}/login` }, body });
    const text = await r.text();
    if (isCloudflareChallenge(r, text)) return { kind: 'challenge', challenge: 'cloudflare', url: `${ORIGIN}/login`, message: 'Human Cloudflare verification required' };
    if (r.status !== 200) throw new ConnectorError('LOGIN_FAILED', 'Unexpected QOJ credential response');
    if (text === '2fa') return { kind: 'challenge', challenge: 'two_factor', url: `${ORIGIN}/login/2fa`, message: 'Complete the actual QOJ 2FA form manually; server 2FA fields have not been verified' };
    if (text === 'pending_2fa') return { kind: 'challenge', challenge: 'external_verification', url: `${ORIGIN}/login`, message: 'QOJ requests external administrator verification; human action required' };
    if (text === 'banned' || text === 'secure') throw new ConnectorError('FORBIDDEN', 'QOJ refused this login');
    if (text !== 'ok') throw new ConnectorError('LOGIN_FAILED', text === 'expired' ? 'QOJ login attempt expired' : 'QOJ login failed');
    const handle = await this.verifySession(ctx);
    if (handle !== input.username) throw new ConnectorError('LOGIN_FAILED', 'QOJ session identity differs from the login account');
    return { kind: 'authenticated', handle };
  },
  async verifySession(ctx: RequestContext): Promise<string> {
    const $ = assertHtml(await getHtml(new URL('/', ORIGIN), ctx));
    if (!$('a[href*="/logout"]').length) throw new ConnectorError('AUTH_REQUIRED', 'QOJ session is not authenticated');
    const own = $('ul.nav .uoj-username');
    const href = own.attr('href');
    const match = href ? siteUrl(href).pathname.match(/^\/user\/profile\/([^/]+)$/) : null;
    if (own.length !== 1 || (!match && own.attr('data-nickname') === undefined)) throw new ConnectorError('PARSE_CHANGED', 'QOJ logged-in identity markup changed');
    return match ? decodeURIComponent(match[1]!) : own.text().trim();
  },
};
