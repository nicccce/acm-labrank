import { load } from 'cheerio';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConnectorError, type RequestContext } from '../contracts/index';
import { ORIGIN, parseContext, readResponse, userSchema, validated } from './parser';

/** Private attempt state. Application must encrypt it if moved between processes. */
export interface LuoguLoginState {
  attemptId: string; version: number; username: string; csrf: string; expiresAt: number;
  consumed: boolean; sessionBinding: unknown;
}
export interface LuoguChallenge {
  state: LuoguLoginState; image: Uint8Array; contentType: string;
}

async function getChallenge(state: LuoguLoginState, ctx: RequestContext): Promise<LuoguChallenge> {
  const url = new URL('/lg4/captcha', ORIGIN); url.searchParams.set('_t', String(Date.now()));
  const response = await ctx.request(url, { headers: { Referer: `${ORIGIN}/auth/login` } });
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !/^image\/(png|jpeg|gif|webp)(?:;|$)/i.test(type)) {
    await readResponse(response);
    throw new ConnectorError('UNSUPPORTED_FLOW', '洛谷未返回当前图片验证码');
  }
  return { state, image: new Uint8Array(await response.arrayBuffer()), contentType: type };
}
function assertAttempt(state: LuoguLoginState, version: number, ctx: RequestContext) {
  if (state.consumed || state.version !== version || Date.now() >= state.expiresAt || state.sessionBinding !== ctx.session) throw new ConnectorError('STALE_CHALLENGE', '验证码挑战已消费、刷新、过期或会话不匹配');
}

export const luoguLogin = {
  async beginLogin(username: string, ctx: RequestContext): Promise<LuoguChallenge> {
    const response = await ctx.request(new URL('/auth/login', ORIGIN), { redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) throw new ConnectorError('LOGIN_FAILED', '此上下文已有会话；请使用独立临时会话开始登录');
    const html = await response.text();
    if (!response.ok) { await readResponse(new Response(html, { status: response.status })); throw new ConnectorError('LOGIN_FAILED', '洛谷登录页不可用'); }
    const page = parseContext(html, 'login');
    void page;
    const csrf = load(html)('meta[name="csrf-token"]').attr('content');
    if (!csrf) throw new ConnectorError('PARSE_CHANGED', '洛谷登录页缺少 CSRF');
    // Validate routes against the config explicitly declared by the real login page.
    const config = await readResponse(await ctx.request(new URL('/_lfe/config/auth', ORIGIN)));
    const routes = validated(z.record(z.string(), z.string()), config.route);
    if (routes['auth.login_methods'] !== '/auth/login-methods' || routes['do_auth.password'] !== '/do-auth/password' || routes.captcha !== '/lg4/captcha') throw new ConnectorError('PARSE_CHANGED', '洛谷登录路由发生变化；不发送凭据');
    const methodsUrl = new URL('/auth/login-methods', ORIGIN); methodsUrl.searchParams.set('login', username);
    const methods = validated(z.object({ default: z.string(), available: z.array(z.string()) }), await readResponse(await ctx.request(methodsUrl, { headers: { Accept: 'application/json', 'X-CSRF-TOKEN': csrf } })));
    if (!methods.available.includes('password')) throw new ConnectorError('UNSUPPORTED_FLOW', '账号需要尚未验证的二次认证登录方式');
    const state: LuoguLoginState = { attemptId: randomUUID(), version: 1, username, csrf, expiresAt: Date.now() + 10 * 60_000, consumed: false, sessionBinding: ctx.session };
    return getChallenge(state, ctx);
  },
  async refreshChallenge(state: LuoguLoginState, version: number, ctx: RequestContext): Promise<LuoguChallenge> {
    assertAttempt(state, version, ctx); state.consumed = true;
    return getChallenge({ ...state, version: state.version + 1, consumed: false }, ctx);
  },
  async advanceLogin(state: LuoguLoginState, input: { version: number; password: string; captcha: string; expectedHandle: string }, ctx: RequestContext) {
    assertAttempt(state, input.version, ctx); state.consumed = true;
    try {
      const response = await ctx.request(new URL('/do-auth/password', ORIGIN), {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': state.csrf, Origin: ORIGIN, Referer: `${ORIGIN}/auth/login` },
        body: JSON.stringify({ username: state.username, password: input.password, captcha: input.captcha }),
      });
      const body = await response.text();
      let result: unknown;
      try { result = JSON.parse(body); } catch { throw new ConnectorError('LOGIN_FAILED', '洛谷登录返回非 JSON，可能需要人工验证'); }
      const parsed = z.object({ redirectTo: z.string() }).safeParse(result);
      if (!response.ok || !parsed.success) throw new ConnectorError('LOGIN_FAILED', '洛谷未接受本次凭据或验证码；请重新获取挑战');
      const identity = await this.verifySession(ctx);
      if (identity.name !== input.expectedHandle) throw new ConnectorError('LOGIN_FAILED', '登录身份与指定采集账号不一致');
      return identity;
    } finally { input.password = ''; input.captcha = ''; }
  },
  async verifySession(ctx: RequestContext) {
    const response = await ctx.request(new URL('/', ORIGIN));
    const html = await response.text();
    if (!response.ok) throw new ConnectorError('AUTH_REQUIRED', '无法核对洛谷登录身份');
    const page = parseContext(html);
    if (!page.user) throw new ConnectorError('AUTH_REQUIRED', '洛谷会话未登录');
    return validated(userSchema, page.user);
  },
};
