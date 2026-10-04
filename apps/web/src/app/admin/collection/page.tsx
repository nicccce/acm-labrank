import Link from 'next/link';
import { MemberShell } from '../../../lib/member-page';
import { redirect } from 'next/navigation';
import { getAdminCollectionControl, getAdminCollectionSettings, getAdminPlatforms, getAdminSyncJobs, getPersonalLeaderboard } from '@acm/core/server';
import { currentSession } from '../../../lib/http';
import { CollectionManager } from '../../../components/collection-manager';
export const dynamic = 'force-dynamic';
export default async function CollectionPage() {
  const session = await currentSession();
  if (!session) redirect('/login');
  if (session.user.role !== 'admin') return <main className="p-8">仅管理员可管理采集。<Link href="/">返回首页</Link></main>;
  const [settings, platforms, control, jobs, leaderboard] = await Promise.all([getAdminCollectionSettings(), getAdminPlatforms(), getAdminCollectionControl(), getAdminSyncJobs(new URLSearchParams()), getPersonalLeaderboard(new URLSearchParams())]);
  const initial = JSON.parse(JSON.stringify({ settings, platforms: platforms.items, control, jobs, leaderboard }));
  return <MemberShell session={session} title="采集管理"><nav className="page-tabs" aria-label="管理导航"><Link href="/admin/collection" aria-current="page">采集管理</Link><Link href="/admin/connections">平台连接</Link></nav><div className="admin-content"><CollectionManager csrfToken={session.csrfToken} initial={initial} /></div></MemberShell>;
}
