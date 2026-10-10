import { setTeamStar } from '@acm/core/server';
import { api, NextResponse, readJson, requireAdmin, type RouteContext } from '../../../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function PUT(request: Request, context: RouteContext) { return api(async () => { const { session } = await requireAdmin(request), { id } = await context.params; return NextResponse.json(await setTeamStar(id!, session.user.id, await readJson(request), true)); }); }
