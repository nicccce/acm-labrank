import type { PlatformId } from '@acm/connectors/contracts';
export interface SiteSettings { headerText: string; loginText: string; version: number }
export type SyncScope = 'initial' | 'incremental' | 'range';
export type Platform = PlatformId;
export type Range = { kind: 'rolling'; days: 7 | 30 } | { kind: 'fixed'; from: string; to: string };
export type Settings = { platforms: Platform[]; autoSyncEnabled: boolean; syncIntervalMinutes: number; scoreRange: Range; version: number; items: Summary[] };
export type Summary = { platform: Platform; bindingCount: number; submissionCount: number; problemCount: number; lastSuccessAt: string | null; nextSyncAt: string | null; blockedCount: number; skipped: string | null; message: string | null };
export type Rate = { minIntervalMs: number; maxIntervalMs: number; version: number };
export type PlatformInfo = { platform: Platform; name: string; rateLimit: Rate; connection: { state: string; collector: string | null } };
export type Job = { id: string; platform: Platform; username: string; handle: string | null; source: string; kind: string; mode: string; scope: SyncScope; initialFrom: string | null; status: string; pages: number; recordsWithOverlap: number; batch: number; range: { from: string; to: string } | null; createdAt: string; startedAt: string | null; finishedAt: string | null; error: { code?: string; message?: string } | null };
export type Jobs = { items: Job[]; nextCursor: string | null };
export type Leaderboard = { range: { from: string; to: string }; provisional: boolean; total: number; items: { id: string; rank: number; displayName: string; points: number; solveCount: number; lastAcAt: string | null }[] };
export type Initial = { settings: Settings; platforms: PlatformInfo[]; control: { enabled: boolean; version: number }; jobs: Jobs; leaderboard: Leaderboard };
export type DispatchResult = { items: { runId?: string; merged?: boolean; skipped?: string; message?: string; error?: { message: string } }[] };

export interface Binding {
  platform: string; version: number;
  active: { handle: string; accountId: string; externalId: string | null } | null;
  candidate: { target: string; state: string; waitingReason?: string | null; error: { message?: string } | null } | null;
  sync: { initializedAt?: string | Date | null; initialFrom?: string | Date | null; latestScope?: SyncScope | null; lastSuccessAt: string | Date | null; historyComplete: boolean; coverage: string };
}
export interface Bindings { items: Binding[] }
export interface CoverageItem { userId: string; platform: string; handle: string | null; initializedAt?: string | Date | null; historyComplete: boolean | null; coverage: string; lastSuccessAt: string | Date | null; candidateState: string | null; lastError: { message?: string } | null }
export const bindingStates: Record<string, string> = { pending: '验证中', verified: '已验证', not_found: '账号不存在', occupied: '账号已被占用', unavailable: '暂不可验证', unsupported: '不支持该账号' };
export const syncScopes: Record<SyncScope, string> = { initial: '首次近 30 天采集', incremental: '持续增量', range: '历史区间补采' };
export const syncStatuses: Record<string, string> = { queued: '排队中', running: '采集中', completed: '已完成', paused: '已暂停', failed: '失败', cancelled: '已取消' };
export const collectionSkipLabels: Record<string, string> = { COLLECTION_PAUSED: '采集总开关已暂停', PLATFORM_DISABLED: '平台未启用', AUTH_REQUIRED: '平台尚未登录或需要重新登录', NO_ACTIVE_BINDING: '没有生效的平台账号绑定', STALE_COLLECTION: '采集设置或数据已变化' };

export const syncSources: Record<string, string> = { manual: '手动更新', scheduled: '定时同步', binding: '绑定验证', settings: '设置更新', rebuild: '清空重爬' };
