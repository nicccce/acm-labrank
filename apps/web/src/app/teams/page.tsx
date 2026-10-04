import Link from 'next/link';
import { getTeams } from '@acm/core/server';
import { loadPage, MemberShell, memberSession, pageParams, PageError, type PageSearch } from '../../lib/member-page';
import { TeamEditor } from '../../components/team-editor';
import { Pagination } from '../../components/score-display';
export const dynamic = 'force-dynamic';
export default async function TeamsPage({ searchParams }: { searchParams: PageSearch }) {
  const session = await memberSession(), params = await pageParams(searchParams); params.set('mine', '1');
  const result = await loadPage(() => getTeams(params, session.user.id)), data = result.data;
  return <MemberShell session={session} title="我的队伍"><nav className="page-tabs" aria-label="队伍状态"><Link href="/teams" aria-current={params.get('status') !== 'archived' ? 'page' : undefined}>进行中</Link><Link href="/teams?status=archived" aria-current={params.get('status') === 'archived' ? 'page' : undefined}>已归档</Link></nav>{data ? <>
    <div className="table-wrap"><table className="data-table"><thead><tr><th>队伍</th><th>成员</th></tr></thead><tbody>{data.items.map(t => <tr key={t.id}><td><Link href={`/teams/${t.id}`}>{t.name}</Link></td><td>{t.members.map(m => m.displayName).join('、')}</td></tr>)}{!data.items.length && <tr><td colSpan={2} className="empty-state">暂无{params.get('status') === 'archived' ? '已归档' : '进行中'}队伍</td></tr>}</tbody></table></div><Pagination path="/teams" params={params} page={data.page} limit={data.limit} total={data.total} />
  </> : <PageError message={result.error!} />}<details className="disclosure" open={data?.total === 0 && params.get('status') !== 'archived'}><summary>＋ 创建队伍</summary><TeamEditor self={session.user} csrfToken={session.csrfToken} /></details></MemberShell>;
}
