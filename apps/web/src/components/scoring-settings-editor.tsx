'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CF_BAND_LABELS, DEFAULT_SCORING_RULES, type ScoringRules, type ScoringSettings } from '@acm/core/domain';
import { apiRequest, requestMessage } from './api-request';

function PointInput({ name, label, value }: { name: string; label: string; value: number }) {
  return <label className="scoring-row"><span>{label}</span><span className="scoring-value"><input name={name} type="number" min="0" max="10000" step="0.001" required defaultValue={value} /><span aria-hidden="true">分</span></span></label>;
}
export function ScoringSettingsEditor({ initial, csrfToken }: { initial: ScoringSettings; csrfToken: string }) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial), [draft, setDraft] = useState(initial.rules), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  function replaceDraft(rules: ScoringRules) { setDraft(rules); setRevision(value => value + 1); }
  async function reload() {
    setBusy(true); setError(''); setStatus('');
    try {
      const latest = await apiRequest<ScoringSettings>('/api/admin/scoring-settings', csrfToken);
      setSettings(latest); replaceDraft(latest.rules); setDirty(false); setStatus('已加载当前生效规则'); router.refresh();
    } catch (error) { setError(requestMessage(error)); }
    finally { setBusy(false); }
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget), number = (name: string) => data.get(name) === '' ? null : Number(data.get(name));
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await apiRequest<ScoringSettings>('/api/admin/scoring-settings', csrfToken, 'PUT', { version: settings.version, rules: {
        codeforces: { points: CF_BAND_LABELS.map((_, i) => number(`cf-${i}`)), unknownPoints: number('cf-unknown') },
        luogu: { points: DEFAULT_SCORING_RULES.luogu.points.map((_, i) => number(`luogu-${i}`)), unknownPoints: number('luogu-unknown') },
        qoj: { points: number('qoj') },
      } });
      setSettings(result); replaceDraft(result.rules); setDirty(false); setStatus('已保存，榜单和明细将自动按新规则计算。下方预览已刷新。'); router.refresh();
    } catch (error) { setError(requestMessage(error)); }
    finally { setBusy(false); }
  }
  return <form className="form-stack scoring-settings" onSubmit={save}>
    <div className="panel"><p>设置首次 AC 的题目分值，保存后自动应用于所有日期区间的个人榜、团队榜和做题明细。</p><p className="muted">每人同题只计首次 AC；CF 组队积分按实际人数平分。分值可设为 0，最多三位小数，上限 10000。</p><p className="muted">当前配置版本 {settings.version}{dirty ? ' · 有未保存的修改' : ''}</p></div>
    <fieldset key={revision} disabled={busy} className="scoring-grid" onChange={() => { setDirty(true); setStatus(''); }}>
      <legend className="sr-only">各平台赋分</legend>
      <section className="panel form-stack" aria-labelledby="cf-scoring-title"><h2 id="cf-scoring-title">Codeforces</h2><p className="muted">按题目 rating 分档</p>{CF_BAND_LABELS.map((label, i) => <PointInput key={label} name={`cf-${i}`} label={label} value={draft.codeforces.points[i]!} />)}<PointInput name="cf-unknown" label="未知 rating" value={draft.codeforces.unknownPoints} /></section>
      <section className="panel form-stack" aria-labelledby="luogu-scoring-title"><h2 id="luogu-scoring-title">洛谷</h2><p className="muted">按原站难度 ID 分档</p>{draft.luogu.points.map((value, i) => <PointInput key={i} name={`luogu-${i}`} label={`难度 ${i + 1}`} value={value} />)}<PointInput name="luogu-unknown" label="未知难度" value={draft.luogu.unknownPoints} /></section>
      <section className="panel form-stack" aria-labelledby="qoj-scoring-title"><h2 id="qoj-scoring-title">QOJ</h2><p className="muted">所有题目使用统一分值</p><PointInput name="qoj" label="每题" value={draft.qoj.points} /></section>
    </fieldset>
    <div className="panel form-stack"><div className="form-actions"><button className="button primary" disabled={busy || !dirty}>{busy ? '处理中…' : '保存并重新计算'}</button><button className="button" type="button" disabled={busy} onClick={() => { replaceDraft(structuredClone(DEFAULT_SCORING_RULES)); setDirty(true); setError(''); setStatus('已填入默认分值，点击保存后生效。'); }}>恢复默认</button><button className="button" type="button" disabled={busy} onClick={() => void reload()}>重新加载已保存规则</button></div><p role="status">{status}</p>{error && <p role="alert" className="error">{error}</p>}</div>
  </form>;
}
