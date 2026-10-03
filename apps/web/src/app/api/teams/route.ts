import { createTeam, getTeams } from '@acm/core/server';
import { api, NextResponse, readJson, requireSession, requireMemberWrite } from '../../../lib/personal-http';
export const runtime = 'nodejs';
export async function GET(request: Request) { return api(async () => { const { session } = await requireSession(); return NextResponse.json(await getTeams(new URL(request.url).searchParams, session.user.id)); }); }
export async function POST(request: Request) { return api(async () => { const { session } = await requireMemberWrite(request); const result = await createTeam(session.user.id, await readJson(request)); return NextResponse.json(result, { status: result.created ? 201 : 200 }); }); }
