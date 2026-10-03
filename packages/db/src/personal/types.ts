import type { PERSONAL_QUEUES } from '../queue';
import type { SyncSource } from '../collection/settings';

export type PersonalPlatform = keyof typeof PERSONAL_QUEUES;
export interface BindingRow { id: string; user_id: string; platform: PersonalPlatform; account_id: string | null; candidate: string | null; candidate_state: string | null; candidate_error: string | null; version: number; handle?: string; external_id?: string | null }
export interface SyncRow { id: string; binding_id: string; binding_version: number; account_id: string | null; kind: 'verify' | 'sync'; mode: 'backfill' | 'incremental'; status: string; batch: number; job_id: string | null; queue: string; pages: number; records: number; retries: number; error: unknown; created_at: Date; finished_at: Date | null; started_at: Date | null; collection_generation: number; source: SyncSource; requested_by: string | null; range_from: Date | null; range_to: Date | null; scan_cursor: CursorRow['cursor']; scan_checkpoint: CursorRow['checkpoint']; cursor_version: number; stop_reason: string; range_complete: boolean; scope: 'initial' | 'incremental' | 'range'; initial_from: Date | null }
export interface PersonalSyncRange { from: Date; to: Date }
export function defaultPersonalSyncRange(now = new Date()): PersonalSyncRange {
  const midnight = Math.floor((now.getTime() + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
  return { from: new Date(midnight - 29 * 86400000), to: new Date(midnight + 86400000) };
}
export interface CursorRow { id: string; cursor: { version: number; data: unknown } | null; checkpoint: { version: number; data: unknown } | null; version: number; initialized_at: Date | null; history_complete: boolean; coverage: string; last_success_at: Date | null }
export const accountKey = (platform: string, handle: string) => platform === 'codeforces' ? handle.toLowerCase() : handle;
