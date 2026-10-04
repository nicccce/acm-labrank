export const CF_BANDS = [[1000, 1], [1200, 2], [1400, 3], [1600, 4], [1800, 5], [2000, 6], [2300, 8], [2600, 10], [2900, 12]] as const;
export const LUOGU_POINTS = [1, 2, 3, 5, 8, 10, 12, 15] as const;
export interface ScoringRules {
  codeforces: { points: number[]; unknownPoints: number };
  luogu: { points: number[]; unknownPoints: number };
  qoj: { points: number };
}
export interface ScoringSettings { rules: ScoringRules; version: number }
export const DEFAULT_SCORING_RULES: ScoringRules = {
  codeforces: { points: [...CF_BANDS.map(([, points]) => points), 15], unknownPoints: 3 },
  luogu: { points: [...LUOGU_POINTS], unknownPoints: 3 },
  qoj: { points: 3 },
};
export const CF_BAND_LABELS = [...CF_BANDS.map(([boundary], i) => i === 0 ? `< ${boundary}` : `${CF_BANDS[i - 1]![0]}–${boundary - 1}`), '≥ 2900'];
export function formatPoints(points: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(points);
}
export function problemPoints(platform: string, difficulty: number | null, rules: ScoringRules = DEFAULT_SCORING_RULES): number {
  const known = difficulty !== null && Number.isFinite(difficulty);
  if (platform === 'codeforces') {
    if (!known) return rules.codeforces.unknownPoints;
    const band = CF_BANDS.findIndex(([boundary]) => difficulty < boundary);
    return rules.codeforces.points[band < 0 ? CF_BANDS.length : band]!;
  }
  if (platform === 'luogu') return known ? rules.luogu.points[difficulty - 1] ?? rules.luogu.unknownPoints : rules.luogu.unknownPoints;
  if (platform === 'qoj') return rules.qoj.points;
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
