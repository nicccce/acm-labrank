'use client';
import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { platformNames } from './score-display';

export function ScoreFilter({ query, range, platforms, extra = {} }: { query: Record<string, string>; range: { from: string; to: string }; platforms: string[]; extra?: Record<string, string> }) {
  const router = useRouter(), path = usePathname();
  const [mode, setMode] = useState(query.from ? 'custom' : query.days ?? 'default');
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget), params = new URLSearchParams(extra);
    if (mode === 'custom') { params.set('from', String(data.get('from'))); params.set('to', String(data.get('to'))); }
    else if (mode !== 'default') params.set('days', mode);
    if (data.get('platform')) params.set('platform', String(data.get('platform')));
    router.push(`${path}?${params}`);
  }
  return <form className="filter-form" onSubmit={submit}><label>日期<select aria-label="日期" value={mode} onChange={e => setMode(e.target.value)}><option value="default">默认区间</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="custom">自定义</option></select></label>{mode === 'custom' && <><label>开始日期<input type="date" name="from" required defaultValue={query.from ?? range.from} /></label><label>结束日期<input type="date" name="to" required defaultValue={query.to ?? range.to} /></label></>}
    <label>平台<select aria-label="平台" name="platform" defaultValue={query.platform ?? ''}><option value="">全部</option>{platforms.map(p => <option key={p} value={p}>{platformNames[p]}</option>)}</select></label><button className="button" type="submit">查询</button><span className="muted">{range.from} — {range.to}</span></form>;
}
