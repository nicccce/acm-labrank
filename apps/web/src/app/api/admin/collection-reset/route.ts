import { resetAdminCollection } from '@acm/core/server';
import { api, NextResponse, readJson, requireAdmin } from '../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function POST(request: Request) { return api(async () => { const { session } = await requireAdmin(request); return NextResponse.json(await resetAdminCollection(await readJson(request), session.user.id), { status: 202 }); }); }
