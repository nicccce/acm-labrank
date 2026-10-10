import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeDb, getPool, checkDatabaseReady, initializeCollectionSettings, initializeSiteSettings, initializePlatformPolicies, createBoss } from '@acm/db/server';
import { inspectMigrations, migrateSchema, MIGRATION_LOCK } from '../packages/db/src/schema-migrations';
import { hashPassword, login, getSession } from '../packages/core/src/application/auth';

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error('DATABASE_URL required');
const database = `acm_upgrade_verify_${randomUUID().replaceAll('-', '')}`;
assert.match(database, /^acm_upgrade_verify_[a-f0-9]{32}$/);
const folder = resolve('packages/db/drizzle');
const stage = await mkdtemp(join(tmpdir(), 'acm-upgrade-'));
const previous = join(stage, 'previous'), broken = join(stage, 'broken');
const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string; idx: number; when: number }[] };
assert.equal(journal.entries.at(-1)?.tag, '0013_mean_vanisher');
const checks: string[] = [];
let passed = false;
const safetyCode = (code: string) => (error: unknown) => (error as { code: string }).code === code;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
async function prepare(target: string, count: number) {
  await mkdir(join(target, 'meta'), { recursive: true });
  await writeFile(join(target, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }));
  for (const entry of journal.entries.slice(0, count)) await copyFile(join(folder, `${entry.tag}.sql`), join(target, `${entry.tag}.sql`));
}
function runMigration(check = false, requirePaused = false) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'packages/db/src/migrate.ts', ...(check ? ['--check'] : []), ...(requirePaused ? ['--require-paused'] : [])], { env: process.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `Isolated migration failed: ${result.stderr}`);
  const events = result.stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  return events;
}
try {
  await getPool().query(`CREATE DATABASE "${database}"`); await closeDb();
  const target = new URL(baseUrl); target.pathname = `/${database}`; process.env.DATABASE_URL = target.href;
  const pool = getPool();
  await prepare(previous, 13); await prepare(broken, 14);
  await migrateSchema(previous);
  await initializeCollectionSettings(); await initializeSiteSettings(); await initializePlatformPolicies();
  await pool.query('INSERT INTO collection_control(id,enabled,version) VALUES (1,false,6)');
  const boss = createBoss(true); await boss.start(); await boss.stop();

  // Deliberately use customized old values, including an already banned user.
  // Hashes and encrypted-session fixtures are compared without logging them.
  const password = 'existing-password-24';
  const passwordHash = await hashPassword(password);
  const users = (await pool.query<{ id: string }>(`INSERT INTO users(username,real_name,password_hash,role,active,created_at)
    VALUES ('upgrade_admin','原管理员',$1,'admin',true,'2026-09-01'),
      ('upgrade_member','原成员',$1,'member',true,'2026-09-02'),
      ('upgrade_banned','原封禁用户',$1,'member',false,'2026-09-03') RETURNING id`, [passwordHash])).rows.map(row => row.id);
  const [admin, member, banned] = users as [string, string, string];
  const token = 'x'.repeat(43);
  await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 day')", [member, createHash('sha256').update(token).digest('hex')]);
  const account = (await pool.query("INSERT INTO platform_accounts(platform,handle,external_id,identity_key) VALUES ('codeforces','fixture_member','123456','id:123456') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO platform_account_aliases(platform,key,account_id) VALUES ('codeforces','handle:fixture_member',$1)", [account]);
  const binding = (await pool.query("INSERT INTO platform_bindings(user_id,platform,account_id,candidate_state,verified_at,version,sync_requested) VALUES ($1,'codeforces',$2,'verified',now(),7,true) RETURNING id", [member, account])).rows[0].id;
  await pool.query("INSERT INTO sync_cursors(account_id,mode,checkpoint,version,initialized_at,history_complete,coverage) VALUES ($1,'incremental','{\"submissionId\":\"old-ac\"}',9,now(),true,'complete')", [account]);
  await pool.query("INSERT INTO sync_runs(binding_id,binding_version,account_id,kind,scope,mode,status,queue,scan_checkpoint) VALUES ($1,7,$2,'sync','incremental','incremental','completed','platform.codeforces.personal','{\"page\":3}')", [binding, account]);
  const problem = (await pool.query("INSERT INTO problems(platform,problem_key,title,native_difficulty,source_url,difficulty_updated_at,observed_at) VALUES ('codeforces','100A','Old problem',1600,'https://codeforces.com/problemset/problem/100/A',now(),now()) RETURNING id")).rows[0].id;
  const submission = (await pool.query("INSERT INTO submissions(platform,external_submission_id,problem_id,submitted_at,verdict,subject_evidence,parser_version,observed_at) VALUES ('codeforces','old-ac',$1,'2026-09-02','accepted','{\"participantType\":\"PRACTICE\"}','fixture-v1',now()) RETURNING id", [problem])).rows[0].id;
  await pool.query("INSERT INTO submission_attributions(submission_id,user_id,account_id,method) VALUES ($1,$2,$3,'personal')", [submission, member, account]);
  const team = (await pool.query("INSERT INTO teams(name,roster_key,version,created_at) VALUES ('原队伍',$1,8,'2026-09-01') RETURNING id", [[admin, member].sort().join(',')])).rows[0].id;
  await pool.query('INSERT INTO team_memberships(team_id,user_id) VALUES ($1,$2),($1,$3)', [team, admin, member]);
  await pool.query("INSERT INTO team_events(team_id,actor_id,action,details) VALUES ($1,$2,'create','{\"existing\":true}')", [team, admin]);
  await pool.query("INSERT INTO connector_sessions(id,platform,encrypted_session) VALUES ('fixture-qoj','qoj','encrypted-fixture-preserve-byte-for-byte')");
  await pool.query("INSERT INTO platform_connections(id,platform,state,generation,cookie_revision) VALUES ('fixture-qoj','qoj','ready',4,6)");
  await pool.query("UPDATE site_settings SET header_text='原页眉',login_text='原登录说明',version=11 WHERE id=1");
  await pool.query("UPDATE collection_settings SET auto_sync_enabled=true,version=10,platforms=ARRAY['codeforces','qoj'] WHERE id=1");
  await pool.query("UPDATE platform_request_policies SET min_interval_ms=7000,max_interval_ms=9000,version=8 WHERE platform='qoj'");
  await pool.query("UPDATE scoring_settings SET rules=jsonb_set(rules,'{qoj,points}','19'),version=12,updated_by=$1 WHERE id=1", [admin]);

  const columns = (await pool.query<{ table_name: string; column_name: string }>("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
  const tables = [...new Set(columns.map(row => row.table_name))];
  async function snapshot() {
    const result: Record<string, { count: number; hash: string }> = {};
    for (const table of tables) {
      const names = columns.filter(column => column.table_name === table).map(column => quote(column.column_name)).join(',');
      const rows = (await pool.query(`SELECT count(*)::int AS count,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS data FROM (SELECT ${names} FROM ${quote(table)}) t`)).rows[0];
      result[table] = { count: rows.count, hash: createHash('sha256').update(rows.data).digest('hex') };
    }
    return result;
  }
  const before = await snapshot();
  const plan = runMigration(true, true).find(event => event.event === 'migration_plan');
  assert.deepEqual(plan.pending, ['0013_mean_vanisher']); assert.equal(plan.applied, 13);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await pool.query("SELECT to_regclass('public.user_management_events') AS table")).rows[0].table, null);
  checks.push('old version preflight is read-only and schedules exactly one incremental migration');
  await pool.query('UPDATE collection_control SET enabled=true WHERE id=1');
  const notPaused = spawnSync(process.execPath, ['--import', 'tsx', 'packages/db/src/migrate.ts', '--check', '--require-paused'], { env: process.env, encoding: 'utf8' });
  assert.equal(notPaused.status, 1); assert.ok(notPaused.stderr.includes('PAUSE_COLLECTION_AND_DRAIN_TASKS'));
  await pool.query('UPDATE collection_control SET enabled=false WHERE id=1');
  assert.deepEqual(await snapshot(), before);
  checks.push('deployment preflight requires collection pause without changing the previous settings');

  await writeFile(join(broken, '0013_mean_vanisher.sql'), (await readFile(join(broken, '0013_mean_vanisher.sql'), 'utf8')) + '\n--> statement-breakpoint\nSELECT 1 / 0;');
  await assert.rejects(migrateSchema(broken));
  assert.equal((await pool.query("SELECT to_regclass('public.user_management_events') AS table")).rows[0].table, null);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='is_starred'")).rows[0].n, 0);
  assert.equal((await inspectMigrations()).applied, 13); assert.deepEqual(await snapshot(), before);
  checks.push('DDL failure rolls back added columns, audit table, ledger and preserves all original data');

  const blocker = await pool.connect();
  try {
    await blocker.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await assert.rejects(migrateSchema(), safetyCode('MIGRATION_ALREADY_RUNNING'));
  } finally { await blocker.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]); blocker.release(); }
  runMigration();
  assert.equal(await checkDatabaseReady(), true); assert.deepEqual(await snapshot(), before);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE is_starred=false AND deleted_at IS NULL AND must_change_password=false')).rows[0].n, 3);
  assert.equal((await pool.query('SELECT is_starred FROM teams WHERE id=$1', [team])).rows[0].is_starred, false);
  assert.equal((await pool.query('SELECT active FROM users WHERE id=$1', [banned])).rows[0].active, false);
  checks.push('13 to 14 migration preserves every old column of every public table; old and new rows receive correct defaults');

  await pool.query('UPDATE users SET is_starred=true,must_change_password=true,deleted_at=now() WHERE id=$1', [banned]);
  await pool.query('UPDATE teams SET is_starred=true WHERE id=$1', [team]);
  await pool.query("INSERT INTO user_management_events(actor_id,user_id,action,details) VALUES ($1,$2,'star_changed','{\"isStarred\":true}')", [admin, member]);
  const afterChange = await pool.query('SELECT is_starred,must_change_password,deleted_at FROM users WHERE id=$1', [banned]);
  const replay = runMigration().find(event => event.event === 'migrations_complete');
  assert.equal(replay.appliedNow, 0); assert.deepEqual(await snapshot(), before);
  assert.deepEqual((await pool.query('SELECT is_starred,must_change_password,deleted_at FROM users WHERE id=$1', [banned])).rows, afterChange.rows);
  assert.equal((await pool.query('SELECT is_starred FROM teams WHERE id=$1', [team])).rows[0].is_starred, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_management_events')).rows[0].n, 1);
  const newUser = (await pool.query("INSERT INTO users(username,password_hash) VALUES ('upgrade_new',$1) RETURNING is_starred,must_change_password,deleted_at", [passwordHash])).rows[0];
  assert.deepEqual(newUser, { is_starred: false, must_change_password: false, deleted_at: null });
  assert.equal((await pool.query("INSERT INTO teams(name,roster_key) VALUES ('新增队伍',$1) RETURNING is_starred", [[admin,banned].sort().join(',')])).rows[0].is_starred, false);
  checks.push('repeated upgrades keep newly edited flags, deletion timestamps and audit history; defaults only apply to missing/new values');

  const oldSession = await getSession(token); assert.equal(oldSession?.user.id, member); assert.equal(oldSession?.user.mustChangePassword, false);
  const session = await login({ username: 'upgrade_member', password }); assert.equal(session.user.id, member); assert.equal(session.user.mustChangePassword, false);
  await assert.rejects(login({ username: 'upgrade_banned', password }));
  checks.push('original password and existing session still work; previously banned users stay banned');

  await assert.rejects(migrateSchema(previous), safetyCode('DATABASE_NEWER_THAN_CODE'));
  const row = (await pool.query('SELECT id,hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1')).rows[0];
  await pool.query("UPDATE drizzle.__drizzle_migrations SET hash='changed-history' WHERE id=$1", [row.id]);
  await assert.rejects(inspectMigrations(), safetyCode('MIGRATION_HISTORY_MISMATCH'));
  await pool.query('UPDATE drizzle.__drizzle_migrations SET hash=$2 WHERE id=$1', [row.id, row.hash]);
  const first = (await pool.query('SELECT id,hash FROM drizzle.__drizzle_migrations ORDER BY created_at LIMIT 1')).rows[0];
  const lf = (await readFile(join(folder, '0000_initial.sql'), 'utf8')).replaceAll('\r\n', '\n');
  await pool.query('UPDATE drizzle.__drizzle_migrations SET hash=$2 WHERE id=$1', [first.id, createHash('sha256').update(lf).digest('hex')]);
  assert.equal((await inspectMigrations()).pending.length, 0);
  await pool.query('UPDATE drizzle.__drizzle_migrations SET hash=$2 WHERE id=$1', [first.id, first.hash]);
  checks.push('downgrades and modified migration history are rejected; LF/CRLF checkout differences remain compatible');
  passed = true;
  console.log(JSON.stringify({ event: 'upgrade_verification_passed', checks }));
} catch (error) {
  console.error(JSON.stringify({ event: 'upgrade_verification_failed', database })); throw error;
} finally {
  await closeDb(); process.env.DATABASE_URL = baseUrl;
  if (passed) await getPool().query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await closeDb();
  assert.ok(stage.startsWith(join(tmpdir(), 'acm-upgrade-'))); await rm(stage, { recursive: true, force: true });
}
