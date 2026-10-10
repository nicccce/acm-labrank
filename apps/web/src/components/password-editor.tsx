'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { memberRequest, requestMessage } from './member-request';
import { LogoutButton } from './logout-button';

export function PasswordEditor({ csrfToken, required = false }: { csrfToken: string; required?: boolean }) {
  const router = useRouter(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get('currentPassword')), newPassword = String(form.get('newPassword'));
    if (newPassword !== form.get('confirmation')) { setError('两次输入的新密码不一致'); return; }
    setBusy(true); setError('');
    try { await memberRequest('/api/me/password', csrfToken, 'PUT', { currentPassword, newPassword }); router.replace('/'); router.refresh(); }
    catch (error) { setError(requestMessage(error)); } finally { setBusy(false); }
  }
  return <section className="panel"><h2>{required ? '请修改临时密码' : '修改密码'}</h2><p className="muted">{required ? '管理员重置了你的密码，修改后才能继续使用账号。' : '修改成功后，其他设备的登录会话将失效。'}</p><form className="form-stack mt-3" onSubmit={save}><label>{required ? '临时密码' : '当前密码'}<input name="currentPassword" type="password" autoComplete="current-password" minLength={12} maxLength={128} required /></label><label>新密码<input name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label><label>确认新密码<input name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>{error && <p role="alert" className="error">{error}</p>}<div className="form-actions"><button className="button primary" disabled={busy}>{busy ? '保存中…' : '保存新密码'}</button>{required && <LogoutButton csrfToken={csrfToken} />}</div></form></section>;
}
