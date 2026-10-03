import { advanceWebLuoguLogin, AppError } from '@acm/core/server';
import { api, NextResponse, requireAdmin, readJson, type RouteContext } from '../../../../../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function POST(request: Request, context: RouteContext) { return api(async () => { const { session } = await requireAdmin(request); const { platform, id } = await context.params; if (platform !== 'luogu') throw new AppError('NOT_IMPLEMENTED', '平台不支持此操作', 422); return NextResponse.json(await advanceWebLuoguLogin(id!, await readJson(request), session.sessionId, request.signal, false)); }); }
