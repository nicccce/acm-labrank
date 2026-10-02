import { NextResponse } from 'next/server';
import { adminPlatform, changeAdminRateLimit } from '@acm/core/server';
import { api, readJson, requireAdmin } from '../../../../../../lib/http';

export const runtime = 'nodejs';
export async function PATCH(request: Request, context: { params: Promise<{ platform: string }> }) {
  return api(async () => {
    const { session } = await requireAdmin(request);
    const platform = adminPlatform((await context.params).platform);
    return NextResponse.json(await changeAdminRateLimit(platform, await readJson(request), session.user.id));
  });
}
