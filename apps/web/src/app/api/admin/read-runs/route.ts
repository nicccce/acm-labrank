import { NextResponse } from 'next/server';
import { getAdminReadRuns, requestAdminRead } from '@acm/core/server';
import { api, readJson, requireAdmin } from '../../../../lib/http';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  return api(async () => { await requireAdmin(); return NextResponse.json(await getAdminReadRuns(new URL(request.url).searchParams)); });
}
export async function POST(request: Request) {
  return api(async () => {
    const { session } = await requireAdmin(request);
    return NextResponse.json(await requestAdminRead(await readJson(request), session.user.id), { status: 202 });
  });
}
