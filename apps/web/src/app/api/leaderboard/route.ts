import { getPersonalLeaderboard } from '@acm/core/server';
import { api, NextResponse, requireSession } from '../../../lib/personal-http';
export const runtime = 'nodejs';
export async function GET(request: Request) { return api(async () => { await requireSession(); return NextResponse.json(await getPersonalLeaderboard(new URL(request.url).searchParams)); }); }
