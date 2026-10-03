import { z } from 'zod';
import { ConnectorError, type AccountRef } from '@acm/connectors/contracts';
import { platformIds } from '@acm/connectors/metadata';
import { activateBinding, assertPersonalRunAvailable, collectionAvailability, getCollectionSettings, restartPersonalScan, claimSyncRun, commitPersonalPage, ensureCollectionConnection, finishPersonalBatch, getBinding, getCollectionControl, getSyncCursor, getSyncRun, listSyncTargets, readSyncCursor, refreshVerifiedIdentity, requestPersonalSync, retryPersonalRun, type ReadQueueClient } from '@acm/db/server';
import { AppError } from '../errors';
import { personalCall } from '../members/profile';
import { parsePersonalQuery } from '../scores/query';
import { withReadQueue } from './jobs';
import { readPlatform, type ReadRuntimeOptions } from './read';
import { classifyReadFailure } from './errors';
import { collectionSettingsCall, collectionSkipMessages } from './settings';
const platforms = platformIds;

export async function requireCollectionEnabled() {
  if (!(await getCollectionControl()).enabled) throw new AppError('COLLECTION_PAUSED', '采集已暂停，请在完成登录验证后由管理员启用', 409);
}
export async function requestAdminSync(input: unknown, actorId?: string) {
  await requireCollectionEnabled();
  const parsed = z.object({ accountIds: z.array(z.uuid()).min(1).max(100).optional(), platforms: z.array(z.enum(platforms)).min(1).max(3).optional(), mode: z.enum(['incremental', 'backfill']).default('incremental'), from: z.string().optional(), to: z.string().optional() }).strict().safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '同步目标参数不合法', 400);
  const settings = await getCollectionSettings();
  const range = parsed.data.from || parsed.data.to ? parsePersonalQuery(new URLSearchParams({ ...(parsed.data.from ? { from: parsed.data.from } : {}), ...(parsed.data.to ? { to: parsed.data.to } : {}) }), new Date(), settings).range : undefined;
  const selected = parsed.data.platforms ?? settings.platforms;
  const targets = await listSyncTargets(parsed.data.accountIds, selected);
  return withReadQueue(async boss => {
    const items = [];
    for (const target of targets) {
      const availability = await collectionAvailability(target.platform);
      if (availability.reason) { items.push({ accountId: target.account_id, platform: target.platform, skipped: availability.reason, message: collectionSkipMessages[availability.reason] }); continue; }
      try {
        const result = await collectionSettingsCall(() => personalCall(() => requestPersonalSync(target.id, parsed.data.mode, boss, range ? { from: range.start, to: range.end } : undefined, 'manual', actorId)));
        const run = (await getSyncRun(result.runId))!;
        items.push({ accountId: target.account_id, platform: target.platform, scope: run.scope, initialFrom: run.initial_from?.toISOString() ?? null, range: run.range_from && run.range_to ? { from: new Date(run.range_from.getTime() + 8 * 3600000).toISOString().slice(0, 10), to: new Date(run.range_to.getTime() - 1 + 8 * 3600000).toISOString().slice(0, 10), timezone: 'Asia/Shanghai' } : null, ...result });
      }
      catch (error) { items.push({ accountId: target.account_id, platform: target.platform, error: { code: error instanceof AppError ? error.code : 'SYNC_FAILED', message: error instanceof AppError ? error.message : '目标未入队，请重试' } }); }
    }
    for (const id of parsed.data.accountIds ?? []) if (!targets.some(t => t.account_id === id)) items.push({ accountId: id, error: { code: 'NOT_FOUND', message: '没有生效的目标绑定' } });
    for (const platform of selected) if (!targets.some(t => t.platform === platform)) { const state = await collectionAvailability(platform); const skipped = state.reason ?? 'NO_ACTIVE_BINDING'; items.push({ platform, skipped, message: collectionSkipMessages[skipped] }); }
    return { items };
  });
}
export async function adminSyncJob(id: string) {
  if (!z.uuid().safeParse(id).success) throw new AppError('INVALID_INPUT', '任务 ID 不合法', 400);
  const run = await getSyncRun(id); if (!run) throw new AppError('NOT_FOUND', '任务不存在', 404);
  const queueState = await withReadQueue(async boss => run.job_id ? (await boss.getJobById(run.queue, run.job_id))?.state ?? 'missing' : 'missing');
  return { id: run.id, bindingId: run.binding_id, accountId: run.account_id, kind: run.kind, mode: run.mode, source: run.source, status: run.status, batch: run.batch, jobId: run.job_id, queueState, pages: run.pages, recordsWithOverlap: run.records, error: run.error, createdAt: run.created_at, startedAt: run.started_at, finishedAt: run.finished_at,
    scope: run.scope, initialFrom: run.initial_from?.toISOString() ?? null, range: run.range_from && run.range_to ? { from: new Date(run.range_from.getTime() + 8 * 3600000).toISOString().slice(0, 10), to: new Date(run.range_to.getTime() - 1 + 8 * 3600000).toISOString().slice(0, 10), timezone: 'Asia/Shanghai' } : null, rangeComplete: run.range_complete, stopReason: run.stop_reason,
    sync: run.account_id ? await getSyncCursor(run.account_id, run.mode).then(c => c ? ({ initializedAt: c.initialized_at, historyComplete: c.history_complete, coverage: c.coverage, lastSuccessAt: c.last_success_at }) : null) : null };
}
export async function retryAdminSync(id: string) { await adminSyncJob(id); await requireCollectionEnabled(); return collectionSettingsCall(() => personalCall(() => withReadQueue(boss => retryPersonalRun(id, boss)))); }

