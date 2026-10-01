export type PlatformId = 'codeforces' | 'qoj' | 'luogu';
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
}

export interface NormalizedSubmission {
  platform: PlatformId;
  externalSubmissionId: string;
  problemKey: string | null;
  submittedAt: string | null;
  verdict: Verdict;
  nativeScore?: number | null;
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
  fetchSubmissionPage(account: AccountRef, scan: {
    mode: 'incremental' | 'backfill'; cursor: ConnectorCursor | null; checkpoint: ConnectorCheckpoint | null;
  }, ctx: RequestContext): Promise<SubmissionPage>;
}

export class ConnectorError extends Error {
  constructor(public readonly code: 'NOT_IMPLEMENTED' | 'AUTH_REQUIRED' | 'ACCOUNT_NOT_FOUND' | 'RATE_LIMITED' | 'PARSE_CHANGED' | 'FORBIDDEN', message: string) {
    super(message);
    this.name = 'ConnectorError';
  }
}
