import { getManagedUsers } from '@acm/core/server';
import { MemberShell, memberSession, pageParams, loadPage, PageError, type PageSearch } from '../../../lib/member-page';
import { UserManager } from '../../../components/user-manager';
import { ManagementFilter } from '../../../components/management-filter';
import { Pagination } from '../../../components/score-display';
export const dynamic = 'force-dynamic';
export default async function UsersPage({ searchParams }: { searchParams: PageSearch }) {
  const session = await memberSession();
  if (session.user.role !== 'admin') return <MemberShell session={session} title="用户管理"><p role="alert">仅管理员可以管理用户。</p></MemberShell>;
  const params = await pageParams(searchParams), result = await loadPage(() => getManagedUsers(params));
  return <MemberShell session={session} title="用户管理"><ManagementFilter params={params} />{result.data ? <><UserManager data={result.data} csrfToken={session.csrfToken} viewerId={session.user.id} /><Pagination path="/admin/users" params={params} {...result.data} /></> : <PageError message={result.error} />}</MemberShell>;
}
