import { z } from 'zod';
import { getConnector } from '@acm/connectors/server';
import { ConnectorError, type PlatformId } from '@acm/connectors/contracts';
import { platforms, isPlatformId } from '@acm/connectors/metadata';
import { getReadRun, latestReadFailures, listCollectionConnections, listPlatformPolicies, listReadRuns, updatePlatformPolicy } from '@acm/db/server';
import { AppError } from '../errors';
import { requestPlatformRead, retryPlatformRead } from './jobs';

export const adminRunIdSchema = z.uuid();
export function adminPlatform(value: string): PlatformId {
  if (!isPlatformId(value)) throw new AppError('INVALID_INPUT', '不支持的平台', 400);
  return value;
}
export async function collectionAdminCall<T>(handler: () => Promise<T>): Promise<T> {
  try { return await handler(); } catch (error) {
    if (error instanceof ConnectorError) throw new AppError(error.code, error.message, error.code === 'INVALID_INPUT' ? 400 : error.code === 'NOT_IMPLEMENTED' ? 422 : 503, error.retryAt);
    throw error;
  }
}
export async function getAdminPlatforms() {
  const [policies, connections, runs] = await Promise.all([listPlatformPolicies(), listCollectionConnections(), latestReadFailures()]);
  return { items: platforms.map(platform => {
    const connector = getConnector(platform.id);
    const connectionId = process.env[platform.id === 'qoj' ? 'QOJ_CONNECTION_ID' : 'LUOGU_CONNECTION_ID'] ?? `${platform.id}-lab`;
    return {
      platform: platform.id, name: platform.name, requiresLogin: platform.requiresLogin,
      capabilities: { ...connector.capabilities, profile: Boolean(connector.fetchProfile), ratingHistory: Boolean(connector.fetchRatingHistory), contests: Boolean(connector.fetchContests), standings: Boolean(connector.fetchStandings), problem: Boolean(connector.fetchProblem) },
      rateLimit: policies.find(policy => policy.platform === platform.id) ?? null,
      connection: platform.requiresLogin ? connections.find(connection => connection.id === connectionId && connection.platform === platform.id) ?? { id: connectionId, state: 'unknown', collector: null, generation: 0, verifiedAt: null } : { state: 'not_required', collector: null },
      latestFailure: runs.find(run => run.platform === platform.id && !['queued', 'running', 'completed'].includes(run.status)) ?? null,
      authentication: platform.id === 'codeforces' ? { kind: 'none' } : platform.id === 'luogu' ? { kind: 'cli_captcha', command: 'pnpm luogu:read --login --account TARGET --username COLLECTOR' } : { kind: 'browser_manual', instruction: '在专用浏览器完成登录或挑战后，调用连接核验接口。' },
    };
  }) };
}
export async function changeAdminRateLimit(platform: PlatformId, input: unknown, actorId: string) {
  const schema = z.object({ minIntervalMs: z.number().int().min(platform === 'codeforces' ? 2000 : 1000).max(60000), maxIntervalMs: z.number().int().max(60000), version: z.number().int().positive() }).strict().refine(value => value.maxIntervalMs >= value.minIntervalMs);
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '请求间隔范围不合法', 400);
  const result = await updatePlatformPolicy({ platform, ...parsed.data, actorId });
  if (!result) throw new AppError('VERSION_CONFLICT', '限流配置已变化，请刷新后重试', 409);
  return result;
}
export async function getAdminReadRuns(query: URLSearchParams) {
  const schema = z.object({ platform: z.enum(['codeforces', 'luogu', 'qoj']).optional(), status: z.enum(['queued', 'running', 'completed', 'auth_required', 'human_input_required', 'restricted', 'parse_changed', 'timeout', 'cancelled', 'failed']).optional(), action: z.enum(['none', 'retry', 'reauthenticate', 'human_verify', 'fix_target', 'fix_parser', 'unsupported']).optional(), limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().max(500).optional() }).strict();
  const parsed = schema.safeParse(Object.fromEntries(query));
  if (!parsed.success) throw new AppError('INVALID_INPUT', '查询参数不合法', 400);
  let before: { createdAt: string; id: string } | undefined;
  if (parsed.data.cursor) {
    try { before = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict().parse(JSON.parse(Buffer.from(parsed.data.cursor, 'base64url').toString())); }
    catch { throw new AppError('INVALID_INPUT', '分页游标不合法', 400); }
  }
  const rows = await listReadRuns({ ...parsed.data, before, limit: parsed.data.limit + 1 });
  const items = rows.slice(0, parsed.data.limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > items.length && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id })).toString('base64url') : null };
}
export async function getAdminReadRun(id: string) {
  if (!adminRunIdSchema.safeParse(id).success) throw new AppError('INVALID_INPUT', '运行 ID 不合法', 400);
  const run = await getReadRun(id);
  if (!run) throw new AppError('NOT_FOUND', '读取记录不存在', 404);
  return run;
}
export async function requestAdminRead(input: unknown, actorId: string) { return collectionAdminCall(() => requestPlatformRead(input, { actorId })); }
export async function retryAdminRead(id: string, actorId: string) {
  const run = await getAdminReadRun(id);
  if (['queued', 'running', 'completed', 'cancelled'].includes(run.status)) throw new AppError('STATE_CONFLICT', '当前状态不支持重试', 409);
  return collectionAdminCall(() => retryPlatformRead(id, actorId));
}
export async function verifyAdminConnection(platform: PlatformId, input: unknown, actorId: string) {
  if (platform === 'codeforces') return { requiresLogin: false, state: 'not_required' };
  const parsed = z.object({ target: z.string().min(1).max(128) }).strict().safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '请指定核验读取目标', 400);
  return collectionAdminCall(() => requestPlatformRead({ platform, target: parsed.data.target, operation: 'verify' }, { actorId }));
}
