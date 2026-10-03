import { getPersonalRecords } from '@acm/core/server';
import { api, NextResponse, requireSession, type RouteContext } from '../../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function GET(request: Request, context: RouteContext) { return api(async () => { await requireSession(); const { id } = await context.params; return NextResponse.json(await getPersonalRecords(id!, new URL(request.url).searchParams, false)); }); }
