import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';
import { z } from 'zod';
import { consumeAuthLimit, createSession, createUser, findSession, findUser, isUniqueViolation, revokeSession, replacePasswordAndSession } from '@acm/db/server';
import { displayName } from '../domain/index';
import { AppError } from './errors';

export const credentialsSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/, '用户名需为 3—32 位字母、数字或下划线'),
  password: z.string().min(12, '密码至少 12 位').max(128, '密码最多 128 位'),
});
const registerSchema = credentialsSchema.extend({ realName: z.string().trim().max(64).optional() });
const hashOptions = { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
let dummyHash: Promise<string> | undefined;
export const hashPassword = (password: string) => hash(password, hashOptions);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const csrfTokenForSession = (token: string) => digest(token + ':csrf');

export function validateCsrf(token: string, submitted: string | null): boolean {
  if (!submitted || !/^[a-f0-9]{64}$/.test(submitted)) return false;
  return timingSafeEqual(Buffer.from(csrfTokenForSession(token), 'hex'), Buffer.from(submitted, 'hex'));
}
export async function checkAuthLimit(action: 'login' | 'register', username: string) {
  for (const [key, maximum] of [
    [action + ':global', action === 'register' ? 60 : 300],
    [action + ':' + digest(username), action === 'register' ? 5 : 10],
  ] as const) {
    const result = await consumeAuthLimit(key, maximum);
    if (!result.allowed) throw new AppError('RATE_LIMITED', '尝试次数过多，请稍后再试', 429, result.retryAt.toISOString());
  }
}
export async function login(input: unknown) {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', parsed.error.issues[0]?.message ?? '输入错误', 400);
  await checkAuthLimit('login', parsed.data.username);
  const user = await findUser(parsed.data.username);
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  const valid = await verify(user?.passwordHash ?? await dummyHash, parsed.data.password);
  if (!valid || !user?.active || user.deletedAt) throw new AppError('INVALID_CREDENTIALS', '用户名或密码错误', 401);
  return issueSession(user);
}
export async function register(input: unknown) {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', parsed.error.issues[0]?.message ?? '输入错误', 400);
  await checkAuthLimit('register', parsed.data.username);
  const passwordHash = await hashPassword(parsed.data.password);
  try {
    const user = await createUser({ username: parsed.data.username, realName: parsed.data.realName || null, passwordHash });
    return await issueSession(user);
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError('USERNAME_TAKEN', '用户名已被使用', 409);
    throw error;
  }
}
function userDto(user: { id: string; username: string; realName: string | null; role: 'admin' | 'member'; isStarred?: boolean; mustChangePassword?: boolean; verifiedCfHandle?: string | null }) {
  return { id: user.id, username: user.username, realName: user.realName, displayName: displayName(user), role: user.role, isStarred: user.isStarred ?? false, mustChangePassword: user.mustChangePassword ?? false };
}
async function issueSession(user: Parameters<typeof userDto>[0] & { passwordHash: string }) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const current = await createSession(user.id, digest(token), expiresAt, user.passwordHash);
  if (!current) throw new AppError('INVALID_CREDENTIALS', '账号或密码已变化，请重新登录', 401);
  return { user: userDto(current), token, expiresAt, csrfToken: csrfTokenForSession(token) };
}
export const changePasswordSchema = z.object({ currentPassword: credentialsSchema.shape.password, newPassword: credentialsSchema.shape.password }).strict().refine(v => v.currentPassword !== v.newPassword, '新密码不能与当前密码相同');
export async function changePassword(session: NonNullable<Awaited<ReturnType<typeof getSession>>>, input: unknown) {
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', parsed.error.issues[0]?.message ?? '密码不合法', 400);
  await checkAuthLimit('login', session.user.username);
  const current = await findUser(session.user.username);
  if (!current?.active || current.deletedAt || !await verify(current.passwordHash, parsed.data.currentPassword)) throw new AppError('INVALID_CREDENTIALS', '当前密码错误或账号已停用', 401);
  const token = randomBytes(32).toString('base64url'), expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const user = await replacePasswordAndSession({ userId: current.id, sessionId: session.sessionId, expectedPasswordHash: current.passwordHash, passwordHash: await hashPassword(parsed.data.newPassword), tokenHash: digest(token), expiresAt });
  if (!user) throw new AppError('UNAUTHENTICATED', '会话或密码已变化，请重新登录', 401);
  return { user: userDto(user), token, expiresAt, csrfToken: csrfTokenForSession(token) };
}
export async function getSession(token: string | undefined) {
  if (!token || !/^[\w-]{43}$/.test(token)) return null;
  const session = await findSession(digest(token), new Date());
  return session ? { sessionId: session.sessionId, user: userDto(session), expiresAt: session.expiresAt, csrfToken: csrfTokenForSession(token) } : null;
}
export async function logout(token: string) { await revokeSession(digest(token), new Date()); }
