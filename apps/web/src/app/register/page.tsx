import { redirect } from 'next/navigation';
import { getSiteSettings } from '@acm/core/server';
import { currentSession } from '../../lib/http';
import { AuthShell } from '../../components/auth-shell';
export const dynamic = 'force-dynamic';
export default async function RegisterPage() {
  if (await currentSession()) redirect('/');
  return <AuthShell mode="register" loginText={(await getSiteSettings()).loginText} />;
}
