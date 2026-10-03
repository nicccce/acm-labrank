import { getMemberBindings } from '@acm/core/server';
import { api, NextResponse, requireSession } from '../../../../lib/personal-http';
export const runtime = 'nodejs';
export async function GET() { return api(async () => { const { session } = await requireSession(); return NextResponse.json(await getMemberBindings(session.user.id)); }); }
