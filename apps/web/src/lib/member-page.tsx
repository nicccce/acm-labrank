import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AppError } from '@acm/core/server';
import { getScorePlatforms, getSiteSettings } from '@acm/core/server';
import { currentSession } from './http';
import { MemberNav } from '../components/member-nav';
import { PageHeading } from '../components/page-heading';

export type PageSearch = Promise<Record<string, string | string[] | undefined>>;
export async function memberSession() { const session = await currentSession(); if (!session) redirect('/login'); return session; }
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
  const settings = await getSiteSettings();
  return <div className="member-main"><a className="skip-link" href="#main-content">跳至内容</a><header className="member-header"><div className="brand-slot">{settings.headerText && <Link href="/" className="brand" aria-label="榜单首页">{settings.headerText}</Link>}</div><MemberNav userId={session?.user.id} name={session?.user.displayName} admin={session?.user.role === 'admin'} csrfToken={session?.csrfToken} /></header>
    <main id="main-content"><PageHeading title={title} />{children}</main><footer className="site-footer"><span>ACM LAB</span><span className="footer-shapes" aria-hidden="true">● ◒ ■</span><span>每一次 AC，都算数。</span></footer></div>;
}
export function PageError({ message }: { message: string }) { return <p role="alert" className="error">{message}</p>; }
