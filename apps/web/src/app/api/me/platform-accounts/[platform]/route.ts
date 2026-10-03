import { deleteMemberBinding, personalPlatform, putMemberBinding } from '@acm/core/server';
import { api, NextResponse, readJson, requireMemberWrite, type RouteContext } from '../../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function PUT(request: Request, context: RouteContext) { return api(async () => { const { session } = await requireMemberWrite(request); const { platform } = await context.params; return NextResponse.json(await putMemberBinding(session.user.id, personalPlatform(platform!), await readJson(request)), { status: 202 }); }); }
export async function DELETE(request: Request, context: RouteContext) { return api(async () => { const { session } = await requireMemberWrite(request); const { platform } = await context.params; return NextResponse.json(await deleteMemberBinding(session.user.id, personalPlatform(platform!))); }); }
