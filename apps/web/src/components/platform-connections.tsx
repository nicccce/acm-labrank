'use client';
import Image from 'next/image';
import { useState } from 'react';

type Connection = { state: string; collector: string | null };
type Attempt = { id: string; version: number; expiresAt?: string };
type Control = { enabled: boolean; version: number };
export function PlatformConnections({ csrfToken, vncUrl, initialConnections, initialControl }: { csrfToken: string; vncUrl: string; initialConnections: Record<string, Connection>; initialControl: Control }) {
  const [connections, setConnections] = useState(initialConnections), [control, setControl] = useState(initialControl);
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [captcha, setCaptcha] = useState('');
  const [attempt, setAttempt] = useState<Attempt | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [luoguBusy, setLuoguBusy] = useState(false), [luoguMessage, setLuoguMessage] = useState('');
  async function call(url: string, method = 'GET', body?: unknown) {
    try {
      const response = await fetch(url, { method, credentials: 'same-origin', signal: AbortSignal.timeout(70000), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store' });
      const data = await response.json(); if (!response.ok) throw new Error(data.message ?? '操作失败'); return data;
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw new Error('请求等待超时，请重新获取验证码或刷新连接状态。', { cause: error });
      throw error;
    }
  }
  async function refreshConnections() {
    const data = await call('/api/admin/platforms');
    setConnections(Object.fromEntries(data.items.map((item: { platform: string; connection: Connection }) => [item.platform, item.connection])));
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await fn(); } catch (error) { setMessage(error instanceof Error ? error.message : '操作未完成'); }
    finally { setBusy(false); }
  }
  async function luoguAction(fn: () => Promise<void>, progress: string) {
    setBusy(true); setLuoguBusy(true); setLuoguMessage(progress);
    try { await fn(); } catch (error) { setLuoguMessage(error instanceof Error ? error.message : '洛谷登录未完成'); }
    finally { setBusy(false); setLuoguBusy(false); }
  }
  async function begin() {
    if (attempt) await call(`/api/admin/connections/luogu/login-attempts/${attempt.id}`, 'DELETE');
    setAttempt(null); setPassword(''); setCaptcha('');
    setAttempt(await call('/api/admin/connections/luogu/login-attempts', 'POST', { username }));
    setLuoguMessage('验证码已获取，请填写密码和图形验证码。');
  }
  async function submit() {
    if (!attempt) return;
    try {
      const result = await call(`/api/admin/connections/luogu/login-attempts/${attempt.id}/submit`, 'POST', { version: attempt.version, password, captcha });
      setAttempt(null); await refreshConnections(); setLuoguMessage(`洛谷已登录：${result.identity.name}（UID ${result.identity.uid}）。提交列表尚未测试。`);
    } catch (error) { setAttempt(null); throw error; }
    finally { setPassword(''); setCaptcha(''); }
  }
  async function verifyQoj() {
    const queued = await call('/api/admin/connections/qoj/verify-session', 'POST');
    setMessage('正在核验 QOJ 登录身份…');
    const deadline = Date.now() + 130000;
    while (Date.now() < deadline) {
      const run = await call(`/api/admin/read-runs/${queued.runId}`);
      if (!['queued', 'running'].includes(run.status)) {
        await refreshConnections();
        if (run.status !== 'completed') throw new Error(run.error?.message ?? '身份核验未完成，请在远程桌面完成登录或挑战后重试');
        setMessage(`QOJ 已核验：${run.result?.collector ?? '已登录'}。提交列表尚未测试。`); return;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error('核验等待超时，请刷新状态后重试');
  }
  const button = 'rounded border border-slate-300 bg-white px-4 py-2 disabled:opacity-50';
  const field = 'w-full rounded border border-slate-300 px-3 py-2';
  return <div className="space-y-8">
    <section className="rounded border bg-white p-5">
      <h2 className="text-lg font-semibold">采集控制</h2>
      <p className="my-3">当前：{control.enabled ? '已启用' : '已暂停'}。请先完成下面两个平台的登录验证，再启用提交采集。</p>
      <button className={button} disabled={busy} onClick={() => void action(async () => { const updated = await call('/api/admin/collection-control', 'PUT', { enabled: !control.enabled, version: control.version }); setControl(updated); setMessage(updated.enabled ? '采集已启用，worker 会接收已入队任务。' : '采集已暂停，身份核验仍可使用。'); })}>{control.enabled ? '暂停采集' : '启用采集'}</button>
    </section>
    <section className="rounded border bg-white p-5">
      <h2 className="text-lg font-semibold">洛谷登录</h2>
      <p className="my-3">连接：{connections.luogu?.state ?? 'unknown'} · 身份：{connections.luogu?.collector ?? '未核验'} · 列表读取权限待测试</p>
      <div className="max-w-md space-y-3">
        <label className="block">登录账号<input className={field} value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" disabled={busy || Boolean(attempt)} /></label>
        {!attempt && <button className={button} disabled={busy || !username.trim()} onClick={() => void luoguAction(begin, '正在连接洛谷并获取图形验证码，请稍候…')}>{luoguBusy ? '正在获取验证码…' : '获取验证码'}</button>}
        {attempt && <>
          <Image src={`/api/admin/connections/luogu/login-attempts/${attempt.id}/captcha?v=${attempt.version}`} alt="洛谷验证码" width={160} height={50} unoptimized />
          <label className="block">密码<input className={field} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="off" disabled={busy} /></label>
          <label className="block">验证码<input className={field} value={captcha} onChange={e => setCaptcha(e.target.value)} autoComplete="off" disabled={busy} /></label>
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={busy || !password || !captcha} onClick={() => void luoguAction(submit, '正在提交洛谷登录并核验身份…')}>登录洛谷</button>
            <button className={button} disabled={busy} onClick={() => void luoguAction(async () => { const result = await call(`/api/admin/connections/luogu/login-attempts/${attempt.id}/refresh-captcha`, 'POST', { version: attempt.version }); setAttempt({ ...attempt, version: result.version }); setCaptcha(''); setLuoguMessage('验证码已刷新，请输入新图片中的字符。'); }, '正在刷新图形验证码…')}>换一张</button>
            <button className={button} disabled={busy} onClick={() => void luoguAction(async () => { try { await call(`/api/admin/connections/luogu/login-attempts/${attempt.id}`, 'DELETE'); setLuoguMessage('本次洛谷登录已取消。'); } finally { setAttempt(null); setPassword(''); setCaptcha(''); } }, '正在取消本次登录…')}>取消</button>
          </div>
        </>}
      </div>
      <p role="status" aria-live="polite" className="mt-3 min-h-6 text-blue-800">{luoguMessage}</p>
    </section>
    <section className="rounded border bg-white p-5">
      <h2 className="text-lg font-semibold">QOJ 远程桌面登录</h2>
      <p className="my-3">连接：{connections.qoj?.state ?? 'unknown'} · 身份：{connections.qoj?.collector ?? '未核验'} · 列表读取权限待测试</p>
      <p className="mb-3 text-sm text-slate-600">在下面的桌面中输入 VNC 密码，再登录 QOJ。完成后点击核验按钮。</p>
      <iframe title="QOJ 专用浏览器远程桌面" src={vncUrl} className="h-[720px] w-full rounded border" allow="fullscreen" />
      <div className="mt-3 flex flex-wrap gap-3"><button className={button} disabled={busy} onClick={() => void action(verifyQoj)}>已登录，核验 QOJ 身份</button><a className={button} href={vncUrl} target="_blank" rel="noreferrer">单独打开远程桌面</a></div>
    </section>
    <div className="flex gap-3"><button className={button} disabled={busy} onClick={() => void action(refreshConnections)}>刷新连接状态</button>{(['luogu', 'qoj'] as const).map(platform => <button key={platform} className={button} disabled={busy} onClick={() => void action(async () => { await call(`/api/admin/connections/${platform}`, 'DELETE'); await refreshConnections(); setMessage('本地连接已断开；QOJ 浏览器中的平台会话可通过显式核验重新连接。'); })}>断开 {platform}</button>)}</div>
    <p role="status" className="min-h-6 text-blue-800">{busy ? '正在处理，请稍候。' : message}</p>
  </div>;
}
