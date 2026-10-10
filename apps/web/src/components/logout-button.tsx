'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function LogoutButton({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const [error, setError] = useState('');
  async function logout() {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } });
      if (!response.ok) { setError('退出失败，请刷新后重试'); return; }
      router.replace('/login'); router.refresh();
    } catch { setError('网络连接失败'); }
  }
  return <div><button type="button" onClick={logout} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">退出登录</button>{error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}</div>;
}
