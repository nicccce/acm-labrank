import { collectionSkipLabels as collectionSkipMessages } from '../../contracts';
import { z } from 'zod';
import { collectionAvailability, collectionPlatformSummary, getCollectionSettings, listPersonalSyncRuns, resetCollectionPlatforms, saveCollectionSettings } from '@acm/db/server';
import { dateRange } from '../../domain';
import { AppError } from '../errors';
import { withReadQueue } from './jobs';

const platform = z.enum(['codeforces', 'luogu', 'qoj']);
export const collectionSettingsSchema = z.object({
  platforms: z.array(platform).max(3).refine(items => new Set(items).size === items.length),
  autoSyncEnabled: z.boolean(), syncIntervalMinutes: z.number().int().min(1).max(10080),
  scoreRange: z.discriminatedUnion('kind', [z.object({ kind: z.literal('rolling'), days: z.union([z.literal(7), z.literal(30)]) }).strict(), z.object({ kind: z.literal('fixed'), from: z.string(), to: z.string() }).strict()]),
  version: z.number().int().positive(),
}).strict().superRefine((value, ctx) => {
  if (value.scoreRange.kind === 'fixed') try { dateRange(value.scoreRange, new Date(0)); } catch { ctx.addIssue({ code: 'custom', message: '日期无效或区间超过 366 天', path: ['scoreRange'] }); }
});
export { collectionSkipLabels as collectionSkipMessages } from '../../contracts';
export async function collectionSettingsCall<T>(handler: () => Promise<T>) {
  try { return await handler(); } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (['VERSION_CONFLICT', 'RESET_REQUEST_CONFLICT', ...Object.keys(collectionSkipMessages)].includes(code)) throw new AppError(code, collectionSkipMessages[code] ?? (code === 'VERSION_CONFLICT' ? '设置已变化，请刷新后重试' : '重爬请求标识已用于其他操作，请重新确认'), 409);
    throw error;
  }
}
export async function getAdminCollectionSettings() {
  const [settings, summary] = await Promise.all([getCollectionSettings(), collectionPlatformSummary()]);
  const items = await Promise.all(summary.map(async row => {
    const available = await collectionAvailability(row.platform);
    const reason = available.reason ?? (row.bindingCount === 0 ? 'NO_ACTIVE_BINDING' : null);
    return { ...row, selected: settings.platforms.includes(row.platform), nextSyncAt: settings.autoSyncEnabled && !reason ? row.nextSyncAt : null, skipped: reason, message: reason ? collectionSkipMessages[reason] : null };
  }));
  return { ...settings, items };
}
export async function changeAdminCollectionSettings(input: unknown, actorId: string) {
  const parsed = collectionSettingsSchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '平台、同步周期或日期区间不合法（最多 366 天）', 400);
  return collectionSettingsCall(() => withReadQueue(boss => saveCollectionSettings(parsed.data, actorId, boss)));
}
export async function resetAdminCollection(input: unknown, actorId: string) {
  const parsed = z.object({ platforms: z.array(platform).min(1).max(3).refine(items => new Set(items).size === items.length), version: z.number().int().positive(), requestId: z.uuid() }).strict().safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '请选择重爬平台并刷新设置版本', 400);
  return collectionSettingsCall(() => withReadQueue(boss => resetCollectionPlatforms(parsed.data, actorId, boss)));
}
export async function getAdminSyncJobs(params: URLSearchParams) {
  const parsed = z.object({ platform: platform.optional(), status: z.enum(['queued', 'running', 'completed', 'paused', 'failed', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().max(500).optional() }).strict().safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new AppError('INVALID_INPUT', '任务查询参数不合法', 400);
  let before: { createdAt: string; id: string } | undefined;
  if (parsed.data.cursor) try { before = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict().parse(JSON.parse(Buffer.from(parsed.data.cursor, 'base64url').toString())); } catch { throw new AppError('INVALID_INPUT', '任务分页游标不合法', 400); }
  const rows = await listPersonalSyncRuns({ ...parsed.data, before, limit: parsed.data.limit + 1 });
  const items = rows.slice(0, parsed.data.limit).map(row => ({ id: row.id, platform: row.platform, handle: row.handle, username: row.username, kind: row.kind, mode: row.mode, scope: row.scope, initialFrom: row.initial_from?.toISOString() ?? null, source: row.source, status: row.status, batch: row.batch, pages: row.pages, recordsWithOverlap: row.records, error: row.error, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, range: row.range_from ? { from: new Date(row.range_from.getTime() + 8 * 3600000).toISOString().slice(0, 10), to: new Date(row.range_to.getTime() - 1 + 8 * 3600000).toISOString().slice(0, 10) } : null, rangeComplete: row.range_complete }));
  const last = rows[Math.min(rows.length, parsed.data.limit) - 1];
  return { items, nextCursor: rows.length > items.length && last ? Buffer.from(JSON.stringify({ createdAt: last.created_at.toISOString(), id: last.id })).toString('base64url') : null };
}
