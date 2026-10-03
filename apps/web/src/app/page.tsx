import { redirect } from 'next/navigation';
import Link from 'next/link';
import { platforms } from '@acm/connectors/metadata';
import { currentSession } from '../lib/http';
import { LogoutButton } from '../components/logout-button';
export const dynamic = 'force-dynamic';
export default async function HomePage() {
  const session = await currentSession();
  if (!session) redirect('/login');
  return <main className="mx-auto max-w-5xl px-6 py-10">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-6"><div><p className="text-sm font-semibold text-blue-700">ACM 实验室</p><h1 className="mt-2 text-3xl font-bold">训练榜单</h1></div><LogoutButton csrfToken={session.csrfToken} /></header>
    <section className="py-8"><h2 className="text-xl font-semibold">你好，{session.user.displayName}</h2>{session.user.role === 'admin' && <Link className="mt-3 inline-block rounded border px-4 py-2 text-blue-700" href="/admin/connections">管理平台登录与采集</Link>}<p className="mt-2 text-slate-600">个人记录与榜单已提供后端 API，展示页面后续接入。</p></section>
    <section className="grid gap-4 md:grid-cols-3" aria-label="平台接入状态">{platforms.map((platform) => <article key={platform.id} className="rounded-2xl border border-slate-200 bg-white p-6"><h3 className="font-semibold">{platform.name}</h3><p className="mt-3 text-sm text-slate-500">尚未接入</p></article>)}</section>
    <section className="mt-8 rounded-2xl border border-dashed border-slate-300 p-8 text-center"><h2 className="font-semibold">训练记录等待接入</h2><p className="mt-2 text-sm text-slate-600">当前提供账号注册和登录。绑定平台账号、个人榜及队伍功能将逐步开放。</p></section>
  </main>;
}
