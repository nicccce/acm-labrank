import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeDb, getCollectionControl, getPool, setCollectionControl, unbindAccount } from '@acm/db/server';
import { archiveTeam, createTeam, deleteTeam, getMemberBindings, getMembers, getPersonalLeaderboard, getPersonalMember, getTeamDetail, getTeamLeaderboard, getTeamProfile, getTeams, leaveTeam, saveMemberProfile, updateTeam } from '../packages/core/src/application/index';

if (!process.env.DATABASE_URL || !/^\/acm_personal_verify_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Isolated verification database required');
const pool = getPool(), checks: string[] = [], query = () => new URLSearchParams({ from: '2026-10-02', to: '2026-10-02' });
try {
  const admin = (await pool.query<{ id: string; password_hash: string }>("SELECT id,password_hash FROM users WHERE username='probe_admin'")).rows[0]!;
  await pool.query('UPDATE users SET active=false WHERE id<>$1', [admin.id]);
  const users = (await pool.query<{ id: string; username: string }>(`INSERT INTO users(username,password_hash) SELECT name,$1 FROM unnest(ARRAY['member_a','member_b','member_c','member_d','member_e','member_f']) AS name RETURNING id,username`, [admin.password_hash])).rows;
  const [a, b, c, d, e, f] = users.map(u => u.id) as [string, string, string, string, string, string];
  const control = await getCollectionControl(); if (control.enabled) await setCollectionControl(false, control.version, admin.id);
  await pool.query('UPDATE collection_settings SET platforms=$1,auto_sync_enabled=false,score_range=$2,version=version+1 WHERE id=1', [['codeforces', 'qoj', 'luogu'], JSON.stringify({ kind: 'fixed', from: '2026-10-02', to: '2026-10-02' })]);
  async function account(userId: string, platform: string, handle: string) {
    const accountId = randomUUID();
    await pool.query('INSERT INTO platform_accounts(id,platform,handle,identity_key) VALUES ($1,$2,$3,$3)', [accountId, platform, handle]);
    await pool.query('INSERT INTO platform_account_aliases(platform,key,account_id) VALUES ($1,$2,$3)', [platform, platform === 'codeforces' ? handle.toLowerCase() : handle, accountId]);
    await pool.query('INSERT INTO platform_bindings(user_id,platform,account_id,verified_at) VALUES ($1,$2,$3,now())', [userId, platform, accountId]);
    await pool.query("INSERT INTO sync_cursors(account_id,mode,history_complete,coverage,last_success_at) VALUES ($1,'backfill',false,'visible',now())", [accountId]);
    return accountId;
  }
  const aa = await account(a, 'codeforces', 'MemberFixtureA'), ba = await account(b, 'codeforces', 'MemberFixtureB'), cl = await account(c, 'luogu', '12345'), cq = await account(c, 'qoj', 'MemberFixtureC');
  async function problem(platform: string, key: string, difficulty: number | null) {
    return (await pool.query<{ id: string }>('INSERT INTO problems(platform,problem_key,title,native_difficulty,source_url,difficulty_updated_at,observed_at) VALUES ($1,$2,$2,$3,$4,now(),now()) RETURNING id', [platform, key, difficulty, platform === 'codeforces' ? `https://codeforces.com/contest/999/problem/${key.split(':')[1]}` : platform === 'qoj' ? 'https://qoj.ac/problem/999' : 'https://www.luogu.com.cn/problem/P999'])).rows[0]!.id;
  }
  const shared = await problem('codeforces', '999:A', 1800), old = await problem('codeforces', '999:B', 2900), lg = await problem('luogu', 'P999', 5), qj = await problem('qoj', '999', null);
  async function submission(userId: string, accountId: string, platform: string, problemId: string, time: string) {
    const id = randomUUID();
    const handle = (await pool.query<{ handle: string }>('SELECT handle FROM platform_accounts WHERE id=$1', [accountId])).rows[0]!.handle;
    await pool.query("INSERT INTO submissions(id,platform,external_submission_id,problem_id,submitted_at,verdict,source_url,subject_evidence,parser_version,observed_at) VALUES ($1,$2,$6,$3,$4,'accepted',$5,$7,'fixture',now())", [id, platform, problemId, time, platform === 'codeforces' ? 'https://codeforces.com/contest/999/submission/1' : null, id, JSON.stringify({ authorAccountKeys: [handle] })]);
    await pool.query("INSERT INTO submission_attributions(submission_id,user_id,account_id,method) VALUES ($1,$2,$3,'verified_person')", [id, userId, accountId]);
  }
  await submission(a, aa, 'codeforces', shared, '2026-10-01T16:00:00Z'); await submission(a, aa, 'codeforces', shared, '2026-10-02T01:00:00Z');
  await submission(b, ba, 'codeforces', shared, '2026-10-01T16:00:00Z');
  await submission(a, aa, 'codeforces', old, '2026-10-01T15:59:59Z'); await submission(a, aa, 'codeforces', old, '2026-10-02T02:00:00Z');
  await submission(c, cl, 'luogu', lg, '2026-10-02T00:00:00Z'); await submission(c, cq, 'qoj', qj, '2026-10-02T00:00:00Z');
  const am = await getPersonalMember(a, query()); assert.equal(am.points, 6); assert.equal(am.solveCount, 1); assert.equal(am.submissionCount, 3); assert.equal(am.rank, 2); assert.equal(am.platformAccounts[0]!.handle, 'MemberFixtureA');
  await saveMemberProfile(a, { realName: '甲同学' }); assert.equal((await getPersonalMember(a, query())).member.displayName, '甲同学');
  assert.equal((await getMembers(new URLSearchParams({ q: '甲同学' }))).items[0]!.id, a);
  assert.equal((await getMembers(new URLSearchParams({ q: 'MemberFixtureA' }))).items[0]!.id, a);
  assert.equal((await getMembers(new URLSearchParams({ q: '%' }))).total, 0);
  assert.equal((await getMembers(new URLSearchParams({ page: '999' }))).total, 7);
  await saveMemberProfile(a, { realName: null }); assert.equal((await getPersonalMember(a, query())).member.displayName, 'MemberFixtureA');
  checks.push('real-name and CF fallback, safe member search, first-AC boundaries and detail ranks');
  const concurrent = await Promise.all([createTeam(a, { name: 'AB', memberIds: [a, b] }), createTeam(b, { name: 'BA', memberIds: [b.toUpperCase(), a.toUpperCase()] })]);
  assert.equal(concurrent[0]!.id, concurrent[1]!.id); assert.equal(concurrent.filter(t => t.created).length, 1);
  const ab = concurrent[0]!.id;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_memberships WHERE team_id=$1', [ab])).rows[0].n, 2);
  await assert.rejects(createTeam(a, { name: 'bad', memberIds: [a, a] }), /不能重复/);
  await assert.rejects(createTeam(a, { name: 'bad', memberIds: [b, c] }), /创建者/);
  await assert.rejects(createTeam(a, { name: 'bad', memberIds: [a, randomUUID()] }), /不存在/);
  await assert.rejects(pool.query('INSERT INTO teams(name,roster_key) SELECT name,roster_key FROM teams WHERE id=$1', [ab]), error => (error as { code: string }).code === '23505');
  const ad = await createTeam(a, { name: 'AD', memberIds: [a, d] }), be = await createTeam(b, { name: 'BE', memberIds: [b, e] }), df = await createTeam(d, { name: 'DF', memberIds: [d, f] });
  const ranks = await getTeamLeaderboard(query()); assert.deepEqual(ranks.items.map(t => t.rank), [1, 2, 2, 4]);
  assert.equal(ranks.items[0]!.points, 12); assert.equal(ranks.items[0]!.solveCount, 2); assert.equal(ranks.items[0]!.platformSolveCounts.codeforces, 2); assert.equal(ranks.items[0]!.provisional, true);
  const abDetail = await getTeamDetail(ab, query()); assert.equal(abDetail.members.reduce((n, m) => n + m.points, 0), abDetail.points);
  assert.equal((await getTeamLeaderboard(new URLSearchParams({ ...Object.fromEntries(query()), limit: '1', page: '2' }))).items[0]!.rank, 2);
  assert.equal((await getTeamLeaderboard(new URLSearchParams({ ...Object.fromEntries(query()), page: '999' }))).total, 4);
  checks.push('concurrent unordered roster deduplication, database uniqueness, shared problems count per member, tied ranks before pagination');
  const profile = await getTeamProfile(ab);
  await assert.rejects(updateTeam(ab, c, { name: 'hack', memberIds: [a, b], version: profile.version }), /仅当前/);
  await assert.rejects(archiveTeam(ab, c, { version: profile.version }), /仅当前/);
  await assert.rejects(deleteTeam(ab, c, { version: profile.version }), /仅当前/);
  await assert.rejects(updateTeam(ad.id, a, { name: 'dup', memberIds: [a, b], version: 1 }), error => (error as { teamId: string }).teamId === ab);
  await updateTeam(ab, b, { name: 'BC', memberIds: [b, c], version: profile.version });
  assert.equal((await getTeamDetail(ab, query())).points, 17);
  await assert.rejects(updateTeam(ab, b, { name: 'stale', memberIds: [b, c], version: profile.version }), /已变化/);
  await assert.rejects(updateTeam(ab, a, { name: 'former member', memberIds: [b, c], version: profile.version + 1 }), /仅当前/);
  assert.equal('ownerId' in await getTeamProfile(ab), false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM team_memberships WHERE team_id=$1 AND left_at IS NOT NULL', [ab])).rows[0].n, 1);
  assert.equal((await getTeams(new URLSearchParams({ mine: '1' }), a)).items.some(t => t.id === ab), false);
  checks.push('equal member editing, replacement uses current members for entire range, membership history, former-member authorization and stale versions');
  const pairAB = await createTeam(a, { name: 'AB again', memberIds: [a, b] });
  const triple = await Promise.all([createTeam(a, { name: 'ABC', memberIds: [a, b, c] }), createTeam(b, { name: 'BCA', memberIds: [b, c, a] }), createTeam(c, { name: 'CAB', memberIds: [c, a, b] })]);
  assert.equal(new Set(triple.map(t => t.id)).size, 1); assert.equal(triple.filter(t => t.created).length, 1);
  const quitter = c;
  const remaining = [a, b, c].filter(id => id !== quitter), matchingPair = await createTeam(remaining[0]!, { name: 'Matching pair', memberIds: remaining });
  await assert.rejects(leaveTeam(triple[0]!.id, quitter, { version: 1 }), error => (error as { teamId: string }).teamId === matchingPair.id);
  await archiveTeam(triple[0]!.id, c, { version: 1 });
  assert.equal((await getTeamDetail(triple[0]!.id, query())).rank, null);
  assert.equal((await getTeams(new URLSearchParams({ mine: '1', status: 'archived' }), quitter)).items.some(t => t.id === triple[0]!.id), true);
  const beExit = await leaveTeam(be.id, e, { version: 1 }); assert.equal(beExit.archived, true);
  await archiveTeam(df.id, f, { version: 1 }); assert.deepEqual(await createTeam(f, { name: 'FD rebuilt', memberIds: [f, d] }), { id: df.id, created: false });
  assert.equal((await createTeam(a, { name: 'ABC archived duplicate', memberIds: [a, b, c] })).created, false);
  await deleteTeam(triple[0]!.id, b, { version: 2 });
  const tripleNew = await createTeam(a, { name: 'ABC new', memberIds: [a, b, c] }); assert.equal(tripleNew.created, true);
  const pending = (await getMemberBindings(a)).items.find(i => i.platform === 'codeforces')!;
  await pool.query("UPDATE platform_bindings SET candidate='DoesNotExist',candidate_state='not_found',candidate_error=$2 WHERE user_id=$1 AND platform='codeforces'", [a, JSON.stringify({ code: 'ACCOUNT_NOT_FOUND', message: '账号不存在' })]);
  assert.equal((await getMemberBindings(a)).items.find(i => i.platform === 'codeforces')!.active!.accountId, pending.active!.accountId);
  assert.equal((await getPersonalMember(a, query())).points, 6);
  await unbindAccount(a, 'codeforces'); assert.equal((await getPersonalMember(a, query())).points, 0); assert.equal((await getTeamDetail(pairAB.id, query())).points, 6);
  await saveMemberProfile(a, { realName: '甲同学' });
  assert.equal((await getPersonalLeaderboard(query())).items.find(i => i.id === a)!.displayName, '甲同学');
  checks.push('three creators share one team, collision exit rejects, minimum size archives, archived duplicate reuses team, delete frees roster, failed replacement preserves score and unbind changes team total');
  console.log(JSON.stringify({ event: 'member_team_probe_passed', checks }));
} finally { await closeDb(); }
