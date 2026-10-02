import { describe, expect, it } from 'vitest';
import { classifyReadFailure } from './errors';
import { originalRetryInput, parsePlatformReadRequest } from './contracts';
import { readRequestKey } from './jobs';
import { ConnectorError } from '@acm/connectors/contracts';

describe('platform collection contract', () => {
  it.each(['codeforces', 'luogu', 'qoj'] as const)('normalizes %s defaults and rejects credentials or runtime fields', platform => {
    expect(parsePlatformReadRequest({ platform, target: 'sample' })).toMatchObject({ platform, target: 'sample', operation: 'submissions', mode: 'backfill', maxPages: 2, maxDurationMs: 120000, cursor: null, checkpoint: null });
    expect(() => parsePlatformReadRequest({ platform, target: 'sample', password: 'must-not-persist' })).toThrow();
    expect(() => parsePlatformReadRequest({ platform, target: 'sample', minIntervalMs: 0 })).toThrow();
  });
  it('uses the original batch cursor for retries and makes equivalent requests deduplicate', () => {
    const input = { platform: 'qoj', target: 'sample', cursor: { version: 1, data: { page: 3 } } };
    expect(originalRetryInput(input).cursor).toEqual(input.cursor);
    expect(readRequestKey(input)).toBe(readRequestKey({ cursor: { data: { page: 3 }, version: 1 }, target: 'sample', platform: 'qoj', maxPages: 2 }));
    expect(readRequestKey(input)).not.toBe(readRequestKey({ ...input, cursor: { version: 1, data: { page: 4 } } }));
  });
  it('keeps verification bounded and rejects account URLs', () => {
    expect(parsePlatformReadRequest({ platform: 'luogu', target: '123', operation: 'verify', maxPages: 99 }).maxPages).toBe(1);
    expect(() => parsePlatformReadRequest({ platform: 'luogu', target: 'https://other.invalid' })).toThrow();
    expect(() => parsePlatformReadRequest({ platform: 'luogu', target: '123', maxPages: 101 })).toThrow();
  });
  it('separates session failures, target restrictions, transient errors and parser changes', () => {
    expect(classifyReadFailure(new ConnectorError('AUTH_REQUIRED', 'secret-value'), 'qoj')).toMatchObject({ status: 'auth_required', error: { action: 'reauthenticate' } });
    expect(classifyReadFailure(new ConnectorError('AUTH_REQUIRED', 'secret-value'), 'codeforces')).toMatchObject({ status: 'failed', error: { action: 'unsupported' } });
    expect(classifyReadFailure(new ConnectorError('FORBIDDEN', 'secret-value'), 'luogu')).toMatchObject({ status: 'restricted', error: { action: 'fix_target' } });
    expect(classifyReadFailure(new ConnectorError('HTTP_ERROR', 'secret-value', { httpStatus: 503 }), 'qoj')).toMatchObject({ status: 'failed', error: { action: 'retry', httpStatus: 503 } });
    expect(classifyReadFailure(new ConnectorError('PARSE_CHANGED', 'secret-value'), 'qoj')).toMatchObject({ status: 'parse_changed', error: { action: 'fix_parser' } });
    expect(JSON.stringify(classifyReadFailure(new Error('Cookie=secret-value'), 'qoj'))).not.toContain('secret-value');
  });
});
