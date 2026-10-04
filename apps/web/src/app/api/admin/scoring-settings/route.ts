import { getScoringSettings, changeScoringSettings } from '@acm/core/server';
import { api, NextResponse, readJson, requireAdmin } from '../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function GET() { return api(async () => { await requireAdmin(); return NextResponse.json(await getScoringSettings()); }); }
export async function PUT(request: Request) { return api(async () => { const { session } = await requireAdmin(request); return NextResponse.json(await changeScoringSettings(await readJson(request), session.user.id)); }); }
