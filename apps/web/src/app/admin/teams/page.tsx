import { getManagedTeams } from '@acm/core/server';
import { MemberShell, memberSession, pageParams, loadPage, PageError, type PageSearch } from '../../../lib/member-page';
import { TeamStarManager } from '../../../components/team-star-manager';
import { ManagementFilter } from '../../../components/management-filter';
import { Pagination } from '../../../components/score-display';
export const dynamic = 'force-dynamic';
export default async function TeamsAdminPage({ searchParams }: { searchParams: PageSearch }) {
  const session = await memberSession();
  if (session.user.role !== 'admin') return <MemberShell session={session} title="队伍打星管理"><p role="alert">仅管理员可以管理队伍打星。</p></MemberShell>;
  const params = await pageParams(searchParams), result = await loadPage(() => getManagedTeams(params));
  return <MemberShell session={session} title="队伍打星管理"><ManagementFilter params={params} team />{result.data ? <><TeamStarManager data={result.data} csrfToken={session.csrfToken} /><Pagination path="/admin/teams" params={params} {...result.data} /></> : <PageError message={result.error} />}</MemberShell>;
}
