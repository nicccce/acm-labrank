import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { waitForQojBrowserAttach } from './browser-attach';
import { createQojReadWorker } from './worker';

async function gateTest(run: (gate: { file: string; id: string }, write: (confirmed: boolean, extra?: object) => Promise<void>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'qoj-attach-test-'));
  const gate = { file: join(directory, 'gate.json'), id: 'test-event' };
  const write = (confirmed: boolean, extra = {}) => writeFile(gate.file, JSON.stringify({ id: gate.id, confirmed, expiresAt: new Date(Date.now() + 5000).toISOString(), ...extra }));
  try { await write(false); await run(gate, write); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
it('does not connect CDP before confirmation and cancellation leaves the pending gate reusable', async () => {
  await gateTest(async gate => {
    let connected = false;
    const worker = createQojReadWorker({ connectionId: 'test', transport: 'browser', signal: new AbortController().signal, browserAttach: gate, browserFactory: async () => { connected = true; throw new Error('must not connect'); } });
    const controller = new AbortController();
    const running = worker.execute({ target: 'sample_person' }, controller.signal);
    await vi.waitFor(() => expect(connected).toBe(false));
    controller.abort();
    expect(await running).toMatchObject({ status: 'cancelled', pages: 0, checkpoint: null });
    expect(connected).toBe(false);
    expect(JSON.parse(await readFile(gate.file, 'utf8')).confirmed).toBe(false);
    await worker.close();
  });
});
it('cancels while waiting for confirmation and preserves the event', async () => {
  await gateTest(async gate => {
    const controller = new AbortController();
    const waiting = waitForQojBrowserAttach(gate, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
    await access(gate.file);
  });
});
it('consumes one matching unexpired confirmation and rejects stale or expired attachment events', async () => {
  await gateTest(async (gate, write) => {
    const signal = new AbortController().signal;
    await write(true, { id: 'old-event' });
    await expect(waitForQojBrowserAttach(gate, signal)).rejects.toMatchObject({ code: 'STALE_CHALLENGE' });
    await write(true, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await expect(waitForQojBrowserAttach(gate, signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await write(true);
    await waitForQojBrowserAttach(gate, signal);
    await expect(access(gate.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
it('counts attachment waiting against the job budget without publishing any progress', async () => {
  await gateTest(async gate => {
    const worker = createQojReadWorker({ connectionId: 'test', transport: 'browser', signal: new AbortController().signal, browserAttach: gate, browserFactory: async () => { throw new Error('must not connect'); } });
    expect(await worker.execute({ target: 'sample_person', maxDurationMs: 25 }, new AbortController().signal)).toMatchObject({ status: 'timeout', code: 'TIMEOUT', pages: 0, checkpoint: null });
    await worker.close();
  });
});
