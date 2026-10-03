import { describe, expect, it } from 'vitest';
import { rangeStartReached, type NormalizedSubmission } from './index';

const range = { from: '2026-10-01T16:00:00.000Z', to: '2026-10-02T16:00:00.000Z' };
const rows = (...times: (string | null)[]) => times.map(submittedAt => ({ submittedAt }) as NormalizedSubmission);
describe('safe range stopping', () => {
  it('does not cut at the inclusive lower boundary and cuts only after crossing it', () => {
    expect(rangeStartReached(rows(range.from), range)).toBe(false);
    expect(rangeStartReached(rows(range.from, '2026-10-01T15:59:59.000Z'), range)).toBe(true);
    expect(rangeStartReached([], range)).toBe(false);
  });
  it('pauses rather than falsely completing when time evidence is missing or unordered', () => {
    expect(() => rangeStartReached(rows(null), range)).toThrow(expect.objectContaining({ code: 'PARSE_CHANGED' }));
    expect(() => rangeStartReached(rows('2026-09-01T00:00:00.000Z', range.from), range)).toThrow(expect.objectContaining({ code: 'PARSE_CHANGED' }));
  });
});
