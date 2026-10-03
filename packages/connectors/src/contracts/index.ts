export type PlatformId = 'codeforces' | 'qoj' | 'luogu';
export type { PlatformReadRequest, PlatformReadOutcome, ReadStatus, ReadAction, ReadFailure, ReadProgress } from './collection';
export { parseRetryAfter } from './http';
export type Verdict = 'accepted' | 'rejected' | 'pending' | 'unknown';
export type ConnectorCursor = { version: number; data: unknown };
export type ConnectorCheckpoint = { version: number; data: unknown };

export interface AccountRef {
  platform: PlatformId;
  kind: 'person' | 'team';
  handle: string;
  externalId: string | null;
  resolutionEvidence?: { requestedHandle: string; historicHandlesChecked: boolean };
}

export interface NormalizedProblem {
  platform: PlatformId;
  problemKey: string;
  title: string;
  nativeDifficulty: number | null;
  difficultyObserved?: boolean;
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
  nativeStatus?: number | null;
  nativeResult?: string;
  sourceUrl?: string;
  nativeVerdict?: string | null;
  subjectEvidence: {
    authorAccountKeys: string[];
    authorHandle?: string;
    contest?: { id: string; name?: string; mode?: string };
    teamId?: string;
    contestId?: string;
    participantType?: string;
    authorMembers?: { handle: string; name?: string }[];
    queriedAccountMatchesAuthor?: boolean;
    teamName?: string;
    ghost?: boolean;
    startedAt?: string;
    relativeTimeSeconds?: number;
    sourceUrl?: string;
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
  range?: SubmissionRange;
}
/** UTC half-open interval; callers convert inclusive Beijing dates before scanning. */
export interface SubmissionRange { from: string; to: string }
export function rangeStartReached(submissions: NormalizedSubmission[], range?: SubmissionRange): boolean {
  if (!range) return false;
  let previous = Infinity;
  for (const row of submissions) {
    const time = row.submittedAt === null ? NaN : Date.parse(row.submittedAt);
    if (!Number.isFinite(time) || time > previous) throw new ConnectorError('PARSE_CHANGED', 'Cannot safely truncate an unordered or undated submission page');
    previous = time;
  }
  return submissions.some(row => Date.parse(row.submittedAt!) < Date.parse(range.from));
}
export function filterSubmissionRange(page: SubmissionPage, range?: SubmissionRange): SubmissionPage {
  if (!range) return page;
  const submissions = page.submissions.filter(row => row.submittedAt !== null && Date.parse(row.submittedAt) >= Date.parse(range.from) && Date.parse(row.submittedAt) < Date.parse(range.to));
  const keys = new Set(submissions.map(row => row.problemKey));
  return { ...page, submissions, problems: page.problems.filter(problem => keys.has(problem.problemKey)) };
}
export interface Profile {
  account: AccountRef;
  rating: number | null;
  maxRating: number | null;
  rank: string | null;
  maxRank: string | null;
  organization: string | null;
  registeredAt: string | null;
  sourceUrl: string;
  parserVersion: string;
  observedAt: string;
}
export interface RatingHistory {
  coverage: 'rated_contests_only';
  changes: { contestId: string; contestName: string; handle: string; rank: number; oldRating: number; newRating: number; updatedAt: string }[];
  sourceUrl: string;
  parserVersion: string;
  observedAt: string;
}
export interface Contest {
  platform: PlatformId;
  externalContestId: string;
  name: string;
  type: string;
  phase: string;
  durationSeconds: number;
  startedAt: string | null;
  sourceUrl: string;
  parserVersion: string;
  observedAt: string;
}
export interface Standings {
  contest: Contest;
  problems: NormalizedProblem[];
  rows: {
    members: { handle: string; name?: string }[];
    participantType: string;
    teamId?: string;
    startedAt?: string;
    rank: number | null;
    nativeScore: number;
    penalty: number;
  }[];
  coverage: 'official_public_only';
  sourceUrl: string;
  parserVersion: string;
  observedAt: string;
}

export interface SubmissionPage {
  submissions: NormalizedSubmission[];
  problems: NormalizedProblem[];
  nextCursor: ConnectorCursor | null;
  stopReason: 'more' | 'history_end' | 'checkpoint_reached' | 'range_start';
  nextCheckpoint: ConnectorCheckpoint | null;
  coverage: 'visible' | 'restricted';
  sourceUrl: string;
  observedAt: string;
}

export interface ReadConnector {
  capabilities: { submissions: boolean; participations: 'none' | 'partial' | 'confirmed'; teamEvidence: boolean };
  resolveAccount(input: string, ctx: RequestContext): Promise<AccountRef>;
  fetchSubmissionPage(account: AccountRef, scan: SubmissionScan, ctx: RequestContext): Promise<SubmissionPage>;
  fetchProfile?(account: AccountRef, ctx: RequestContext): Promise<Profile>;
  fetchRatingHistory?(account: AccountRef, ctx: RequestContext): Promise<RatingHistory>;
  fetchContestSubmissionPage?(account: AccountRef, contestId: string, scan: SubmissionScan, ctx: RequestContext): Promise<SubmissionPage>;
  fetchContests?(ctx: RequestContext): Promise<Contest[]>;
  fetchStandings?(contestId: string, ctx: RequestContext): Promise<Standings>;
  fetchProblem?(contestId: string, index: string, ctx: RequestContext): Promise<NormalizedProblem | null>;
}

export type ConnectorErrorCode = 'ACCOUNT_AMBIGUOUS' | 'PRIVACY_RESTRICTED' | 'RISK_CONTROL' | 'TEMP_UNAVAILABLE' | 'PAGINATION_DRIFT' | 'UNSUPPORTED_FLOW' | 'STALE_CHALLENGE' | 'NOT_IMPLEMENTED' | 'AUTH_REQUIRED' | 'ACCOUNT_NOT_FOUND' | 'RATE_LIMITED' |
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
