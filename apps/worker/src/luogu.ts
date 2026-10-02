import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, unlink, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { beginLuoguLogin, collectLuogu } from '@acm/core/server';
import { closeDb } from '@acm/db/server';

const { values } = parseArgs({ options: {
  account: { type: 'string' }, connection: { type: 'string', default: 'luogu-lab' }, mode: { type: 'string', default: 'backfill' },
  'max-pages': { type: 'string', default: '2' }, 'timeout-ms': { type: 'string', default: '600000' },
  state: { type: 'string' }, login: { type: 'boolean', default: false }, username: { type: 'string' },
  'captcha-file': { type: 'string', default: '.local/luogu/captcha.png' },
} });
type Result = Awaited<ReturnType<typeof collectLuogu>>;
function summary(result: Result) {
  return { event: 'luogu_collection', target: { handle: result.account.handle, uid: result.account.externalId },
    collectorVerified: true, pages: result.pages, uniqueSubmissions: result.submissions.length, uniqueProblems: result.problems.length,
    verdicts: Object.fromEntries(['accepted', 'rejected', 'pending', 'unknown'].map(v => [v, result.submissions.filter(s => s.verdict === v).length])),
    nativeStatuses: [...new Set(result.submissions.map(s => s.nativeStatus))],
    earliestSubmittedAt: result.submissions.map(s => s.submittedAt).filter(s => s !== null).sort()[0] ?? null,
    latestSubmittedAt: result.submissions.map(s => s.submittedAt).filter(s => s !== null).sort().at(-1) ?? null,
    stopReason: result.stopReason, hasMore: result.cursor !== null, coverage: result.coverage,
    visibleHistoryComplete: result.stopReason === 'history_end', teamEvidence: false, participations: 'none' };
}
try {
  const maxPages = Number(values['max-pages']), timeoutMs = Number(values['timeout-ms']);
  if (!values.account || !['backfill', 'incremental'].includes(values.mode) || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) throw new Error('INVALID_ARGUMENTS');
  const signal = AbortSignal.timeout(timeoutMs);
  const mode = values.mode as 'backfill' | 'incremental';
  const connectionId = values.connection;
  if (values.login) {
    if (!values.username) throw new Error('LOGIN_USERNAME_REQUIRED');
    const attempt = await beginLuoguLogin({ username: values.username, connectionId, signal, target: values.account });
    const captchaPath = resolve(values['captcha-file']);
    await mkdir(dirname(captchaPath), { recursive: true });
    async function showChallenge() {
      const challenge = attempt.getChallenge();
      await writeFile(captchaPath, challenge.image, { mode: 0o600 });
      console.log(JSON.stringify({ event: 'captcha_required', version: challenge.version, expiresAt: new Date(challenge.expiresAt).toISOString(), image: captchaPath }));
    }
    await showChallenge();
    // Raw terminal input prevents passwords/captcha from being echoed into logs.
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    const input = createInterface({ input: process.stdin, terminal: false });
    const cancel = () => input.close();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for await (const line of input) {
        const command = JSON.parse(line) as { action: string; version: number; password: string; captcha: string; expectedHandle: string };
        if (command.action === 'cancel') break;
        if (command.action === 'refresh') { await attempt.refresh(command.version); await showChallenge(); continue; }
        if (command.action !== 'login') throw new Error('INVALID_LOGIN_ACTION');
        const result = await attempt.complete(command);
        console.log(JSON.stringify({ ...summary(result), encryptedSessionSaved: true }));
        break;
      }
    } finally { signal.removeEventListener('abort', cancel); input.close(); if (process.stdin.isTTY) process.stdin.setRawMode(false); process.stdin.pause(); await unlink(captchaPath).catch(() => undefined); }
  } else {
    let state: { version: number; target: string; connection: string; records?: Record<string, Result['submissions'][number]>; problems?: Record<string, Result['problems'][number]>; backfill?: { cursor: Result['cursor']; checkpoint: Result['checkpoint'] }; incremental?: { cursor: Result['cursor']; checkpoint: Result['checkpoint'] } } = { version: 1, target: values.account, connection: connectionId };
    if (values.state) {
      try { state = JSON.parse(await readFile(values.state, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (state.version !== 1 || state.target !== values.account || state.connection !== connectionId) throw new Error('STATE_TARGET_MISMATCH');
    }
    const old = state[mode];
    const result = await collectLuogu({ account: values.account, connectionId, mode, signal, maxPages, cursor: old?.cursor, checkpoint: mode === 'incremental' ? old?.checkpoint ?? state.backfill?.checkpoint : null,
      async onPage(page) {
        if (!values.state) return;
        state.records ??= {}; state.problems ??= {};
        for (const row of page.submissions) state.records[row.externalSubmissionId] = row;
        for (const row of page.problems) state.problems[row.problemKey] = row;
        state[mode] = { cursor: page.nextCursor, checkpoint: page.nextCheckpoint ?? old?.checkpoint ?? null };
        const path = resolve(values.state); await mkdir(dirname(path), { recursive: true });
        // Atomic page facts + scan position; this optional file is a local debugging artifact.
        const pending = `${path}.pending`; await writeFile(pending, JSON.stringify(state, null, 2)); await rename(pending, path);
      },
    });
    console.log(JSON.stringify(summary(result)));
  }
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'LUOGU_WORKER_FAILED';
  console.error(JSON.stringify({ event: 'luogu_failed', code })); process.exitCode = 1;
} finally { await closeDb(); }
