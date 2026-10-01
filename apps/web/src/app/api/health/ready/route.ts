import { checkDatabaseReady } from '@acm/db/server';
import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export async function GET() {
  let ready = false;
  try { ready = await checkDatabaseReady(); } catch { /* Do not expose connection details. */ }
  return NextResponse.json({ status: ready ? 'ready' : 'unavailable' }, { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
