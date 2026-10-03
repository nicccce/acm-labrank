'use client';
import Link from 'next/link';
import type { Dispatch, SetStateAction } from 'react';
import type { Platform, Settings, Rate, PlatformInfo } from '@acm/core/contracts';
const buttonBase = 'rounded-lg border px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
const button = `${buttonBase} border-slate-300 bg-white hover:bg-slate-50`;
const field = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm';
const panel = 'rounded-2xl border border-slate-200 bg-white p-5 sm:p-6';
function time(value: string | null) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'; }

export function PlatformPanel({ platforms, settings, rates, busy, setRates, saveRate }: { platforms: PlatformInfo[]; settings: Settings; rates: Record<Platform, Rate>; busy: boolean; setRates: Dispatch<SetStateAction<Record<Platform, Rate>>>; saveRate: (platform: Platform) => void }) {
  return <>
    <section className="grid gap-4 lg:grid-cols-3" aria-label="平台采集状态">{platforms.map(platform => {
      const summary = settings.items.find(item => item.platform === platform.platform), rate = rates[platform.platform];
      return <article key={platform.platform} className={panel}><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{platform.name}</h2><span className={`rounded-full px-3 py-1 text-xs ${settings.platforms.includes(platform.platform) ? 'bg-blue-50 text-blue-800' : 'bg-slate-100 text-slate-600'}`}>{settings.platforms.includes(platform.platform) ? '参与采集与计分' : '未启用'}</span></div><p className="mt-3 text-sm">{platform.connection.state === 'not_required' ? '公开 API，无需登录' : `登录：${platform.connection.state === 'ready' ? '已就绪' : '待登录/核验'} · ${platform.connection.collector ?? '未核验身份'}`}</p><p className="mt-2 text-sm text-amber-800">{summary?.message ?? (summary?.blockedCount ? `${summary.blockedCount} 个目标已暂停，请检查任务错误。` : '可正常采集')}</p><dl className="mt-4 space-y-2 text-sm text-slate-600"><div>生效绑定：{summary?.bindingCount ?? 0}</div><div>本地题目 / 提交：{summary?.problemCount ?? 0} / {summary?.submissionCount ?? 0}</div><div>最近成功：{time(summary?.lastSuccessAt ?? null)}</div><div>下次同步：{time(summary?.nextSyncAt ?? null)}</div></dl>{platform.platform !== 'codeforces' && <Link className="mt-3 inline-block text-sm text-blue-700" href="/admin/connections">登录或核验平台 →</Link>}<fieldset className="mt-5 border-t pt-4" disabled={busy}><legend className="pt-3 text-sm font-medium">单次请求随机间隔（毫秒）</legend><div className="mt-2 flex items-center gap-2"><input aria-label={`${platform.name}最小请求间隔`} className={`${field} w-full min-w-0`} type="number" min={platform.platform === 'codeforces' ? 2000 : 1000} max={60000} value={rate.minIntervalMs} onChange={e => setRates({ ...rates, [platform.platform]: { ...rate, minIntervalMs: Number(e.target.value) } })} /><span>至</span><input aria-label={`${platform.name}最大请求间隔`} className={`${field} w-full min-w-0`} type="number" min={rate.minIntervalMs} max={60000} value={rate.maxIntervalMs} onChange={e => setRates({ ...rates, [platform.platform]: { ...rate, maxIntervalMs: Number(e.target.value) } })} /></div><button className={`${button} mt-3`} onClick={() => saveRate(platform.platform)}>保存请求间隔</button></fieldset></article>;
    })}</section>

  </>;
}
