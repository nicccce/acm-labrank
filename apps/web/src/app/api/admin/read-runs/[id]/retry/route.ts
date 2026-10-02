import { NextResponse } from 'next/server';
import { retryAdminRead } from '@acm/core/server';
import { api, requireAdmin } from '../../../../../../lib/http';

export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { session } = await requireAdmin(request);
    return NextResponse.json(await retryAdminRead((await context.params).id, session.user.id), { status: 202 });
  });
}
