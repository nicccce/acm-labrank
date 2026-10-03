import type { AccountRef, ConnectorCheckpoint, ConnectorCursor, ConnectorErrorCode, NormalizedProblem, NormalizedSubmission, PlatformId, Profile, RatingHistory, SubmissionPage, SubmissionRange } from './index';

export type ReadStatus = 'completed' | 'auth_required' | 'human_input_required' | 'restricted' | 'parse_changed' | 'timeout' | 'cancelled' | 'failed';
export type ReadAction = 'none' | 'retry' | 'reauthenticate' | 'human_verify' | 'fix_target' | 'fix_parser' | 'unsupported';
export interface PlatformReadRequest {
  platform: PlatformId;
  target: string;
  connectionId?: string;
  operation?: 'submissions' | 'verify' | 'verify_session' | 'resolve' | 'contests' | 'standings' | 'problem';
  mode?: 'backfill' | 'incremental';
  cursor?: ConnectorCursor | null;
  checkpoint?: ConnectorCheckpoint | null;
  pageSize?: number;
  since?: string;
  range?: SubmissionRange;
  maxPages?: number;
  maxDurationMs?: number;
  withProfile?: boolean;
  withRating?: boolean;
  contestId?: string;
  index?: string;
}
export interface ReadProgress { pages: number; rawRecordCount: number; uniqueRecordCount: number; problemCount: number }
export interface ReadFailure {
  code: ConnectorErrorCode;
  message: string;
  httpStatus: number | null;
  retryAt: string | null;
  action: ReadAction;
}
export interface PlatformReadOutcome {
  runId: string;
  platform: PlatformId;
  account: AccountRef | null;
  collector: string | null;
  status: ReadStatus;
  batchStatus: 'complete' | 'page_limit' | 'budget_exhausted' | 'cancelled';
  stopReason: SubmissionPage['stopReason'];
  coverage: SubmissionPage['coverage'] | 'unknown';
  historyComplete: boolean;
  progress: ReadProgress;
  continuation: { cursor: ConnectorCursor | null; checkpoint: ConnectorCheckpoint | null };
  data: { submissions: NormalizedSubmission[]; problems: NormalizedProblem[]; profile: Profile | null; ratingHistory: RatingHistory | null; auxiliary?: unknown };
  error: ReadFailure | null;
}
