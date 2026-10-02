import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { getPool } from '../client';

export interface ReadRunRecord {
  id: string; platform: string; connectionId: string | null; input: unknown; jobId: string | null; queue: string | null;
  status: string; progress: unknown; continuation: unknown; result: unknown; error: unknown;
  recoveryState: string; connectionGeneration: number | null; recoveryGeneration: number | null;
  retryOf: string | null; resolvedBy: string | null; requestedBy: string | null;
  createdAt: Date; startedAt: Date | null; finishedAt: Date | null;
}
const columns = `id,platform,connection_id AS "connectionId",input,job_id AS "jobId",queue,status,progress,continuation,result,error,
  recovery_state AS "recoveryState",connection_generation AS "connectionGeneration",recovery_generation AS "recoveryGeneration",
  retry_of AS "retryOf",resolved_by AS "resolvedBy",requested_by AS "requestedBy",created_at AS "createdAt",started_at AS "startedAt",finished_at AS "finishedAt"`;
export async function getReadRun(id: string): Promise<ReadRunRecord | null> {
  return (await getPool().query<ReadRunRecord>(`SELECT ${columns} FROM platform_read_runs WHERE id=$1`, [id])).rows[0] ?? null;
}
export async function createDirectReadRun(platform: string, connectionId: string | null, input: unknown, job?: { id: string; queue: string }): Promise<string> {
  const id = randomUUID();
  await getPool().query(`INSERT INTO platform_read_runs(id,platform,connection_id,request_key,input,job_id,queue) VALUES ($1::uuid,$2,$3,$1::text,$4,$5,$6)`, [id, platform, connectionId, JSON.stringify(input), job?.id ?? null, job?.queue ?? null]);
  return id;
}
export async function enqueueReadRun(boss: PgBoss, options: { platform: string; connectionId: string | null; input: unknown; queue: string; requestKey: string; actorId?: string; retryOf?: string; recoveryGeneration?: number }): Promise<{ runId: string; jobId: string; merged: boolean }> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,73192403))', [options.requestKey]);
    if (options.retryOf && options.recoveryGeneration !== undefined) {
      const parent = await client.query('SELECT recovery_state,recovery_generation,resolved_by FROM platform_read_runs WHERE id=$1 FOR UPDATE', [options.retryOf]);
      const previous = parent.rows[0];
      if (!previous) throw new Error('READ_RECOVERY_PARENT_MISSING');
      if (previous.recovery_state !== 'waiting' || (previous.recovery_generation !== null && previous.recovery_generation >= options.recoveryGeneration)) {
        const dispatched = await client.query('SELECT id,job_id FROM platform_read_runs WHERE id=$1', [previous.resolved_by]);
        if (!dispatched.rows[0]?.job_id) throw new Error('READ_RECOVERY_ALREADY_HANDLED');
        await client.query('COMMIT');
        return { runId: dispatched.rows[0].id, jobId: dispatched.rows[0].job_id, merged: true };
      }
    }
    const existing = await client.query<{ id: string; job_id: string }>(`SELECT id,job_id FROM platform_read_runs WHERE request_key=$1 AND status IN ('queued','running')`, [options.requestKey]);
    let runId = existing.rows[0]?.id;
    let jobId = existing.rows[0]?.job_id;
    const merged = Boolean(runId);
    if (!runId) {
      runId = randomUUID();
      await client.query(`INSERT INTO platform_read_runs(id,platform,connection_id,request_key,input,queue,requested_by,retry_of) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [runId, options.platform, options.connectionId, options.requestKey, JSON.stringify(options.input), options.queue, options.actorId ?? null, options.retryOf ?? null]);
      jobId = await boss.send(options.queue, { version: 1, runId }, { singletonKey: options.requestKey, expireInSeconds: 960, heartbeatSeconds: 30, db: { executeSql: (sql, values) => client.query(sql, values) } }) ?? undefined;
      if (!jobId) throw new Error('READ_QUEUE_CONFLICT');
      await client.query('UPDATE platform_read_runs SET job_id=$2 WHERE id=$1', [runId, jobId]);
    }
    if (!jobId) throw new Error('READ_RUN_JOB_MISSING');
    if (options.retryOf) {
      await client.query(`UPDATE platform_read_runs SET recovery_state='requeued',recovery_generation=$2,resolved_by=$3 WHERE id=$1 AND recovery_state<>'resolved'`, [options.retryOf, options.recoveryGeneration ?? null, runId]);
    }
    if (options.actorId) await client.query('INSERT INTO collection_audit_logs(actor_id,action,target,details) VALUES ($1,$2,$3,$4)', [options.actorId, options.retryOf ? 'read_retried' : 'read_requested', runId, JSON.stringify({ merged })]);
    await client.query('COMMIT');
    return { runId, jobId, merged };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export async function startReadRun(id: string, generation: number | null): Promise<boolean> {
  return (await getPool().query(`UPDATE platform_read_runs SET status='running',started_at=now(),connection_generation=$2 WHERE id=$1 AND status='queued' RETURNING id`, [id, generation])).rowCount === 1;
}
export async function writeReadProgress(id: string, progress: unknown, continuation: unknown) {
  const result = await getPool().query(`UPDATE platform_read_runs SET progress=$2,continuation=$3 WHERE id=$1 AND status='running' RETURNING id`, [id, JSON.stringify(progress), JSON.stringify(continuation)]);
  if (!result.rowCount) throw new Error('READ_RUN_NO_LONGER_ACTIVE');
}
export async function writeReadGeneration(id: string, generation: number) {
  await getPool().query("UPDATE platform_read_runs SET connection_generation=$2 WHERE id=$1 AND status='running'", [id, generation]);
}
export async function finishReadRun(id: string, outcome: { status: string; progress: unknown; continuation: unknown; error: { action: string } | null }, summary: unknown) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const waiting = outcome.error?.action === 'reauthenticate' || outcome.error?.action === 'human_verify';
    const result = await client.query(`UPDATE platform_read_runs SET status=$2,progress=$3,continuation=$4,error=$5,result=$6,recovery_state=$7,finished_at=now() WHERE id=$1 AND status='running' RETURNING retry_of`, [id, outcome.status, JSON.stringify(outcome.progress), JSON.stringify(outcome.continuation), outcome.error ? JSON.stringify(outcome.error) : null, JSON.stringify(summary), waiting ? 'waiting' : 'none']);
    if (!result.rowCount) throw new Error('READ_RUN_NO_LONGER_ACTIVE');
    if (outcome.status === 'completed') {
      await client.query(`WITH RECURSIVE ancestors AS (
        SELECT retry_of AS id FROM platform_read_runs WHERE id=$1
        UNION ALL SELECT r.retry_of FROM platform_read_runs r JOIN ancestors a ON r.id=a.id WHERE r.retry_of IS NOT NULL
      ) UPDATE platform_read_runs SET recovery_state='resolved',resolved_by=$1 WHERE id IN (SELECT id FROM ancestors)`, [id]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export async function listReadRuns(options: { platform?: string; status?: string; action?: string; limit: number; before?: { createdAt: string; id: string } }): Promise<ReadRunRecord[]> {
  return (await getPool().query<ReadRunRecord>(`SELECT ${columns} FROM platform_read_runs WHERE ($1::text IS NULL OR platform=$1) AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR error->>'action'=$3) AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT $6`, [options.platform ?? null, options.status ?? null, options.action ?? null, options.before?.createdAt ?? null, options.before?.id ?? null, options.limit])).rows;
}
export async function latestReadFailures(): Promise<ReadRunRecord[]> {
  return (await getPool().query<ReadRunRecord>(`SELECT DISTINCT ON (platform) ${columns} FROM platform_read_runs WHERE status NOT IN ('queued','running','completed') ORDER BY platform,created_at DESC,id DESC`)).rows;
}
export async function listRecoverableRuns(): Promise<ReadRunRecord[]> {
  return (await getPool().query<ReadRunRecord>(`SELECT ${columns.split(',').map(part => part.trim().startsWith('r.') ? part : 'r.' + part.trim()).join(',')} FROM platform_read_runs r JOIN platform_connections c ON c.id=r.connection_id AND c.platform=r.platform WHERE r.recovery_state='waiting' AND c.state='ready' AND c.generation>coalesce(r.connection_generation,-1) AND (r.recovery_generation IS NULL OR r.recovery_generation<c.generation) AND NOT EXISTS (SELECT 1 FROM platform_read_runs newer WHERE newer.request_key=r.request_key AND newer.created_at>r.created_at) ORDER BY r.created_at LIMIT 50`)).rows;
}
export async function listUnsettledRuns(): Promise<ReadRunRecord[]> {
  return (await getPool().query<ReadRunRecord>(`SELECT ${columns} FROM platform_read_runs WHERE status IN ('queued','running') AND (
    (job_id IS NOT NULL AND created_at<now()-interval '30 seconds') OR
    (job_id IS NULL AND status='queued' AND created_at<now()-interval '30 seconds') OR
    (job_id IS NULL AND status='running' AND coalesce(started_at,created_at)+(coalesce((input->>'maxDurationMs')::int,120000)+60000)*interval '1 millisecond'<now())
  ) ORDER BY created_at LIMIT 100`)).rows;
}
export async function markInterruptedRun(id: string, status: 'failed' | 'cancelled') {
  await getPool().query(`UPDATE platform_read_runs SET status=$2,finished_at=now(),error=$3 WHERE id=$1 AND status IN ('queued','running')`, [id, status, JSON.stringify({ code: status === 'cancelled' ? 'CANCELLED' : 'API_ERROR', message: '读取进程退出或队列任务过期', httpStatus: null, retryAt: null, action: status === 'cancelled' ? 'none' : 'retry' })]);
}
export async function cleanCollectionHistory() {
  await getPool().query(`DELETE FROM platform_read_runs WHERE finished_at<now()-interval '30 days' AND recovery_state IN ('none','resolved') AND id NOT IN (SELECT retry_of FROM platform_read_runs WHERE retry_of IS NOT NULL)`);
  await getPool().query(`DELETE FROM collection_audit_logs WHERE created_at<now()-interval '180 days'`);
}
