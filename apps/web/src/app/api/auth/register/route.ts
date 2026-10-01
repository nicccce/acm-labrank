import { register } from '@acm/core/server';
import { api, checkOrigin, readJson, sessionResponse } from '../../../../lib/http';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    return sessionResponse(await register(await readJson(request)), 201);
  });
}
