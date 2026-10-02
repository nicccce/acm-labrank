import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
  leaseIntervalMs: integer('lease_interval_ms').default(0).notNull(),
}, (table) => [check('platform_request_lease_pair', sql`(${table.leaseToken} IS NULL) = (${table.leaseExpiresAt} IS NULL)`)]);

export const connectorSessions = pgTable('connector_sessions', {
  id: text('id').primaryKey(),
  platform: text('platform').notNull(),
  encryptedSession: text('encrypted_session').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const platformRequestPolicies = pgTable('platform_request_policies', {
  platform: text('platform').primaryKey(),
  minIntervalMs: integer('min_interval_ms').notNull(),
  maxIntervalMs: integer('max_interval_ms').notNull(),
  version: integer('version').default(1).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
}, table => [check('platform_policy_intervals', sql`${table.platform} IN ('codeforces','luogu','qoj') AND ${table.minIntervalMs} >= CASE WHEN ${table.platform} = 'codeforces' THEN 2000 ELSE 1000 END AND ${table.maxIntervalMs} >= ${table.minIntervalMs} AND ${table.maxIntervalMs} <= 60000 AND ${table.version} > 0`)]);

export const platformConnections = pgTable('platform_connections', {
  id: text('id').primaryKey(),
  platform: text('platform').notNull(),
  state: text('state').default('unknown').notNull(),
  generation: integer('generation').default(0).notNull(),
  cookieRevision: integer('cookie_revision').default(0).notNull(),
  collector: text('collector'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  taskToken: text('task_token'),
  taskExpiresAt: timestamp('task_expires_at', { withTimezone: true }),
}, table => [check('platform_connection_state', sql`${table.platform} IN ('luogu','qoj') AND ${table.state} IN ('unknown','ready','auth_required','human_input_required') AND ${table.generation} >= 0 AND (${table.taskToken} IS NULL) = (${table.taskExpiresAt} IS NULL)`)]);

export const platformReadRuns = pgTable('platform_read_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  platform: text('platform').notNull(),
  connectionId: text('connection_id'),
  requestKey: text('request_key').notNull(),
  input: jsonb('input').notNull(),
  jobId: uuid('job_id'),
  queue: text('queue'),
  status: text('status').default('queued').notNull(),
  progress: jsonb('progress').default({}).notNull(),
  continuation: jsonb('continuation').default({}).notNull(),
  result: jsonb('result'),
  error: jsonb('error'),
  recoveryState: text('recovery_state').default('none').notNull(),
  connectionGeneration: integer('connection_generation'),
  recoveryGeneration: integer('recovery_generation'),
  retryOf: uuid('retry_of'),
  resolvedBy: uuid('resolved_by'),
  requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, table => [
  index('platform_runs_history_idx').on(table.createdAt, table.id),
  index('platform_runs_recovery_idx').on(table.connectionId, table.recoveryState),
  uniqueIndex('platform_runs_active_request_idx').on(table.requestKey).where(sql`${table.status} IN ('queued','running')`),
  check('platform_run_values', sql`${table.platform} IN ('codeforces','luogu','qoj') AND ${table.status} IN ('queued','running','completed','auth_required','human_input_required','restricted','parse_changed','timeout','cancelled','failed') AND ${table.recoveryState} IN ('none','waiting','requeued','resolved')`),
]);

export const collectionAuditLogs = pgTable('collection_audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  target: text('target').notNull(),
  details: jsonb('details').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
