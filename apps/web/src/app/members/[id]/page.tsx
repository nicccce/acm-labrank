import Link from 'next/link';
import { getPersonalMember, getPersonalRecords } from '@acm/core/server';
import { loadPage, MemberShell, memberSession, pageParams, PageError, scorePlatforms, type PageSearch } from '../../../lib/member-page';
import { ScoreFilter } from '../../../components/score-filter';
import { CoverageTable, formatTime, Pagination, platformNames, ScoreSummary } from '../../../components/score-display';
export const dynamic = 'force-dynamic';
interface Solve { id: string; platform: string; problemKey: string; title: string; nativeDifficulty: number | null; difficultyUpdatedAt: Date; sourceUrl: string; firstAcAt: Date; points: number }
interface Submission { id: string; platform: string; externalSubmissionId: string; submittedAt: Date | null; verdict: string; nativeScore: number | null; nativeResult: string | null; sourceUrl: string | null; problemKey: string | null; title: string | null; participantType: string | null }
const verdicts: Record<string, string> = { accepted: 'AC', rejected: '未通过', pending: '判题中', unknown: '未知' };
export default async function MemberPage({ params: route, searchParams }: { params: Promise<{ id: string }>; searchParams: PageSearch }) {
  const session = await memberSession(), { id } = await route, params = await pageParams(searchParams), view = params.get('view') === 'submissions' ? 'submissions' : 'solves';
  const query = new URLSearchParams(params); query.delete('view');
  const [result, platforms] = await Promise.all([loadPage(async () => { const [member, records] = await Promise.all([getPersonalMember(id, query), getPersonalRecords(id, query, view === 'submissions')]); return { member, records }; }), scorePlatforms()]);
  const data = result.data;
  function tabHref(value: string) { const q = new URLSearchParams(query); q.delete('page'); q.set('view', value); return `/members/${id}?${q}`; }
  return <MemberShell session={session} title={data?.member.member.displayName ?? '个人成绩'}>{data ? <>
    <p className="muted">{data.member.member.username}{data.member.platformAccounts.map(a => ` · ${platformNames[a.platform]} ${a.handle}`).join('')}</p>
    <ScoreFilter key={params.toString()} query={Object.fromEntries(query)} range={data.member.range} platforms={platforms} extra={{ view }} />
    <ScoreSummary points={data.member.points} solveCount={data.member.solveCount} submissionCount={data.member.submissionCount} rank={data.member.rank} provisional={data.member.provisional} />
    <CoverageTable items={data.member.coverage} />
    <section><h2>每日成绩</h2><div className="table-wrap"><table className="data-table"><thead><tr><th>日期</th><th>题数</th><th>积分</th></tr></thead><tbody>{data.member.calendar.map((day: { date: string; solveCount: number; points: number }) => <tr key={day.date}><td>{day.date}</td><td>{day.solveCount}</td><td>{day.points}</td></tr>)}{!data.member.calendar.length && <tr><td colSpan={3}>暂无记录</td></tr>}</tbody></table></div></section>
    <section><div className="form-actions"><Link href={tabHref('solves')}>过题明细</Link><Link href={tabHref('submissions')}>提交记录</Link><span className="muted">计分规则 {data.member.ruleVersion}</span></div>
    <div className="table-wrap">{view === 'solves' ? <table className="data-table"><thead><tr><th>平台</th><th>题目</th><th>首次 AC</th><th>原生难度</th><th>积分</th><th>难度更新时间</th></tr></thead><tbody>{(data.records.items as Solve[]).map(s => <tr key={s.id}><td>{platformNames[s.platform]}</td><td><a href={s.sourceUrl} target="_blank" rel="noreferrer">{s.problemKey} {s.title}</a></td><td>{formatTime(s.firstAcAt)}</td><td>{s.nativeDifficulty ?? '未知'}</td><td>{s.points}</td><td>{formatTime(s.difficultyUpdatedAt)}</td></tr>)}{!data.records.items.length && <tr><td colSpan={6}>暂无记录</td></tr>}</tbody></table> : <table className="data-table"><thead><tr><th>平台</th><th>提交</th><th>题目</th><th>时间</th><th>判题</th><th>原站得分</th><th>类型</th></tr></thead><tbody>{(data.records.items as Submission[]).map(s => <tr key={s.id}><td>{platformNames[s.platform]}</td><td>{s.sourceUrl ? <a href={s.sourceUrl} target="_blank" rel="noreferrer">{s.externalSubmissionId}</a> : s.externalSubmissionId}</td><td>{s.problemKey ?? '待识别'} {s.title}</td><td>{formatTime(s.submittedAt)}</td><td>{verdicts[s.verdict]}{s.nativeResult ? ` · ${s.nativeResult}` : ''}</td><td>{s.nativeScore ?? '—'}</td><td>{s.participantType ?? '—'}</td></tr>)}{!data.records.items.length && <tr><td colSpan={7}>暂无记录</td></tr>}</tbody></table>}</div>
    <Pagination path={`/members/${id}`} params={params} page={data.records.page} limit={data.records.limit} total={data.records.total} /></section>
  </> : <PageError message={result.error!} />}</MemberShell>;
}
