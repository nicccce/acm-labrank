import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AppError } from '@acm/core/server';
import { getScorePlatforms } from '@acm/core/server';
import { currentSession } from './http';
import { LogoutButton } from '../components/logout-button';

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
export function MemberShell({ session, title, children }: { session: Awaited<ReturnType<typeof memberSession>>; title: string; children: React.ReactNode }) {
  return <main className="member-main"><header className="member-header"><Link href="/" className="brand">ACM 实验室榜单</Link><LogoutButton csrfToken={session.csrfToken} /></header>
    <nav className="member-nav" aria-label="主导航"><Link href="/">个人榜</Link><Link href="/team-leaderboard">团队榜</Link><Link href={`/members/${session.user.id}`}>我的成绩</Link><Link href="/profile">我的资料</Link><Link href="/teams">我的队伍</Link>{session.user.role === 'admin' && <><Link href="/admin/collection">采集与积分更新</Link><Link href="/admin/connections">管理平台登录</Link></>}</nav>
    <h1>{title}</h1>{children}</main>;
}
export function PageError({ message }: { message: string }) { return <p role="alert" className="error">{message}</p>; }