export async function executePersonalJob(boss: ReadQueueClient, envelope: { syncRunId: string; batch: number }, jobId: string, runtime: ReadRuntimeOptions) {
  if (!await claimSyncRun(envelope.syncRunId, envelope.batch, jobId)) return { ignored: true };
  const run = (await getSyncRun(envelope.syncRunId))!, binding = await getBinding(run.binding_id);
  try {
    await requireCollectionEnabled();
    await collectionSettingsCall(() => assertPersonalRunAvailable(run.id));
    if (!binding || binding.version !== run.binding_version || (run.kind === 'sync' && binding.account_id !== run.account_id)) throw new Error('STALE_BINDING');
    // A crash after committing the terminal page must not restart the scan at the head.
    if (run.kind === 'sync' && run.stop_reason !== 'more') { await finishPersonalBatch(run.id, boss, { complete: true }); return { id: run.id, status: 'completed' }; }
    let resolved: AccountRef | null = null;
    let renamed = false;
    const onAccount = async (account: AccountRef) => {
      resolved = account;
      if (run.kind === 'sync') {
        if (account.kind !== 'person' || account.externalId !== (binding.external_id ?? null)) throw new ConnectorError('ACCOUNT_AMBIGUOUS', '账号身份已变化，请重新验证绑定');
        if (accountKeyForCompare(binding.platform, account.handle) !== accountKeyForCompare(binding.platform, binding.handle!)) {
          renamed = await refreshVerifiedIdentity(binding.id, binding.version, account, run.id);
          if (renamed) throw new ConnectorError('LEASE_LOST', 'Confirmed handle rename requires a safe cursor restart');
        }
      }
    };
    if (run.account_id) await readSyncCursor(run.account_id, run.mode, run.id);
    const connectionId = binding.platform === 'codeforces' ? undefined : process.env[binding.platform === 'qoj' ? 'QOJ_CONNECTION_ID' : 'LUOGU_CONNECTION_ID'] ?? `${binding.platform}-lab`;
    const connection = connectionId ? await ensureCollectionConnection(connectionId, binding.platform) : null;
    let cursorVersion = run.cursor_version;
    const beforeRequest = async () => { try { await assertPersonalRunAvailable(run.id); } catch (error) { throw new ConnectorError(error instanceof Error && error.message === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'CANCELLED', '采集设置、绑定或任务状态已变化'); } await runtime.beforeRequest?.(); };
    const result = await readPlatform({ platform: binding.platform, target: run.kind === 'verify' ? binding.candidate : binding.handle, operation: run.kind === 'verify' ? 'resolve' : 'submissions', mode: run.mode, cursor: run.scan_cursor, checkpoint: run.scan_checkpoint, ...(run.initial_from ? { since: run.initial_from.toISOString() } : {}), ...(run.range_from && run.range_to ? { range: { from: run.range_from.toISOString(), to: run.range_to.toISOString() } } : {}), maxPages: 3, maxDurationMs: 120000 }, { ...runtime, beforeRequest, onAccount, onPage: async page => { cursorVersion = await commitPersonalPage(run.id, cursorVersion, page, connection ? { id: connection.id, generation: connection.generation } : undefined); } });
    if (renamed) { await finishPersonalBatch(run.id, boss, {}); }
    else if (result.status === 'completed') {
      if (run.kind === 'verify') { if (!resolved || !result.account) throw new Error('UNRESOLVED_ACCOUNT'); await activateBinding(run.id, result.account, boss); }
      else await finishPersonalBatch(run.id, boss, { complete: result.stopReason !== 'more' });
    } else {
      if (run.kind === 'sync' && result.batchStatus === 'budget_exhausted' && result.progress.pages > 0) { await finishPersonalBatch(run.id, boss, {}); return { id: run.id, status: 'queued' }; }
      if (run.kind === 'sync' && ['PAGINATION_DRIFT', 'INVALID_CURSOR'].includes(result.error?.code ?? '') && run.retries < 3) { await restartPersonalScan(run.id, result.error?.code === 'INVALID_CURSOR'); await finishPersonalBatch(run.id, boss, { error: result.error, retryDelay: 5 }); return { id: run.id, status: 'queued' }; }
      const error = { ...result.error!, connectionGeneration: connection?.generation ?? null };
      if (!(await getCollectionControl()).enabled) { await finishPersonalBatch(run.id, boss, { paused: true, error: { code: 'COLLECTION_PAUSED', message: '采集已暂停，已提交页面保留', action: 'retry' } }); return { id: run.id, status: 'paused' }; }
      const temporary = ['RATE_LIMITED', 'NETWORK_ERROR', 'TEMP_UNAVAILABLE', 'HTTP_ERROR', 'TIMEOUT'].includes(error.code);
      await finishPersonalBatch(run.id, boss, { error, paused: ['reauthenticate', 'human_verify', 'fix_parser'].includes(error.action), retryDelay: temporary && run.retries < 3 ? Math.max(5 * 2 ** run.retries + Math.floor(Math.random() * 3), error.retryAt ? Math.ceil((Date.parse(error.retryAt) - Date.now()) / 1000) : 0) : undefined, candidateState: run.kind === 'verify' ? error.code === 'ACCOUNT_NOT_FOUND' ? 'not_found' : error.action === 'unsupported' ? 'unsupported' : 'unavailable' : undefined });
    }
    return { id: run.id, status: (await getSyncRun(run.id))?.status };
  } catch (error) {
    const code = error instanceof Error ? error.message : 'SYNC_FAILED';
    const candidateState = code === 'ACCOUNT_OCCUPIED' ? 'occupied' : code === 'TEAM_ACCOUNT_UNSUPPORTED' ? 'unsupported' : 'unavailable';
    const classified = error instanceof ConnectorError ? classifyReadFailure(error, binding?.platform ?? 'codeforces').error : { code: error instanceof AppError ? error.code : ['STALE_BINDING', 'STALE_CURSOR', 'STALE_CONNECTION', 'ACCOUNT_OCCUPIED', 'TEAM_ACCOUNT_UNSUPPORTED', 'COLLECTION_PAUSED'].includes(code) ? code : 'SYNC_FAILED', message: '同步未完成，已提交页面保留', action: 'retry' };
    if (classified.code === 'AUTH_REQUIRED') classified.action = 'reauthenticate';
    await finishPersonalBatch(run.id, boss, { error: classified, paused: classified.code === 'COLLECTION_PAUSED' || ['reauthenticate', 'human_verify', 'fix_parser'].includes(classified.action), candidateState: run.kind === 'verify' ? candidateState : undefined });
    return { id: run.id, status: 'failed' };
  }
}
function accountKeyForCompare(platform: string, value: string) { return platform === 'codeforces' ? value.toLowerCase() : value; }
