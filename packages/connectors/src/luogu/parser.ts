import { load } from 'cheerio';
import { z } from 'zod';
import { ConnectorError } from '../contracts/index';
import type { NormalizedProblem, NormalizedSubmission, Verdict } from '../contracts/index';

export const PARSER_VERSION = 'luogu-lentille/1';
export const ORIGIN = 'https://www.luogu.com.cn';
export const idSchema = z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]).transform(String);
export const userSchema = z.object({ uid: idSchema, name: z.string().min(1) });
const problemSchema = z.object({ pid: z.string().min(1), name: z.string(), difficulty: z.number().int().nullable().optional() });
const recordSchema = z.object({
  id: idSchema, status: z.number().int(), score: z.number().finite().nullable().optional(),
  submitTime: z.number().int().positive().max(253402300799).nullable().optional(),
  user: userSchema.nullable(), problem: problemSchema.nullable(),
  contest: z.object({ id: idSchema, name: z.string().optional(), mode: z.union([z.string(), z.number()]).optional() }).nullable().optional(),
});
export const recordsSchema = z.object({ count: z.number().int().nonnegative(), perPage: z.number().int().positive(), result: z.array(recordSchema) });
export const accountSchema = z.object({ platform: z.literal('luogu'), kind: z.literal('person'), handle: z.string().min(1), externalId: z.string().regex(/^[1-9]\d*$/) });
export const normalizedSubmissionSchema = z.object({
  platform: z.literal('luogu'), externalSubmissionId: z.string().regex(/^[1-9]\d*$/), problemKey: z.string().nullable(),
  submittedAt: z.iso.datetime().nullable(), verdict: z.enum(['accepted', 'rejected', 'pending', 'unknown']),
  nativeStatus: z.number().int(), nativeScore: z.number().nullable().optional(), sourceUrl: z.url(),
  subjectEvidence: z.object({ authorAccountKeys: z.array(z.string()).min(1), authorHandle: z.string(), contestId: z.string().optional(), contest: z.object({ id: z.string(), name: z.string().optional(), mode: z.string().optional() }).optional() }),
  parserVersion: z.literal(PARSER_VERSION), observedAt: z.iso.datetime(),
});
export const normalizedProblemSchema = z.object({ platform: z.literal('luogu'), problemKey: z.string(), title: z.string(), nativeDifficulty: z.number().int().min(1).max(8).nullable(), difficultyObserved: z.boolean().optional(), sourceUrl: z.url(), parserVersion: z.literal(PARSER_VERSION), observedAt: z.iso.datetime() });

export function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ConnectorError('PARSE_CHANGED', '洛谷响应字段与已验证结构不符');
  return parsed.data;
}

/** Observed in /_lfe/config RecordStatus, not inferred from score or colour. */
export function mapStatus(status: number): Verdict {
  if (status === 12) return 'accepted';
  if (status === 0 || status === 1) return 'pending';
  if ([2, 3, 4, 5, 6, 7, 14].includes(status)) return 'rejected';
  return 'unknown';
}
export function mapDifficulty(value: number | null | undefined) { return value !== undefined && value !== null && value >= 1 && value <= 8 ? value : null; }

export function checkPlatformError(value: unknown, status = 200): void {
  const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const details = `${object.errorType ?? ''} ${object.errorMessage ?? ''} ${object.message ?? ''}`;
  if (/UserUnlogin|UserSessionLocked|未登录|请.*登录/i.test(details) || status === 401) throw new ConnectorError('AUTH_REQUIRED', '洛谷采集会话失效');
  if (/privacy|隐私|保护设置/i.test(details)) throw new ConnectorError('PRIVACY_RESTRICTED', '目标用户的隐私设置限制读取');
  if (/captcha|challenge|风控|安全验证|人机验证/i.test(details)) throw new ConnectorError('RISK_CONTROL', '洛谷要求人工安全验证');
  if (/UserNotFound|用户不存在|找不到.*用户/i.test(details)) throw new ConnectorError('ACCOUNT_NOT_FOUND', '洛谷账号不存在');
  if (status === 429) throw new ConnectorError('RATE_LIMITED', '洛谷限制请求频率');
  if (status >= 500) throw new ConnectorError('TEMP_UNAVAILABLE', '洛谷暂不可用');
  if (status === 403 || /permission|AccessDenied|Forbidden|权限|无权/i.test(details)) throw new ConnectorError('FORBIDDEN', '当前采集账号没有读取权限');
  if (object.errorType || status >= 400) throw new ConnectorError('TEMP_UNAVAILABLE', '洛谷返回平台错误');
}

