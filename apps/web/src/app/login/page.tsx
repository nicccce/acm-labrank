import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentSession } from '../../lib/http';
import { AuthForm } from '../../components/auth-form';
export const dynamic = 'force-dynamic';
export default async function LoginPage() {
  if (await currentSession()) redirect('/');
  return <main className="auth-simple"><section>
    <h1>登录</h1>
    <AuthForm mode="login" /><p className="mt-6 text-center text-sm text-slate-600">还没有账号？ <Link className="text-blue-700" href="/register">注册账号</Link></p>
  </section></main>;
}
