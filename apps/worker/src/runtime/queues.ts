import { getReadRun, PLATFORM_READ_QUEUES, PERSONAL_QUEUES, QOJ_SESSION_QUEUE, getCollectionControl, type ReadQueueClient } from '@acm/db/server';
import { ConnectorError, executePersonalJob, parsePlatformReadRequest, qojReadJobSchema, readPlatform, readOutcomeSummary, type ReadRuntimeOptions, type PlatformId } from '@acm/core/server';

export async function registerPlatformQueues(boss: ReadQueueClient, runtime: ReadRuntimeOptions, connectionId: string) {
  for (const [platform, queue] of Object.entries(PLATFORM_READ_QUEUES) as [PlatformId, string][]) {
    await boss.work<{ version: 1; runId: string } | unknown>(queue, { batchSize: 1, pollingIntervalSeconds: 2, heartbeatRefreshSeconds: 5 }, async jobs => {
      const job = jobs[0]!;
      if (!(await getCollectionControl()).enabled) throw new ConnectorError('CANCELLED', 'Collection is paused');
      const envelope = job.data as { version?: number; runId?: string };
      let input: unknown;
      let runId: string | undefined;
      let legacy = false;
      if (envelope?.version === 1 && typeof envelope.runId === 'string') {
        const record = await getReadRun(envelope.runId);
        if (!record || record.platform !== platform || record.jobId !== job.id || record.queue !== queue) throw new ConnectorError('INVALID_INPUT', 'Queue run identity mismatch');
        input = record.input; runId = record.id;
      } else if (platform === 'qoj') {
        // Keep existing queued payloads readable through the new orchestration.
        input = { ...qojReadJobSchema.parse(job.data), platform, connectionId }; legacy = true;
      } else throw new ConnectorError('INVALID_INPUT', 'Invalid platform queue envelope');
      const request = parsePlatformReadRequest(input);
      const result = await readPlatform(request, { ...runtime, runId, job: { id: job.id, queue }, signal: AbortSignal.any([runtime.signal, job.signal]) });
      console.log(JSON.stringify({ event: 'platform_worker_read', jobId: job.id, ...readOutcomeSummary(result) }));
      return legacy ? { ...result, pages: result.progress.pages, uniqueSubmissions: result.progress.uniqueRecordCount, cursor: result.continuation.cursor, checkpoint: result.continuation.checkpoint, submissions: result.data.submissions, problems: result.data.problems, code: result.error?.code } : result;
    });
  }
}
export async function registerPersonalQueues(boss: ReadQueueClient, runtime: ReadRuntimeOptions) {
  for (const queue of Object.values(PERSONAL_QUEUES)) await boss.work<{ version: number; syncRunId: string; batch: number }>(queue, { batchSize: 1, pollingIntervalSeconds: 2, heartbeatRefreshSeconds: 5 }, async jobs => {
    const job = jobs[0]!;
    if (job.data.version !== 1 || typeof job.data.syncRunId !== 'string' || !Number.isInteger(job.data.batch)) throw new ConnectorError('INVALID_INPUT', 'Invalid personal queue envelope');
    return executePersonalJob(boss, job.data, job.id, { ...runtime, signal: AbortSignal.any([runtime.signal, job.signal]) });
  });
}
export async function registerSessionQueue(boss: ReadQueueClient, runtime: ReadRuntimeOptions) {
  await boss.work<{ version: number; runId: string }>(QOJ_SESSION_QUEUE, { batchSize: 1, pollingIntervalSeconds: 2, heartbeatRefreshSeconds: 5 }, async jobs => {
    const job = jobs[0]!, run = await getReadRun(job.data.runId);
    if (job.data.version !== 1 || !run || run.queue !== QOJ_SESSION_QUEUE || run.jobId !== job.id) throw new ConnectorError('INVALID_INPUT', 'Invalid session verification envelope');
    const input = parsePlatformReadRequest(run.input);
    if (input.platform !== 'qoj' || input.operation !== 'verify_session') throw new ConnectorError('INVALID_INPUT', 'Session queue only verifies identity');
    const result = await readPlatform(input, { ...runtime, runId: run.id, signal: AbortSignal.any([runtime.signal, job.signal]) });
    return readOutcomeSummary(result);
  });
}
