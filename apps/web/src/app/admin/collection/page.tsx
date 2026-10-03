import Link from 'next/link';
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
  return <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6"><nav className="flex gap-5 text-sm text-blue-700"><Link href="/">返回首页</Link><Link href="/admin/connections">管理平台登录</Link></nav><header><p className="text-sm text-slate-500">管理员 · 训练数据</p><h1 className="mt-2 text-3xl font-bold">采集与积分更新</h1><p className="mt-3 text-slate-600">设置榜单查询区间，查看首次采集与持续增量进度，按需补采更早历史。</p></header><CollectionManager csrfToken={session.csrfToken} initial={initial} /></main>;
}
