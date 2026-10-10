import type { PgBoss } from 'pg-boss';
import type { PoolClient } from 'pg';
import { getPool } from './client';
import { collectionTransaction } from './collection/settings';

export interface ManagedUser {
  id: string; username: string; realName: string | null; role: 'admin' | 'member';
  active: boolean; isStarred: boolean; deletedAt: Date | null; mustChangePassword: boolean; createdAt: Date;
}
export class UserStateError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export async function assertWritableUser(client: PoolClient, userId: string) {
  if (!(await client.query('SELECT id FROM users WHERE id=$1 AND active AND deleted_at IS NULL AND NOT must_change_password FOR SHARE', [userId])).rowCount) throw new UserStateError('USER_FORBIDDEN');
}
const columns = `id,username,real_name AS "realName",role,active,is_starred AS "isStarred",deleted_at AS "deletedAt",must_change_password AS "mustChangePassword",created_at AS "createdAt"`;
export async function listManagedUsers(input: { q: string; status: string; starred: string; limit: number; offset: number }) {
  const pattern = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
  const where = `(username ILIKE $1 OR real_name ILIKE $1)
    AND ($2='all' OR ($2='deleted' AND deleted_at IS NOT NULL) OR ($2='active' AND active AND deleted_at IS NULL) OR ($2='banned' AND NOT active AND deleted_at IS NULL))
    AND ($3='all' OR is_starred=($3='1'))`;
  const values = [pattern, input.status, input.starred];
  const rows = (await getPool().query<ManagedUser>(`SELECT ${columns} FROM users WHERE ${where} ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`, [...values, input.limit, input.offset])).rows;
  const total = (await getPool().query<{ total: number }>(`SELECT count(*)::int AS total FROM users WHERE ${where}`, values)).rows[0]!.total;
  return { rows, total };
}
type Mutation = { kind: 'update'; realName?: string | null; active?: boolean; isStarred?: boolean }
  | { kind: 'delete' } | { kind: 'restore' } | { kind: 'reset'; passwordHash: string };

export async function mutateManagedUser(actorId: string, userId: string, input: Mutation, boss?: PgBoss) {
  // Exclusive collection lock waits for page commits and prevents scheduling across a suspension.
  return collectionTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(73192402)');
    const locked = (await client.query<ManagedUser>(`SELECT ${columns} FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [[actorId, userId]])).rows;
    const actor = locked.find(u => u.id === actorId), before = locked.find(u => u.id === userId);
    if (!actor?.active || actor.deletedAt || actor.mustChangePassword || actor.role !== 'admin') throw new UserStateError('USER_FORBIDDEN');
    if (!before) throw new UserStateError('USER_NOT_FOUND');
    if (before.deletedAt && input.kind !== 'restore') throw new UserStateError('USER_DELETED');
    const disabling = input.kind === 'delete' || (input.kind === 'update' && input.active === false);
    if (disabling && actorId === userId) throw new UserStateError('USER_SELF_SUSPEND');
    if (disabling && before.role === 'admin' && before.active && !before.deletedAt) {
      const count = (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM users WHERE role='admin' AND active AND deleted_at IS NULL")).rows[0]!.count;
      if (count <= 1) throw new UserStateError('USER_LAST_ADMIN');
    }
    if (input.kind === 'update') {
      await client.query('UPDATE users SET real_name=CASE WHEN $2 THEN $3 ELSE real_name END,active=coalesce($4,active),is_starred=coalesce($5,is_starred) WHERE id=$1',
        [userId, input.realName !== undefined, input.realName ?? null, input.active ?? null, input.isStarred ?? null]);
    } else if (input.kind === 'delete') await client.query('UPDATE users SET deleted_at=now() WHERE id=$1', [userId]);
    else if (input.kind === 'restore') await client.query('UPDATE users SET deleted_at=NULL WHERE id=$1', [userId]);
    else await client.query('UPDATE users SET password_hash=$2,must_change_password=true WHERE id=$1', [userId, input.passwordHash]);
    const after = (await client.query<ManagedUser>(`SELECT ${columns} FROM users WHERE id=$1`, [userId])).rows[0]!;
    if (disabling || input.kind === 'reset') await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
    if (disabling) {
      const jobs = (await client.query<{ queue: string; job_id: string | null }>(`UPDATE sync_runs SET status='cancelled',finished_at=now()
        WHERE binding_id IN (SELECT id FROM platform_bindings WHERE user_id=$1) AND status IN ('queued','running','paused','failed') RETURNING queue,job_id`, [userId])).rows;
      for (const queue of new Set(jobs.map(j => j.queue))) {
        const ids = jobs.filter(j => j.queue === queue && j.job_id).map(j => j.job_id!);
        if (ids.length && boss) await boss.cancel(queue, ids, { db: { executeSql: (query, values) => client.query(query, values) } });
      }
    }
    if (after.active && !after.deletedAt && (!before.active || before.deletedAt)) {
      await client.query('UPDATE platform_bindings SET sync_requested=true,sync_blocked=NULL,next_sync_at=now() WHERE user_id=$1', [userId]);
    }
    await client.query('INSERT INTO user_management_events(actor_id,user_id,action,details) VALUES ($1,$2,$3,$4)',
      [actorId, userId, input.kind, JSON.stringify({ before, after })]);
    return after;
  }, true);
}

export async function updateOwnUser(userId: string, input: { realName?: string | null; isStarred?: boolean }) {
  return collectionTransaction(async client => {
    const before = (await client.query<ManagedUser>(`SELECT ${columns} FROM users WHERE id=$1 FOR UPDATE`, [userId])).rows[0];
    if (!before?.active || before.deletedAt || before.mustChangePassword) throw new UserStateError('USER_FORBIDDEN');
    const after = (await client.query<ManagedUser>(`UPDATE users SET real_name=CASE WHEN $2 THEN $3 ELSE real_name END,is_starred=coalesce($4,is_starred) WHERE id=$1 RETURNING ${columns}`,
      [userId, input.realName !== undefined, input.realName ?? null, input.isStarred ?? null])).rows[0]!;
    await client.query("INSERT INTO user_management_events(actor_id,user_id,action,details) VALUES ($1,$1,'self_update',$2)", [userId, JSON.stringify({ before, after })]);
    return after;
  });
}
