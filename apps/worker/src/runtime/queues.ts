import { getReadRun, PLATFORM_READ_QUEUES, type ReadQueueClient } from '@acm/db/server';
import { ConnectorError, parsePlatformReadRequest, qojReadJobSchema, readPlatform, readOutcomeSummary, type ReadRuntimeOptions, type PlatformId } from '@acm/core/server';

export async function registerPlatformQueues(boss: ReadQueueClient, runtime: ReadRuntimeOptions, connectionId: string) {
  for (const [platform, queue] of Object.entries(PLATFORM_READ_QUEUES) as [PlatformId, string][]) {
    await boss.work<{ version: 1; runId: string } | unknown>(queue, { batchSize: 1, pollingIntervalSeconds: 2, heartbeatRefreshSeconds: 5 }, async jobs => {
      const job = jobs[0]!;
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
