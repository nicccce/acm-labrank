import { getPersonalLeaderboard, leaderboardOverview } from '@acm/core/server';
import { api, NextResponse } from '../../../lib/personal-http';
import { currentSession } from '../../../lib/http';
export const runtime = 'nodejs';
export async function GET(request: Request) { return api(async () => { const [session, data] = await Promise.all([currentSession(), getPersonalLeaderboard(new URL(request.url).searchParams)]); return NextResponse.json(session ? data : leaderboardOverview(data)); }); }
