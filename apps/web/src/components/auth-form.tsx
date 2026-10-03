'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/auth/' + mode, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.get('username'), password: form.get('password'), ...(mode === 'register' ? { realName: form.get('realName') } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) { setError(result.message ?? '操作失败'); return; }
      router.replace('/'); router.refresh();
    } catch { setError('网络连接失败，请稍后重试'); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="space-y-5">
    <label className="block text-sm font-medium">用户名<input className="mt-2" name="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_]+" autoComplete="username" placeholder="字母、数字或下划线" /></label>
    {mode === 'register' && <label className="block text-sm font-medium">真实姓名（选填）<input className="mt-2" name="realName" maxLength={64} autoComplete="name" /></label>}
    <label className="block text-sm font-medium">密码<input className="mt-2" type="password" name="password" required minLength={12} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder="至少 12 位" /></label>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button disabled={busy} className="w-full rounded border border-blue-700 bg-blue-700 px-4 py-2 text-white">{busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}</button>
  </form>;
}