export function parseContext(html: string, expectedTemplate?: string) {
  const $ = load(html);
  const script = $('script#lentille-context');
  if (script.length !== 1) {
    const text = $('title').text() + ' ' + $('body').text();
    if (/Just a moment|cf-chl|安全验证|人机验证|风控/i.test(html)) throw new ConnectorError('RISK_CONTROL', '洛谷返回安全验证页面');
    if (/登录|Welcome - Luogu Spilopelia/i.test(text)) throw new ConnectorError('AUTH_REQUIRED', '洛谷返回登录页面');
    if (/隐私|保护设置/i.test(text)) throw new ConnectorError('PRIVACY_RESTRICTED', '洛谷返回隐私限制页面');
    if (/权限|403 Forbidden/i.test(text)) throw new ConnectorError('FORBIDDEN', '洛谷返回权限限制页面');
    throw new ConnectorError('PARSE_CHANGED', '缺少唯一的 lentille-context 数据脚本');
  }
  let value: unknown;
  try { value = JSON.parse(script.text()); } catch { throw new ConnectorError('PARSE_CHANGED', 'lentille-context 不是有效 JSON'); }
  const ctx = validated(z.object({ template: z.string(), status: z.number().int(), data: z.record(z.string(), z.unknown()), user: userSchema.nullable().optional() }).passthrough(), value);
  if (['login', 'unlock', 'auth.login'].includes(ctx.template) && expectedTemplate !== 'login') throw new ConnectorError('AUTH_REQUIRED', '洛谷返回登录页面');
  checkPlatformError(ctx.data, ctx.status);
  if (expectedTemplate && ctx.template !== expectedTemplate) throw new ConnectorError('PARSE_CHANGED', '洛谷页面模板发生变化');
  return ctx;
}

export async function readResponse(response: Response, template?: string): Promise<Record<string, unknown>> {
  if (response.status >= 300 && response.status < 400) {
    if (/\/auth\/(login|unlock)(?:[/?#]|$)/.test(response.headers.get('location') ?? '')) throw new ConnectorError('AUTH_REQUIRED', '洛谷要求重新登录');
    throw new ConnectorError('TEMP_UNAVAILABLE', '洛谷返回未预期重定向');
  }
  const body = await response.text();
  if (/\/auth\/(login|unlock)(?:[/?#]|$)/.test(response.url)) throw new ConnectorError('AUTH_REQUIRED', '洛谷要求重新登录');
  if (/^\s*[[{]/.test(body)) {
    let data: unknown;
    try { data = JSON.parse(body); } catch { throw new ConnectorError('PARSE_CHANGED', '无效 JSON 响应'); }
    checkPlatformError(data, response.status);
    const object = validated(z.record(z.string(), z.unknown()), data);
    if (template) {
      const ctx = validated(z.object({ template: z.literal(template), status: z.number(), data: z.record(z.string(), z.unknown()) }), object);
      checkPlatformError(ctx.data, ctx.status);
      return ctx.data;
    }
    return object;
  }
  if (/lentille-context/.test(body)) { const ctx = parseContext(body, template); checkPlatformError({}, response.status); return ctx.data; }
  if (/Just a moment|cf-chl|challenge-platform/i.test(body)) throw new ConnectorError('RISK_CONTROL', '洛谷返回安全验证页面');
  checkPlatformError({}, response.status);
  return parseContext(body, template).data;
}

export function normalizeRecords(value: unknown, uid: string, observedAt: string) {
  const records = validated(recordsSchema, value);
  if (records.result.length > records.perPage || (records.count === 0 && records.result.length)) throw new ConnectorError('PARSE_CHANGED', '洛谷分页元数据矛盾');
  const submissions: NormalizedSubmission[] = [];
  const problems = new Map<string, NormalizedProblem>();
  let previous: bigint | undefined;
  for (const record of records.result) {
    if (!record.user) throw new ConnectorError('PRIVACY_RESTRICTED', '提交作者不可见，不能核对目标 UID');
    if (record.user.uid !== uid) throw new ConnectorError('PARSE_CHANGED', '提交作者 UID 与目标账号不一致');
    if (previous !== undefined && BigInt(record.id) >= previous) throw new ConnectorError('PARSE_CHANGED', '提交列表不是唯一 ID 降序');
    previous = BigInt(record.id);
    const contest = record.contest ? { id: record.contest.id, ...(record.contest.name !== undefined ? { name: record.contest.name } : {}), ...(record.contest.mode !== undefined ? { mode: String(record.contest.mode) } : {}) } : undefined;
    submissions.push(validated(normalizedSubmissionSchema, {
      platform: 'luogu', externalSubmissionId: record.id, problemKey: record.problem?.pid ?? null,
      submittedAt: record.submitTime ? new Date(record.submitTime * 1000).toISOString() : null,
      verdict: mapStatus(record.status), nativeStatus: record.status,
      ...(record.score !== undefined ? { nativeScore: record.score } : {}),
      sourceUrl: `${ORIGIN}/record/${record.id}`, subjectEvidence: { authorAccountKeys: [uid], authorHandle: record.user.name, ...(contest ? { contestId: contest.id, contest } : {}) },
      parserVersion: PARSER_VERSION, observedAt,
    }));
    if (record.problem) problems.set(record.problem.pid, validated(normalizedProblemSchema, { platform: 'luogu', problemKey: record.problem.pid, title: record.problem.name, nativeDifficulty: mapDifficulty(record.problem.difficulty), difficultyObserved: record.problem.difficulty !== undefined, sourceUrl: `${ORIGIN}/problem/${encodeURIComponent(record.problem.pid)}`, parserVersion: PARSER_VERSION, observedAt }));
  }
  return { records, submissions, problems: [...problems.values()] };
}
