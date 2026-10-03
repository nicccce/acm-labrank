import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, doublePrecision, foreignKey } from 'drizzle-orm/pg-core';

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

export const teams = pgTable('teams', {
  id: uuid('id').defaultRandom().primaryKey(), name: text('name').notNull(),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  rosterKey: text('roster_key').notNull(), version: integer('version').default(1).notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [uniqueIndex('team_active_roster').on(t.rosterKey).where(sql`${t.archivedAt} IS NULL`), check('team_values', sql`length(btrim(${t.name})) BETWEEN 1 AND 64 AND ${t.version}>0`)]);
export const teamMemberships = pgTable('team_memberships', {
  id: uuid('id').defaultRandom().primaryKey(), teamId: uuid('team_id').notNull().references(() => teams.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  leftAt: timestamp('left_at', { withTimezone: true }),
}, t => [uniqueIndex('team_current_member').on(t.teamId, t.userId).where(sql`${t.leftAt} IS NULL`), index('team_member_user').on(t.userId, t.teamId), check('membership_interval', sql`${t.leftAt} IS NULL OR ${t.leftAt}>=${t.joinedAt}`)]);
export const teamEvents = pgTable('team_events', {
  id: uuid('id').defaultRandom().primaryKey(), teamId: uuid('team_id').notNull().references(() => teams.id),
  actorId: uuid('actor_id').notNull().references(() => users.id), action: text('action').notNull(),
  details: jsonb('details').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

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
  readingVerifiedAt: timestamp('reading_verified_at', { withTimezone: true }),
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

export const collectionControl = pgTable('collection_control', {
  id: integer('id').primaryKey(), enabled: boolean('enabled').default(false).notNull(),
  version: integer('version').default(1).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [check('collection_control_singleton', sql`${t.id}=1`)]);

export const collectionSettings = pgTable('collection_settings', {
  id: integer('id').primaryKey(), platforms: text('platforms').array().default(['codeforces']).notNull(),
  autoSyncEnabled: boolean('auto_sync_enabled').default(false).notNull(), syncIntervalMinutes: integer('sync_interval_minutes').default(360).notNull(),
  scoreRange: jsonb('score_range').default({ kind: 'rolling', days: 30 }).notNull(), version: integer('version').default(1).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(), updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [check('collection_settings_values', sql`${t.id}=1 AND ${t.version}>0 AND ${t.syncIntervalMinutes} BETWEEN 1 AND 10080 AND ${t.platforms}<@ARRAY['codeforces','luogu','qoj']::text[]`)]);
export const collectionPlatformState = pgTable('collection_platform_state', {
  platform: text('platform').primaryKey(), generation: integer('generation').default(1).notNull(),
}, t => [check('collection_platform_values', sql`${t.platform} IN ('codeforces','luogu','qoj') AND ${t.generation}>0`)]);
export const collectionResetRequests = pgTable('collection_reset_requests', {
  id: uuid('id').primaryKey(), actorId: uuid('actor_id').notNull().references(() => users.id),
  input: jsonb('input').notNull(), result: jsonb('result').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const platformLoginAttempts = pgTable('platform_login_attempts', {
  id: uuid('id').primaryKey(), sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id').notNull().references(() => platformConnections.id), generation: integer('generation').notNull(),
  state: text('state').notNull(), version: integer('version').default(1).notNull(), encryptedContext: text('encrypted_context'),
  image: text('image'), contentType: text('content_type'), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, t => [check('login_attempt_state', sql`${t.state} IN ('processing','awaiting_input','succeeded','failed','cancelled','expired')`), index('login_attempt_expiry').on(t.expiresAt)]);

export const platformAccounts = pgTable('platform_accounts', {
  id: uuid('id').defaultRandom().primaryKey(), platform: text('platform').notNull(), kind: text('kind').default('person').notNull(),
  externalId: text('external_id'), handle: text('handle').notNull(), identityKey: text('identity_key').notNull(),
}, t => [uniqueIndex('platform_account_identity').on(t.platform, t.identityKey), uniqueIndex('platform_account_id_platform').on(t.id, t.platform), uniqueIndex('platform_account_external').on(t.platform, t.externalId).where(sql`${t.externalId} IS NOT NULL`), check('account_person_only', sql`${t.kind}='person'`)]);
export const platformAccountAliases = pgTable('platform_account_aliases', {
  id: uuid('id').defaultRandom().primaryKey(), platform: text('platform').notNull(), key: text('key').notNull(),
  accountId: uuid('account_id').notNull().references(() => platformAccounts.id),
}, t => [uniqueIndex('platform_alias_identity').on(t.platform, t.key), foreignKey({ columns: [t.accountId, t.platform], foreignColumns: [platformAccounts.id, platformAccounts.platform] })]);
export const platformBindings = pgTable('platform_bindings', {
  id: uuid('id').defaultRandom().primaryKey(), userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(), accountId: uuid('account_id').references(() => platformAccounts.id),
  candidate: text('candidate'), candidateState: text('candidate_state'), candidateError: text('candidate_error'),
  version: integer('version').default(1).notNull(), verifiedAt: timestamp('verified_at', { withTimezone: true }),
  nextSyncAt: timestamp('next_sync_at', { withTimezone: true }).defaultNow(), syncBlocked: text('sync_blocked'), syncRequested: boolean('sync_requested').default(false).notNull(),
}, t => [uniqueIndex('binding_user_platform').on(t.userId, t.platform), uniqueIndex('binding_account_owner').on(t.accountId).where(sql`${t.accountId} IS NOT NULL`), foreignKey({ columns: [t.accountId, t.platform], foreignColumns: [platformAccounts.id, platformAccounts.platform] }), check('binding_candidate_state', sql`${t.candidateState} IS NULL OR ${t.candidateState} IN ('pending','verified','not_found','occupied','unavailable','unsupported')`)]);
export const problems = pgTable('problems', {
  id: uuid('id').defaultRandom().primaryKey(), platform: text('platform').notNull(), problemKey: text('problem_key').notNull(),
  title: text('title').notNull(), nativeDifficulty: doublePrecision('native_difficulty'), sourceUrl: text('source_url').notNull(),
  difficultyUpdatedAt: timestamp('difficulty_updated_at', { withTimezone: true }).notNull(), observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
}, t => [uniqueIndex('problem_identity').on(t.platform, t.problemKey), uniqueIndex('problem_id_platform').on(t.id, t.platform)]);
export const submissions = pgTable('submissions', {
  id: uuid('id').defaultRandom().primaryKey(), platform: text('platform').notNull(), externalSubmissionId: text('external_submission_id').notNull(),
  problemId: uuid('problem_id').references(() => problems.id), submittedAt: timestamp('submitted_at', { withTimezone: true }),
  verdict: text('verdict').notNull(), nativeScore: doublePrecision('native_score'), nativeResult: text('native_result'),
  sourceUrl: text('source_url'), subjectEvidence: jsonb('subject_evidence').notNull(), parserVersion: text('parser_version').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
}, t => [uniqueIndex('submission_identity').on(t.platform, t.externalSubmissionId), foreignKey({ columns: [t.problemId, t.platform], foreignColumns: [problems.id, problems.platform] }), index('submission_ac_time').on(t.problemId, t.submittedAt).where(sql`${t.verdict}='accepted'`), check('submission_verdict', sql`${t.verdict} IN ('accepted','rejected','pending','unknown')`)]);
export const submissionAttributions = pgTable('submission_attributions', {
  submissionId: uuid('submission_id').primaryKey().references(() => submissions.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id), accountId: uuid('account_id').references(() => platformAccounts.id),
  method: text('method').notNull(), ruleVersion: text('rule_version').default('personal-v1').notNull(),
}, t => [index('attribution_user').on(t.userId), check('attribution_person_pair', sql`(${t.userId} IS NULL)=(${t.accountId} IS NULL)`)]);
export const syncCursors = pgTable('sync_cursors', {
  id: uuid('id').defaultRandom().primaryKey(), accountId: uuid('account_id').notNull().references(() => platformAccounts.id),
  mode: text('mode').notNull(), cursor: jsonb('cursor'), checkpoint: jsonb('checkpoint'), version: integer('version').default(1).notNull(),
  initializedAt: timestamp('initialized_at', { withTimezone: true }),
  historyComplete: boolean('history_complete').default(false).notNull(), coverage: text('coverage').default('unknown').notNull(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
}, t => [uniqueIndex('sync_cursor_account_mode').on(t.accountId, t.mode), check('sync_cursor_mode', sql`${t.mode} IN ('backfill','incremental')`)]);
export const syncRuns = pgTable('sync_runs', {
  id: uuid('id').defaultRandom().primaryKey(), bindingId: uuid('binding_id').notNull().references(() => platformBindings.id),
  bindingVersion: integer('binding_version').notNull(), accountId: uuid('account_id').references(() => platformAccounts.id),
  scope: text('scope').default('range').notNull(), initialFrom: timestamp('initial_from', { withTimezone: true }),
  kind: text('kind').notNull(), mode: text('mode').default('backfill').notNull(), status: text('status').default('queued').notNull(),
  batch: integer('batch').default(0).notNull(), jobId: uuid('job_id'), queue: text('queue').notNull(),
  pages: integer('pages').default(0).notNull(), records: integer('records').default(0).notNull(), retries: integer('retries').default(0).notNull(),
  error: jsonb('error'), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }), collectionGeneration: integer('collection_generation').default(1).notNull(),
  source: text('source').default('binding').notNull(), requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
  rangeFrom: timestamp('range_from', { withTimezone: true }), rangeTo: timestamp('range_to', { withTimezone: true }),
  scanCursor: jsonb('scan_cursor'), scanCheckpoint: jsonb('scan_checkpoint'), cursorVersion: integer('cursor_version').default(1).notNull(),
  stopReason: text('stop_reason').default('more').notNull(), rangeComplete: boolean('range_complete').default(false).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, t => [uniqueIndex('active_sync_target_kind').on(t.bindingId, t.kind, t.mode).where(sql`${t.status} IN ('queued','running')`), check('sync_run_scope', sql`${t.scope} IN ('initial','incremental','range')`), check('sync_initial_from', sql`(${t.scope}='initial')=(${t.initialFrom} IS NOT NULL)`), check('sync_run_range', sql`(${t.rangeFrom} IS NULL AND ${t.rangeTo} IS NULL) OR (${t.rangeFrom} IS NOT NULL AND ${t.rangeTo} IS NOT NULL AND ${t.rangeFrom}<${t.rangeTo} AND ${t.rangeTo}-${t.rangeFrom}<=interval '366 days')`), check('sync_run_kind', sql`${t.kind} IN ('verify','sync')`), check('sync_run_status', sql`${t.status} IN ('queued','running','completed','paused','failed','cancelled')`)]);
