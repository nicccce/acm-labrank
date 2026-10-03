import { leaveTeam } from '@acm/core/server';
import { api, NextResponse, readJson, requireMemberWrite, type RouteContext } from '../../../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function DELETE(request: Request, context: RouteContext) { return api(async () => { const { session } = await requireMemberWrite(request), { id } = await context.params; return NextResponse.json(await leaveTeam(id!, session.user.id, await readJson(request))); }); }
