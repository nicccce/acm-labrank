'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SiteSettings } from '@acm/core/contracts';
import { apiRequest, requestMessage } from './api-request';

export function SiteSettingsEditor({ initial, csrfToken }: { initial: SiteSettings; csrfToken: string }) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setStatus('');
    const data = new FormData(event.currentTarget);
    try {
      const result = await apiRequest<SiteSettings>('/api/admin/site-settings', csrfToken, 'PUT', { headerText: data.get('headerText'), loginText: data.get('loginText'), version: settings.version });
      setSettings(result); setStatus('已保存'); router.refresh();
    } catch (error) { setError(requestMessage(error)); }
    finally { setBusy(false); }
  }
  return <form className="form-stack panel site-settings-form" onSubmit={save}>
    <label>平台名称<input name="headerText" maxLength={80} defaultValue={settings.headerText} disabled={busy} /></label>
    <label>登录页左侧文字<textarea name="loginText" rows={7} maxLength={800} defaultValue={settings.loginText} disabled={busy} /></label>
    <p className="muted">留空则不显示文字。</p>
    <div className="form-actions"><button className="button primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button><span role="status">{status}</span></div>
    {error && <p role="alert" className="error">{error}</p>}
  </form>;
}
