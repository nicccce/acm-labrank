import { beginWebLuoguLogin, AppError } from '@acm/core/server';
import { api, NextResponse, requireAdmin, readJson, type RouteContext } from '../../../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function POST(request: Request, context: RouteContext) { return api(async () => { const { session } = await requireAdmin(request); if ((await context.params).platform !== 'luogu') throw new AppError('NOT_IMPLEMENTED', 'QOJ 请通过远程桌面登录', 422); return NextResponse.json(await beginWebLuoguLogin(await readJson(request), session.sessionId, request.signal), { status: 201 }); }); }
