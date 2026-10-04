import Link from 'next/link';
import { MemberShell } from '../../../lib/member-page';
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
  return <MemberShell session={session} title="平台连接"><nav className="page-tabs" aria-label="管理导航"><Link href="/admin/collection">采集管理</Link><Link href="/admin/connections" aria-current="page">平台连接</Link></nav><div className="admin-content"><PlatformConnections csrfToken={session.csrfToken} vncUrl={process.env.QOJ_VNC_URL ?? 'http://localhost:6080/vnc.html?autoconnect=1&resize=scale'} initialConnections={initialConnections} initialControl={control} /></div></MemberShell>;
}
