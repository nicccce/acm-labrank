import { webLuoguCaptcha, AppError } from '@acm/core/server';
import { api, NextResponse, requireAdmin, type RouteContext } from '../../../../../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function GET(_request: Request, context: RouteContext) { return api(async () => { const { session } = await requireAdmin(); const { platform, id } = await context.params; if (platform !== 'luogu') throw new AppError('NOT_IMPLEMENTED', '平台不支持此操作', 422); const result = await webLuoguCaptcha(id!, session.sessionId); return new NextResponse(new Uint8Array(result.image), { headers: { 'Content-Type': result.contentType, 'Cache-Control': 'no-store', 'X-Challenge-Version': String(result.version) } }); }); }
