import { currentSession } from '../../lib/http';
import { getTeamLeaderboard } from '@acm/core/server';
import { loadPage, MemberShell, pageParams, PageError, scorePlatforms, type PageSearch } from '../../lib/member-page';
import { ScoreFilter } from '../../components/score-filter';
import { Pagination } from '../../components/score-display';
import { LeaderboardTable } from '../../components/leaderboard-table';
import { LeaderboardDisclaimer } from '../../components/leaderboard-disclaimer';
export const dynamic = 'force-dynamic';
export default async function TeamLeaderboardPage({ searchParams }: { searchParams: PageSearch }) {
  const session = await currentSession(), params = await pageParams(searchParams);
  const [result, platforms] = await Promise.all([loadPage(() => getTeamLeaderboard(params)), scorePlatforms()]); const data = result.data;
  const detailQuery = new URLSearchParams(params); detailQuery.delete('page');
  return <MemberShell session={session} title="团队榜">{data ? <div className="leaderboard-surface">
    <ScoreFilter key={params.toString()} query={Object.fromEntries(params)} range={data.range} platforms={platforms} />
    <LeaderboardTable items={data.items} kind="team" signedIn={Boolean(session)} detailQuery={detailQuery} />
    <Pagination path="/team-leaderboard" params={params} page={data.page} limit={data.limit} total={data.total} />
    <LeaderboardDisclaimer />
  </div> : <PageError message={result.error!} />}</MemberShell>;
}
