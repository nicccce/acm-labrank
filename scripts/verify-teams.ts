import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeDb, getPool } from '@acm/db/server';
import { migrateSchema } from '../packages/db/src/schema-migrations';
import { archiveTeam, createTeam, deleteTeam, getTeamProfile, leaveTeam, updateTeam } from '../packages/core/src/application/teams';

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error('DATABASE_URL required');
const database = `acm_teams_verify_${randomUUID().replaceAll('-', '')}`;
assert.match(database, /^acm_teams_verify_[a-f0-9]{32}$/);
const folder = resolve('packages/db/drizzle'), stage = await mkdtemp(join(tmpdir(), 'acm-teams-'));
const checks: string[] = [];
let passed = false;
const errorCode = (code: string, teamId?: string) => (error: unknown) => {
  const actual = error as { code: string; teamId?: string };
  return actual.code === code && (teamId === undefined || actual.teamId === teamId);
};
try {
  await getPool().query(`CREATE DATABASE "${database}"`); await closeDb();
  const target = new URL(baseUrl); target.pathname = `/${database}`; process.env.DATABASE_URL = target.href;
  const pool = getPool();
  const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
  const previous = journal.entries.slice(0, journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0010_equal_team_members'));
  await mkdir(join(stage, 'meta'));
  await writeFile(join(stage, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: previous }));
  for (const entry of previous) await copyFile(join(folder, `${entry.tag}.sql`), join(stage, `${entry.tag}.sql`));
  await migrateSchema(stage);
  const users = (await pool.query<{ id: string }>("INSERT INTO users(username,password_hash) SELECT name,'isolated-fixture' FROM unnest(ARRAY['team_a','team_b','team_c','team_d','team_e']) name RETURNING id")).rows.map(u => u.id);
  const [a, b, c, d, e] = users as [string, string, string, string, string];
  async function legacy(name: string, members: string[], archived: boolean, createdAt: string) {
    const id = (await pool.query<{ id: string }>('INSERT INTO teams(name,owner_id,roster_key,archived_at,created_at) VALUES ($1,$2,$3,CASE WHEN $4 THEN now() END,$5) RETURNING id', [name, members[0], [...members].sort().join(','), archived, createdAt])).rows[0]!.id;
    await pool.query('INSERT INTO team_memberships(team_id,user_id) SELECT $1,unnest($2::uuid[])', [id, members]);
    await pool.query("INSERT INTO team_events(team_id,actor_id,action,details) VALUES ($1,$2,'create',$3)", [id, members[0], JSON.stringify({ memberIds: members })]);
    return id;
  }
  const oldAB = await legacy('Archived AB', [a, b], true, '2026-10-01T00:00:00Z');
  const ab = await legacy('Active AB', [a, b], false, '2026-10-02T00:00:00Z');
  const oldDE = await legacy('Old DE', [d, e], true, '2026-10-01T00:00:00Z');
  const newDE = await legacy('New DE', [e, d], true, '2026-10-02T00:00:00Z');
  // Historical fixtures may have used another delimiter; identity comes from members.
  await pool.query('UPDATE teams SET roster_key=$2 WHERE id=$1', [newDE, [d, e].join(':')]);
  const factsBefore = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  await migrateSchema(folder); await migrateSchema(folder);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM teams')).rows[0].n, 2);
  assert.equal((await getTeamProfile(ab)).name, 'Active AB');
  assert.equal((await getTeamProfile(oldDE)).name, 'Old DE');
  assert.equal((await getTeamProfile(ab)).members.length, 2);
  assert.equal((await getTeamProfile(ab)).version, 2);
  for (const removed of [oldAB, newDE]) await assert.rejects(getTeamProfile(removed), errorCode('TEAM_NOT_FOUND'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_memberships WHERE left_at IS NOT NULL')).rows[0].n, 4);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_events')).rows[0].n, 4);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM team_events WHERE details ? 'mergedFromTeamId'")).rows[0].n, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='teams' AND column_name='owner_id'")).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, factsBefore);
  checks.push('legacy active/archive duplicates merge deterministically, history survives, normalized member identity, migration replay');

  const concurrent = await Promise.all([
    createTeam(a, { name: 'ABC', memberIds: [a, b, c] }),
    createTeam(b, { name: 'BCA', memberIds: [b.toUpperCase(), c, a] }),
    createTeam(c, { name: 'CAB', memberIds: [c, a, b] }),
  ]);
  assert.equal(new Set(concurrent.map(t => t.id)).size, 1);
  assert.equal(concurrent.filter(t => t.created).length, 1);
  const abc = concurrent[0]!.id;
  await assert.rejects(pool.query('INSERT INTO teams(name,roster_key) SELECT name,roster_key FROM teams WHERE id=$1', [abc]), errorCode('23505'));
  await assert.rejects(createTeam(a, { name: 'duplicate user', memberIds: [a, a] }), errorCode('INVALID_INPUT'));
  await assert.rejects(createTeam(a, { name: 'outsider', memberIds: [b, c] }), errorCode('INVALID_INPUT'));
  await assert.rejects(createTeam(a, { name: 'missing member', memberIds: [a, randomUUID()] }), errorCode('INVALID_MEMBERS'));
  await assert.rejects(updateTeam(abc, c, { name: 'duplicate AB', memberIds: [a, b], version: 1 }), errorCode('TEAM_DUPLICATE', ab));
  await assert.rejects(leaveTeam(abc, c, { version: 1 }), errorCode('TEAM_DUPLICATE', ab));
  await archiveTeam(ab, b, { version: 2 });
  assert.deepEqual(await createTeam(b, { name: 'Renamed BA', memberIds: [b, a] }), { id: ab, created: false });
  assert.equal((await getTeamProfile(ab)).name, 'Active AB');
  await assert.rejects(updateTeam(abc, c, { name: 'archived duplicate', memberIds: [a, b], version: 1 }), errorCode('TEAM_DUPLICATE', ab));
  await assert.rejects(leaveTeam(abc, c, { version: 1 }), errorCode('TEAM_DUPLICATE', ab));
  checks.push('concurrent case/order-independent create, database uniqueness, create/update/leave collisions including archived teams');

  // Every original member can rename; any current member can add or remove others.
  for (let i = 0; i < 3; i++) await updateTeam(abc, [a, b, c][i]!, { name: `Renamed by member ${i}`, memberIds: [a, b, c], version: i + 1 });
  await updateTeam(abc, b, { name: 'BC', memberIds: [b, c], version: 4 });
  for (const action of [
    () => updateTeam(abc, a, { name: 'Former member', memberIds: [b, c], version: 5 }),
    () => archiveTeam(abc, a, { version: 5 }),
    () => deleteTeam(abc, a, { version: 5 }),
  ]) await assert.rejects(action(), errorCode('TEAM_FORBIDDEN'));
  await updateTeam(abc, c, { name: 'BCD', memberIds: [b, c, d], version: 5 });
  await updateTeam(abc, d, { name: 'CD', memberIds: [c, d], version: 6 });
  await assert.rejects(deleteTeam(abc, b, { version: 7 }), errorCode('TEAM_FORBIDDEN'));
  const competing = await Promise.allSettled([c, d].map(actor => updateTeam(abc, actor, { name: 'Concurrent rename', memberIds: [c, d], version: 7 })));
  assert.equal(competing.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(competing.filter(r => r.status === 'rejected' && errorCode('TEAM_STALE')(r.reason)).length, 1);
  await archiveTeam(abc, d, { version: 8 });
  await assert.rejects(updateTeam(abc, c, { name: 'Archived edit', memberIds: [c, d], version: 9 }), errorCode('TEAM_ARCHIVED'));
  await assert.rejects(deleteTeam(abc, c, { version: 8 }), errorCode('TEAM_STALE'));
  await deleteTeam(abc, c, { version: 9 });
  await assert.rejects(getTeamProfile(abc), errorCode('TEAM_NOT_FOUND'));
  for (const table of ['team_memberships', 'team_events']) assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE team_id=$1`, [abc])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, factsBefore);
  const recreated = await createTeam(c, { name: 'CD again', memberIds: [c, d] });
  assert.equal(recreated.created, true); assert.notEqual(recreated.id, abc);
  await deleteTeam(recreated.id, d, { version: 1 });
  checks.push('all members rename/add/remove/archive/delete, removed members lose permission, stale writes conflict, active/archived delete frees roster');

  const ac = await createTeam(a, { name: 'AC', memberIds: [a, c] });
  assert.equal((await leaveTeam(ac.id, a, { version: 1 })).archived, true);
  assert.deepEqual((await getTeamProfile(ac.id)).members.map(m => m.id), [c]);
  await assert.rejects(deleteTeam(ac.id, a, { version: 2 }), errorCode('TEAM_FORBIDDEN'));
  await deleteTeam(ac.id, c, { version: 2 });
  checks.push('creator can leave, minimum roster archives, only remaining members retain delete permission');
  passed = true;
  console.log(JSON.stringify({ event: 'team_members_verify_passed', checks }));
} finally {
  await closeDb(); process.env.DATABASE_URL = baseUrl;
  if (passed) await getPool().query(`DROP DATABASE "${database}" WITH (FORCE)`);
  else console.error(JSON.stringify({ code: 'TEAM_VERIFY_FAILED', isolatedDatabase: database }));
  await closeDb(); await rm(stage, { recursive: true, force: true });
}
