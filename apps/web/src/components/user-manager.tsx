'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ManagedUser, ManagementPage } from '@acm/core/contracts';
import { memberRequest, requestMessage } from './member-request';
import { formatTime } from './score-display';

type Action = 'ban' | 'delete' | 'reset';
const labels = { ban: '封禁', delete: '伪删除', reset: '重置密码' };
const messages = { ban: '该用户将退出登录和个人榜，其成绩不再计入队伍，采集任务将取消。可以随后解除封禁。', delete: '账号将隐藏并禁止登录，成绩、绑定和队伍关系保留。原队伍显示“已删除成员”，可随后恢复。', reset: '旧密码和全部登录会话将失效。系统生成临时密码，仅在本次弹窗展示；用户下次登录必须修改密码。' };
export function ManagementDialog({ title, children, close }: { title: string; children: React.ReactNode; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="management-dialog" aria-label={title} onCancel={event => { event.preventDefault(); close(); }}><h2>{title}</h2>{children}</dialog>;
}
export function UserManager({ data, csrfToken, viewerId }: { data: ManagementPage<ManagedUser>; csrfToken: string; viewerId: string }) {
  const router = useRouter(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState<{ user: ManagedUser; action: Action } | null>(null);
  const [secret, setSecret] = useState<{ username: string; password: string; self: boolean } | null>(null);
  function closeSecret() { const self = secret?.self; setSecret(null); setNotice(''); setError(''); if (self) { router.replace('/login'); router.refresh(); } }
  async function perform(user: ManagedUser, method: string, body?: unknown, suffix = '') {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await memberRequest<{ temporaryPassword?: string }>(`/api/admin/users/${user.id}${suffix}`, csrfToken, method, body);
      setPending(null);
      if (result.temporaryPassword) setSecret({ username: user.username, password: result.temporaryPassword, self: user.id === viewerId });
      else setNotice('操作已保存');
      if (!result.temporaryPassword || user.id !== viewerId) router.refresh();
    } catch (error) { setError(requestMessage(error)); } finally { setBusy(false); }
  }
  function confirm() {
    if (!pending) return;
    const { user, action } = pending;
    void perform(user, action === 'ban' ? 'PATCH' : action === 'delete' ? 'DELETE' : 'POST', action === 'ban' ? { active: false } : undefined, action === 'reset' ? '/reset-password' : '');
  }
  async function copyPassword() {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret.password); setNotice('临时密码已复制'); }
    catch { setError('复制失败，请手动选择并复制临时密码'); }
  }
  return <>{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}<div className="table-wrap"><table className="data-table management-table"><thead><tr><th>用户 / 角色</th><th>真实姓名</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{data.items.map(user => <tr key={`${user.id}:${user.realName ?? ''}`}><td><strong>{user.username}</strong><div className="muted">{user.role === 'admin' ? '管理员' : '成员'}{user.id === viewerId ? ' · 我' : ''}</div></td><td>{user.deletedAt ? user.realName ?? '—' : <form className="management-name" onSubmit={event => { event.preventDefault(); void perform(user, 'PATCH', { realName: String(new FormData(event.currentTarget).get('realName')).trim() || null }); }}><input name="realName" aria-label={`${user.username} 的真实姓名`} maxLength={64} defaultValue={user.realName ?? ''} /><button className="button" disabled={busy}>保存</button></form>}</td><td>{user.deletedAt ? '已删除' : user.active ? '正常' : '已封禁'}<div className="muted">{user.isStarred ? '已打星' : '参与排名'}{user.mustChangePassword ? ' · 待改密' : ''}</div></td><td>{formatTime(user.createdAt)}</td><td><div className="form-actions">{user.deletedAt ? <button className="button" disabled={busy} onClick={() => perform(user, 'POST', undefined, '/restore')}>恢复账号</button> : <><button className="button" disabled={busy} onClick={() => perform(user, 'PATCH', { isStarred: !user.isStarred })}>{user.isStarred ? '取消打星' : '打星'}</button>{user.active ? <button className="button" disabled={busy || user.id === viewerId} onClick={() => { setError(''); setPending({ user, action: 'ban' }); }}>封禁</button> : <button className="button" disabled={busy} onClick={() => perform(user, 'PATCH', { active: true })}>解除封禁</button>}<button className="button" disabled={busy || user.id === viewerId} onClick={() => { setError(''); setPending({ user, action: 'delete' }); }}>伪删除</button><button className="button" disabled={busy} onClick={() => { setError(''); setPending({ user, action: 'reset' }); }}>重置密码</button></>}</div></td></tr>)}</tbody></table>{!data.items.length && <p className="empty-state">没有匹配的用户</p>}</div>
    {pending && <ManagementDialog title={`${labels[pending.action]} ${pending.user.username}`} close={() => { if (!busy) setPending(null); }}><p>{messages[pending.action]}</p>{error && <p role="alert" className="error">{error}</p>}<div className="form-actions"><button className="button primary" disabled={busy} onClick={confirm}>{busy ? '处理中…' : `确认${labels[pending.action]}`}</button><button className="button" disabled={busy} onClick={() => setPending(null)}>取消</button></div></ManagementDialog>}
    {secret && <ManagementDialog title={`临时密码 · ${secret.username}`} close={closeSecret}><p>请保存并转交给用户。关闭后无法再次查看，下次登录必须修改密码。</p><input className="temporary-password" aria-label="临时密码" readOnly value={secret.password} autoComplete="off" />{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}<div className="form-actions"><button className="button" onClick={copyPassword}>复制临时密码</button><button className="button primary" onClick={closeSecret}>已保存，关闭</button></div></ManagementDialog>}
  </>;
}
