import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  username: text('username').notNull(),
  realName: text('real_name'),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<'admin' | 'member'>().default('member').notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('users_username_unique').on(table.username),
  check('users_role_check', sql`${table.role} IN ('admin', 'member')`),
  check('users_username_check', sql`${table.username} ~ '^[a-z0-9_]{3,32}$'`),
]);

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex('sessions_token_hash_unique').on(table.tokenHash), index('sessions_user_id_idx').on(table.userId), index('sessions_expires_at_idx').on(table.expiresAt)]);

export const authRateLimits = pgTable('auth_rate_limits', {
  key: text('key').primaryKey(),
  attempts: integer('attempts').notNull(),
  resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
});

export const runtimeHeartbeats = pgTable('runtime_heartbeats', {
  instanceId: text('instance_id').primaryKey(),
  service: text('service').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const platformRequestLimits = pgTable('platform_request_limits', {
  platform: text('platform').primaryKey(),
  nextRequestAt: timestamp('next_request_at', { withTimezone: true }).defaultNow().notNull(),
  blockedUntil: timestamp('blocked_until', { withTimezone: true }).defaultNow().notNull(),
  leaseToken: text('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
}, (table) => [check('platform_request_lease_pair', sql`(${table.leaseToken} IS NULL) = (${table.leaseExpiresAt} IS NULL)`)]);

export const connectorSessions = pgTable('connector_sessions', {
  id: text('id').primaryKey(),
  platform: text('platform').notNull(),
  encryptedSession: text('encrypted_session').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
