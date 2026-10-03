import { deleteTeam, getTeamDetail, updateTeam } from '@acm/core/server';
import { api, NextResponse, readJson, requireSession, requireMemberWrite, type RouteContext } from '../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function GET(request: Request, context: RouteContext) { return api(async () => { await requireSession(); const { id } = await context.params; return NextResponse.json(await getTeamDetail(id!, new URL(request.url).searchParams)); }); }
export async function PUT(request: Request, context: RouteContext) { return api(async () => { const { session } = await requireMemberWrite(request), { id } = await context.params; return NextResponse.json(await updateTeam(id!, session.user.id, await readJson(request))); }); }
export async function DELETE(request: Request, context: RouteContext) { return api(async () => { const { session } = await requireMemberWrite(request), { id } = await context.params; return NextResponse.json(await deleteTeam(id!, session.user.id, await readJson(request))); }); }
