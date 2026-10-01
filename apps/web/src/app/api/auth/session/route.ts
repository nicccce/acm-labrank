import { NextResponse } from 'next/server';
import { api, requireSession } from '../../../../lib/http';

export const dynamic = 'force-dynamic';
export async function GET() {
  return api(async () => {
    const { session } = await requireSession();
    return NextResponse.json(session);
  });
}
