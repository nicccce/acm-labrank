import { restoreManagedUser } from '@acm/core/server';
import { api, NextResponse, requireAdmin, type RouteContext } from '../../../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function POST(request: Request, context: RouteContext) { return api(async () => { const { session } = await requireAdmin(request), { id } = await context.params; return NextResponse.json(await restoreManagedUser(session.user.id, id!)); }); }
