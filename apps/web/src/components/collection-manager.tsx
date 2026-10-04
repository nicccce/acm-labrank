'use client';
import { BackfillPanel } from './collection/backfill-panel';
import { ResetPanel } from './collection/reset-panel';
import { ScorePreview } from './collection/score-preview';
import { JobsPanel } from './collection/jobs-panel';
import { PlatformPanel } from './collection/platform-panel';
import { SettingsPanel } from './collection/settings-panel';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { Platform, Range, Settings, Rate, PlatformInfo, Jobs, Leaderboard, Initial, DispatchResult } from '@acm/core/contracts';
import { platformNames as labels } from '@acm/connectors/metadata';
import { apiRequest, requestMessage } from './api-request';

const buttonBase = 'rounded-lg border px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
const button = `${buttonBase} border-slate-300 bg-white hover:bg-slate-50`;
const primary = `${buttonBase} border-blue-700 bg-blue-700 text-white hover:bg-blue-800`;
const panel = 'rounded-2xl border border-slate-200 bg-white p-5 sm:p-6';
function outcome(data: DispatchResult) {
  const count = data.items.filter(item => item.runId && !item.merged).length;
  const merged = data.items.filter(item => item.merged).length;
  const skips = [...new Set(data.items.filter(item => item.skipped || item.error).map(item => item.message ?? item.error?.message ?? item.skipped))];
  return `新建 ${count} 个任务，合并 ${merged} 个已有任务。${skips.join('；')}`;
}
export function CollectionManager({ csrfToken, initial }: { csrfToken: string; initial: Initial }) {
  const [settings, setSettings] = useState(initial.settings), [draft, setDraft] = useState(initial.settings);
  const [platforms, setPlatforms] = useState(initial.platforms), [rates, setRates] = useState(Object.fromEntries(initial.platforms.map(p => [p.platform, p.rateLimit])) as Record<Platform, Rate>);
  const [control, setControl] = useState(initial.control), [jobs, setJobs] = useState(initial.jobs), [leaderboard, setLeaderboard] = useState(initial.leaderboard);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [pollError, setPollError] = useState('');
  const [cursor, setCursor] = useState<string | null>(null), [previousCursors, setPreviousCursors] = useState<(string | null)[]>([]);
  const [resetPlatforms, setResetPlatforms] = useState<Platform[]>([]), [reset, setReset] = useState<{ requestId: string; version: number } | null>(null);
  const [resetAttempted, setResetAttempted] = useState(false);
  const refreshId = useRef(0), polling = useRef<AbortController | null>(null), acting = useRef(false);
  const call = useCallback(<T,>(url: string, method = 'GET', body?: unknown, signal?: AbortSignal) => apiRequest<T>(url, csrfToken, method, body, signal), [csrfToken]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const revision = ++refreshId.current;
    const [s, p, c, j, l] = await Promise.all([call<Settings>('/api/admin/collection-settings', 'GET', undefined, signal), call<{ items: PlatformInfo[] }>('/api/admin/platforms', 'GET', undefined, signal), call<Initial['control']>('/api/admin/collection-control', 'GET', undefined, signal), call<Jobs>(`/api/admin/sync-jobs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, signal), call<Leaderboard>('/api/leaderboard', 'GET', undefined, signal)]);
    if (signal?.aborted || revision !== refreshId.current) return { settings: s, platforms: p.items };
    setSettings(s); setPlatforms(p.items); setControl(c); setJobs(j); setLeaderboard(l); setPollError('');
    return { settings: s, platforms: p.items };
  }, [call, cursor]);
  const invalidateRefresh = useCallback(() => { ++refreshId.current; }, []);
  useEffect(() => {
    const controller = new AbortController(); polling.current = controller;
    let stopped = false, pending = false;
    const poll = async () => { if (stopped || pending || acting.current || document.hidden) return; pending = true; const active = new AbortController(); polling.current = active; try { await refresh(AbortSignal.any([controller.signal, active.signal])); } catch (error) { if (!stopped && !controller.signal.aborted && !active.signal.aborted && !acting.current) setPollError(requestMessage(error)); } finally { pending = false; } };
    void poll(); const timer = setInterval(() => void poll(), 5000);
    return () => { stopped = true; controller.abort(); invalidateRefresh(); clearInterval(timer); };
  }, [refresh, invalidateRefresh]);
  async function action(fn: () => Promise<void>) {
    acting.current = true; polling.current?.abort(); ++refreshId.current;
    setBusy(true); setMessage('');
    try { await fn(); await refresh(); } catch (error) { setMessage(requestMessage(error)); } finally { acting.current = false; setBusy(false); }
  }
  const setRange = (range: Range) => setDraft({ ...draft, scoreRange: range });
  const selectedSummary = settings.items.filter(item => resetPlatforms.includes(item.platform));
  function dialogKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && !busy) { setReset(null); return; }
    if (event.key !== 'Tab') return;
    const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)');
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
  }
  return <div className="space-y-6">
    <section className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">数据同步</h2><p className="mt-2 text-sm text-slate-600">{control.enabled ? '运行中' : '已暂停'}</p></div><button className={button} disabled={busy} onClick={() => void action(async () => { setControl(await call('/api/admin/collection-control', 'PUT', { enabled: !control.enabled, version: control.version })); setMessage(control.enabled ? '采集已暂停，已入库数据保留。' : '采集已恢复。'); })}>{control.enabled ? '暂停采集' : '启用采集'}</button></div>
      <div className="mt-5 flex flex-wrap gap-3"><button className={primary} disabled={busy || !control.enabled || !settings.platforms.length} onClick={() => void action(async () => { const result = await call<DispatchResult>('/api/admin/sync', 'POST', {}); setMessage(outcome(result)); })}>立即同步</button><button className={button} disabled={busy} onClick={() => void action(async () => { const data = await refresh(); setDraft(data.settings); setRates(Object.fromEntries(data.platforms.map(p => [p.platform, p.rateLimit])) as Record<Platform, Rate>); setMessage('已重新读取最新设置。'); })}>刷新设置</button></div>
      <p role="status" aria-live="polite" className="mt-4 min-h-5 text-sm text-blue-800">{busy ? '正在处理，请稍候…' : message}</p>{pollError && <p role="alert" className="mt-2 text-sm text-red-700">自动刷新失败：{pollError}</p>}
    </section>
    <details className="disclosure"><summary>同步与计分设置</summary><SettingsPanel draft={draft} settings={settings} busy={busy} leaderboard={leaderboard} setDraft={setDraft} setRange={setRange} save={() => void action(async () => { const result = await call<{ settings: Settings } & DispatchResult>('/api/admin/collection-settings', 'PUT', { platforms: draft.platforms, autoSyncEnabled: draft.autoSyncEnabled, syncIntervalMinutes: draft.syncIntervalMinutes, scoreRange: draft.scoreRange, version: draft.version }); setDraft({ ...draft, ...result.settings }); setMessage(`设置已保存。${outcome(result)}`); })} />
    </details><PlatformPanel platforms={platforms} settings={settings} rates={rates} busy={busy} setRates={setRates} saveRate={platformId => void action(async () => { const updated = await call<Rate>(`/api/admin/platforms/${platformId}/rate-limit`, 'PATCH', { minIntervalMs: rates[platformId].minIntervalMs, maxIntervalMs: rates[platformId].maxIntervalMs, version: rates[platformId].version }); setRates(current => ({ ...current, [platformId]: updated })); setMessage(`${labels[platformId]}请求间隔已保存。`); })} />
    <JobsPanel jobs={jobs} busy={busy} control={control} cursor={cursor} previousCursors={previousCursors} setCursor={setCursor} setPreviousCursors={setPreviousCursors} retry={id => void action(async () => { await call(`/api/admin/sync-jobs/${id}/retry`, 'POST', {}); setMessage('重试任务已入队。'); })} />
    <details className="disclosure"><summary>积分预览</summary><ScorePreview leaderboard={leaderboard} /></details>
    <details className="disclosure"><summary>补采历史</summary><BackfillPanel busy={busy} enabled={control.enabled && settings.platforms.length > 0} range={leaderboard.range} submit={(from, to) => void action(async () => { const result = await call<DispatchResult>('/api/admin/sync', 'POST', { mode: 'backfill', from, to }); setMessage(`历史补采已提交。${outcome(result)}`); })} />
    </details><details className="disclosure danger"><summary>清空与重爬</summary><ResetPanel settings={settings} control={control} busy={busy} leaderboard={leaderboard} reset={reset} resetAttempted={resetAttempted} resetPlatforms={resetPlatforms} selectedSummary={selectedSummary} message={message} setReset={setReset} setResetPlatforms={setResetPlatforms} dialogKeys={dialogKeys} open={() => { setMessage(''); setResetPlatforms(settings.items.filter(item => !item.skipped).map(item => item.platform)); setReset({ requestId: crypto.randomUUID(), version: settings.version }); setResetAttempted(false); }} confirm={() => reset && void action(async () => { setResetAttempted(true); const result = await call<DispatchResult>('/api/admin/collection-reset', 'POST', { platforms: resetPlatforms, version: reset.version, requestId: reset.requestId }); setReset(null); setMessage(`已清空并开始重爬。${outcome(result)}`); })} />
    </details>
  </div>;
}
