import { describe, expect, it } from 'vitest';
import { rangeStartReached, filterSubmissionRange, type SubmissionPage, type NormalizedSubmission } from './index';

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


describe('initial lower-bound collection', () => {
  it('keeps later submissions without a fixed upper boundary and includes the lower boundary', () => {
    const page = { submissions: rows('2026-10-04T16:00:00.000Z', range.from, '2026-09-30T00:00:00.000Z'), problems: [] } as unknown as SubmissionPage;
    expect(filterSubmissionRange(page, undefined, range.from).submissions.map(row => row.submittedAt)).toEqual(['2026-10-04T16:00:00.000Z', range.from]);
    expect(rangeStartReached(page.submissions, undefined, range.from)).toBe(true);
    expect(rangeStartReached(rows(range.from), undefined, range.from)).toBe(false);
  });
  it('rejects a range combined with an initial lower boundary', () => {
    expect(() => rangeStartReached([], range, range.from)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => filterSubmissionRange({ submissions: [], problems: [] } as unknown as SubmissionPage, range, range.from)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});
