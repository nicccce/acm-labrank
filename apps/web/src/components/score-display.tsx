import { formatPoints } from '@acm/core/domain';
import { platformNames } from '@acm/connectors/metadata';
import type { CoverageItem } from '@acm/core/contracts';
import Link from 'next/link';

export function formatTime(value: string | Date | null | undefined) { return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—'; }
export { platformNames } from '@acm/connectors/metadata';
export function Pagination({ path, params, page, limit, total }: { path: string; params: URLSearchParams; page: number; limit: number; total: number }) {
  function href(n: number) { const query = new URLSearchParams(params); query.set('page', String(n)); return `${path}?${query}`; }
  return <div className="pagination"><span>共 {total} 条 · 第 {page} 页</span>{page > 1 && <Link href={href(page - 1)}>上一页</Link>}{page * limit < total && <Link href={href(page + 1)}>下一页</Link>}</div>;
}
export function ScoreSummary({ points, solveCount, rank, provisional, submissionCount }: { points: number; solveCount: number; rank: number | null; provisional: boolean; submissionCount?: number }) {
  return <div className="score-summary"><span>排名 <strong>{rank ?? '—'}</strong></span><span>积分 <strong>{formatPoints(points)}</strong></span><span>题数 <strong>{solveCount}</strong></span>{submissionCount !== undefined && <span>提交 <strong>{submissionCount}</strong></span>}{provisional && <span className="muted">暂定</span>}</div>;
}

export function CoverageTable({ items }: { items: CoverageItem[] }) {
  if (!items.length) return null;
  return <section><h2>同步状态</h2><div className="table-wrap"><table className="data-table"><thead><tr><th>平台</th><th>账号</th><th>最近同步</th><th>历史</th><th>状态</th></tr></thead><tbody>{items.map(c => <tr key={`${c.userId}:${c.platform}`}><td>{platformNames[c.platform]}</td><td>{c.handle ?? '—'}</td><td>{formatTime(c.lastSuccessAt)}</td><td>{c.historyComplete ? '完整' : c.initializedAt ? '初始窗口完成；更早历史未完整' : '初始窗口未完成'}</td><td>{c.lastError?.message ?? (c.coverage === 'restricted' ? '权限受限' : c.candidateState === 'pending' ? '验证中' : c.coverage === 'visible' ? '正常' : '未同步')}</td></tr>)}</tbody></table></div></section>;
}
