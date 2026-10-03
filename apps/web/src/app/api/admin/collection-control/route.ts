import { getAdminCollectionControl, changeAdminCollectionControl } from '@acm/core/server';
import { api, NextResponse, requireAdmin, readJson } from '../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function GET() { return api(async () => { await requireAdmin(); return NextResponse.json(await getAdminCollectionControl()); }); }
export async function PUT(request: Request) { return api(async () => { const { session } = await requireAdmin(request); return NextResponse.json(await changeAdminCollectionControl(await readJson(request), session.user.id)); }); }
