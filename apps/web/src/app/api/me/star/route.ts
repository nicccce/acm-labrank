import { setOwnUserStar } from '@acm/core/server';
import { api, NextResponse, readJson, requireMemberWrite } from '../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function PUT(request: Request) { return api(async () => { const { session } = await requireMemberWrite(request); return NextResponse.json(await setOwnUserStar(session.user.id, await readJson(request))); }); }
