import Link from 'next/link';
import { getTeamLeaderboard } from '@acm/core/server';
import { loadPage, MemberShell, memberSession, pageParams, PageError, scorePlatforms, type PageSearch } from '../../lib/member-page';
import { ScoreFilter } from '../../components/score-filter';
import { formatTime, Pagination } from '../../components/score-display';
export const dynamic = 'force-dynamic';
export default async function TeamLeaderboardPage({ searchParams }: { searchParams: PageSearch }) {
  const session = await memberSession(), params = await pageParams(searchParams);
  const [result, platforms] = await Promise.all([loadPage(() => getTeamLeaderboard(params)), scorePlatforms()]); const data = result.data;
  const detailQuery = new URLSearchParams(params); detailQuery.delete('page');
  return <MemberShell session={session} title="团队榜">{data ? <>
    <ScoreFilter key={params.toString()} query={Object.fromEntries(params)} range={data.range} platforms={platforms} />
    <div className="table-wrap"><table className="data-table"><thead><tr><th>排名</th><th>队伍</th><th>成员</th><th>积分</th><th>题数</th><th>CF</th><th>QOJ</th><th>洛谷</th><th>最近 AC</th><th>状态</th></tr></thead><tbody>{data.items.map(row => <tr key={row.id}><td>{row.rank}</td><td><Link href={`/teams/${row.id}?${detailQuery}`}>{row.name}</Link></td><td>{row.members.map(m => m.displayName).join('、')}</td><td>{row.points}</td><td>{row.solveCount}</td><td>{row.platformSolveCounts.codeforces ?? 0}</td><td>{row.platformSolveCounts.qoj ?? 0}</td><td>{row.platformSolveCounts.luogu ?? 0}</td><td>{formatTime(row.lastAcAt)}</td><td>{row.provisional ? '暂定' : '—'}</td></tr>)}{!data.items.length && <tr><td colSpan={10}>暂无队伍</td></tr>}</tbody></table></div>
    <Pagination path="/team-leaderboard" params={params} page={data.page} limit={data.limit} total={data.total} />
  </> : <PageError message={result.error!} />}</MemberShell>;
}
