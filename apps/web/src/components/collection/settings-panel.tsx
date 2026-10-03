'use client';
import type { Dispatch, SetStateAction } from 'react';
import type { Range, Settings, Leaderboard } from '@acm/core/contracts';
import { platformNames as labels } from '@acm/connectors/metadata';
const buttonBase = 'rounded-lg border px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
const primary = `${buttonBase} border-blue-700 bg-blue-700 text-white hover:bg-blue-800`;
const field = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm';
const panel = 'rounded-2xl border border-slate-200 bg-white p-5 sm:p-6';

export function SettingsPanel({ draft, settings, busy, leaderboard, setDraft, setRange, save }: { draft: Settings; settings: Settings; busy: boolean; leaderboard: Leaderboard; setDraft: Dispatch<SetStateAction<Settings>>; setRange: (range: Range) => void; save: () => void }) {
  return <>
    <section className={panel}>
      <h2 className="text-lg font-semibold">计分查询与自动同步</h2><p className="mt-2 text-sm text-slate-600">平台开关控制采集和计分；修改查询日期只调整榜单，不重扫提交或清空增量进度。</p>
      <fieldset className="mt-5 flex flex-wrap gap-6" disabled={busy}><legend className="sr-only">参与平台</legend>{(['codeforces', 'luogu', 'qoj'] as const).map(platform => <label key={platform} className="flex items-center gap-2"><input type="checkbox" checked={draft.platforms.includes(platform)} onChange={e => setDraft({ ...draft, platforms: e.target.checked ? [...draft.platforms, platform] : draft.platforms.filter(p => p !== platform) })} />{labels[platform]}</label>)}</fieldset>
      <div className="mt-5 grid gap-5 md:grid-cols-2"><div><label className="block text-sm font-medium" htmlFor="score-range">榜单默认查询区间（北京时间）</label><select id="score-range" className={`${field} mt-2 w-full`} disabled={busy} value={draft.scoreRange.kind === 'fixed' ? 'fixed' : String(draft.scoreRange.days)} onChange={e => setRange(e.target.value === 'fixed' ? { kind: 'fixed', from: leaderboard.range.from, to: leaderboard.range.to } : { kind: 'rolling', days: Number(e.target.value) as 7 | 30 })}><option value="7">滚动近 7 天（包含今天）</option><option value="30">滚动近 30 天（包含今天）</option><option value="fixed">自定义起止日期</option></select>{draft.scoreRange.kind === 'fixed' && <div className="mt-3 flex flex-wrap items-center gap-3"><label className="text-sm">开始<input aria-label="开始日期" type="date" className={`${field} ml-2`} value={draft.scoreRange.from} disabled={busy} onChange={e => { if (draft.scoreRange.kind === 'fixed') setRange({ ...draft.scoreRange, from: e.target.value }); }} /></label><label className="text-sm">结束<input aria-label="结束日期" type="date" className={`${field} ml-2`} value={draft.scoreRange.to} disabled={busy} onChange={e => { if (draft.scoreRange.kind === 'fixed') setRange({ ...draft.scoreRange, to: e.target.value }); }} /></label><p className="text-xs text-slate-500">包含首尾日期，最多 366 天。</p></div>}</div><div><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" disabled={busy} checked={draft.autoSyncEnabled} onChange={e => setDraft({ ...draft, autoSyncEnabled: e.target.checked })} />开启自动增量同步</label><label className="mt-3 block text-sm">统一同步周期<input className={`${field} mx-2 w-28`} type="number" min={1} max={10080} disabled={busy} value={draft.syncIntervalMinutes} onChange={e => setDraft({ ...draft, syncIntervalMinutes: Number(e.target.value) })} />分钟</label><p className="mt-2 text-xs text-slate-500">1 分钟至 7 天；360 分钟为 6 小时。平台的 HTTP 请求间隔在下面单独设置。</p></div></div>
      {settings.version !== draft.version && <p role="alert" className="mt-4 text-sm text-amber-800">设置已被其他管理员修改，请重新读取后保存。</p>}
      <button className={`${primary} mt-5`} disabled={busy || settings.version !== draft.version} onClick={save}>保存设置</button>
    </section>

  </>;
}
