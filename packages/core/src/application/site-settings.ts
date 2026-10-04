import { z } from 'zod';
import { getSiteSettingsRecord, updateSiteSettingsRecord } from '@acm/db/server';
import { AppError } from './errors';

export const siteSettingsSchema = z.object({
  headerText: z.string().trim().max(80, '平台名称最多 80 字'),
  loginText: z.string().trim().max(800, '登录页文字最多 800 字'),
  version: z.number().int().positive(),
}).strict();
export function getSiteSettings() { return getSiteSettingsRecord(); }
export async function changeSiteSettings(input: unknown, actorId: string) {
  const parsed = siteSettingsSchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', parsed.error.issues[0]?.message ?? '站点设置不合法', 400);
  const settings = await updateSiteSettingsRecord(parsed.data, actorId);
  if (!settings) throw new AppError('SETTINGS_STALE', '站点设置已变化，请刷新后重试', 409);
  return settings;
}
