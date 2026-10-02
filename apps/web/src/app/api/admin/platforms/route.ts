import { NextResponse } from 'next/server';
import { getAdminPlatforms } from '@acm/core/server';
import { api, requireAdmin } from '../../../../lib/http';

export const runtime = 'nodejs';
export async function GET() {
  return api(async () => { await requireAdmin(); return NextResponse.json(await getAdminPlatforms()); });
}
