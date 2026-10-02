export type PlatformId = 'codeforces' | 'qoj' | 'luogu';
export { parseRetryAfter } from './http';
export type Verdict = 'accepted' | 'rejected' | 'pending' | 'unknown';
export type ConnectorCursor = { version: number; data: unknown };
export type ConnectorCheckpoint = { version: number; data: unknown };

export interface AccountRef {
  platform: PlatformId;
  kind: 'person' | 'team';
  handle: string;
  externalId: string | null;
}

export interface NormalizedProblem {
  platform: PlatformId;
  problemKey: string;
  title: string;
  nativeDifficulty: number | null;
  sourceUrl: string;
  parserVersion?: string;
  observedAt?: string;
}

export interface NormalizedSubmission {
  platform: PlatformId;
  externalSubmissionId: string;
  problemKey: string | null;
  submittedAt: string | null;
  verdict: Verdict;
  nativeScore?: number | null;
  nativeResult?: string;
  sourceUrl?: string;
  subjectEvidence: {
    authorAccountKeys: string[];
    teamId?: string;
    contestId?: string;
    participantType?: string;
  };
  parserVersion: string;
  observedAt: string;
}

export interface RequestContext {
  /** Implemented by the application with a shared DB lease and hard HTTP limits. */
  request(url: URL, init?: RequestInit): Promise<Response>;
  signal: AbortSignal;
  session: Readonly<Record<string, unknown>> | null;
  /** Publish API-level throttling through the same shared platform quota. */
  deferUntil?(retryAt: string): Promise<void>;
}

export interface SubmissionScan {
  mode: 'incremental' | 'backfill';
  cursor: ConnectorCursor | null;
  checkpoint: ConnectorCheckpoint | null;
  pageSize?: number;
}
export interface SubmissionPage {
  submissions: NormalizedSubmission[];
  problems: NormalizedProblem[];
  nextCursor: ConnectorCursor | null;
  stopReason: 'more' | 'history_end' | 'checkpoint_reached';
  nextCheckpoint: ConnectorCheckpoint | null;
  coverage: 'visible' | 'restricted';
  sourceUrl: string;
  observedAt: string;
}

export interface ReadConnector {
  capabilities: { submissions: boolean; participations: 'none' | 'partial' | 'confirmed'; teamEvidence: boolean };
  resolveAccount(input: string, ctx: RequestContext): Promise<AccountRef>;
  fetchSubmissionPage(account: AccountRef, scan: SubmissionScan, ctx: RequestContext): Promise<SubmissionPage>;
}

export type ConnectorErrorCode = 'UNSUPPORTED_FLOW' | 'STALE_CHALLENGE' | 'NOT_IMPLEMENTED' | 'AUTH_REQUIRED' | 'ACCOUNT_NOT_FOUND' | 'RATE_LIMITED' |
  'PARSE_CHANGED' | 'FORBIDDEN' | 'CHALLENGE_REQUIRED' | 'INVALID_CURSOR' | 'NETWORK_ERROR' | 'LOGIN_FAILED' |
  'TIMEOUT' | 'CANCELLED' | 'API_ERROR' | 'HTTP_ERROR' | 'RESPONSE_TOO_LARGE' | 'LEASE_LOST' | 'INVALID_INPUT';
export class ConnectorError extends Error {
  readonly retryAt?: string;
  readonly httpStatus?: number;
  constructor(public readonly code: ConnectorErrorCode, message: string, options: { retryAt?: string; httpStatus?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ConnectorError';
    this.retryAt = options.retryAt;
    this.httpStatus = options.httpStatus;
  }
}
