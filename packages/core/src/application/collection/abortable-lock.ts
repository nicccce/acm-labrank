import { ConnectorError } from '@acm/connectors/contracts';

/** FIFO lock. Cancelling a waiter never releases or interrupts its current owner. */
export function createAbortableLock() {
  let tail: Promise<void> = Promise.resolve();
  return async function acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new ConnectorError('CANCELLED', 'Session operation cancelled');
    const previous = tail;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    tail = previous.then(() => held);
    try {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(new ConnectorError('CANCELLED', 'Session operation cancelled'));
        signal.addEventListener('abort', cancel, { once: true });
        previous.then(() => { signal.removeEventListener('abort', cancel); resolve(); });
        if (signal.aborted) cancel();
      });
      if (signal.aborted) throw new ConnectorError('CANCELLED', 'Session operation cancelled');
      return release;
    } catch (error) { release(); throw error; }
  };
}
