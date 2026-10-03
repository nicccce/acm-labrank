import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAdminCollectionControl, getAdminPlatforms } from '@acm/core/server';
import { currentSession } from '../../../lib/http';
import { PlatformConnections } from '../../../components/platform-connections';
export const dynamic = 'force-dynamic';
export default async function ConnectionsPage() {
  const session = await currentSession(); if (!session) redirect('/login');
  if (session.user.role !== 'admin') return <main className="p-8">仅管理员可管理采集连接。<Link href="/">返回首页</Link></main>;
  const [platforms, control] = await Promise.all([getAdminPlatforms(), getAdminCollectionControl()]);
  const initialConnections = Object.fromEntries(platforms.items.map(p => [p.platform, { state: p.connection.state, collector: p.connection.collector }]));
  return <main className="mx-auto max-w-6xl p-6"><nav className="flex gap-5 text-blue-700"><Link href="/">返回首页</Link><Link href="/admin/collection">采集与积分更新</Link></nav><h1 className="my-6 text-2xl font-bold">平台采集连接</h1><PlatformConnections csrfToken={session.csrfToken} vncUrl={process.env.QOJ_VNC_URL ?? 'http://localhost:6080/vnc.html?autoconnect=1&resize=scale'} initialConnections={initialConnections} initialControl={control} /></main>;
}
