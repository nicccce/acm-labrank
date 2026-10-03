'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { memberRequest, requestMessage } from './member-request';
import { formatTime, platformNames } from './score-display';

interface Binding { platform: string; version: number; active: { handle: string; accountId: string; externalId: string | null } | null; candidate: { target: string; state: string; error: { message?: string } | null } | null; sync: { lastSuccessAt: string | Date | null; historyComplete: boolean; coverage: string } }
interface Bindings { items: Binding[] }
const states: Record<string, string> = { pending: '验证中', verified: '已验证', not_found: '账号不存在', occupied: '账号已被占用', unavailable: '暂不可验证', unsupported: '不支持该账号' };
export function ProfileEditor({ username, realName, initial, csrfToken }: { username: string; realName: string | null; initial: Bindings; csrfToken: string }) {
  const router = useRouter(), [bindings, setBindings] = useState(initial), [busy, setBusy] = useState(''), [error, setError] = useState(''), [status, setStatus] = useState(''), [confirm, setConfirm] = useState<string | null>(null);
  const pending = bindings.items.some(b => b.candidate?.state === 'pending');
  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const next = await memberRequest<Bindings>('/api/me/platform-accounts', csrfToken, 'GET', undefined, controller.signal); if (controller.signal.aborted) return; setBindings(next); if (!next.items.some(b => b.candidate?.state === 'pending')) router.refresh(); }
      catch (error) { if (!controller.signal.aborted) setError(requestMessage(error)); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
    }
    timer = setTimeout(poll, 5000); return () => { controller.abort(); clearTimeout(timer); };
  }, [pending, csrfToken, router]);
  async function saveName(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy('name'); setError(''); setStatus('');
    try { await memberRequest('/api/me', csrfToken, 'PUT', { realName: String(form.get('realName')).trim() || null }); setStatus('已保存'); router.refresh(); }
    catch (error) { setError(requestMessage(error)); } finally { setBusy(''); }
  }
  async function bind(event: React.FormEvent<HTMLFormElement>, platform: string) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(platform); setError(''); setStatus('');
    try { const result = await memberRequest<{ skipped?: string; unchanged?: boolean }>(`/api/me/platform-accounts/${platform}`, csrfToken, 'PUT', { target: form.get('target') }); setBindings(await memberRequest<Bindings>('/api/me/platform-accounts', csrfToken)); setStatus(result.unchanged ? '账号未变更' : result.skipped ? '已保存，等待管理员启用该平台采集' : '已保存，验证中'); }
    catch (error) { setError(requestMessage(error)); } finally { setBusy(''); }
  }
  async function unbind(platform: string) {
    setBusy(platform); setError(''); setStatus('');
    try { await memberRequest(`/api/me/platform-accounts/${platform}`, csrfToken, 'DELETE'); setBindings(await memberRequest<Bindings>('/api/me/platform-accounts', csrfToken)); setConfirm(null); setStatus('已解绑'); router.refresh(); }
    catch (error) { setError(requestMessage(error)); } finally { setBusy(''); }
  }
  return <><p>用户名：{username}</p><form className="form-stack panel" onSubmit={saveName}><label>真实姓名（选填）<input name="realName" maxLength={64} defaultValue={realName ?? ''} autoComplete="name" /></label><div><button className="button" disabled={!!busy}>保存姓名</button></div></form>
    {error && <p role="alert" className="error">{error}</p>}{status && <p role="status">{status}</p>}
    {bindings.items.map(b => <section key={b.platform} className="panel"><h2>{platformNames[b.platform]}</h2><p>生效账号：{b.active?.handle ?? '未绑定'}</p>{b.candidate && <p className="muted">{b.candidate.target} · {states[b.candidate.state] ?? b.candidate.state}{b.candidate.error?.message ? ` · ${b.candidate.error.message}` : ''}</p>}
      <p className="muted">最近同步：{formatTime(b.sync.lastSuccessAt)} · 历史{b.sync.historyComplete ? '完整' : '未完整'}{b.sync.coverage === 'restricted' ? ' · 权限受限' : ''}</p>
      <form className="filter-form" onSubmit={event => bind(event, b.platform)}><label>{b.platform === 'luogu' ? '洛谷 UID' : `${platformNames[b.platform]} 用户名`}<input name="target" required maxLength={100} defaultValue={b.candidate?.target ?? b.active?.handle ?? ''} pattern={b.platform === 'luogu' ? '[1-9][0-9]*' : undefined} /></label><button className="button" disabled={!!busy}>保存账号</button>{(b.active || b.candidate) && <button type="button" className="button" disabled={!!busy} onClick={() => setConfirm(b.platform)}>解绑</button>}</form>
      {confirm === b.platform && <div role="dialog" aria-label="确认解绑"><p>解绑后，该账号历史不再计入个人积分。</p><div className="form-actions"><button className="button" disabled={!!busy} onClick={() => unbind(b.platform)}>确认解绑</button><button className="button" onClick={() => setConfirm(null)}>取消</button></div></div>}
    </section>)}</>;
}
