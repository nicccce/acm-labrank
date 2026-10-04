'use client';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { apiRequest, ApiRequestError, requestMessage } from './api-request';
import { refreshConnectionSessions, verifyConnectionSession, type Connection } from './connection-session';

type Attempt = { id: string; version: number; expiresAt?: string };
type Control = { enabled: boolean; version: number };
export function PlatformConnections({ csrfToken, vncUrl, initialConnections, initialControl }: { csrfToken: string; vncUrl: string; initialConnections: Record<string, Connection>; initialControl: Control }) {
  const [connections, setConnections] = useState(initialConnections), [control, setControl] = useState(initialControl);
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [captcha, setCaptcha] = useState('');
  const [attempt, setAttempt] = useState<Attempt | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [luoguBusy, setLuoguBusy] = useState(false), [luoguMessage, setLuoguMessage] = useState('');
  const requests = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); requests.current = controller; return () => controller.abort(); }, []);
  const call = <T = Record<string, never>>(url: string, method = 'GET', body?: unknown) => apiRequest<T>(url, csrfToken, method, body, requests.current?.signal);
  async function loadConnections() {
    const data = await call<{ items: { platform: string; connection: Connection }[] }>('/api/admin/platforms');
    setConnections(Object.fromEntries(data.items.map((item: { platform: string; connection: Connection }) => [item.platform, item.connection])));
  }
  async function refreshConnections() {
    setMessage('正在核验洛谷和 QOJ 当前登录状态…');
    setConnections(current => ({ ...current, luogu: { state: 'checking', collector: null }, qoj: { state: 'checking', collector: null } }));
    try {
      const result = await refreshConnectionSessions(call, requests.current?.signal);
      setConnections(result.connections); setMessage(result.message);
    } catch (error) {
      setConnections(current => ({ ...current, luogu: { state: 'unknown', collector: null }, qoj: { state: 'unknown', collector: null } }));
      throw error;
    }
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await fn(); } catch (error) { if (!requests.current?.signal.aborted) setMessage(requestMessage(error)); }
    finally { setBusy(false); }
  }
  async function luoguAction(fn: () => Promise<void>, progress: string) {
    setBusy(true); setLuoguBusy(true); setLuoguMessage(progress);
    try { await fn(); } catch (error) { if (!requests.current?.signal.aborted) setLuoguMessage(requestMessage(error)); }
    finally { setBusy(false); setLuoguBusy(false); }
  }
  async function begin() {
    if (attempt) await call(`/api/admin/connections/luogu/login-attempts/${attempt.id}`, 'DELETE');
    setAttempt(null); setPassword(''); setCaptcha('');
    setAttempt(await call<Attempt>('/api/admin/connections/luogu/login-attempts', 'POST', { username }));
    setLuoguMessage('验证码已获取，请填写密码和图形验证码。');
  }
  async function submit() {
    if (!attempt) return;
    try {
      const result = await call<{ identity: { name: string; uid: string } }>(`/api/admin/connections/luogu/login-attempts/${attempt.id}/submit`, 'POST', { version: attempt.version, password, captcha });
      setAttempt(null); await loadConnections(); setLuoguMessage(`洛谷已登录：${result.identity.name}（UID ${result.identity.uid}）。提交列表尚未测试。`);
    } catch (error) { setAttempt(null); throw error; }
    finally { setPassword(''); setCaptcha(''); }
  }
  async function verifyQoj() {
    setMessage('正在核验 QOJ 登录身份…');
    setConnections(current => ({ ...current, qoj: { state: 'checking', collector: null } }));
    try {
      const run = await verifyConnectionSession('qoj', call, requests.current?.signal);
      await loadConnections();
      if (run.status !== 'completed') {
        setConnections(current => ({ ...current, qoj: { state: ['auth_required', 'human_input_required'].includes(run.status) ? run.status : 'unknown', collector: null } }));
        throw new ApiRequestError(run.error?.message ?? '身份核验未完成，请在远程桌面完成登录或挑战后重试');
      }
      setMessage(`QOJ 已核验：${run.result?.collector ?? '已登录'}。提交列表尚未测试。`);
    } catch (error) {
      setConnections(current => current.qoj?.state === 'checking' ? { ...current, qoj: { state: 'unknown', collector: null } } : current);
      throw error;
    }
  }
  const button = 'rounded border border-slate-300 bg-white px-4 py-2 disabled:opacity-50';
  const field = 'w-full rounded border border-slate-300 px-3 py-2';
  return <div className="space-y-8">
    <section className="rounded border bg-white p-5">
      <h2 className="text-lg font-semibold">采集控制</h2>
      <p className="my-3">{control.enabled ? '采集已启用' : '采集已暂停'}</p>
      <button className={button} disabled={busy} onClick={() => void action(async () => { const updated = await call<Control>('/api/admin/collection-control', 'PUT', { enabled: !control.enabled, version: control.version }); setControl(updated); setMessage(updated.enabled ? '采集已启用，worker 会接收已入队任务。' : '采集已暂停，身份核验仍可使用。'); })}>{control.enabled ? '暂停采集' : '启用采集'}</button>
    </section>
    <section className="rounded border bg-white p-5">
      <h2 className="text-lg font-semibold">洛谷登录</h2>
      <p className="my-3">连接：{connections.luogu?.state === 'checking' ? '核验中' : connections.luogu?.state ?? 'unknown'} · 身份：{connections.luogu?.state === 'ready' ? connections.luogu.collector ?? '未核验' : '未核验'} · 列表读取权限待测试</p>
      {connections.luogu?.state === 'auth_required' && <p role="alert" className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">洛谷未登录或登录已过期，采集已暂停。请在下方重新获取验证码并登录。</p>}
      <div className="max-w-md space-y-3">
        <label className="block">登录账号<input className={field} value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" disabled={busy || Boolean(attempt)} /></label>
        {!attempt && <button className={button} disabled={busy || !username.trim()} onClick={() => void luoguAction(begin, '正在连接洛谷并获取图形验证码，请稍候…')}>{luoguBusy ? '正在获取验证码…' : '获取验证码'}</button>}
        {attempt && <>
          <Image src={`/api/admin/connections/luogu/login-attempts/${attempt.id}/captcha?v=${attempt.version}`} alt="洛谷验证码" width={160} height={50} unoptimized />
          <label className="block">密码<input className={field} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="off" disabled={busy} /></label>
          <label className="block">验证码<input className={field} value={captcha} onChange={e => setCaptcha(e.target.value)} autoComplete="off" disabled={busy} /></label>
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={busy || !password || !captcha} onClick={() => void luoguAction(submit, '正在提交洛谷登录并核验身份…')}>登录洛谷</button>
            <button className={button} disabled={busy} onClick={() => void luoguAction(async () => { const result = await call<Attempt>(`/api/admin/connections/luogu/login-attempts/${attempt.id}/refresh-captcha`, 'POST', { version: attempt.version }); setAttempt({ ...attempt, version: result.version }); setCaptcha(''); setLuoguMessage('验证码已刷新，请输入新图片中的字符。'); }, '正在刷新图形验证码…')}>换一张</button>
            <button className={button} disabled={busy} onClick={() => void luoguAction(async () => { try { await call(`/api/admin/connections/luogu/login-attempts/${attempt.id}`, 'DELETE'); setLuoguMessage('本次洛谷登录已取消。'); } finally { setAttempt(null); setPassword(''); setCaptcha(''); } }, '正在取消本次登录…')}>取消</button>
          </div>
        </>}
      </div>
      <p role="status" aria-live="polite" className="mt-3 min-h-6 text-blue-800">{luoguMessage}</p>
    </section>
    <section className="rounded border bg-white p-5">
      <h2 className="text-lg font-semibold">QOJ 登录</h2>
      <p className="my-3">连接：{connections.qoj?.state === 'checking' ? '核验中' : connections.qoj?.state ?? 'unknown'} · 身份：{connections.qoj?.state === 'ready' ? connections.qoj.collector ?? '未核验' : '未核验'} · 列表读取权限待测试</p>
      {connections.qoj?.state === 'auth_required' && <p role="alert" className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">QOJ 未登录或登录已过期，采集已暂停。请打开下方远程桌面重新登录，再点击“已登录，核验 QOJ 身份”。</p>}
      <p className="mb-3 text-sm text-slate-600">在下面的桌面中输入 VNC 密码，再登录 QOJ。完成后点击核验按钮。</p>
      <details className="disclosure"><summary>打开远程桌面</summary><iframe loading="lazy" title="QOJ 专用浏览器远程桌面" src={vncUrl} className="h-[720px] w-full rounded border" allow="fullscreen" /></details>
      <div className="mt-3 flex flex-wrap gap-3"><button className={button} disabled={busy} onClick={() => void action(verifyQoj)}>已登录，核验 QOJ 身份</button><a className={button} href={vncUrl} target="_blank" rel="noreferrer">单独打开远程桌面</a></div>
    </section>
    <div className="flex flex-wrap gap-3"><button className={button} disabled={busy} onClick={() => void action(refreshConnections)}>刷新连接状态</button>{(['luogu', 'qoj'] as const).map(platform => <button key={platform} className={button} disabled={busy} onClick={() => void action(async () => { await call(`/api/admin/connections/${platform}`, 'DELETE'); await loadConnections(); setMessage('本地连接已断开；QOJ 浏览器中的平台会话可通过显式核验重新连接。'); })}>断开 {platform}</button>)}</div>
    <p role="status" aria-live="polite" className="min-h-6 text-blue-800">{message || (busy ? '正在处理，请稍候。' : '')}</p>
  </div>;
}
