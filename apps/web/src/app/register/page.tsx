import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentSession } from '../../lib/http';
import { AuthForm } from '../../components/auth-form';
export const dynamic = 'force-dynamic';
export default async function RegisterPage() {
  if (await currentSession()) redirect('/');
  return <main className="mx-auto flex min-h-screen max-w-md items-center px-6 py-12"><section className="w-full rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
    <p className="mb-3 text-sm font-semibold text-blue-700">ACM 实验室</p><h1 className="mb-2 text-2xl font-bold">加入训练榜单</h1><p className="mb-8 text-sm text-slate-500">真实姓名可选，后续可绑定 OJ 账号。</p>
    <AuthForm mode="register" /><p className="mt-6 text-center text-sm text-slate-600">已有账号？ <Link className="text-blue-700" href="/login">返回登录</Link></p>
  </section></main>;
}
