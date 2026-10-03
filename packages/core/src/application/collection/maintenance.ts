import { dispatchDueCollection, maintainPersonalRuns } from '@acm/db/server';
import { maintainReadQueue } from './jobs';
import type { ReadQueueClient } from '@acm/db/server';
export async function maintainCollectionJobs(boss: ReadQueueClient, dispatch: boolean) {
  await maintainReadQueue(boss);
  await maintainPersonalRuns(boss);
  if (dispatch) await dispatchDueCollection(boss);
}
