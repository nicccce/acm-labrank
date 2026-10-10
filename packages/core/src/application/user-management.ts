import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { listManagedUsers, mutateManagedUser, updateOwnUser, UserStateError, type ManagedUser } from '@acm/db/server';
import { hashPassword } from './auth';
import { AppError } from './errors';
import { withReadQueue } from './collection/jobs';

const userIdSchema = z.uuid().transform(v => v.toLowerCase());
export const starSchema = z.object({ isStarred: z.boolean() }).strict();
export const userPatchSchema = z.object({ realName: z.string().trim().max(64).nullable().optional(), active: z.boolean().optional(), isStarred: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0);
export const managementListSchema = z.object({ q: z.string().trim().max(64).default(''), status: z.enum(['all', 'active', 'banned', 'deleted']).default('active'), starred: z.enum(['all', '1', '0']).default('all'), page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
export function managementInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError('INVALID_INPUT', '输入或查询参数不合法', 400);
  return result.data;
}
export function managedUserDto(user: ManagedUser) {
  return { ...user, createdAt: user.createdAt.toISOString(), deletedAt: user.deletedAt?.toISOString() ?? null };
}
export async function userManagementCall<T>(fn: () => Promise<T>) {
  try { return await fn(); } catch (error) {
    if (!(error instanceof UserStateError)) throw error;
    const messages: Record<string, string> = { USER_FORBIDDEN: '账号状态或权限已变化，请重新登录', USER_NOT_FOUND: '用户不存在', USER_DELETED: '已删除账号只允许恢复', USER_SELF_SUSPEND: '不能封禁或删除自己的账号', USER_LAST_ADMIN: '不能停用最后一名可用管理员' };
    throw new AppError(error.code, messages[error.code] ?? '用户操作失败', error.code === 'USER_FORBIDDEN' ? 403 : error.code === 'USER_NOT_FOUND' ? 404 : 409);
  }
}
export async function getManagedUsers(params: URLSearchParams) {
  const input = managementInput(managementListSchema, Object.fromEntries(params));
  const result = await listManagedUsers({ ...input, offset: (input.page - 1) * input.limit });
  return { page: input.page, limit: input.limit, total: result.total, items: result.rows.map(managedUserDto) };
}
export async function patchManagedUser(actorId: string, id: string, raw: unknown) {
  const userId = managementInput(userIdSchema, id), input = managementInput(userPatchSchema, raw);
  if (input.realName === '') input.realName = null;
  return userManagementCall(async () => managedUserDto(await withReadQueue(boss => mutateManagedUser(actorId, userId, { kind: 'update', ...input }, boss))));
}
export async function deleteManagedUser(actorId: string, id: string) {
  const userId = managementInput(userIdSchema, id);
  return userManagementCall(async () => managedUserDto(await withReadQueue(boss => mutateManagedUser(actorId, userId, { kind: 'delete' }, boss))));
}
export async function restoreManagedUser(actorId: string, id: string) {
  const userId = managementInput(userIdSchema, id);
  return userManagementCall(async () => managedUserDto(await mutateManagedUser(actorId, userId, { kind: 'restore' })));
}
export async function resetManagedUserPassword(actorId: string, id: string) {
  const userId = managementInput(userIdSchema, id), temporaryPassword = randomBytes(18).toString('base64url');
  const passwordHash = await hashPassword(temporaryPassword);
  const user = await userManagementCall(() => mutateManagedUser(actorId, userId, { kind: 'reset', passwordHash }));
  return { user: managedUserDto(user), temporaryPassword };
}
export async function setOwnUserStar(userId: string, raw: unknown) {
  const input = managementInput(starSchema, raw);
  return userManagementCall(async () => managedUserDto(await updateOwnUser(userId, input)));
}
