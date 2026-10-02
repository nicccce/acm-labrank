import { NextResponse } from 'next/server';
import { getAdminReadRun } from '@acm/core/server';
import { api, requireAdmin } from '../../../../../lib/http';

export const runtime = 'nodejs';
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => { await requireAdmin(); return NextResponse.json(await getAdminReadRun((await context.params).id)); });
}
