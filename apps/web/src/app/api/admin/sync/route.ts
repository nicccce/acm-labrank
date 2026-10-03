import { requestAdminSync } from '@acm/core/server';
import { api, NextResponse, requireAdmin, readJson } from '../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function POST(request: Request) { return api(async () => { const { session } = await requireAdmin(request); return NextResponse.json(await requestAdminSync(await readJson(request), session.user.id), { status: 202 }); }); }
