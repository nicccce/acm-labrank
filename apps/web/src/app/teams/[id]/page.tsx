import Link from 'next/link';
import { getTeamDetail } from '@acm/core/server';
import { loadPage, MemberShell, memberSession, pageParams, PageError, scorePlatforms, type PageSearch } from '../../../lib/member-page';
import { ScoreFilter } from '../../../components/score-filter';
import { CoverageTable, formatTime, ScoreSummary } from '../../../components/score-display';
import { TeamActions, TeamEditor } from '../../../components/team-editor';
export const dynamic = 'force-dynamic';
export default async function TeamPage({ params: route, searchParams }: { params: Promise<{ id: string }>; searchParams: PageSearch }) {
  const session = await memberSession(), { id } = await route, params = await pageParams(searchParams);
  const [result, platforms] = await Promise.all([loadPage(() => getTeamDetail(id, params)), scorePlatforms()]); const data = result.data;
  return <MemberShell session={session} title={data?.team.name ?? '队伍'}>{data ? <>
    {data.team.archivedAt && <p className="muted">已归档 · {formatTime(data.team.archivedAt)}</p>}
    <ScoreFilter key={params.toString()} query={Object.fromEntries(params)} range={data.range} platforms={platforms} />
    <ScoreSummary points={data.points} solveCount={data.solveCount} rank={data.rank} provisional={data.provisional} />
    <div className="table-wrap"><table className="data-table"><thead><tr><th>成员</th><th>积分</th><th>题数</th><th>CF</th><th>QOJ</th><th>洛谷</th><th>最近 AC</th></tr></thead><tbody>{data.members.map(m => <tr key={m.id}><td>{m.active ? <Link href={`/members/${m.id}?${params}`}>{m.displayName}</Link> : m.displayName}{m.id === data.team.ownerId ? '（负责人）' : ''}{!m.active ? '（已停用）' : ''}</td><td>{m.points}</td><td>{m.solveCount}</td><td>{m.platformSolveCounts.codeforces ?? 0}</td><td>{m.platformSolveCounts.qoj ?? 0}</td><td>{m.platformSolveCounts.luogu ?? 0}</td><td>{formatTime(m.lastAcAt)}</td></tr>)}</tbody></table></div>
    <CoverageTable items={data.coverage} />
    {!data.team.archivedAt && data.team.ownerId === session.user.id && <section><h2>编辑队伍</h2><TeamEditor key={data.team.version} self={session.user} team={data.team} csrfToken={session.csrfToken} /></section>}
    <section><TeamActions key={data.team.version} team={data.team} viewerId={session.user.id} csrfToken={session.csrfToken} /></section>
  </> : <PageError message={result.error!} />}</MemberShell>;
}
