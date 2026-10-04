import Link from 'next/link';
import { getSiteSettings } from '@acm/core/server';
import { MemberShell, memberSession } from '../../../lib/member-page';
import { SiteSettingsEditor } from '../../../components/site-settings-editor';
export const dynamic = 'force-dynamic';
export default async function SitePage() {
  const session = await memberSession();
  if (session.user.role !== 'admin') return <MemberShell session={session} title="站点设置"><p role="alert">仅管理员可以修改站点设置。</p><Link href="/">返回榜单</Link></MemberShell>;
  const settings = await getSiteSettings();
  return <MemberShell session={session} title="站点设置"><SiteSettingsEditor initial={settings} csrfToken={session.csrfToken} /></MemberShell>;
}
