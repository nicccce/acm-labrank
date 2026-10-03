import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeDb, getPool, queryLeaderboard, queryMemberRecords, queryMemberStats, queryTeamScore, unbindAccount } from '@acm/db/server';
import { migrateSchema } from '../packages/db/src/schema-migrations';
import { rebuildAttributions } from '../packages/db/src/personal/facts';
import { parsePersonalQuery } from '../packages/core/src/application/scores/query';

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error('DATABASE_URL required');
const database = `acm_cf_shared_verify_${randomUUID().replaceAll('-', '')}`;
assert.match(database, /^acm_cf_shared_verify_[a-f0-9]{32}$/);
const migrationsFolder = resolve('packages/db/drizzle');
const stage = await mkdtemp(join(tmpdir(), 'acm-cf-shared-'));
const checks: string[] = [];
let passed = false;
function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`); }
try {
  await getPool().query(`CREATE DATABASE "${database}"`); await closeDb();
  const target = new URL(baseUrl); target.pathname = `/${database}`; process.env.DATABASE_URL = target.href;
  const pool = getPool();
  // Seed real v1-shaped records, then test the upgrade rather than only a clean schema.
  const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
  const { mkdir } = await import('node:fs/promises'); await mkdir(join(stage, 'meta'));
  await writeFile(join(stage, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 9) }));
  for (const entry of journal.entries.slice(0, 9)) await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(stage, `${entry.tag}.sql`));
  await migrateSchema(stage);
  const users = (await pool.query<{ id: string }>("INSERT INTO users(username,password_hash) SELECT name,'isolated-fixture' FROM unnest(ARRAY['share_a','share_b','share_c']) name RETURNING id")).rows.map(u => u.id);
  const accounts: string[] = [], handles = ['ShareA', 'ShareB', 'ShareC'];
  for (let i = 0; i < 3; i++) {
    const account = (await pool.query<{ id: string }>('INSERT INTO platform_accounts(platform,handle,identity_key) VALUES ($1,$2,$3) RETURNING id', ['codeforces', handles[i], handles[i]!.toLowerCase()])).rows[0]!.id;
    accounts.push(account);
    await pool.query('INSERT INTO platform_account_aliases(platform,key,account_id) VALUES ($1,$2,$3)', ['codeforces', handles[i]!.toLowerCase(), account]);
    if (i < 2) await pool.query('INSERT INTO platform_bindings(user_id,platform,account_id) VALUES ($1,$2,$3)', [users[i], 'codeforces', account]);
  }
  const range = parsePersonalQuery(new URLSearchParams({ from: '2026-10-04', to: '2026-10-04' })).query;
  async function fact(key: string, members: string[], time: string, extra: Record<string, unknown> = {}) {
    const problemId = (await pool.query<{ id: string }>("INSERT INTO problems(platform,problem_key,title,native_difficulty,source_url,difficulty_updated_at,observed_at) VALUES ('codeforces',$1,$1,1600,'https://codeforces.com/contest/999/problem/A',now(),now()) ON CONFLICT(platform,problem_key) DO UPDATE SET title=EXCLUDED.title RETURNING id", [key])).rows[0]!.id;
    return (await pool.query<{ id: string }>("INSERT INTO submissions(platform,external_submission_id,problem_id,submitted_at,verdict,subject_evidence,parser_version,observed_at) VALUES ('codeforces',$1,$2,$3,'accepted',$4,'fixture',now()) RETURNING id", [randomUUID(), problemId, time, JSON.stringify({ authorAccountKeys: members, authorMembers: members.map(handle => ({ handle })), ...extra })])).rows[0]!.id;
  }
  const first = await fact('999:A', handles, '2026-10-04T01:00:00Z', { teamId: '77', participantType: 'VIRTUAL' });
  const duplicate = await fact('999:A', handles, '2026-10-04T02:00:00Z', { teamId: '77' });
  for (const id of [first, duplicate]) await pool.query("INSERT INTO submission_attributions(submission_id,method) VALUES ($1,'unassigned')", [id]);
  await migrateSchema(migrationsFolder);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM submissions')).rows[0].n, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM submission_attributions')).rows[0].n, 4);
  const board = await queryLeaderboard(range);
  near(board.find(u => u.id === users[0])!.points, 5 / 3);
  assert.equal(board.find(u => u.id === users[0])!.solveCount, 1);
  assert.equal(board.find(u => u.id === users[2])!.points, 0);
  const record = (await queryMemberRecords(users[0]!, range, false))[0]!;
  near(record.points, 5 / 3); assert.equal(record.shareDivisor, 3);
  const stats = await queryMemberStats(users[0]!, range);
  near(stats.platforms[0]!.points, 5 / 3); near(stats.calendar[0]!.points, 5 / 3);
  assert.equal(stats.submissionCount, 2);
  checks.push('v1 upgrade backfills shared facts; unbound members remain in divisor; records, calendar and leaderboard agree');
  async function rebuild(accountIds = accounts) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await rebuildAttributions(client, 'codeforces', { accountIds }); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  await pool.query('INSERT INTO platform_bindings(user_id,platform,account_id) VALUES ($1,$2,$3)', [users[2], 'codeforces', accounts[2]]);
  await rebuild([accounts[2]!]); await rebuild([accounts[2]!]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM submission_attributions')).rows[0].n, 6);
  near((await queryLeaderboard(range)).find(u => u.id === users[2])!.points, 5 / 3);
  const teamId = (await pool.query<{ id: string }>("INSERT INTO teams(name,roster_key) VALUES ('ABC',$1) RETURNING id", [[...users].sort().join(',')])).rows[0]!.id;
  for (const user of users) await pool.query('INSERT INTO team_memberships(team_id,user_id) VALUES ($1,$2)', [teamId, user]);
  near((await queryTeamScore(teamId, range)).points, 5);
  assert.equal((await queryTeamScore(teamId, range)).solveCount, 3);
  checks.push('late binding credits a non-first author; rebuilds are idempotent; three member shares total one full problem score');
  await fact('999:B', handles.slice(0, 2), '2026-10-04T03:00:00Z', { teamId: '78' });
  await fact('999:B', [handles[0]!], '2026-10-04T04:00:00Z'); // later solo AC cannot earn the same problem again
  await fact('999:C', [handles[0]!], '2026-10-04T05:00:00Z');
  await fact('999:C', handles, '2026-10-04T06:00:00Z', { teamId: '79' });
  await fact('999:D', [handles[0]!, handles[0]!.toLowerCase(), handles[1]!], '2026-10-04T07:00:00Z');
  const ghost = await fact('999:E', handles, '2026-10-04T08:00:00Z', { teamId: '80', ghost: true });
  const mismatch = await fact('999:F', handles, '2026-10-04T09:00:00Z', { authorMembers: [{ handle: 'Unrelated' }] });
  await rebuild();
  const aRecords = await queryMemberRecords(users[0]!, range, false);
  near(aRecords.find(s => s.problemKey === '999:B')!.points, 2.5);
  near(aRecords.find(s => s.problemKey === '999:C')!.points, 5);
  assert.equal(aRecords.find(s => s.problemKey === '999:D')!.shareDivisor, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM submission_attributions WHERE submission_id=ANY($1::uuid[]) AND user_id IS NOT NULL', [[ghost, mismatch]])).rows[0].n, 0);
  checks.push('two member fractional scores, personal/team first-AC deduplication, case-insensitive author deduplication and invalid/ghost evidence');
  await unbindAccount(users[1]!, 'codeforces');
  assert.equal((await queryLeaderboard(range)).find(u => u.id === users[1])!.points, 0);
  assert.equal((await pool.query('SELECT share_divisor FROM submission_attributions WHERE submission_id=$1 AND user_id=$2', [first, users[0]])).rows[0].share_divisor, 3);
  await pool.query('UPDATE platform_bindings SET account_id=$2 WHERE user_id=$1 AND platform=$3', [users[1], accounts[1], 'codeforces']); await rebuild([accounts[1]!]);
  await pool.query("UPDATE submissions SET verdict='rejected' WHERE id=ANY($1::uuid[])", [[first, duplicate]]);
  assert.equal((await queryMemberRecords(users[0]!, range, false)).some(s => s.problemKey === '999:A'), false);
  await pool.query("UPDATE submissions SET verdict='accepted' WHERE id=$1", [duplicate]);
  near((await queryMemberRecords(users[0]!, range, false)).find(s => s.problemKey === '999:A')!.points, 5 / 3);
  checks.push('unbinding and rebinding any member revokes/restores historical shares; rejudging recomputes first AC');
  passed = true;
  console.log(JSON.stringify({ event: 'cf_shared_verification_passed', checks }));
} finally {
  await closeDb(); process.env.DATABASE_URL = baseUrl;
  if (passed) await getPool().query(`DROP DATABASE "${database}" WITH (FORCE)`);
  else console.error(JSON.stringify({ code: 'CF_SHARED_PROBE_FAILED', isolatedDatabase: database }));
  await closeDb();
  assert.ok(stage.startsWith(join(tmpdir(), 'acm-cf-shared-'))); await rm(stage, { recursive: true });
}
