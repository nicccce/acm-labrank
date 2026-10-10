import { describe, expect, it } from 'vitest';
import { managementListSchema, starSchema, userPatchSchema } from './user-management';
import { changePasswordSchema } from './auth';

describe('user management input boundaries', () => {
  it('requires explicit booleans and rejects role/password injection', () => {
    expect(starSchema.safeParse({ isStarred: 'false' }).success).toBe(false);
    expect(starSchema.safeParse({ isStarred: false }).success).toBe(true);
    for (const input of [{}, { role: 'admin' }, { passwordHash: 'injected' }, { deletedAt: null }, { active: 'false' }]) expect(userPatchSchema.safeParse(input).success).toBe(false);
    expect(userPatchSchema.parse({ realName: '  姓名  ', active: false })).toEqual({ realName: '姓名', active: false });
  });
  it('bounds searches and pagination', () => {
    expect(managementListSchema.parse({})).toMatchObject({ status: 'active', starred: 'all', page: 1, limit: 20 });
    for (const input of [{ status: 'unknown' }, { page: 0 }, { limit: 101 }, { q: 'x'.repeat(65) }]) expect(managementListSchema.safeParse(input).success).toBe(false);
  });
  it('does not accept reuse of a temporary password or unexpected fields', () => {
    expect(changePasswordSchema.safeParse({ currentPassword: 'temporary_password', newPassword: 'temporary_password' }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: 'temporary_password', newPassword: 'short' }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: 'temporary_password', newPassword: 'different_password', userId: 'other' }).success).toBe(false);
  });
});
