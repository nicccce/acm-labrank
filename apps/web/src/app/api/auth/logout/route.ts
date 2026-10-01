import { NextResponse } from 'next/server';
import { logout } from '@acm/core/server';
import { api, checkOrigin, requireSession, SESSION_COOKIE } from '../../../../lib/http';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const { token } = await requireSession(request);
    await logout(token);
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, '', { maxAge: 0, path: '/', httpOnly: true, sameSite: 'lax' });
    return response;
  });
}
