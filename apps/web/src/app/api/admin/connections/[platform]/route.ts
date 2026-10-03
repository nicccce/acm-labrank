import { disconnectAdminConnection } from '@acm/core/server';
import { api, NextResponse, requireAdmin, type RouteContext } from '../../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function DELETE(request: Request, context: RouteContext) { return api(async () => { const { session } = await requireAdmin(request); return NextResponse.json(await disconnectAdminConnection((await context.params).platform!, session.user.id)); }); }
