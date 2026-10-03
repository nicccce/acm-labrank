import { load } from 'cheerio';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConnectorError, parseRetryAfter, type RequestContext } from '../contracts/index';
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

/** Match platform explanations, but never copy its response text into errors or logs. */
function rejectLoginResponse(value: Record<string, unknown>, response: Response) {
  const fields = z.object({ errorData: z.object({ fields: z.array(z.object({ message: z.string() }).passthrough()).optional() }).nullable().optional() }).safeParse(value);
  const details = [value.errorType, value.errorMessage, value.message, ...(fields.success ? fields.data.errorData?.fields?.map(field => field.message) ?? [] : [])].filter(part => typeof part === 'string').join(' ');
  const options = { httpStatus: response.status };
  if (response.status === 429) throw new ConnectorError('RATE_LIMITED', '洛谷暂时限制登录频率，请稍后再试', { ...options, retryAt: parseRetryAfter(response.headers.get('retry-after')) });
  if (response.status >= 500) throw new ConnectorError('TEMP_UNAVAILABLE', '洛谷登录服务暂不可用，请稍后再试', options);
  if (response.status === 419 || /csrf|令牌.{0,12}(?:无效|错误|过期)/i.test(details)) throw new ConnectorError('STALE_CHALLENGE', '洛谷登录校验令牌已失效，请重新获取验证码', options);
  if (/two.?factor|multi.?factor|totp|motp|二次认证|两步验证|二步验证|动态验证码/i.test(details)) throw new ConnectorError('UNSUPPORTED_FLOW', '该洛谷账号要求额外的两步验证，当前账号密码表单暂不支持', options);
  if (/captcha|图形验证码|验证码/i.test(details)) throw new ConnectorError('LOGIN_FAILED', '洛谷提示图形验证码错误、缺失或已失效，请换一张后重新输入', options);
  if (/invalid.{0,24}password|wrong.?password|bad.?credentials|invalid.?credentials|password.{0,24}(?:incorrect|invalid)|密码.{0,12}(?:错误|不正确|不匹配)|(?:账号|用户名).{0,12}(?:或|和).{0,12}密码/i.test(details)) throw new ConnectorError('LOGIN_FAILED', '洛谷提示账号或密码未通过校验；请使用用户名、UID、手机号或邮箱登录，重新获取验证码后再试', options);
  if (/UserNotFound|用户不存在|账号不存在|找不到用户/i.test(details)) throw new ConnectorError('LOGIN_FAILED', '洛谷未找到该登录账号，请核对用户名、UID、手机号或邮箱', options);
  if (/challenge|风控|安全验证|人机验证/i.test(details)) throw new ConnectorError('RISK_CONTROL', '洛谷要求额外安全验证，请先在官网登录页检查账号提示', options);
  if (response.status === 403) throw new ConnectorError('FORBIDDEN', '洛谷拒绝本次登录请求（HTTP 403），请先在官网登录页检查是否需要安全验证', options);
  if (!response.ok || value.errorType || value.error || value.success === false) throw new ConnectorError('LOGIN_FAILED', `洛谷返回未识别的登录失败（HTTP ${response.status}），请先在官网登录页确认账号是否能登录`, options);
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
  async advanceLogin(state: LuoguLoginState, input: { version: number; password: string; captcha: string; expectedHandle?: string }, ctx: RequestContext) {
    assertAttempt(state, input.version, ctx); state.consumed = true;
    try {
      const response = await ctx.request(new URL('/do-auth/password', ORIGIN), {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-TOKEN': state.csrf, Origin: ORIGIN, Referer: `${ORIGIN}/auth/login` },
        body: JSON.stringify({ username: state.username, password: input.password, captcha: input.captcha }),
      });
      const body = await response.text();
      let result: unknown;
      try { result = JSON.parse(body); } catch {
        if (/Just a moment|cf-chl|challenge-platform/i.test(body)) throw new ConnectorError('RISK_CONTROL', '洛谷要求额外安全验证，请先在官网登录页检查账号提示', { httpStatus: response.status });
        rejectLoginResponse({}, response);
        throw new ConnectorError('PARSE_CHANGED', '洛谷登录返回非 JSON，无法确认登录结果，请先检查官网是否需要额外验证', { httpStatus: response.status });
      }
      const parsed = z.record(z.string(), z.unknown()).safeParse(result);
      if (!parsed.success) throw new ConnectorError('PARSE_CHANGED', '洛谷登录响应格式发生变化，无法确认登录结果', { httpStatus: response.status });
      rejectLoginResponse(parsed.data, response);
      // A redirect field alone never establishes a login. The authenticated UID does.
      const identity = await this.verifySession(ctx);
      if (input.expectedHandle && identity.name !== input.expectedHandle) throw new ConnectorError('LOGIN_FAILED', '登录身份与指定采集账号不一致');
      return identity;
    } finally { input.password = ''; input.captcha = ''; }
  },
  async verifySession(ctx: RequestContext) {
    const response = await ctx.request(new URL('/', ORIGIN));
    const html = await response.text();
    if (response.status === 429) throw new ConnectorError('RATE_LIMITED', '洛谷限制身份核验频率', { httpStatus: 429 });
    if (response.status >= 500) throw new ConnectorError('TEMP_UNAVAILABLE', '洛谷身份核验暂不可用', { httpStatus: response.status });
    if (response.status === 403) throw new ConnectorError('FORBIDDEN', '洛谷拒绝本次身份核验', { httpStatus: 403 });
    if (!response.ok) throw new ConnectorError('AUTH_REQUIRED', '无法核对洛谷登录身份', { httpStatus: response.status });
    const page = parseContext(html);
    if (!page.user) throw new ConnectorError('AUTH_REQUIRED', '洛谷会话未登录');
    return validated(userSchema, page.user);
  },
};
