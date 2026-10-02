import type { RequestContext } from '@acm/connectors/contracts';
import { createRequestContext } from '../../collection/request-context';

export function createCodeforcesReadContext(signal: AbortSignal): RequestContext {
  return createRequestContext({ platform: 'codeforces', signal });
}
