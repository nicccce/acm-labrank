import { createHash } from 'node:crypto';
import { createBoss, enqueueReadRun, ensureCollectionConnection, getReadRun, listRecoverableRuns, listUnsettledRuns, markInterruptedRun, PLATFORM_READ_QUEUES, type ReadQueueClient as PgBoss } from '@acm/db/server';
import { ConnectorError, type PlatformId } from '@acm/connectors/contracts';
import { originalRetryInput, parsePlatformReadRequest } from './contracts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function readRequestKey(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(parsePlatformReadRequest(input)))).digest('hex');
}
export async function withReadQueue<T>(handler: (boss: PgBoss) => Promise<T>): Promise<T> {
  const boss = createBoss();
  try { await boss.start(); return await handler(boss); } finally { await boss.stop(); }
}
export async function requestPlatformRead(input: unknown, options: { actorId?: string; boss?: PgBoss; retryOf?: string; recoveryGeneration?: number } = {}) {
  const request = parsePlatformReadRequest(input);
  if (request.platform === 'qoj' && request.connectionId !== (process.env.QOJ_CONNECTION_ID ?? 'qoj-lab')) throw new ConnectorError('INVALID_INPUT', '正式 QOJ 队列只使用配置的专用连接');
  const enqueue = (boss: PgBoss) => enqueueReadRun(boss, { platform: request.platform, connectionId: request.connectionId ?? null, input: request, queue: PLATFORM_READ_QUEUES[request.platform], requestKey: readRequestKey(request), ...options });
  return options.boss ? enqueue(options.boss) : withReadQueue(enqueue);
}
export async function retryPlatformRead(id: string, actorId?: string, boss?: PgBoss, recoveryGeneration?: number) {
  const run = await getReadRun(id);
  if (!run) throw new ConnectorError('INVALID_INPUT', '读取记录不存在');
  if (['queued', 'running', 'completed', 'cancelled'].includes(run.status)) throw new ConnectorError('INVALID_INPUT', '当前运行状态不支持重试');
  if (run.resolvedBy) {
    const replacement = await getReadRun(run.resolvedBy);
    if (replacement?.jobId && ['queued', 'running', 'completed'].includes(replacement.status)) return { runId: replacement.id, jobId: replacement.jobId, merged: true };
  }
  return requestPlatformRead(originalRetryInput(run.input), { actorId, boss, retryOf: id, recoveryGeneration });
}
export async function maintainReadQueue(boss: PgBoss) {
  for (const run of await listUnsettledRuns()) {
    if (!run.jobId || !run.queue) { await markInterruptedRun(run.id, 'failed'); continue; }
    const job = await boss.getJobById(run.queue, run.jobId);
    if (!job || ['failed', 'cancelled', 'completed'].includes(job.state)) await markInterruptedRun(run.id, job?.state === 'cancelled' ? 'cancelled' : 'failed');
  }
  for (const run of await listRecoverableRuns()) {
    if (!run.connectionId) continue;
    const connection = await ensureCollectionConnection(run.connectionId, run.platform as PlatformId);
    if (connection.state !== 'ready') continue;
    await retryPlatformRead(run.id, undefined, boss, connection.generation);
  }
}
