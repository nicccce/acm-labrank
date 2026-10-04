'use client';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { memberRequest, MemberRequestError, requestMessage } from './member-request';

interface Member { id: string; username: string; displayName: string }
export interface EditableTeam { id: string; name: string; version: number; archivedAt: string | null; members: Member[] }
interface MemberResults { page: number; limit: number; total: number; items: Member[] }
export function TeamEditor({ self, team, csrfToken }: { self: Member; team?: EditableTeam; csrfToken: string }) {
  const router = useRouter(), [selected, setSelected] = useState<Member[]>(team?.members ?? [self]), [search, setSearch] = useState(''), [page, setPage] = useState(1), [composing, setComposing] = useState(false), [results, setResults] = useState<MemberResults | null>(null), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [searchError, setSearchError] = useState(''), [duplicate, setDuplicate] = useState<string | undefined>(), [notice, setNotice] = useState('');
  const searchHelpId = useId();
  const searchController = useRef<AbortController | null>(null);
  useEffect(() => {
    const q = search.trim();
    if (!q || composing) return;
    const controller = new AbortController(); searchController.current = controller;
    const timer = setTimeout(async () => {
      if (controller.signal.aborted) return;
      setLoading(true); setSearchError('');
      try {
        const data = await memberRequest<MemberResults>(`/api/members?${new URLSearchParams({ q, page: String(page) })}`, csrfToken, 'GET', undefined, controller.signal);
        if (!controller.signal.aborted) setResults(data);
      } catch (error) { if (!controller.signal.aborted) setSearchError(requestMessage(error)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search, page, composing, csrfToken]);
  function updateSearch(value: string) {
    searchController.current?.abort();
    setSearch(value); setPage(1); setResults(null); setSearchError(''); setLoading(Boolean(value.trim()) && !composing);
  }
  function changePage(nextPage: number) {
    searchController.current?.abort(); setPage(nextPage); setSearchError(''); setLoading(true);
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); setError(''); setNotice(''); setDuplicate(undefined);
    try {
      const result = await memberRequest<{ id: string; created?: boolean }>(team ? `/api/teams/${team.id}` : '/api/teams', csrfToken, team ? 'PUT' : 'POST', { name: form.get('name'), memberIds: selected.map(m => m.id), ...(team ? { version: team.version } : {}) });
      if (!team && result.created === false) { setDuplicate(result.id); setNotice('已存在相同成员的队伍（含已归档队伍），请查看已有队伍。'); }
      else { router.push(`/teams/${result.id}`); router.refresh(); }
    } catch (error) { setError(requestMessage(error)); if (error instanceof MemberRequestError) setDuplicate(error.teamId); }
    finally { setBusy(false); }
  }
  return <form className="form-stack panel" onSubmit={save}><label>队伍名称<input name="name" required maxLength={64} defaultValue={team?.name ?? ''} /></label>
    <div><p>成员（2—3 人）</p><details className="disclosure"><summary>组队规则</summary><p className="muted">每位成员都可管理队伍；相同成员只能创建一支队伍。</p></details>{selected.map(m => <div key={m.id} className="member-choice"><span>{m.displayName} <span className="muted">{m.username}</span></span><button type="button" className="button" disabled={(!team && m.id === self.id) || busy} onClick={() => setSelected(selected.filter(s => s.id !== m.id))}>移除</button></div>)}</div>
    <div><label>查找成员<input value={search} maxLength={64} aria-describedby={searchHelpId} placeholder="实名、用户名或已绑定的平台账号" onChange={e => updateSearch(e.target.value)} onCompositionStart={() => { searchController.current?.abort(); setComposing(true); setResults(null); setLoading(false); }} onCompositionEnd={event => { setComposing(false); setSearch(event.currentTarget.value); setLoading(Boolean(event.currentTarget.value.trim())); }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault(); }} /></label>
    <p id={searchHelpId} className="muted mt-2">支持实名、用户名、CF / QOJ 账号和洛谷 UID，输入后自动搜索。</p>
    <p role="status" aria-live="polite" className="muted mt-2 min-h-5">{loading ? '正在搜索…' : ''}</p>
    {searchError && <p role="alert" className="error mt-2">{searchError}</p>}
    {results && <div className="mt-3" aria-busy={loading}>{results.items.filter(m => !selected.some(s => s.id === m.id)).map(m => <div key={m.id} className="member-choice"><span>{m.displayName} <span className="muted">{m.username}</span></span><button type="button" className="button" disabled={selected.length >= 3 || busy || loading} onClick={() => setSelected(current => current.length >= 3 || current.some(s => s.id === m.id) ? current : [...current, m])}>添加</button></div>)}{!results.items.length && <p className="muted">没有匹配的成员</p>}<div className="form-actions mt-3">{results.page > 1 && <button type="button" className="button" disabled={loading || busy} onClick={() => changePage(results.page - 1)}>上一页</button>}{results.page * results.limit < results.total && <button type="button" className="button" disabled={loading || busy} onClick={() => changePage(results.page + 1)}>下一页</button>}</div></div>}</div>
    {notice && <p role="status">{notice} · <Link href={`/teams/${duplicate}`}>查看已有队伍</Link></p>}
    {error && <p role="alert" className="error">{error}{duplicate && <> · <Link href={`/teams/${duplicate}`}>查看已有队伍</Link></>}</p>}
    <div><button className="button primary" disabled={busy || selected.length < 2}>{busy ? '保存中…' : team ? '保存队伍' : '创建队伍'}</button></div>
  </form>;
}
export function TeamActions({ team, viewerId, csrfToken }: { team: EditableTeam; viewerId: string; csrfToken: string }) {
  const router = useRouter(), [confirm, setConfirm] = useState<'archive' | 'leave' | 'delete' | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [duplicate, setDuplicate] = useState<string | undefined>();
  if (!team.members.some(m => m.id === viewerId)) return null;
  const labels = { archive: '归档队伍', leave: '退出队伍', delete: '删除队伍' };
  async function perform() {
    if (!confirm) return;
    setBusy(true); setError(''); setDuplicate(undefined);
    const suffix = confirm === 'archive' ? '/archive' : confirm === 'leave' ? '/members/me' : '';
    try { await memberRequest(`/api/teams/${team.id}${suffix}`, csrfToken, confirm === 'archive' ? 'POST' : 'DELETE', { version: team.version }); router.push('/teams'); router.refresh(); }
    catch (error) { setError(requestMessage(error)); if (error instanceof MemberRequestError) setDuplicate(error.teamId); } finally { setBusy(false); }
  }
  return <div className="form-actions">{confirm ? <div role="dialog" aria-label={`确认${labels[confirm]}`}><p>{confirm === 'delete' ? '删除后队伍及其成员关系和操作记录将永久移除，个人成绩会保留。确认删除队伍？' : confirm === 'leave' ? '确认退出队伍？剩余成员不足 2 人时队伍将自动归档。' : '确认归档队伍？归档后保留队伍信息，并退出团队榜。'}</p><button className="button" disabled={busy} onClick={perform}>{`确认${labels[confirm]}`}</button> <button className="button" disabled={busy} onClick={() => setConfirm(null)}>取消</button></div> : <>{!team.archivedAt && <><button className="button" onClick={() => setConfirm('archive')}>归档队伍</button><button className="button" onClick={() => setConfirm('leave')}>退出队伍</button></>}<button className="button" onClick={() => setConfirm('delete')}>删除队伍</button></>}{error && <p role="alert" className="error">{error}{duplicate && <> · <Link href={`/teams/${duplicate}`}>查看已有队伍</Link></>}</p>}</div>;
}
