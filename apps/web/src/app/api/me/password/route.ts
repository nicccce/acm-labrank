import { changePassword } from '@acm/core/server';
import { api, checkOrigin, readJson, requireSession, sessionResponse } from '../../../../lib/http';
export const runtime = 'nodejs';
export async function PUT(request: Request) {
  return api(async () => { checkOrigin(request); const { session } = await requireSession(request, true); return sessionResponse(await changePassword(session, await readJson(request))); });
}
