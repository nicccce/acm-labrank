import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCORING_RULES } from '../domain';
import { scoringSettingsSchema } from '../domain/scoring-rules';
import { changeScoringSettings, getScoringSettings } from './scoring-settings';
import { pointsSql } from './scores/query';

const db = vi.hoisted(() => ({ getScoringSettingsRecord: vi.fn(), updateScoringSettingsRecord: vi.fn() }));
vi.mock('@acm/db/server', () => db);
const input = () => ({ rules: structuredClone(DEFAULT_SCORING_RULES), version: 1 });
beforeEach(() => vi.clearAllMocks());
describe('administrator scoring settings', () => {
  it('accepts defaults, zero and decimal points', () => {
    expect(scoringSettingsSchema.parse(input())).toEqual(input());
    const custom = input(); custom.rules.codeforces.points[0] = 0; custom.rules.luogu.points[7] = 12.345; custom.rules.qoj.points = 0.001;
    expect(scoringSettingsSchema.parse(custom)).toEqual(custom);
  });
  it('rejects incomplete rules, invalid scores, extra keys and missing versions', () => {
    for (const value of [-1, 10000.001, 0.0001, NaN, Infinity, '3', null]) {
      const custom = input(); Object.assign(custom.rules.qoj, { points: value });
      expect(scoringSettingsSchema.safeParse(custom).success).toBe(false);
    }
    const short = input(); short.rules.codeforces.points.pop();
    const extra = input(); extra.rules.luogu.points.push(20);
    for (const value of [short, extra, { ...input(), version: 0 }, { rules: input().rules }, { ...input(), role: 'admin' }]) expect(scoringSettingsSchema.safeParse(value).success).toBe(false);
    expect(() => pointsSql({ ...input().rules, qoj: { points: '0; DROP TABLE users' as unknown as number } })).toThrow();
  });
  it('persists the validated rules and rejects stale updates', async () => {
    const saved = { ...input(), version: 2 }; db.updateScoringSettingsRecord.mockResolvedValueOnce(saved).mockResolvedValueOnce(null);
    expect(await changeScoringSettings(input(), 'admin')).toEqual(saved);
    expect(db.updateScoringSettingsRecord).toHaveBeenCalledWith(input(), 'admin');
    await expect(changeScoringSettings(input(), 'admin')).rejects.toMatchObject({ status: 409, code: 'SETTINGS_STALE' });
    await expect(changeScoringSettings({}, 'admin')).rejects.toMatchObject({ status: 400 });
    expect(db.updateScoringSettingsRecord).toHaveBeenCalledTimes(2);
  });
  it('reads saved rules afresh instead of caching a previous configuration', async () => {
    const changed = input(); changed.rules.qoj.points = 19;
    db.getScoringSettingsRecord.mockResolvedValueOnce(input()).mockResolvedValueOnce({ ...changed, version: 2 });
    expect((await getScoringSettings()).rules.qoj.points).toBe(3);
    expect((await getScoringSettings()).rules.qoj.points).toBe(19);
  });
});
