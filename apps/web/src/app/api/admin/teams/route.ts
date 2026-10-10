import { getManagedTeams } from '@acm/core/server';
import { api, NextResponse, requireAdmin } from '../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function GET(request: Request) { return api(async () => { await requireAdmin(); return NextResponse.json(await getManagedTeams(new URL(request.url).searchParams)); }); }
