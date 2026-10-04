import { beforeEach, expect, it, vi } from 'vitest';
import { getCollectionControl, getReadRun, type ReadQueueClient } from '@acm/db/server';
import { readPlatform } from '@acm/core/server';
import { registerPlatformQueues } from './queues';

vi.mock('@acm/db/server', () => ({ PLATFORM_READ_QUEUES: { luogu: 'luogu' }, getReadRun: vi.fn(), getCollectionControl: vi.fn(async () => ({ enabled: false })) }));
vi.mock('@acm/core/server', async () => ({ ConnectorError: (await import('../../../../packages/connectors/src/contracts/index')).ConnectorError, parsePlatformReadRequest: (input: unknown) => input, readPlatform: vi.fn(async () => ({ status: 'completed' })), readOutcomeSummary: (input: unknown) => input }));
beforeEach(() => vi.clearAllMocks());
it.each(['verify_session', 'submissions'])('processes %s with the collection switch paused only for identity checks', async operation => {
  const work = vi.fn();
  await registerPlatformQueues({ work } as unknown as ReadQueueClient, { signal: new AbortController().signal }, 'luogu-lab');
  vi.mocked(getReadRun).mockResolvedValueOnce({ id: 'run', platform: 'luogu', queue: 'luogu', jobId: 'job', input: { platform: 'luogu', operation } } as NonNullable<Awaited<ReturnType<typeof getReadRun>>>);
  const execute = work.mock.calls[0]![2];
  const pending = execute([{ id: 'job', data: { version: 1, runId: 'run' }, signal: new AbortController().signal }]);
  if (operation === 'verify_session') {
    await expect(pending).resolves.toMatchObject({ status: 'completed' });
    expect(readPlatform).toHaveBeenCalledOnce();
    expect(getCollectionControl).not.toHaveBeenCalled();
  } else {
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(readPlatform).not.toHaveBeenCalled();
  }
});
