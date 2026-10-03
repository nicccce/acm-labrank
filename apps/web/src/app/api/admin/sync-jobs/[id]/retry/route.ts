import { retryAdminSync } from '@acm/core/server';
import { api, NextResponse, requireAdmin, type RouteContext } from '../../../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function POST(request: Request, context: RouteContext) { return api(async () => { await requireAdmin(request); const { id } = await context.params; return NextResponse.json(await retryAdminSync(id!), { status: 202 }); }); }
