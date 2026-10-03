import { cancelWebLuoguLogin, AppError } from '@acm/core/server';
import { api, NextResponse, requireAdmin, type RouteContext } from '../../../../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function DELETE(request: Request, context: RouteContext) { return api(async () => { const { session } = await requireAdmin(request); const { platform, id } = await context.params; if (platform !== 'luogu') throw new AppError('NOT_IMPLEMENTED', '平台不支持此操作', 422); return NextResponse.json(await cancelWebLuoguLogin(id!, session.sessionId)); }); }
