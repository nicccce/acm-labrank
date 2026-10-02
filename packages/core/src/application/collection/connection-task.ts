import { randomUUID } from 'node:crypto';
import { acquireConnectionTask, releaseConnectionTask, renewConnectionTask } from '@acm/db/server';
import { ConnectorError } from '@acm/connectors/contracts';

export async function holdConnectionTask(id: string, signal: AbortSignal) {
  const token = randomUUID();
  const lifetime = new AbortController();
  const taskSignal = AbortSignal.any([signal, lifetime.signal]);
  taskSignal.throwIfAborted();
  while (!await acquireConnectionTask(id, token)) {
    taskSignal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(new ConnectorError('CANCELLED', 'Connection task cancelled')); };
      const timer = setTimeout(() => { taskSignal.removeEventListener('abort', cancel); resolve(); }, 250);
      taskSignal.addEventListener('abort', cancel, { once: true });
      if (taskSignal.aborted) cancel();
    });
  }
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void renewConnectionTask(id, token).then(owned => { if (!owned) lifetime.abort(new ConnectorError('LEASE_LOST', 'Connection task lease lost')); })
      .catch(() => lifetime.abort(new ConnectorError('LEASE_LOST', 'Connection task lease unavailable'))).finally(() => { renewing = false; });
  }, 5000);
  return {
    token, signal: taskSignal,
    async check() { if (!await renewConnectionTask(id, token)) throw new ConnectorError('LEASE_LOST', 'Connection task lease lost'); taskSignal.throwIfAborted(); },
    async release() { clearInterval(timer); lifetime.abort(); await releaseConnectionTask(id, token); },
  };
}
