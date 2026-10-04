'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { memberRequest, requestMessage } from './member-request';
import { formatTime, platformNames } from './score-display';

import type { Bindings } from '@acm/core/contracts';
import { bindingStates as states, collectionSkipLabels } from '@acm/core/contracts';
const profileUrls: Record<string, string> = {
  codeforces: 'https://codeforces.com/profile/',
  luogu: 'https://www.luogu.com.cn/user/',
  qoj: 'https://qoj.ac/user/profile/',
};
export function ProfileEditor({ username, realName, initial, csrfToken }: { username: string; realName: string | null; initial: Bindings; csrfToken: string }) {
  const router = useRouter(), [bindings, setBindings] = useState(initial), [busy, setBusy] = useState(''), [error, setError] = useState(''), [status, setStatus] = useState(''), [confirm, setConfirm] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const bindingRevision = useRef(0), bindingBusy = useRef(false);
  const pending = bindings.items.some(b => b.candidate?.state === 'pending');
  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (bindingBusy.current) { timer = setTimeout(poll, 5000); return; }
      const revision = bindingRevision.current;
      try { const next = await memberRequest<Bindings>('/api/me/platform-accounts', csrfToken, 'GET', undefined, controller.signal); if (controller.signal.aborted) return; if (revision === bindingRevision.current && !bindingBusy.current) { setBindings(next); if (!next.items.some(b => b.candidate?.state === 'pending')) router.refresh(); } }
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
    event.preventDefault(); const form = new FormData(event.currentTarget); ++bindingRevision.current; bindingBusy.current = true; setBusy(platform); setError(''); setStatus('');
    try { const result = await memberRequest<{ skipped?: string; unchanged?: boolean }>(`/api/me/platform-accounts/${platform}`, csrfToken, 'PUT', { target: form.get('target') }); setBindings(await memberRequest<Bindings>('/api/me/platform-accounts', csrfToken)); setStatus(result.unchanged ? '账号未变更' : result.skipped ? '已保存，等待管理员启用该平台采集' : '已保存，验证中'); }
    catch (error) { setError(requestMessage(error)); } finally { bindingBusy.current = false; ++bindingRevision.current; setBusy(''); }
  }
  async function unbind(platform: string) {
    ++bindingRevision.current; bindingBusy.current = true; setBusy(platform); setError(''); setStatus('');
    try { await memberRequest(`/api/me/platform-accounts/${platform}`, csrfToken, 'DELETE'); setBindings(await memberRequest<Bindings>('/api/me/platform-accounts', csrfToken)); setTargets(previous => ({ ...previous, [platform]: '' })); setConfirm(null); setStatus('已解绑'); router.refresh(); }
    catch (error) { setError(requestMessage(error)); } finally { bindingBusy.current = false; ++bindingRevision.current; setBusy(''); }
  }
  return <><p className="muted" style={{ marginBottom: 16 }}>@{username}</p><form className="form-stack panel" onSubmit={saveName}><label>真实姓名（选填）<input name="realName" maxLength={64} defaultValue={realName ?? ''} autoComplete="name" /></label><div><button className="button" disabled={!!busy}>保存姓名</button></div></form>
    {error && <p role="alert" className="error">{error}</p>}{status && <p role="status">{status}</p>}
    {bindings.items.map(b => {
      const target = targets[b.platform] ?? b.candidate?.target ?? (b.platform === 'luogu' ? b.active?.externalId : b.active?.handle) ?? '';
      const account = target.trim(), valid = b.platform === 'luogu' ? /^[1-9][0-9]*$/.test(account) : !!account && !/[\s/?#\\]/.test(account);
      const profileUrl = valid && profileUrls[b.platform] ? profileUrls[b.platform] + encodeURIComponent(account) : null;
      return <section key={b.platform} className="panel"><h2>{platformNames[b.platform]}</h2><p>生效账号：{b.active?.handle ?? '未绑定'}</p>{b.candidate && <p className="muted">{b.candidate.target} · {b.candidate.state === 'pending' && b.candidate.waitingReason ? `等待验证：${collectionSkipLabels[b.candidate.waitingReason] ?? '平台暂不可用'}` : states[b.candidate.state] ?? b.candidate.state}{b.candidate.error?.message ? ` · ${b.candidate.error.message}` : ''}</p>}
      <details className="disclosure"><summary>同步详情</summary><p className="muted">首次近 30 天：{b.sync.initializedAt ? '已完成' : '未完成'} · 最近同步：{formatTime(b.sync.lastSuccessAt)} · 历史{b.sync.historyComplete ? '完整' : '未完整'}{b.sync.coverage === 'restricted' ? ' · 权限受限' : ''}</p></details>
      {b.active && <p className="muted">更换账号验证成功后，将替换旧账号的历史积分。</p>}
      <form className="filter-form" onSubmit={event => bind(event, b.platform)}>
        <label>{b.platform === 'luogu' ? '洛谷 UID' : `${platformNames[b.platform]} 用户名`}<input name="target" required maxLength={100} value={target} onChange={event => setTargets(previous => ({ ...previous, [b.platform]: event.target.value }))} pattern={b.platform === 'luogu' ? '[1-9][0-9]*' : undefined} aria-describedby={b.platform === 'luogu' ? 'luogu-uid-help' : undefined} /></label>
        {profileUrl ? <a className="account-profile-link" href={profileUrl} target="_blank" rel="noopener noreferrer" aria-label={`查看${platformNames[b.platform]}主页确认（在新标签页打开）`}>查看主页确认 ↗</a> : <span className="muted">填写有效账号后可查看主页</span>}
        <button className="button" disabled={!!busy}>保存账号</button>{(b.active || b.candidate) && <button type="button" className="button" disabled={!!busy} onClick={() => setConfirm(b.platform)}>解绑</button>}
      </form>
      {b.platform === 'luogu' && <p id="luogu-uid-help" className="muted">UID 就是你洛谷个人主页 URL 中 <code>/user/</code> 后的那串数字。例如 <code>https://www.luogu.com.cn/user/123456</code> 中的 UID 是 <strong>123456</strong>。</p>}
      {confirm === b.platform && <div role="dialog" aria-label="确认解绑"><p>解绑后，该账号历史不再计入个人积分。</p><div className="form-actions"><button className="button" disabled={!!busy} onClick={() => unbind(b.platform)}>确认解绑</button><button className="button" onClick={() => setConfirm(null)}>取消</button></div></div>}
    </section>;
    })}</>;
}
