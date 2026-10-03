import { requestAdminSessionVerification } from '@acm/core/server';
import { api, NextResponse, requireAdmin, type RouteContext } from '../../../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function POST(request: Request, context: RouteContext) { return api(async () => { const { session } = await requireAdmin(request); return NextResponse.json(await requestAdminSessionVerification((await context.params).platform!, session.user.id), { status: 202 }); }); }
