import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeDb, getPool, createBoss, createSession, listSyncTargets, mutateManagedUser, queryLeaderboard, queryMemberRank, queryTeamLeaderboard, queryTeamScore, type QueryRange } from '@acm/db/server';
import { hashPassword, login, getSession, changePassword, register } from '../packages/core/src/application/auth';
import { deleteManagedUser, getManagedUsers, patchManagedUser, resetManagedUserPassword, restoreManagedUser, setOwnUserStar } from '../packages/core/src/application/user-management';
import { createTeam, getTeamProfile, getMembers, setTeamStar } from '../packages/core/src/application/teams';
import { getMemberProfile } from '../packages/core/src/application/members/profile';
import { checkDatabaseReady } from '../packages/db/src/health';

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error('DATABASE_URL required');
const database = `acm_user_verify_${randomUUID().replaceAll('-', '')}`;
assert.match(database, /^acm_user_verify_[a-f0-9]{32}$/);
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
let passed = false;
const checks: string[] = [];
try {
  await getPool().query(`CREATE DATABASE "${database}"`); await closeDb();
  const target = new URL(baseUrl); target.pathname = `/${database}`; process.env.DATABASE_URL = target.href;
  const migrate = spawnSync(process.execPath, ['--import', 'tsx', 'packages/db/src/migrate.ts'], { env: process.env, encoding: 'utf8' });
  if (migrate.status !== 0) throw new Error(`Isolated migration failed: ${migrate.stderr}`);
  assert.equal(await checkDatabaseReady(), true);
  const repeat = spawnSync(process.execPath, ['--import', 'tsx', 'packages/db/src/migrate.ts'], { env: process.env, encoding: 'utf8' });
  assert.equal(repeat.status, 0);
  const pool = getPool(), oldPassword = 'old_fixture_password_123', passwordHash = await hashPassword(oldPassword);
  const users = (await pool.query<{ id: string; username: string }>(`INSERT INTO users(username,real_name,password_hash,role)
    SELECT name,name,$1,CASE WHEN name LIKE 'admin%' THEN 'admin' ELSE 'member' END FROM unnest(ARRAY['admin_a','admin_b','alice','bob','charlie']) name RETURNING id,username`, [passwordHash])).rows;
  const id = (name: string) => users.find(u => u.username === name)!.id;
  const admin = id('admin_a'), otherAdmin = id('admin_b'), alice = id('alice'), bob = id('bob'), charlie = id('charlie');
  for (const [member, score] of [[alice, 100], [bob, 80], [charlie, 80]] as const) {
    const account = (await pool.query<{ id: string }>("INSERT INTO platform_accounts(platform,handle,identity_key) VALUES ('codeforces',$1,$1) RETURNING id", [member])).rows[0]!.id;
    const binding = (await pool.query<{ id: string }>("INSERT INTO platform_bindings(user_id,platform,account_id,verified_at) VALUES ($1,'codeforces',$2,now()) RETURNING id", [member, account])).rows[0]!.id;
    const problem = (await pool.query<{ id: string }>("INSERT INTO problems(platform,problem_key,title,native_difficulty,source_url,difficulty_updated_at,observed_at) VALUES ('codeforces',$1,$1,$2,'https://codeforces.com/contest/999/problem/A',now(),now()) RETURNING id", [member, score])).rows[0]!.id;
    const submission = randomUUID();
    await pool.query("INSERT INTO submissions(id,platform,external_submission_id,problem_id,submitted_at,verdict,subject_evidence,parser_version,observed_at) VALUES ($1::uuid,'codeforces',$1::text,$2,'2026-10-05T00:00:00Z','accepted','{}','fixture',now())", [submission, problem]);
    await pool.query("INSERT INTO submission_attributions(submission_id,user_id,account_id,method) VALUES ($1,$2,$3,'verified_person')", [submission, member, account]);
    if (member === alice) await pool.query("INSERT INTO sync_runs(binding_id,binding_version,account_id,kind,mode,status,queue) VALUES ($1,1,$2,'sync','incremental','queued','platform.codeforces.personal')", [binding, account]);
  }
  const q: QueryRange = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z'), platforms: ['codeforces'], limit: 100, offset: 0, pointsSql: 'p.native_difficulty' };
  const ab = (await createTeam(alice, { name: 'AB', memberIds: [alice, bob] })).id;
  const bc = (await createTeam(bob, { name: 'BC', memberIds: [bob, charlie] })).id;
  const ac = (await createTeam(charlie, { name: 'AC', memberIds: [alice, charlie] })).id;
  await setOwnUserStar(alice, { isStarred: true });
  const rows = await queryLeaderboard(q);
  assert.equal(rows[0]!.id, alice); assert.equal(rows[0]!.rank, null); assert.equal(rows[0]!.isStarred, true);
  assert.equal(rows.find(u => u.id === bob)!.rank, 1); assert.equal(rows.find(u => u.id === charlie)!.rank, 1);
  assert.equal(await queryMemberRank(alice, q), null);
  assert.equal((await queryLeaderboard({ ...q, limit: 1, offset: 2 }))[0]!.rank, 1);
  assert.equal((await queryTeamScore(ab, q)).points, 180);
  await setTeamStar(ab, bob, { isStarred: true, version: 1 });
  const teams = await queryTeamLeaderboard(q);
  assert.equal(teams.find(t => t.id === ab)!.rank, null);
  assert.equal(teams.find(t => t.id === ac)!.rank, 1);
  assert.equal(teams.find(t => t.id === bc)!.rank, 2);
  await assert.rejects(setTeamStar(ab, bob, { isStarred: false, version: 1 }), code('TEAM_STALE'));
  await assert.rejects(setTeamStar(ab, charlie, { isStarred: false, version: 2 }), code('TEAM_FORBIDDEN'));
  await assert.rejects(setTeamStar(ab, charlie, { isStarred: false, version: 2 }, true), code('TEAM_FORBIDDEN'));
  await setTeamStar(ab, admin, { isStarred: false, version: 2 }, true);
  for (const user of users) await pool.query('UPDATE users SET is_starred=true WHERE id=$1', [user.id]);
  assert.equal((await queryLeaderboard(q)).every(u => u.rank === null), true);
  assert.equal((await queryLeaderboard(q))[0]!.total, 5);
  await pool.query('UPDATE users SET is_starred=false');
  assert.equal(await queryMemberRank(alice, q), 1);
  checks.push('starred ranking, ties, pagination, all-star leaderboard, independent team totals and version/permission checks');

  await assert.rejects(patchManagedUser(alice, bob, { active: false }), code('USER_FORBIDDEN'));
  await assert.rejects(deleteManagedUser(admin, admin), code('USER_SELF_SUSPEND'));
  await assert.rejects(patchManagedUser(admin, admin, { active: false }), code('USER_SELF_SUSPEND'));
  const original = await login({ username: 'alice', password: oldPassword });
  await patchManagedUser(admin, alice, { active: false, realName: '测试姓名', isStarred: true });
  assert.equal(await getSession(original.token), null);
  await assert.rejects(login({ username: 'alice', password: oldPassword }), code('INVALID_CREDENTIALS'));
  await assert.rejects(getMemberProfile(alice), code('NOT_FOUND'));
  assert.equal((await queryLeaderboard(q)).some(u => u.id === alice), false);
  assert.equal((await queryTeamScore(ab, q)).points, 80);
  assert.equal((await pool.query("SELECT status FROM sync_runs WHERE binding_id IN (SELECT id FROM platform_bindings WHERE user_id=$1)", [alice])).rows.every(r => r.status === 'cancelled'), true);
  assert.equal((await listSyncTargets()).some(b => b.user_id === alice), false);
  await deleteManagedUser(admin, alice);
  const deletedTeam = await getTeamProfile(ab), placeholder = deletedTeam.members.find(m => m.id === alice)!;
  assert.equal(placeholder.displayName, '已删除成员'); assert.equal(placeholder.username, ''); assert.equal(placeholder.active, false);
  assert.equal((await getMembers(new URLSearchParams({ q: 'alice' }))).total, 0);
  await assert.rejects(patchManagedUser(admin, alice, { active: true }), code('USER_DELETED'));
  await assert.rejects(resetManagedUserPassword(admin, alice), code('USER_DELETED'));
  await assert.rejects(register({ username: 'alice', password: oldPassword }), code('USERNAME_TAKEN'));
  const restored = await restoreManagedUser(admin, alice);
  assert.equal(restored.active, false); assert.equal(restored.isStarred, true);
  await patchManagedUser(admin, alice, { active: true });
  assert.equal((await getTeamProfile(ab)).members.find(m => m.id === alice)!.displayName, '测试姓名');
  assert.equal((await queryTeamScore(ab, q)).points, 180);
  assert.equal((await pool.query('SELECT sync_requested FROM platform_bindings WHERE user_id=$1', [alice])).rows[0].sync_requested, true);
  assert.equal((await getManagedUsers(new URLSearchParams({ q: '测试姓名', starred: '1' }))).total, 1);
  // Two administrators cannot suspend each other concurrently and leave no active administrator.
  const competing = await Promise.allSettled([patchManagedUser(admin, otherAdmin, { active: false }), patchManagedUser(otherAdmin, admin, { active: false })]);
  assert.equal(competing.filter(r => r.status === 'fulfilled').length, 1);
  const remaining = (await pool.query<{ id: string }>("SELECT id FROM users WHERE role='admin' AND active AND deleted_at IS NULL")).rows;
  assert.equal(remaining.length, 1);
  const validAdmin = remaining[0]!.id;
  checks.push('suspension, deletion, restoration, username retention, anonymous roster placeholders, collection cancellation and administrator races');

  const first = await resetManagedUserPassword(validAdmin, alice), second = await resetManagedUserPassword(validAdmin, alice);
  assert.equal(first.temporaryPassword.length, 24); assert.notEqual(first.temporaryPassword, second.temporaryPassword);
  await assert.rejects(login({ username: 'alice', password: first.temporaryPassword }), code('INVALID_CREDENTIALS'));
  await assert.rejects(login({ username: 'alice', password: oldPassword }), code('INVALID_CREDENTIALS'));
  const temporary = await login({ username: 'alice', password: second.temporaryPassword });
  const session = (await getSession(temporary.token))!; assert.equal(session.user.mustChangePassword, true);
  await assert.rejects(setOwnUserStar(alice, { isStarred: false }), code('USER_FORBIDDEN'));
  await assert.rejects(changePassword(session, { currentPassword: second.temporaryPassword, newPassword: second.temporaryPassword }), code('INVALID_INPUT'));
  const changed = await changePassword(session, { currentPassword: second.temporaryPassword, newPassword: 'new_fixture_password_123' });
  assert.equal(changed.user.mustChangePassword, false); assert.equal(await getSession(temporary.token), null);
  assert.ok(await getSession(changed.token));
  // A verified old hash cannot create a session once reset wins the row lock.
  const stale = (await pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [bob])).rows[0]!.password_hash;
  await resetManagedUserPassword(validAdmin, bob);
  assert.equal(await createSession(bob, randomUUID(), new Date(Date.now() + 3600000), stale), null);
  const audit = JSON.stringify((await pool.query('SELECT details FROM user_management_events')).rows);
  for (const secret of [passwordHash, first.temporaryPassword, second.temporaryPassword, oldPassword]) assert.equal(audit.includes(secret), false);
  checks.push('repeated password resets, forced change, old-session invalidation, atomic stale-credential rejection and secret-free audits');

  // Queue cancellation participates in the same transaction as disabling the user.
  const boss = createBoss();
  try {
    await boss.start();
    const binding = (await pool.query<{ id: string; account_id: string }>('SELECT id,account_id FROM platform_bindings WHERE user_id=$1', [charlie])).rows[0]!;
    const jobId = await boss.send('platform.codeforces.personal', { fixture: true }); assert.ok(jobId);
    await pool.query("INSERT INTO sync_runs(binding_id,binding_version,account_id,kind,mode,status,queue,job_id) VALUES ($1,1,$2,'sync','incremental','queued','platform.codeforces.personal',$3)", [binding.id, binding.account_id, jobId]);
    await mutateManagedUser(validAdmin, charlie, { kind: 'update', active: false }, boss);
    assert.equal((await boss.getJobById('platform.codeforces.personal', jobId))?.state, 'cancelled');
  } finally { await boss.stop(); }
  checks.push('actual pg-boss job cancellation and repeatable migration/readiness');
  if (process.argv.includes('--http')) await import('./user-management-http-probe');
  passed = true;
  console.log(JSON.stringify({ event: 'user_management_verified', checks }));
} finally {
  await closeDb(); process.env.DATABASE_URL = baseUrl;
  if (passed) await getPool().query(`DROP DATABASE "${database}" WITH (FORCE)`);
  else console.error(JSON.stringify({ code: 'USER_MANAGEMENT_VERIFY_FAILED', isolatedDatabase: database }));
  await closeDb();
}
