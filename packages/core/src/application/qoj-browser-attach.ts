import { readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorError } from '@acm/connectors/contracts';

/** Local operator handshake only; never accepts credentials or page contents. */
export async function waitForQojBrowserAttach(gate: { file: string; id: string }, signal: AbortSignal) {
  while (true) {
    if (signal.aborted) throw new ConnectorError('CANCELLED', 'QOJ browser attachment cancelled');
    const pending = JSON.parse(await readFile(gate.file, 'utf8'));
    if (pending.id !== gate.id || typeof pending.confirmed !== 'boolean') throw new ConnectorError('STALE_CHALLENGE', 'QOJ browser attachment event changed');
    const expires = Date.parse(pending.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) throw new ConnectorError('TIMEOUT', 'QOJ browser attachment expired');
    if (pending.confirmed) {
      signal.throwIfAborted();
      await rm(gate.file);
      return;
    }
    try { await delay(Math.min(250, expires - Date.now()), undefined, { signal }); }
    catch { throw new ConnectorError('CANCELLED', 'QOJ browser attachment cancelled'); }
  }
}
