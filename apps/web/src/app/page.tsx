import { currentSession } from '../lib/http';
import { getAdminConnectionAlerts, getPersonalLeaderboard } from '@acm/core/server';
import { AdminConnectionNotice } from '../components/admin-connection-notice';
import { loadPage, MemberShell, pageParams, PageError, scorePlatforms, type PageSearch } from '../lib/member-page';
import { ScoreFilter } from '../components/score-filter';
import { Pagination } from '../components/score-display';
import { LeaderboardTable } from '../components/leaderboard-table';
import { LeaderboardDisclaimer } from '../components/leaderboard-disclaimer';
export const dynamic = 'force-dynamic';
export default async function HomePage({ searchParams }: { searchParams: PageSearch }) {
  const session = await currentSession(), params = await pageParams(searchParams);
  const [result, platforms, alerts] = await Promise.all([loadPage(() => getPersonalLeaderboard(params)), scorePlatforms(), session?.user.role === 'admin' ? getAdminConnectionAlerts().catch(() => ({ items: [] })) : Promise.resolve({ items: [] })]);
  const data = result.data;
  const detailQuery = new URLSearchParams(params); detailQuery.delete('page');
  return <MemberShell session={session} title="个人榜">{session?.user.role === 'admin' && <AdminConnectionNotice csrfToken={session.csrfToken} initial={alerts.items} />}{data ? <div className="leaderboard-surface">
    <ScoreFilter key={params.toString()} query={Object.fromEntries(params)} range={data.range} platforms={platforms} />
    {data.provisional && <p className="leaderboard-notice">部分历史待同步 · 排名暂定</p>}
    <LeaderboardTable items={data.items.map(row => ({ ...row, name: row.displayName }))} kind="personal" userId={session?.user.id} signedIn={Boolean(session)} detailQuery={detailQuery} />
    <Pagination path="/" params={params} page={data.page} limit={data.limit} total={data.total} />
    <LeaderboardDisclaimer />
  </div> : <PageError message={result.error!} />}</MemberShell>;
}
