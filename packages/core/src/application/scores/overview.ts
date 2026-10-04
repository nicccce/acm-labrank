interface LeaderboardData {
  ruleVersion: string; asOf: string; range: unknown; platforms: string[];
  page: number; limit: number; provisional: boolean; total: number; items: unknown[];
}
// Anonymous responses expose leaderboard summaries, excluding account coverage and errors.
export function leaderboardOverview<T extends LeaderboardData>(data: T) {
  return { ruleVersion: data.ruleVersion, asOf: data.asOf, range: data.range, platforms: data.platforms, page: data.page, limit: data.limit, provisional: data.provisional, total: data.total, items: data.items };
}
