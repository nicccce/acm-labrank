import { patchManagedUser, deleteManagedUser } from '@acm/core/server';
import { api, NextResponse, readJson, requireAdmin, type RouteContext } from '../../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function PATCH(request: Request, context: RouteContext) { return api(async () => { const { session } = await requireAdmin(request), { id } = await context.params; return NextResponse.json(await patchManagedUser(session.user.id, id!, await readJson(request))); }); }
export async function DELETE(request: Request, context: RouteContext) { return api(async () => { const { session } = await requireAdmin(request), { id } = await context.params; return NextResponse.json(await deleteManagedUser(session.user.id, id!)); }); }
