import Link from 'next/link';
import { getScoringSettings, getPersonalLeaderboard } from '@acm/core/server';
import { MemberShell, memberSession } from '../../../lib/member-page';
import { ScoringSettingsEditor } from '../../../components/scoring-settings-editor';
import { ScorePreview } from '../../../components/collection/score-preview';
export const dynamic = 'force-dynamic';
export default async function ScoringPage() {
  const session = await memberSession();
  if (session.user.role !== 'admin') return <MemberShell session={session} title="赋分设置"><p role="alert">仅管理员可以修改赋分规则。</p><Link href="/">返回榜单</Link></MemberShell>;
  const [settings, leaderboard] = await Promise.all([getScoringSettings(), getPersonalLeaderboard(new URLSearchParams())]);
  return <MemberShell session={session} title="赋分设置"><div className="scoring-page"><ScoringSettingsEditor initial={settings} csrfToken={session.csrfToken} /><ScorePreview leaderboard={JSON.parse(JSON.stringify(leaderboard))} /></div></MemberShell>;
}
