'use client';
import { useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { platformNames } from './score-display';

export function ScoreFilter({ query, range, platforms, extra = {} }: { query: Record<string, string>; range: { from: string; to: string }; platforms: string[]; extra?: Record<string, string> }) {
  const router = useRouter(), path = usePathname();
  const [mode, setMode] = useState(query.from ? 'custom' : query.days ?? 'default');
  const [platform, setPlatform] = useState(query.platform ?? '');
  const [from, setFrom] = useState(query.from ?? range.from), [to, setTo] = useState(query.to ?? range.to);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  function navigate(nextMode: string, nextPlatform: string, dates = { from, to }) {
    setError('');
    if (nextMode === 'custom' && (Date.parse(dates.to) - Date.parse(dates.from)) / 86400000 > 365) { setError('日期区间最多 366 天'); return; }
    const params = new URLSearchParams(extra);
    if (query.limit) params.set('limit', query.limit);
    if (nextMode === 'custom') { params.set('from', dates.from); params.set('to', dates.to); }
    else if (nextMode !== 'default') params.set('days', nextMode);
    if (nextPlatform) params.set('platform', nextPlatform);
    startTransition(() => router.push(`${path}${params.size ? `?${params}` : ''}`, { scroll: false }));
  }
  return <form className="score-filter" aria-label="成绩筛选" aria-busy={pending} onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); navigate(mode, platform, { from: String(data.get('from')), to: String(data.get('to')) }); }}>
    <div className="filter-toolbar"><div className="segmented" aria-label="日期区间">{[['default', '默认'], ['7', '近 7 天'], ['30', '近 30 天'], ['custom', '自定义']].map(([value, label]) => <button type="button" key={value} aria-pressed={mode === value} disabled={pending} onClick={() => { setMode(value!); if (value !== 'custom') navigate(value!, platform); }}>{label}</button>)}</div>
    <label className="platform-filter"><span className="sr-only">平台</span><select aria-label="平台" value={platform} disabled={pending} onChange={e => { setPlatform(e.target.value); if (mode !== 'custom') navigate(mode, e.target.value); }}><option value="">全部平台</option>{platforms.map(p => <option key={p} value={p}>{platformNames[p]}</option>)}</select></label><span className="filter-range" role="status">{pending ? '更新中…' : `${range.from} — ${range.to}`}</span></div>
    {mode === 'custom' && <div className="custom-range"><label>开始日期<input type="date" name="from" required defaultValue={from} max={to} onChange={e => setFrom(e.target.value)} /></label><span aria-hidden="true">—</span><label>结束日期<input type="date" name="to" required min={from} defaultValue={to} onChange={e => setTo(e.target.value)} /></label><button className="button primary" disabled={pending}>应用筛选</button></div>}
    {error && <p role="alert" className="error">{error}</p>}
  </form>;
}
