import { beforeEach, expect, it, vi } from 'vitest';
import { getSession, validateCsrf } from '@acm/core/server';
import { requireAdmin, requireSession } from './http';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'token' }) }) }));
vi.mock('@acm/core/server', async () => ({ AppError: (await import('../../../../packages/core/src/application/errors')).AppError, getConfig: () => ({ APP_URL: 'http://localhost:3000' }), getSession: vi.fn(), validateCsrf: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(validateCsrf).mockReturnValue(true); });
function session(role: 'member' | 'admin', mustChangePassword: boolean) {
  return { user: { id: 'user', role, mustChangePassword }, csrfToken: 'csrf' } as NonNullable<Awaited<ReturnType<typeof getSession>>>;
}
it('blocks even an administrator until the temporary password is changed', async () => {
  vi.mocked(getSession).mockResolvedValue(session('admin', true));
  await expect(requireSession()).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED', status: 403 });
  await expect(requireAdmin()).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
  expect((await requireSession(undefined, true)).session.user.mustChangePassword).toBe(true);
});
it('checks CSRF on the password-change exception and rejects ordinary users as admins', async () => {
  vi.mocked(getSession).mockResolvedValue(session('member', true)); vi.mocked(validateCsrf).mockReturnValue(false);
  await expect(requireSession(new Request('http://localhost:3000/api/me/password'), true)).rejects.toMatchObject({ code: 'INVALID_CSRF' });
  vi.mocked(getSession).mockResolvedValue(session('member', false));
  await expect(requireAdmin()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(requireAdmin(new Request('http://localhost:3000/api/admin/users', { headers: { origin: 'https://other.example' } }))).rejects.toMatchObject({ code: 'INVALID_ORIGIN' });
});
