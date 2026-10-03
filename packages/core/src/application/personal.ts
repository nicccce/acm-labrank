import { z } from 'zod';
import { ConnectorError, type AccountRef, type PlatformId } from '@acm/connectors/contracts';
import { activateBinding, claimSyncRun, commitPersonalPage, ensureCollectionConnection, finishPersonalBatch, getBinding, getCollectionControl, getSyncRun, listBindings, listSyncTargets, memberProfile, queryCoverage, queryLeaderboard, queryLeaderboardCount, queryMemberRecords, queryMemberRecordCount, queryMemberStats, readSyncCursor, refreshVerifiedIdentity, requestPersonalSync, retryPersonalRun, saveBindingCandidate, seedIncrementalCheckpoint, unbindAccount, updateMemberName, type ReadQueueClient } from '@acm/db/server';
import { CF_BANDS, LUOGU_POINTS, SCORING_VERSION, dateRange, displayName } from '../domain';
import { AppError } from './errors';
import { withReadQueue } from './collection/jobs';
import { readPlatform, type ReadRuntimeOptions } from './collection/read';
import { classifyReadFailure } from './collection/errors';

const platforms = ['codeforces', 'luogu', 'qoj'] as const;
export function personalPlatform(platform: string): PlatformId {
  if (!platforms.includes(platform as PlatformId)) throw new AppError('INVALID_INPUT', '不支持的平台', 400); return platform as PlatformId;
}
export async function personalCall<T>(fn: () => Promise<T>) {
  try { return await fn(); } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (['ACCOUNT_OCCUPIED', 'STALE_BINDING', 'SYNC_STATE_CONFLICT', 'SYNC_RANGE_CONFLICT', 'NO_ACTIVE_BINDING', 'TEAM_ACCOUNT_UNSUPPORTED'].includes(code)) throw new AppError(code, code === 'ACCOUNT_OCCUPIED' ? '该平台身份已被绑定' : code === 'SYNC_RANGE_CONFLICT' ? '该账号已有其他日期范围的同步任务，请等待完成后再提交' : '绑定或任务状态已变化，请刷新', 409);
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new AppError('STATE_CONFLICT', '账号或任务已被占用，请刷新', 409);
    throw error;
  }
}
export async function getMemberProfile(id: string) {
  if (!z.uuid().safeParse(id).success) throw new AppError('INVALID_INPUT', '成员 ID 不合法', 400);
  const row = await memberProfile(id); if (!row) throw new AppError('NOT_FOUND', '成员不存在', 404);
  return { id: row.id, username: row.username, realName: row.realName, displayName: displayName(row), role: row.role };
}
export async function saveMemberProfile(id: string, input: unknown) {
  const parsed = z.object({ realName: z.string().trim().max(64).nullable() }).strict().safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '姓名需在 64 字内', 400);
  await updateMemberName(id, parsed.data.realName || null); return getMemberProfile(id);
}
export async function getMemberBindings(userId: string) {
  const rows = await listBindings(userId);
  return { items: platforms.map(platform => {
    const row = rows.find(r => r.platform === platform);
    return { platform, version: row?.version ?? 0, active: row?.account_id ? { accountId: row.account_id, handle: row.handle, externalId: row.external_id } : null,
      candidate: row?.candidate ? { target: row.candidate, state: row.candidate_state, error: row.candidate_error ? JSON.parse(row.candidate_error) : null } : null,
      sync: { lastSuccessAt: row?.latest_success ?? null, historyComplete: row?.history_complete ?? false, coverage: row?.coverage ?? 'unknown' } };
  }) };
}
export async function putMemberBinding(userId: string, platform: PlatformId, input: unknown) {
  const parsed = z.object({ target: z.string().trim().min(1).max(100) }).strict().safeParse(input);
  if (!parsed.success || /[\s/?#\\]/.test(parsed.data.target) || (platform === 'luogu' && !/^[1-9]\d*$/.test(parsed.data.target))) throw new AppError('INVALID_INPUT', '请输入合法的平台账号（洛谷使用 UID）', 400);
  return personalCall(() => withReadQueue(boss => saveBindingCandidate(userId, platform, parsed.data.target, boss)));
}
export async function deleteMemberBinding(userId: string, platform: PlatformId) { await unbindAccount(userId, platform); return { unbound: true }; }
export async function requireCollectionEnabled() {
  if (!(await getCollectionControl()).enabled) throw new AppError('COLLECTION_PAUSED', '采集已暂停，请在完成登录验证后由管理员启用', 409);
}
export async function requestAdminSync(input: unknown) {
  await requireCollectionEnabled();
  const parsed = z.object({ accountIds: z.array(z.uuid()).min(1).max(100).optional(), platforms: z.array(z.enum(platforms)).min(1).max(3).optional(), mode: z.enum(['incremental', 'backfill']).default('incremental'), from: z.string().optional(), to: z.string().optional() }).strict().safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '同步目标参数不合法', 400);
  const range = parsePersonalQuery(new URLSearchParams(parsed.data.from || parsed.data.to ? { ...(parsed.data.from ? { from: parsed.data.from } : {}), ...(parsed.data.to ? { to: parsed.data.to } : {}) } : {})).range;
  const targets = await listSyncTargets(parsed.data.accountIds, parsed.data.platforms);
  return withReadQueue(async boss => {
    const items = [];
    for (const target of targets) {
      try { items.push({ accountId: target.account_id, platform: target.platform, range: { from: range.from, to: range.to, timezone: range.timezone }, ...await personalCall(() => requestPersonalSync(target.id, parsed.data.mode, boss, { from: range.start, to: range.end })) }); }
      catch (error) { items.push({ accountId: target.account_id, platform: target.platform, error: { code: error instanceof AppError ? error.code : 'SYNC_FAILED', message: '目标未入队，请重试' } }); }
    }
    for (const id of parsed.data.accountIds ?? []) if (!targets.some(t => t.account_id === id)) items.push({ accountId: id, error: { code: 'NOT_FOUND', message: '没有生效的目标绑定' } });
    return { items };
  });
}
export async function adminSyncJob(id: string) {
  if (!z.uuid().safeParse(id).success) throw new AppError('INVALID_INPUT', '任务 ID 不合法', 400);
  const run = await getSyncRun(id); if (!run) throw new AppError('NOT_FOUND', '任务不存在', 404);
  const queueState = await withReadQueue(async boss => run.job_id ? (await boss.getJobById(run.queue, run.job_id))?.state ?? 'missing' : 'missing');
  return { id: run.id, bindingId: run.binding_id, accountId: run.account_id, kind: run.kind, mode: run.mode, status: run.status, batch: run.batch, jobId: run.job_id, queueState, pages: run.pages, recordsWithOverlap: run.records, error: run.error, createdAt: run.created_at, finishedAt: run.finished_at,
    range: run.range_from && run.range_to ? { from: new Date(run.range_from.getTime() + 8 * 3600000).toISOString().slice(0, 10), to: new Date(run.range_to.getTime() - 1 + 8 * 3600000).toISOString().slice(0, 10), timezone: 'Asia/Shanghai' } : null, rangeComplete: run.range_complete, stopReason: run.stop_reason,
    sync: run.account_id ? await readSyncCursor(run.account_id, run.mode) .then(c => ({ historyComplete: c.history_complete, coverage: c.coverage, lastSuccessAt: c.last_success_at })) : null };
}
export async function retryAdminSync(id: string) { await adminSyncJob(id); await requireCollectionEnabled(); return personalCall(() => withReadQueue(boss => retryPersonalRun(id, boss))); }

function pointsSql() {
  return `(CASE WHEN p.platform='codeforces' AND p.native_difficulty IS NOT NULL THEN CASE ${CF_BANDS.map(([boundary, points]) => `WHEN p.native_difficulty<${boundary} THEN ${points}`).join(' ')} ELSE 15 END WHEN p.platform='luogu' THEN CASE p.native_difficulty ${LUOGU_POINTS.map((points, i) => `WHEN ${i + 1} THEN ${points}`).join(' ')} ELSE 3 END ELSE 3 END)`;
}
export function parsePersonalQuery(params: URLSearchParams, now = new Date()) {
  const parsed = z.object({ from: z.string().optional(), to: z.string().optional(), days: z.coerce.number().refine(n => n === 7 || n === 30).optional(), platform: z.enum(platforms).optional(), page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new AppError('INVALID_INPUT', '日期、平台或分页参数不合法', 400);
  if ((parsed.data.from && !parsed.data.to) || (!parsed.data.from && parsed.data.to) || (parsed.data.days && parsed.data.from)) throw new AppError('INVALID_INPUT', '自定义日期须同时提供 from、to，并与 days 二选一', 400);
  let range: ReturnType<typeof dateRange>;
  try { range = dateRange(parsed.data, now); } catch { throw new AppError('INVALID_INPUT', '日期无效或区间超过 366 天', 400); }
  return { range, page: parsed.data.page, query: { from: range.start, to: range.end, platforms: parsed.data.platform ? [parsed.data.platform] : [...platforms], limit: parsed.data.limit, offset: (parsed.data.page - 1) * parsed.data.limit, pointsSql: pointsSql() } };
}
function queryMeta(parsed: ReturnType<typeof parsePersonalQuery>, coverage: Awaited<ReturnType<typeof queryCoverage>>) {
  return { ruleVersion: SCORING_VERSION, asOf: new Date().toISOString(), range: { from: parsed.range.from, to: parsed.range.to, timezone: parsed.range.timezone }, platforms: parsed.query.platforms, page: parsed.page, limit: parsed.query.limit, provisional: coverage.some(c => !c.historyComplete || c.coverage !== 'visible' || c.lastError), coverage };
}
export async function getPersonalLeaderboard(params: URLSearchParams) {
  const parsed = parsePersonalQuery(params);
  const [rows, coverage] = await Promise.all([queryLeaderboard(parsed.query), queryCoverage(parsed.query.platforms)]);
  return { ...queryMeta(parsed, coverage), total: rows[0]?.total ?? await queryLeaderboardCount(), items: rows.map(r => ({ id: r.id, displayName: displayName(r), points: r.points, solveCount: r.solveCount, platformSolveCounts: r.platformSolveCounts, lastAcAt: r.lastAcAt, rank: r.rank })) };
}
export async function getPersonalMember(id: string, params: URLSearchParams) {
  const member = await getMemberProfile(id), parsed = parsePersonalQuery(params);
  const [stats, coverage] = await Promise.all([queryMemberStats(id, parsed.query), queryCoverage(parsed.query.platforms, id)]);
  const perPlatform = parsed.query.platforms.map(platform => stats.platforms.find(p => p.platform === platform) ?? { platform, points: 0, solveCount: 0, lastAcAt: null });
  return { ...queryMeta(parsed, coverage), member, points: perPlatform.reduce((n, p) => n + p.points, 0), solveCount: perPlatform.reduce((n, p) => n + p.solveCount, 0), submissionCount: stats.submissionCount, perPlatform, calendar: stats.calendar };
}
export async function getPersonalRecords(id: string, params: URLSearchParams, raw: boolean) {
  await getMemberProfile(id); const parsed = parsePersonalQuery(params);
  const [rows, coverage] = await Promise.all([queryMemberRecords(id, parsed.query, raw), queryCoverage(parsed.query.platforms, id)]);
  return { ...queryMeta(parsed, coverage), total: rows[0]?.total ?? await queryMemberRecordCount(id, parsed.query, raw), items: rows.map(row => { const { total, ...dto } = row; void total; return dto; }) };
}

export async function executePersonalJob(boss: ReadQueueClient, envelope: { syncRunId: string; batch: number }, jobId: string, runtime: ReadRuntimeOptions) {
  if (!await claimSyncRun(envelope.syncRunId, envelope.batch, jobId)) return { ignored: true };
  const run = (await getSyncRun(envelope.syncRunId))!, binding = await getBinding(run.binding_id);
  try {
    await requireCollectionEnabled();
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
          renamed = await refreshVerifiedIdentity(binding.id, binding.version, account);
          if (renamed) throw new ConnectorError('LEASE_LOST', 'Confirmed handle rename requires a safe cursor restart');
        }
      }
    };
    let cursor = run.account_id ? await readSyncCursor(run.account_id, run.mode) : null;
    if (!run.range_from && run.kind === 'sync' && run.mode === 'backfill' && cursor?.history_complete) { await finishPersonalBatch(run.id, boss, { complete: true }); return { id: run.id, status: 'completed' }; }
    if (!run.range_from && run.mode === 'incremental' && run.account_id && !cursor?.checkpoint) { await seedIncrementalCheckpoint(run.account_id); cursor = await readSyncCursor(run.account_id, run.mode); }
    const connectionId = binding.platform === 'codeforces' ? undefined : process.env[binding.platform === 'qoj' ? 'QOJ_CONNECTION_ID' : 'LUOGU_CONNECTION_ID'] ?? `${binding.platform}-lab`;
    const connection = connectionId ? await ensureCollectionConnection(connectionId, binding.platform) : null;
    let cursorVersion = run.range_from ? run.cursor_version : cursor?.version ?? 1;
    const result = await readPlatform({ platform: binding.platform, target: run.kind === 'verify' ? binding.candidate : binding.handle, operation: run.kind === 'verify' ? 'resolve' : 'submissions', mode: run.mode, cursor: run.range_from ? run.scan_cursor : cursor?.cursor ?? null, checkpoint: run.range_from ? run.scan_checkpoint : cursor?.checkpoint ?? null, ...(run.range_from && run.range_to ? { range: { from: run.range_from.toISOString(), to: run.range_to.toISOString() } } : {}), maxPages: 3, maxDurationMs: 120000 }, { ...runtime, onAccount, onPage: async page => { cursorVersion = await commitPersonalPage(run.id, cursorVersion, page, connection ? { id: connection.id, generation: connection.generation } : undefined); } });
    if (renamed) { await finishPersonalBatch(run.id, boss, {}); }
    else if (result.status === 'completed') {
      if (run.kind === 'verify') { if (!resolved || !result.account) throw new Error('UNRESOLVED_ACCOUNT'); await activateBinding(run.id, result.account, boss); }
      else await finishPersonalBatch(run.id, boss, { complete: result.stopReason !== 'more' });
    } else {
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
    await finishPersonalBatch(run.id, boss, { error: classified, paused: classified.code === 'COLLECTION_PAUSED', candidateState: run.kind === 'verify' ? candidateState : undefined });
    return { id: run.id, status: 'failed' };
  }
}
function accountKeyForCompare(platform: string, value: string) { return platform === 'codeforces' ? value.toLowerCase() : value; }
