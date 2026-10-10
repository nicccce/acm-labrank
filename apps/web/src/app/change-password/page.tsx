import { memberSession } from '../../lib/member-page';
import { PasswordEditor } from '../../components/password-editor';
export const dynamic = 'force-dynamic';
export default async function ChangePasswordPage() {
  const session = await memberSession(true);
  return <main className="member-main"><h1>修改密码</h1><PasswordEditor csrfToken={session.csrfToken} required={session.user.mustChangePassword} /></main>;
}
