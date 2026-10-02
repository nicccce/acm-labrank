import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { closeDb, createBoss, QOJ_READ_QUEUE } from '@acm/db/server';
import { createQojReadWorker, createQojMemoryStore, qojReadJobSchema, type QojReadJob } from '@acm/core/server';
import { qojHumanInput } from './qoj-human';

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'muhammad' }, connection: { type: 'string', default: 'qoj-lab' },
  browser: { type: 'boolean' }, headed: { type: 'boolean' }, headless: { type: 'boolean' },
  'browser-channel': { type: 'string' }, 'browser-executable': { type: 'string' },
  'browser-proxy': { type: 'string' }, 'browser-cdp': { type: 'string' },
  pages: { type: 'string', default: '2' }, mode: { type: 'string', default: 'backfill' }, state: { type: 'string' }, checkpoint: { type: 'string' },
  'duration-ms': { type: 'string', default: '120000' }, 'timeout-ms': { type: 'string', default: '30000' }, retries: { type: 'string', default: '2' },
  'human-timeout-ms': { type: 'string', default: '120000' }, 'human-retries': { type: 'string', default: '2' }, 'confirm-file': { type: 'string' },
  'challenge-image': { type: 'string', default: '.local/qoj-challenge.png' }, 'http-diagnostics': { type: 'boolean' },
  'login-user': { type: 'string' }, memory: { type: 'boolean' }, enqueue: { type: 'boolean' },
  'direct-read': { type: 'boolean' },
} });
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
let worker: ReturnType<typeof createQojReadWorker> | undefined;
try {
  if (values.headless && values.headed) throw new Error('CONFLICTING_BROWSER_MODE');
  const channel = values['browser-channel'];
  if (channel && !['msedge', 'chrome', 'chromium'].includes(channel)) throw new Error('INVALID_BROWSER_CHANNEL');
  let input: QojReadJob = { target: values.target, mode: values.mode as 'backfill' | 'incremental', maxPages: Number(values.pages), maxDurationMs: Number(values['duration-ms']) };
  if (values.state) {
    try {
      const saved = JSON.parse(await readFile(values.state, 'utf8'));
      if (saved.target !== input.target || saved.mode !== input.mode) throw new Error('STATE_SCAN_MISMATCH');
      input = { ...input, cursor: saved.cursor, checkpoint: saved.checkpoint };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (values.checkpoint) input.checkpoint = JSON.parse(await readFile(values.checkpoint, 'utf8'));
  input = qojReadJobSchema.parse(input);
  if (values.enqueue) {
    if (values.memory || values.browser || values.headed || values.headless || values['browser-executable'] || values['browser-proxy'] || values['browser-cdp'] || channel || values['confirm-file']) throw new Error('ENQUEUE_USES_WORKER_ENV_CONFIGURATION');
    const boss = createBoss();
    try {
      await boss.start();
      const id = await boss.send(QOJ_READ_QUEUE, input, { singletonKey: `${input.target}:${input.mode}`, expireInSeconds: 960, heartbeatSeconds: 30 });
      console.log(JSON.stringify({ event: 'qoj_read_enqueued', jobId: id, merged: id === null, queue: QOJ_READ_QUEUE }));
    } finally { await boss.stop(); }
  } else {
    worker = createQojReadWorker({ transport: values.browser || process.env.QOJ_TRANSPORT === 'browser' ? 'browser' : 'node', connectionId: values.connection, signal: controller.signal,
      ...(process.env.QOJ_BROWSER_ATTACH_FILE && process.env.QOJ_BROWSER_ATTACH_ID ? { browserAttach: { file: process.env.QOJ_BROWSER_ATTACH_FILE, id: process.env.QOJ_BROWSER_ATTACH_ID } } : {}),
      browser: { headed: !values.headless, channel: channel as 'msedge' | 'chrome' | 'chromium' | undefined, executablePath: values['browser-executable'], proxyServer: values['browser-proxy'] ?? process.env.QOJ_BROWSER_PROXY_SERVER, cdpEndpoint: values['browser-cdp'] ?? process.env.QOJ_BROWSER_CDP_ENDPOINT, timeoutMs: Number(values['timeout-ms']), maxRetries: Number(values.retries), ...(values.memory ? { memoryStore: createQojMemoryStore() } : {}),
        ...(values['http-diagnostics'] ? { diagnostic: data => console.log(JSON.stringify({ event: 'qoj_browser_response', ...data })) } : {}) },
      humanTimeoutMs: Number(values['human-timeout-ms']), humanRetries: Number(values['human-retries']), expectedLoginHandle: values['login-user'],
      onHumanInput: qojHumanInput({ image: values['challenge-image'], confirmationFile: values['confirm-file'] }),
      ...(values['http-diagnostics'] ? { diagnostic: data => console.log(JSON.stringify({ event: 'qoj_http', ...data })) } : {}),
    });
    let checkpoint = input.checkpoint ?? null;
    const result = await worker.execute(input, controller.signal, async page => {
      checkpoint = page.nextCheckpoint ?? checkpoint;
      if (values.state) {
        await mkdir(dirname(values.state), { recursive: true });
        const temporary = `${values.state}.tmp`;
        await writeFile(temporary, JSON.stringify({ target: input.target, mode: input.mode, cursor: page.nextCursor, checkpoint }, null, 2));
        await rename(temporary, values.state);
      }
      const sample = page.submissions.slice(-1).map(({ externalSubmissionId, problemKey, submittedAt, nativeResult, sourceUrl }) => ({ externalSubmissionId, problemKey, submittedAt, nativeResult, sourceUrl }));
      console.log(JSON.stringify({ event: 'qoj_page', sourceUrl: page.sourceUrl, recordsWithOverlap: page.submissions.length, stopReason: page.stopReason, observedAt: page.observedAt, sample }));
    });
    console.log(JSON.stringify({ event: 'qoj_scan', target: input.target, ...result, submissions: undefined, problems: undefined }));
    if (result.status !== 'completed') process.exitCode = result.status === 'human_input_required' ? 2 : 1;
  }
} catch { console.error(JSON.stringify({ event: 'qoj_debug_failed', code: 'CONFIGURATION_OR_INPUT_FAILED' })); process.exitCode = 1; }
finally { await worker?.close(); await closeDb(); }
