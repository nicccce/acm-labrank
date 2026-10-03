import { adminSyncJob } from '@acm/core/server';
import { api, NextResponse, requireAdmin, type RouteContext } from '../../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function GET(_request: Request, context: RouteContext) { return api(async () => { await requireAdmin(); const { id } = await context.params; return NextResponse.json(await adminSyncJob(id!)); }); }
