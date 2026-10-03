import { z } from 'zod';
import { ConnectorError, type PlatformReadRequest } from '@acm/connectors/contracts';

const state = z.object({ version: z.number().int().positive(), data: z.unknown() }).strict();
export const platformReadRequestSchema = z.object({
  platform: z.enum(['codeforces', 'luogu', 'qoj']),
  target: z.string().trim().min(1).max(128).refine(value => !/[/?#\\]/.test(value) && Array.from(value).every(character => character.charCodeAt(0) > 31)),
  connectionId: z.string().max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
  operation: z.enum(['submissions', 'verify', 'verify_session', 'resolve', 'contests', 'standings', 'problem']).default('submissions'),
  mode: z.enum(['backfill', 'incremental']).default('backfill'),
  cursor: state.nullable().default(null), checkpoint: state.nullable().default(null),
  pageSize: z.number().int().min(1).max(10000).optional(),
  since: z.iso.datetime().optional(),
  range: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }).strict().refine(r => Date.parse(r.from) < Date.parse(r.to), 'Invalid range').optional(),
  maxPages: z.number().int().min(1).max(1000).default(2),
  maxDurationMs: z.number().int().min(1).max(900000).default(120000),
  withProfile: z.boolean().default(false), withRating: z.boolean().default(false),
  contestId: z.string().min(1).max(30).optional(), index: z.string().min(1).max(16).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.range && input.since) ctx.addIssue({ code: 'custom', message: 'range 与 since 不能同时指定' });
  if (input.platform === 'luogu' && input.maxPages > 100) ctx.addIssue({ code: 'custom', message: '洛谷每批最多 100 页' });
  if (input.operation === 'verify' && (input.cursor !== null || input.checkpoint !== null)) ctx.addIssue({ code: 'custom', message: '连接核验不接受续跑状态' });
});
export type ParsedReadRequest = z.output<typeof platformReadRequestSchema>;
export function parsePlatformReadRequest(input: unknown): ParsedReadRequest {
  const parsed = platformReadRequestSchema.safeParse(input);
  if (!parsed.success) throw new ConnectorError('INVALID_INPUT', '平台读取参数不合法');
  const request = parsed.data;
  if (request.platform === 'codeforces') {
    if (request.connectionId) throw new ConnectorError('INVALID_INPUT', 'Codeforces 公共读取不使用采集连接');
  } else request.connectionId ??= process.env[request.platform === 'qoj' ? 'QOJ_CONNECTION_ID' : 'LUOGU_CONNECTION_ID'] ?? `${request.platform}-lab`;
  if (request.operation === 'verify') { request.maxPages = 1; request.withProfile = false; request.withRating = false; }
  return request;
}
export function originalRetryInput(input: unknown): PlatformReadRequest {
  // This metadata store does not commit submission facts. Never resume from diagnostic progress.
  return parsePlatformReadRequest(input);
}
