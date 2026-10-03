'use client';
import type { Leaderboard } from '@acm/core/contracts';
const panel = 'rounded-2xl border border-slate-200 bg-white p-5 sm:p-6';
function time(value: string | null) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'; }

export function ScorePreview({ leaderboard }: { leaderboard: Leaderboard }) {
  return <>
    <section className={panel}><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">当前积分榜预览</h2><p className="mt-2 text-sm text-slate-600">{leaderboard.range.from} 至 {leaderboard.range.to} · 北京时间 · {leaderboard.total} 位成员</p></div><span className={`rounded-full px-3 py-1 text-xs ${leaderboard.provisional ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'}`}>{leaderboard.provisional ? '历史采集未完整，积分暂定' : '已采集数据计算完成'}</span></div><p className="mt-3 text-xs text-slate-500">首次 AC 按全部已采集有效记录确定，积分采用当前题目难度与 v1 规则。这里显示前 20 位。</p><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="border-b text-slate-500"><tr>{['名次', '成员', '积分', '首次 AC 题数', '最近首次 AC'].map(text => <th key={text} className="px-3 py-3 font-medium">{text}</th>)}</tr></thead><tbody>{leaderboard.items.map(item => <tr key={item.id} className="border-b last:border-0"><td className="px-3 py-3">{item.rank}</td><td className="px-3 py-3 font-medium">{item.displayName}</td><td className="px-3 py-3 text-blue-800">{item.points}</td><td className="px-3 py-3">{item.solveCount}</td><td className="px-3 py-3 text-slate-500">{time(item.lastAcAt)}</td></tr>)}</tbody></table>{!leaderboard.items.length && <p className="py-6 text-center text-sm text-slate-500">暂无成员。</p>}</div></section>

  </>;
}
