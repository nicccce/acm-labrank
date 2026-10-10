'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ManagedTeam, ManagementPage } from '@acm/core/contracts';
import { memberRequest, requestMessage } from './member-request';

export function TeamStarManager({ data, csrfToken }: { data: ManagementPage<ManagedTeam>; csrfToken: string }) {
  const router = useRouter(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save(team: ManagedTeam) {
    setBusy(true); setError('');
    try { await memberRequest(`/api/admin/teams/${team.id}/star`, csrfToken, 'PUT', { isStarred: !team.isStarred, version: team.version }); router.refresh(); }
    catch (error) { setError(requestMessage(error)); } finally { setBusy(false); }
  }
  return <>{error && <p role="alert" className="error">{error}</p>}<div className="table-wrap"><table className="data-table"><thead><tr><th>队伍</th><th>成员</th><th>状态</th><th>排名设置</th><th>操作</th></tr></thead><tbody>{data.items.map(team => <tr key={team.id}><td>{team.name}</td><td>{team.members.map(m => m.displayName).join('、')}</td><td>{team.archivedAt ? '已归档' : '正常'}</td><td>{team.isStarred ? '打星，不参与排名' : '参与排名'}</td><td><button className="button" disabled={busy} onClick={() => save(team)}>{team.isStarred ? '取消打星' : '设置打星'}</button></td></tr>)}</tbody></table>{!data.items.length && <p className="empty-state">没有匹配的队伍</p>}</div></>;
}
