import Link from 'next/link';
import { currentSession } from '../lib/http';
import { formatPoints } from '@acm/core/domain';
import { getPersonalLeaderboard } from '@acm/core/server';
import { loadPage, MemberShell, pageParams, PageError, scorePlatforms, type PageSearch } from '../lib/member-page';
import { ScoreFilter } from '../components/score-filter';
import { formatTime, Pagination } from '../components/score-display';
export const dynamic = 'force-dynamic';
export default async function HomePage({ searchParams }: { searchParams: PageSearch }) {
  const session = await currentSession(), params = await pageParams(searchParams);
  const [result, platforms] = await Promise.all([loadPage(() => getPersonalLeaderboard(params)), scorePlatforms()]);
  const data = result.data;
  const detailQuery = new URLSearchParams(params); detailQuery.delete('page');
  return <MemberShell session={session} title="个人榜">{data ? <>
    <ScoreFilter key={params.toString()} query={Object.fromEntries(params)} range={data.range} platforms={platforms} />
    {data.provisional && <p className="muted" style={{ marginBottom: 12 }}>部分历史待同步 · 排名暂定</p>}
    <div className="table-wrap"><table className="data-table"><thead><tr><th>排名</th><th>姓名</th><th>积分</th><th>题数</th><th>CF</th><th>QOJ</th><th>洛谷</th><th>最近 AC</th></tr></thead><tbody>{data.items.map(row => <tr key={row.id} className={row.id === session?.user.id ? 'self-row' : undefined}><td><span className={`rank-badge rank-${row.rank}`}>{row.rank}</span></td><td>{session ? <Link href={`/members/${row.id}?${detailQuery}`}>{row.displayName}</Link> : <span className="entry-name">{row.displayName}</span>}{row.id === session?.user.id && <span className="self-tag">我</span>}</td><td className="points-cell">{formatPoints(row.points)}</td><td>{row.solveCount}</td><td>{row.platformSolveCounts.codeforces ?? 0}</td><td>{row.platformSolveCounts.qoj ?? 0}</td><td>{row.platformSolveCounts.luogu ?? 0}</td><td>{formatTime(row.lastAcAt)}</td></tr>)}{!data.items.length && <tr><td colSpan={8} className="empty-state">当前区间暂无成绩{session && <Link href="/profile">绑定平台账号 ↗</Link>}</td></tr>}</tbody></table></div>
    <Pagination path="/" params={params} page={data.page} limit={data.limit} total={data.total} />
  </> : <PageError message={result.error!} />}</MemberShell>;
}
