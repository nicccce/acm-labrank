import { getScoringSettingsRecord, updateScoringSettingsRecord } from '@acm/db/server';
import { scoringSettingsSchema } from '../domain/scoring-rules';
import { AppError } from './errors';

export async function getScoringSettings() { return scoringSettingsSchema.parse(await getScoringSettingsRecord()); }
export async function changeScoringSettings(input: unknown, actorId: string) {
  const parsed = scoringSettingsSchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '请完整填写各档赋分；分值须为 0–10000 的数字，最多三位小数', 400);
  const settings = await updateScoringSettingsRecord(parsed.data, actorId);
  if (!settings) throw new AppError('SETTINGS_STALE', '赋分规则已被其他管理员修改，请重新加载后再保存', 409);
  return scoringSettingsSchema.parse(settings);
}
