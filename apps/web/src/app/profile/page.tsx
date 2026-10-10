import { getMemberBindings, getMemberProfile } from '@acm/core/server';
import { MemberShell, memberSession } from '../../lib/member-page';
import { ProfileEditor } from '../../components/profile-editor';
import { StarSetting } from '../../components/star-setting';
import { PasswordEditor } from '../../components/password-editor';
export const dynamic = 'force-dynamic';
export default async function ProfilePage() {
  const session = await memberSession(), [member, bindings] = await Promise.all([getMemberProfile(session.user.id), getMemberBindings(session.user.id)]);
  return <MemberShell session={session} title="我的资料"><StarSetting isStarred={member.isStarred} url="/api/me/star" csrfToken={session.csrfToken} /><ProfileEditor username={member.username} realName={member.realName} initial={bindings} csrfToken={session.csrfToken} /><PasswordEditor csrfToken={session.csrfToken} /></MemberShell>;
}
