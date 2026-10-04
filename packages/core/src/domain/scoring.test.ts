import { describe, expect, it } from 'vitest';
import { CF_BANDS, DEFAULT_SCORING_RULES, LUOGU_POINTS, dateRange, problemPoints } from './scoring';
describe('configurable scoring and Beijing dates', () => {
  it('uses custom points across every band, unknown difficulty and QOJ', () => {
    const rules = structuredClone(DEFAULT_SCORING_RULES);
    rules.codeforces.points = rules.codeforces.points.map((_, i) => i / 2);
    rules.codeforces.unknownPoints = 7.125;
    rules.luogu.points = rules.luogu.points.map((_, i) => i * 3);
    rules.luogu.unknownPoints = 0; rules.qoj.points = 21;
    CF_BANDS.forEach(([boundary], i) => { expect(problemPoints('codeforces', boundary - 1, rules)).toBe(i / 2); expect(problemPoints('codeforces', boundary, rules)).toBe((i + 1) / 2); });
    expect(problemPoints('codeforces', null, rules)).toBe(7.125);
    expect(problemPoints('codeforces', NaN, rules)).toBe(7.125);
    rules.luogu.points.forEach((value, i) => expect(problemPoints('luogu', i + 1, rules)).toBe(value));
    for (const difficulty of [null, 0, 9, Infinity]) expect(problemPoints('luogu', difficulty, rules)).toBe(0);
    for (const difficulty of [null, 2000]) expect(problemPoints('qoj', difficulty, rules)).toBe(21);
  });
  it('covers every CF band edge and unknown difficulty', () => {
    expect(problemPoints('codeforces', null)).toBe(3);
    CF_BANDS.forEach(([boundary, points], i) => { expect(problemPoints('codeforces', boundary - 1)).toBe(points); expect(problemPoints('codeforces', boundary)).toBe(CF_BANDS[i + 1]?.[1] ?? 15); });
    expect(problemPoints('qoj', 2000)).toBe(3);
  });
  it('covers every Luogu ID and unknown IDs', () => {
    LUOGU_POINTS.forEach((points, i) => expect(problemPoints('luogu', i + 1)).toBe(points));
    expect(problemPoints('luogu', 0)).toBe(3); expect(problemPoints('luogu', 9)).toBe(3);
  });
  it('includes today in 7/30 days and uses UTC half-open boundaries', () => {
    const now = new Date('2026-10-01T16:00:00Z');
    expect(dateRange({ days: 7 }, now)).toMatchObject({ from: '2026-09-26', to: '2026-10-02' });
    const range = dateRange({ from: '2026-10-02', to: '2026-10-02' }, now);
    expect(range.start.toISOString()).toBe('2026-10-01T16:00:00.000Z'); expect(range.end.toISOString()).toBe('2026-10-02T16:00:00.000Z');
    expect(dateRange({}, now).from).toBe('2026-09-03');
  });
  it('rejects impossible dates, reversed ranges and excessive ranges', () => {
    for (const input of [{ from: '2026-02-30', to: '2026-03-01' }, { from: '2026-10-03', to: '2026-10-02' }, { from: '2025-01-01', to: '2026-01-02' }]) expect(() => dateRange(input, new Date())).toThrow();
  });
});
