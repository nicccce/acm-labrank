'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { memberRequest, requestMessage } from './member-request';

export function StarSetting({ isStarred, url, version, csrfToken, team = false }: { isStarred: boolean; url: string; version?: number; csrfToken: string; team?: boolean }) {
  const router = useRouter(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try { await memberRequest(url, csrfToken, 'PUT', { isStarred: !isStarred, ...(version !== undefined ? { version } : {}) }); router.refresh(); }
    catch (error) { setError(requestMessage(error)); } finally { setBusy(false); }
  }
  return <section className="panel"><h2>{team ? '队伍打星' : '个人打星'}</h2><p className="muted">{isStarred ? '已打星，不参与排名。' : '当前参与排名。'}打星后仍显示成绩。{team ? '此设置不影响成员的个人排名。' : '此设置不影响所在队伍的积分和排名。'}</p><button type="button" className="button mt-3" aria-pressed={isStarred} disabled={busy} onClick={save}>{busy ? '保存中…' : isStarred ? '取消打星' : '设置打星'}</button>{error && <p role="alert" className="error">{error}</p>}</section>;
}
