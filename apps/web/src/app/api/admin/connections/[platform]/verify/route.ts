import { NextResponse } from 'next/server';
import { adminPlatform, verifyAdminConnection } from '@acm/core/server';
import { api, readJson, requireAdmin } from '../../../../../../lib/http';

export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ platform: string }> }) {
  return api(async () => {
    const { session } = await requireAdmin(request);
    const platform = adminPlatform((await context.params).platform);
    const result = await verifyAdminConnection(platform, platform === 'codeforces' ? null : await readJson(request), session.user.id);
    return NextResponse.json(result, { status: 'requiresLogin' in result ? 200 : 202 });
  });
}
