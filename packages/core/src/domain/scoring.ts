export const CF_BANDS = [[1000, 1], [1200, 2], [1400, 3], [1600, 4], [1800, 5], [2000, 6], [2300, 8], [2600, 10], [2900, 12]] as const;
export const LUOGU_POINTS = [1, 2, 3, 5, 8, 10, 12, 15] as const;
export function problemPoints(platform: string, difficulty: number | null): number {
  if (difficulty === null || !Number.isFinite(difficulty)) return 3;
  if (platform === 'codeforces') return CF_BANDS.find(([boundary]) => difficulty < boundary)?.[1] ?? 15;
  if (platform === 'luogu') return LUOGU_POINTS[difficulty - 1] ?? 3;
  return 3;
}
export function dateRange(input: { from?: string; to?: string; days?: number }, now: Date) {
  const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const to = input.to ?? today;
  const from = input.from ?? new Date(Date.parse(`${to}T00:00:00+08:00`) - ((input.days ?? 30) - 1) * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  function valid(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
  if (!valid(from) || !valid(to)) throw new Error('INVALID_DATE');
  const start = new Date(`${from}T00:00:00+08:00`), end = new Date(Date.parse(`${to}T00:00:00+08:00`) + 86400000);
  if (end <= start || end.getTime() - start.getTime() > 366 * 86400000) throw new Error('INVALID_DATE_RANGE');
  return { from, to, start, end, timezone: 'Asia/Shanghai' as const };
}
