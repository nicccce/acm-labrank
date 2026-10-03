import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentSession } from '../../lib/http';
import { AuthForm } from '../../components/auth-form';
export const dynamic = 'force-dynamic';
export default async function RegisterPage() {
  if (await currentSession()) redirect('/');
  return <main className="auth-simple"><section>
    <h1>注册</h1>
    <AuthForm mode="register" /><p className="mt-6 text-center text-sm text-slate-600">已有账号？ <Link className="text-blue-700" href="/login">返回登录</Link></p>
  </section></main>;
}
