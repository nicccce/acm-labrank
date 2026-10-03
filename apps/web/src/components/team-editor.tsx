'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { memberRequest, MemberRequestError, requestMessage } from './member-request';

interface Member { id: string; username: string; displayName: string }
export interface EditableTeam { id: string; name: string; ownerId: string; version: number; archivedAt: string | null; members: Member[] }
interface MemberResults { page: number; limit: number; total: number; items: Member[] }
export function TeamEditor({ self, team, csrfToken }: { self: Member; team?: EditableTeam; csrfToken: string }) {
  const router = useRouter(), [selected, setSelected] = useState<Member[]>(team?.members ?? [self]), [ownerId, setOwnerId] = useState(team?.ownerId ?? self.id), [search, setSearch] = useState(''), [usedSearch, setUsedSearch] = useState(''), [results, setResults] = useState<MemberResults | null>(null), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [duplicate, setDuplicate] = useState<string | undefined>(), [notice, setNotice] = useState('');
  const searchController = useRef<AbortController | null>(null);
  useEffect(() => () => searchController.current?.abort(), []);
  async function findMembers(page = 1, q = search) {
    searchController.current?.abort(); const controller = new AbortController(); searchController.current = controller;
    setLoading(true); setError('');
    try { const data = await memberRequest<MemberResults>(`/api/members?${new URLSearchParams({ q, page: String(page) })}`, csrfToken, 'GET', undefined, controller.signal); if (!controller.signal.aborted) { setResults(data); setUsedSearch(q); } }
    catch (error) { if (!controller.signal.aborted) setError(requestMessage(error)); } finally { if (!controller.signal.aborted) setLoading(false); }
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); setError(''); setNotice(''); setDuplicate(undefined);
    try {
      const result = await memberRequest<{ id: string; created?: boolean }>(team ? `/api/teams/${team.id}` : '/api/teams', csrfToken, team ? 'PUT' : 'POST', { name: form.get('name'), memberIds: selected.map(m => m.id), ...(team ? { ownerId, version: team.version } : {}) });
      if (!team && result.created === false) { setDuplicate(result.id); setNotice('已存在相同成员的队伍，已复用现有队伍；名称和负责人保持原值。'); }
      else { router.push(`/teams/${result.id}`); router.refresh(); }
    } catch (error) { setError(requestMessage(error)); if (error instanceof MemberRequestError) setDuplicate(error.teamId); }
    finally { setBusy(false); }
  }
  return <form className="form-stack panel" onSubmit={save}><label>队伍名称<input name="name" required maxLength={64} defaultValue={team?.name ?? ''} /></label>
    <div><p>成员（2—3 人）</p>{selected.map(m => <div key={m.id} className="member-choice"><span>{m.displayName} <span className="muted">{m.username}</span></span><button type="button" className="button" disabled={m.id === ownerId || busy} onClick={() => setSelected(selected.filter(s => s.id !== m.id))}>移除</button></div>)}</div>
    {team && <label>负责人<select aria-label="负责人" value={ownerId} onChange={e => setOwnerId(e.target.value)}>{selected.map(m => <option key={m.id} value={m.id}>{m.displayName} ({m.username})</option>)}</select></label>}
    <div><label>查找成员<input value={search} maxLength={64} onChange={e => setSearch(e.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void findMembers(); } }} /></label><button type="button" className="button" disabled={loading || busy} onClick={() => findMembers()}>搜索成员</button>
    {results && <div>{results.items.filter(m => !selected.some(s => s.id === m.id)).map(m => <div key={m.id} className="member-choice"><span>{m.displayName} <span className="muted">{m.username}</span></span><button type="button" className="button" disabled={selected.length >= 3 || busy} onClick={() => setSelected(current => current.length >= 3 || current.some(s => s.id === m.id) ? current : [...current, m])}>添加</button></div>)}{!results.items.length && <p className="muted">没有匹配的成员</p>}<div className="form-actions">{results.page > 1 && <button type="button" className="button" disabled={loading} onClick={() => findMembers(results.page - 1, usedSearch)}>上一页</button>}{results.page * results.limit < results.total && <button type="button" className="button" disabled={loading} onClick={() => findMembers(results.page + 1, usedSearch)}>下一页</button>}</div></div>}</div>
    {notice && <p role="status">{notice} · <Link href={`/teams/${duplicate}`}>查看已有队伍</Link></p>}
    {error && <p role="alert" className="error">{error}{duplicate && <> · <Link href={`/teams/${duplicate}`}>查看已有队伍</Link></>}</p>}
    <div><button className="button primary" disabled={busy || selected.length < 2}>{busy ? '保存中…' : team ? '保存队伍' : '创建队伍'}</button></div>
  </form>;
}
export function TeamActions({ team, viewerId, csrfToken }: { team: EditableTeam; viewerId: string; csrfToken: string }) {
  const router = useRouter(), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (team.archivedAt || !team.members.some(m => m.id === viewerId)) return null;
  const owner = team.ownerId === viewerId;
  async function perform() {
    setBusy(true); setError('');
    try { await memberRequest(`/api/teams/${team.id}${owner ? '' : '/members/me'}`, csrfToken, 'DELETE', { version: team.version }); router.push('/teams'); router.refresh(); }
    catch (error) { setError(requestMessage(error)); } finally { setBusy(false); }
  }
  return <div className="form-actions">{confirm ? <div role="dialog" aria-label={owner ? '确认归档' : '确认退出'}><p>{owner ? '归档队伍？' : '退出队伍？'}</p><button className="button" disabled={busy} onClick={perform}>{owner ? '确认归档' : '确认退出'}</button> <button className="button" disabled={busy} onClick={() => setConfirm(false)}>取消</button></div> : <button className="button" onClick={() => setConfirm(true)}>{owner ? '归档队伍' : '退出队伍'}</button>}{error && <p role="alert" className="error">{error}</p>}</div>;
}
