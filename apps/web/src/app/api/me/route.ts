import { getMemberProfile, saveMemberProfile } from '@acm/core/server';
import { api, NextResponse, readJson, requireSession, requireMemberWrite } from '../../../lib/personal-http';
export const runtime = 'nodejs';
export async function GET() { return api(async () => { const { session } = await requireSession(); return NextResponse.json(await getMemberProfile(session.user.id)); }); }
export async function PUT(request: Request) { return api(async () => { const { session } = await requireMemberWrite(request); return NextResponse.json(await saveMemberProfile(session.user.id, await readJson(request))); }); }
