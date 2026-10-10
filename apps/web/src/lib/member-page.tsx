import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AppError } from '@acm/core/server';
import { getScorePlatforms, getSiteSettings } from '@acm/core/server';
import { currentSession } from './http';
import { MemberNav } from '../components/member-nav';
import { PageHeading } from '../components/page-heading';
import { SiteFooter } from '../components/site-footer';

export type PageSearch = Promise<Record<string, string | string[] | undefined>>;
export async function memberSession(allowPasswordChange = false) { const session = await currentSession(); if (!session) redirect('/login'); if (session.user.mustChangePassword && !allowPasswordChange) redirect('/change-password'); return session; }
export async function pageParams(search: PageSearch) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await search)) if (value !== undefined) params.set(key, Array.isArray(value) ? value[value.length - 1]! : value);
  return params;
}
export async function loadPage<T>(fn: () => Promise<T>): Promise<{ data: T; error: null } | { data: null; error: string }> {
  try { return { data: await fn(), error: null }; }
  catch (error) { if (!(error instanceof AppError)) throw error; if (error.status === 404) notFound(); return { data: null, error: error.message }; }
}
export async function scorePlatforms() { return getScorePlatforms(); }
export async function MemberShell({ session, title, children }: { session: Awaited<ReturnType<typeof currentSession>>; title: string; children: React.ReactNode }) {
  if (session?.user.mustChangePassword) redirect('/change-password');
  const settings = await getSiteSettings();
  return <div className="member-main"><a className="skip-link" href="#main-content">跳至内容</a><header className="member-header"><div className="brand-slot">{settings.headerText && <Link href="/" className="brand" aria-label="榜单首页"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>{settings.headerText}</span></Link>}</div><MemberNav userId={session?.user.id} name={session?.user.displayName} admin={session?.user.role === 'admin'} csrfToken={session?.csrfToken} /></header>
    <main id="main-content"><PageHeading title={title} />{children}</main>
    <SiteFooter headerText={settings.headerText} loginText={settings.loginText} /></div>;
}
export function PageError({ message }: { message: string }) { return <p role="alert" className="error">{message}</p>; }
