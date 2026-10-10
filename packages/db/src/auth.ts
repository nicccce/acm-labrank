import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb } from './client';
import { authRateLimits, sessions, users } from './schema';

export async function findUser(username: string) {
  return (await getDb().select().from(users).where(eq(users.username, username)).limit(1))[0];
}
export async function createUser(input: { username: string; realName: string | null; passwordHash: string }) {
  return (await getDb().insert(users).values(input).returning())[0]!;
}
export async function createSession(userId: string, tokenHash: string, expiresAt: Date, expectedPasswordHash?: string) {
  return getDb().transaction(async tx => {
    const user = (await tx.select().from(users).where(eq(users.id, userId)).for('update'))[0];
    if (!user?.active || user.deletedAt || (expectedPasswordHash !== undefined && user.passwordHash !== expectedPasswordHash)) return null;
    await tx.insert(sessions).values({ userId, tokenHash, expiresAt });
    return user;
  });
}
export async function replacePasswordAndSession(input: { userId: string; sessionId: string; expectedPasswordHash: string; passwordHash: string; tokenHash: string; expiresAt: Date }) {
  return getDb().transaction(async tx => {
    const user = (await tx.select().from(users).where(eq(users.id, input.userId)).for('update'))[0];
    if (!user?.active || user.deletedAt || user.passwordHash !== input.expectedPasswordHash) return null;
    const session = (await tx.select().from(sessions).where(and(eq(sessions.id, input.sessionId), eq(sessions.userId, input.userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()))).for('update'))[0];
    if (!session) return null;
    const updated = (await tx.update(users).set({ passwordHash: input.passwordHash, mustChangePassword: false }).where(eq(users.id, input.userId)).returning())[0]!;
    await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, input.userId), isNull(sessions.revokedAt)));
    await tx.insert(sessions).values({ userId: input.userId, tokenHash: input.tokenHash, expiresAt: input.expiresAt });
    await tx.execute(sql`INSERT INTO user_management_events(actor_id,user_id,action,details) VALUES (${input.userId},${input.userId},'password_changed','{}'::jsonb)`);
    return updated;
  });
}
export async function findSession(tokenHash: string, now: Date) {
  const rows = await getDb().select({
    sessionId: sessions.id,
    expiresAt: sessions.expiresAt,
    id: users.id,
    username: users.username,
    realName: users.realName,
    role: users.role,
    isStarred: users.isStarred,
    mustChangePassword: users.mustChangePassword,
    verifiedCfHandle: sql<string | null>`(SELECT a.handle FROM platform_bindings b JOIN platform_accounts a ON a.id=b.account_id WHERE b.user_id=${users.id} AND b.platform='codeforces')`,
  }).from(sessions).innerJoin(users, eq(users.id, sessions.userId)).where(and(
    eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now), eq(users.active, true), isNull(users.deletedAt),
  )).limit(1);
  return rows[0] ?? null;
}
export async function revokeSession(tokenHash: string, now: Date) {
  await getDb().update(sessions).set({ revokedAt: now }).where(eq(sessions.tokenHash, tokenHash));
}
export async function consumeAuthLimit(key: string, maximum: number) {
  const rows = await getDb().insert(authRateLimits).values({
    key, attempts: 1, resetAt: new Date(Date.now() + 15 * 60 * 1000),
  }).onConflictDoUpdate({
    target: authRateLimits.key,
    set: {
      attempts: sql`CASE WHEN ${authRateLimits.resetAt} <= now() THEN 1 ELSE ${authRateLimits.attempts} + 1 END`,
      resetAt: sql`CASE WHEN ${authRateLimits.resetAt} <= now() THEN now() + interval '15 minutes' ELSE ${authRateLimits.resetAt} END`,
    },
  }).returning();
  const limit = rows[0]!;
  return { allowed: limit.attempts <= maximum, retryAt: limit.resetAt };
}
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && error.code === '23505') return true;
  return 'cause' in error && isUniqueViolation(error.cause);
}
export async function bootstrapFirstAdmin(loadCredentials: () => Promise<{ username: string; passwordHash: string }>) {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(73192402)`);
    const existing = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).limit(1);
    if (existing.length) return false;
    const credentials = await loadCredentials();
    await tx.insert(users).values({ ...credentials, role: 'admin' });
    return true;
  });
}
