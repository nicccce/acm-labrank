import { getAdminConnectionAlerts } from '@acm/core/server';
import { api, NextResponse, requireAdmin } from '../../../../lib/personal-http';

export const runtime = 'nodejs';
export async function GET() {
  return api(async () => {
    await requireAdmin();
    return NextResponse.json(await getAdminConnectionAlerts());
  });
}
