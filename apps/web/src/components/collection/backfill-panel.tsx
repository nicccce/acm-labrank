'use client';
import { useState } from 'react';
export function BackfillPanel({ busy, enabled, range, submit }: { busy: boolean; enabled: boolean; range: { from: string; to: string }; submit: (from: string, to: string) => void }) {
  const [from, setFrom] = useState(range.from), [to, setTo] = useState(range.to);
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
    <h2 className="text-lg font-semibold">历史区间补采</h2>
    <p className="mt-2 text-sm text-slate-600">补采更早的提交记录，保留已有数据。</p>
    <form className="mt-4 flex flex-wrap items-end gap-4" onSubmit={event => { event.preventDefault(); submit(from, to); }}>
      <label className="text-sm">补采开始日期<input aria-label="补采开始日期" className="ml-2 rounded-lg border p-2" type="date" required value={from} disabled={busy} onChange={event => setFrom(event.target.value)} /></label>
      <label className="text-sm">补采结束日期<input aria-label="补采结束日期" className="ml-2 rounded-lg border p-2" type="date" required min={from} value={to} disabled={busy} onChange={event => setTo(event.target.value)} /></label>
      <button className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50" disabled={busy || !enabled}>补采所选历史区间</button>
    </form>
    <p className="mt-3 text-xs text-slate-500">北京时间，最多 366 天。</p>
  </section>;
}
