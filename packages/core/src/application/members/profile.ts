import { z } from 'zod';
import type { PlatformId } from '@acm/connectors/contracts';
import { collectionAvailability, listBindings, memberProfile, saveBindingCandidate, unbindAccount, updateMemberName } from '@acm/db/server';
import { displayName } from '../../domain';
import { AppError } from '../errors';
import { withReadQueue } from '../collection/jobs';
import { platformIds } from '@acm/connectors/metadata';
import { userManagementCall } from '../user-management';

const platforms = platformIds;
export function personalPlatform(platform: string): PlatformId {
  if (!platforms.includes(platform as PlatformId)) throw new AppError('INVALID_INPUT', '不支持的平台', 400); return platform as PlatformId;
}
export async function personalCall<T>(fn: () => Promise<T>) {
  try { return await userManagementCall(fn); } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (['ACCOUNT_OCCUPIED', 'STALE_BINDING', 'SYNC_STATE_CONFLICT', 'SYNC_RANGE_CONFLICT', 'NO_ACTIVE_BINDING', 'TEAM_ACCOUNT_UNSUPPORTED'].includes(code)) throw new AppError(code, code === 'ACCOUNT_OCCUPIED' ? '该平台身份已被绑定' : code === 'SYNC_RANGE_CONFLICT' ? '该账号已有其他日期范围的同步任务，请等待完成后再提交' : '绑定或任务状态已变化，请刷新', 409);
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new AppError('STATE_CONFLICT', '账号或任务已被占用，请刷新', 409);
    throw error;
  }
}
export async function getMemberProfile(id: string) {
  if (!z.uuid().safeParse(id).success) throw new AppError('INVALID_INPUT', '成员 ID 不合法', 400);
  const row = await memberProfile(id); if (!row) throw new AppError('NOT_FOUND', '成员不存在', 404);
  return { id: row.id, username: row.username, realName: row.realName, displayName: displayName(row), role: row.role, isStarred: row.isStarred };
}
export async function saveMemberProfile(id: string, input: unknown) {
  const parsed = z.object({ realName: z.string().trim().max(64).nullable() }).strict().safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '姓名需在 64 字内', 400);
  await userManagementCall(() => updateMemberName(id, parsed.data.realName || null)); return getMemberProfile(id);
}
export async function getMemberBindings(userId: string) {
  const rows = await listBindings(userId);
  return { items: await Promise.all(platforms.map(async platform => {
    const availability = await collectionAvailability(platform);
    const row = rows.find(r => r.platform === platform);
    return { platform, version: row?.version ?? 0, active: row?.account_id ? { accountId: row.account_id, handle: row.handle, externalId: row.external_id } : null,
      candidate: row?.candidate ? { target: row.candidate, state: row.candidate_state, waitingReason: availability.reason, error: row.candidate_error ? JSON.parse(row.candidate_error) : null } : null,
      sync: { initializedAt: row?.initialized_at ?? null, initialFrom: row?.initial_from ?? null, latestScope: row?.latest_scope ?? null, lastSuccessAt: row?.latest_success ?? null, historyComplete: row?.history_complete ?? false, coverage: row?.coverage ?? 'unknown' } };
  })) };
}
export async function putMemberBinding(userId: string, platform: PlatformId, input: unknown) {
  const parsed = z.object({ target: z.string().trim().min(1).max(100) }).strict().safeParse(input);
  if (!parsed.success || /[\s/?#\\]/.test(parsed.data.target) || (platform === 'luogu' && !/^[1-9]\d*$/.test(parsed.data.target))) throw new AppError('INVALID_INPUT', '请输入合法的平台账号（洛谷使用 UID）', 400);
  return personalCall(() => withReadQueue(boss => saveBindingCandidate(userId, platform, parsed.data.target, boss)));
}
export async function deleteMemberBinding(userId: string, platform: PlatformId) { await unbindAccount(userId, platform); return { unbound: true }; }
