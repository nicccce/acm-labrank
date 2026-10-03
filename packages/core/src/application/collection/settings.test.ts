import { describe, expect, it } from 'vitest';
import { configuredSyncRange } from '@acm/db/server';
import { parsePersonalQuery } from '../personal';
import { collectionSettingsSchema } from './settings';
const settings = { platforms: ['codeforces'], autoSyncEnabled: false, syncIntervalMinutes: 360, scoreRange: { kind: 'rolling' as const, days: 30 as const }, version: 1 };
describe('administrator collection settings', () => {
  it('rejects duplicate/unknown platforms, invalid dates and unsafe cycles', () => {
    for (const input of [
      { ...settings, platforms: ['qoj', 'qoj'] }, { ...settings, platforms: ['other'] },
      { ...settings, syncIntervalMinutes: 0 }, { ...settings, syncIntervalMinutes: 10081 },
      { ...settings, scoreRange: { kind: 'fixed', from: '2026-02-30', to: '2026-03-01' } },
      { ...settings, scoreRange: { kind: 'fixed', from: '2025-01-01', to: '2026-01-02' } },
      { ...settings, scoreRange: { kind: 'fixed', from: '2026-10-03', to: '2026-10-02' } },
      { ...settings, password: 'never-accepted' },
    ]) expect(collectionSettingsSchema.safeParse(input).success).toBe(false);
    expect(collectionSettingsSchema.safeParse({ ...settings, platforms: [], syncIntervalMinutes: 1 }).success).toBe(true);
  });
  it('uses Beijing midnight for rolling acquisition and query snapshots', () => {
    const before = new Date('2026-10-02T15:59:59Z'), after = new Date('2026-10-02T16:00:00Z');
    const a = configuredSyncRange(settings, before), b = configuredSyncRange(settings, after);
    expect(b.from.getTime() - a.from.getTime()).toBe(86400000);
    const query = parsePersonalQuery(new URLSearchParams(), after, settings);
    expect(query.range.start).toEqual(b.from); expect(query.range.end).toEqual(b.to);
    expect(query.query.platforms).toEqual(['codeforces']);
  });
  it('uses the fixed default, preserves explicit dates and excludes disabled scores', () => {
    const fixed = { ...settings, scoreRange: { kind: 'fixed' as const, from: '2026-09-01', to: '2026-09-30' } };
    const query = parsePersonalQuery(new URLSearchParams(), new Date('2026-10-03T01:00Z'), fixed);
    expect(query.range).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(query.range.start).toEqual(configuredSyncRange(fixed).from);
    const explicit = parsePersonalQuery(new URLSearchParams({ from: '2026-10-01', to: '2026-10-02', platform: 'qoj' }), new Date(), fixed);
    expect(explicit.range.from).toBe('2026-10-01'); expect(explicit.query.platforms).toEqual([]);
    expect(parsePersonalQuery(new URLSearchParams({ days: '7' }), new Date('2026-10-02T16:00:00Z'), fixed).range.from).toBe('2026-09-27');
  });
});
