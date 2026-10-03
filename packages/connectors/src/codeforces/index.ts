import { z } from 'zod';
import { ConnectorError, parseRetryAfter, rangeStartReached, filterSubmissionRange, type AccountRef, type ConnectorCheckpoint, type ReadConnector, type RequestContext, type SubmissionScan } from '../contracts/index';
import { contestPath, normalizeProblem, normalizeSubmission, PARSER_VERSION, utc, validated } from './parser';
import {
  accountSchema, contestSchema, envelopeSchema, normalizedContestSchema, normalizedRatingSchema,
  normalizedStandingsSchema, pageSchema, profileSchema, ratingSchema, standingsSchema, submissionSchema, userSchema,
} from './schemas';

const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const externalId = z.string().regex(/^\d+$/);
const cursorData = z.object({
  handle: z.string(), scope: z.string(), mode: z.enum(['incremental', 'backfill']), parserVersion: z.literal(PARSER_VERSION),
  pageSize: z.number().int().min(2).max(1000), from: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  anchor: externalId.nullable(), seekAnchor: externalId.nullable(), startedAt: z.iso.datetime(),
  checkpointStartedAt: z.iso.datetime().nullable(),
  headId: externalId.nullable(), olderPages: z.number().int().min(0).max(2),
});
const checkpointData = z.object({
  handle: z.string(), scope: z.string(), parserVersion: z.literal(PARSER_VERSION), highWaterId: externalId.nullable(), startedAt: z.iso.datetime(),
});

function accountHandle(account: AccountRef): string {
  if (account.platform !== 'codeforces' || account.kind !== 'person') throw new ConnectorError('INVALID_INPUT', 'Codeforces user methods require a personal handle');
  return handleInput(account.handle);
}
function handleInput(input: string): string {
  const handle = input.trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(handle)) throw new ConnectorError('INVALID_INPUT', 'Invalid Codeforces handle');
  return handle;
}
function validContestId(input: string): string {
  if (!/^\d+$/.test(input) || BigInt(input) <= 0n || BigInt(input) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConnectorError('INVALID_INPUT', 'Invalid Codeforces contest ID');
  }
  return String(BigInt(input));
}
function apiUrl(method: string, params: Record<string, string> = {}): URL {
  const url = new URL(`https://codeforces.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

export function classifyFailure(comment: string): ConnectorError {
  if (/call limit|too many requests|rate limit|limit exceeded/i.test(comment)) return new ConnectorError('RATE_LIMITED', 'Codeforces API call limit exceeded');
  if (/(?:user with (?:handle|username)|handles?[: ])[^\n]*not found|(?:user|account) not found/i.test(comment)) return new ConnectorError('ACCOUNT_NOT_FOUND', 'Codeforces account not found');
  if (/api key|apiSig|authentication|login|not authorized/i.test(comment)) return new ConnectorError('AUTH_REQUIRED', 'Codeforces authentication required');
  if (/(?:access|permission).*denied|not allowed|permission|forbidden|not public|not available|private|hidden|do not have.*rights/i.test(comment)) return new ConnectorError('FORBIDDEN', 'Codeforces data is not publicly accessible');
  return new ConnectorError('API_ERROR', 'Codeforces API rejected the request');
}
async function api<T>(url: URL, schema: z.ZodType<T>, ctx: RequestContext): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (ctx.signal.aborted) throw new ConnectorError('CANCELLED', 'Codeforces read cancelled');
    let response: Response;
    try { response = await ctx.request(url, { headers: { accept: 'application/json' } }); }
    catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(ctx.signal.aborted ? 'CANCELLED' : 'NETWORK_ERROR', 'Codeforces network request failed', { cause: error });
    }
    const httpOptions = { httpStatus: response.status };
    if (response.status === 429) throw new ConnectorError('RATE_LIMITED', 'Codeforces HTTP rate limit', { ...httpOptions, retryAt: parseRetryAfter(response.headers.get('retry-after')) });
    if (response.status === 401) throw new ConnectorError('AUTH_REQUIRED', 'Codeforces authentication required', httpOptions);
    if (response.status === 403) throw new ConnectorError('FORBIDDEN', 'Codeforces access forbidden', httpOptions);
    if (response.status >= 500) throw new ConnectorError('HTTP_ERROR', 'Codeforces server error', httpOptions);
    if (!/application\/json/i.test(response.headers.get('content-type') ?? '')) throw new ConnectorError('PARSE_CHANGED', 'Expected Codeforces JSON response', httpOptions);
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new ConnectorError('PARSE_CHANGED', 'Invalid Codeforces JSON', httpOptions); }
    const envelope = validated(envelopeSchema, body);
    if (envelope.status === 'FAILED') {
      const error = classifyFailure(envelope.comment);
      if (error.code === 'RATE_LIMITED') {
        const retryAt = new Date(Math.max(Date.now() + 2000 * 2 ** attempt,
          Date.parse(parseRetryAfter(response.headers.get('retry-after')) ?? '') || 0)).toISOString();
        await ctx.deferUntil?.(retryAt);
        if (attempt < 2) {
          // The next ctx.request waits on the shared blocked_until; no platform-local limiter.
          continue;
        }
        throw new ConnectorError(error.code, error.message, { ...httpOptions, retryAt });
      }
      throw new ConnectorError(error.code, error.message, httpOptions);
    }
    if (!response.ok) throw new ConnectorError('HTTP_ERROR', 'Unexpected Codeforces HTTP status', httpOptions);
    return validated(schema, envelope.result);
  }
}

async function fetchPage(account: AccountRef, scan: SubmissionScan, ctx: RequestContext, contestId?: string) {
  const handle = accountHandle(account);
  const scope = contestId ? `contest:${validContestId(contestId)}` : 'user';
  const size = scan.pageSize ?? 100;
  if (!Number.isInteger(size) || size < 2 || size > 1000) throw new ConnectorError('INVALID_INPUT', 'Page size must be 2–1000');
  let state: z.infer<typeof cursorData> = {
    handle, scope, mode: scan.mode, parserVersion: PARSER_VERSION, pageSize: size, from: 1,
    anchor: null, seekAnchor: null, startedAt: new Date().toISOString(), headId: null, olderPages: 0,
    checkpointStartedAt: null,
  };
  if (scan.cursor) {
    const parsed = cursorData.safeParse(scan.cursor.data);
    if (scan.cursor.version !== 1 || !parsed.success || parsed.data.handle !== handle || parsed.data.scope !== scope ||
        parsed.data.mode !== scan.mode || (scan.pageSize !== undefined && parsed.data.pageSize !== size)) {
      throw new ConnectorError('INVALID_CURSOR', 'Incompatible Codeforces cursor; restart from the first page');
    }
    state = parsed.data;
  }
  let checkpoint: z.infer<typeof checkpointData> | null = null;
  if (scan.checkpoint) {
    const parsed = checkpointData.safeParse(scan.checkpoint.data);
    if (scan.checkpoint.version !== 1 || !parsed.success || parsed.data.handle !== handle || parsed.data.scope !== scope) {
      throw new ConnectorError('INVALID_CURSOR', 'Incompatible Codeforces checkpoint; restart safely');
    }
    checkpoint = parsed.data;
  }
  if (scan.cursor && state.checkpointStartedAt !== (checkpoint?.startedAt ?? null)) {
    throw new ConnectorError('INVALID_CURSOR', 'The checkpoint changed during this Codeforces scan; restart from the first page');
  }
  state.checkpointStartedAt = checkpoint?.startedAt ?? null;
  const params = { handle, from: String(state.from), count: String(state.pageSize), ...(contestId ? { contestId: validContestId(contestId) } : {}) };
  const url = apiUrl(contestId ? 'contest.status' : 'user.status', params);
  const raw = await api(url, z.array(submissionSchema), ctx);
  const observedAt = new Date().toISOString();
  if (raw.length > state.pageSize) throw new ConnectorError('PARSE_CHANGED', 'Codeforces submission page exceeds the requested count');
  if (contestId && raw.some((row) => row.contestId !== Number(contestId))) throw new ConnectorError('PARSE_CHANGED', 'Codeforces submission page has an unexpected contest');
  if (raw.some((row, index) => index > 0 && row.id >= raw[index - 1]!.id)) throw new ConnectorError('PARSE_CHANGED', 'Codeforces submission IDs are not in descending order');
  if (state.from === 1 && state.headId === null && raw[0]) state.headId = String(raw[0].id);
  // The query handle is a lookup key, never a replacement for the actual authors (including old handles).
  const submissions = raw.map((row) => normalizeSubmission(row, url.href, observedAt, handle));
  const problems = [...new Map(raw.map((row) => normalizeProblem(row.problem, observedAt)).filter((p) => p !== null).map((p) => [p.problemKey, p])).values()];
  const base = { submissions, problems, coverage: 'visible' as const, sourceUrl: url.href, observedAt };
  // An offset that no longer contains the prior boundary cannot be trusted, including an empty page.
  if (state.anchor && !raw.some((row) => String(row.id) === state.anchor)) {
    return filterSubmissionRange(validated(pageSchema, { ...base, nextCursor: { version: 1, data: { ...state, from: 1, anchor: null, seekAnchor: state.anchor, olderPages: 0 } }, stopReason: 'more', nextCheckpoint: null }), scan.range, scan.since);
  }
  const locating = state.seekAnchor !== null && !raw.some((row) => String(row.id) === state.seekAnchor);
  const older = scan.mode === 'incremental' && checkpoint?.highWaterId && raw.length > 0 && raw.every((row) =>
    BigInt(row.id) <= BigInt(checkpoint.highWaterId!) && row.creationTimeSeconds * 1000 < Date.parse(checkpoint.startedAt) - LOOKBACK_MS);
  const olderPages = !locating && older ? state.olderPages + 1 : 0;
  const rangeReached = !locating && rangeStartReached(submissions, scan.range, scan.since);
  const finished = raw.length === 0 || olderPages >= 2 || rangeReached;
  const nextCheckpoint: ConnectorCheckpoint | null = finished && (scan.mode === 'incremental' || scan.range || scan.since) ? {
    version: 1, data: { handle, scope, parserVersion: PARSER_VERSION, highWaterId: state.headId, startedAt: state.startedAt },
  } : null;
  const overlap = Math.max(1, Math.floor(state.pageSize * 0.2));
  return filterSubmissionRange(validated(pageSchema, {
    ...base, stopReason: rangeReached ? 'range_start' : raw.length === 0 ? 'history_end' : finished ? 'checkpoint_reached' : 'more', nextCheckpoint,
    nextCursor: finished ? null : { version: 1, data: {
      ...state, from: state.from + raw.length - (raw.length === state.pageSize ? overlap : 0),
      anchor: locating || raw.length < state.pageSize ? null : String(raw.at(-1)!.id),
      seekAnchor: locating ? state.seekAnchor : null, olderPages,
    } },
  }), scan.range, scan.since);
}

function normalizeContest(raw: z.infer<typeof contestSchema>, observedAt: string) {
  return validated(normalizedContestSchema, {
    platform: 'codeforces', externalContestId: String(raw.id), name: raw.name, type: raw.type, phase: raw.phase,
    durationSeconds: raw.durationSeconds, startedAt: raw.startTimeSeconds === undefined ? null : utc(raw.startTimeSeconds),
    sourceUrl: `https://codeforces.com/${contestPath(raw.id)}`, parserVersion: PARSER_VERSION, observedAt,
  });
}
export const codeforcesConnector: ReadConnector = {
  capabilities: { submissions: true, participations: 'partial', teamEvidence: true },
  async resolveAccount(input, ctx) {
    const requestedHandle = handleInput(input);
    const users = await api(apiUrl('user.info', { handles: requestedHandle, checkHistoricHandles: 'true' }), z.array(userSchema).length(1), ctx);
    return validated(accountSchema, { platform: 'codeforces', kind: 'person', handle: users[0]!.handle, externalId: null, resolutionEvidence: { requestedHandle, historicHandlesChecked: true } });
  },
  fetchSubmissionPage: (account, scan, ctx) => fetchPage(account, scan, ctx),
  fetchContestSubmissionPage: (account, contestId, scan, ctx) => fetchPage(account, scan, ctx, contestId),
  async fetchProfile(account, ctx) {
    const handle = accountHandle(account);
    const url = apiUrl('user.info', { handles: handle, checkHistoricHandles: 'true' });
    const users = await api(url, z.array(userSchema).length(1), ctx);
    const user = users[0]!;
    if (user.handle !== handle) throw new ConnectorError('PARSE_CHANGED', 'Codeforces account changed; resolve it again');
    return validated(profileSchema, {
      account, rating: user.rating ?? null, maxRating: user.maxRating ?? null, rank: user.rank ?? null,
      maxRank: user.maxRank ?? null, organization: user.organization ?? null,
      registeredAt: user.registrationTimeSeconds === undefined ? null : utc(user.registrationTimeSeconds),
      sourceUrl: `https://codeforces.com/profile/${encodeURIComponent(handle)}`, parserVersion: PARSER_VERSION, observedAt: new Date().toISOString(),
    });
  },
  async fetchRatingHistory(account, ctx) {
    const handle = accountHandle(account);
    const url = apiUrl('user.rating', { handle });
    const changes = await api(url, z.array(ratingSchema), ctx);
    if (changes.some((change) => change.handle.toLowerCase() !== handle.toLowerCase())) throw new ConnectorError('PARSE_CHANGED', 'Unexpected Codeforces rating account');
    return validated(normalizedRatingSchema, {
      coverage: 'rated_contests_only', changes: changes.map((change) => ({
        contestId: String(change.contestId), contestName: change.contestName, handle: change.handle, rank: change.rank,
        oldRating: change.oldRating, newRating: change.newRating, updatedAt: utc(change.ratingUpdateTimeSeconds),
      })), sourceUrl: url.href, parserVersion: PARSER_VERSION, observedAt: new Date().toISOString(),
    });
  },
  async fetchContests(ctx) {
    const contests = await api(apiUrl('contest.list', { gym: 'false' }), z.array(contestSchema), ctx);
    const observedAt = new Date().toISOString();
    return contests.map((contest) => normalizeContest(contest, observedAt));
  },
  async fetchStandings(contestId, ctx) {
    const id = validContestId(contestId);
    if (Number(id) >= 100000) throw new ConnectorError('AUTH_REQUIRED', 'Gym and mashup standings need a separately implemented authenticated API context');
    // Public regular contests allow exactly this parameter, no handle or unofficial filters.
    const url = apiUrl('contest.standings', { contestId: id });
    const standings = await api(url, standingsSchema, ctx);
    if (String(standings.contest.id) !== id) throw new ConnectorError('PARSE_CHANGED', 'Unexpected Codeforces contest');
    const observedAt = new Date().toISOString();
    return validated(normalizedStandingsSchema, {
      contest: normalizeContest(standings.contest, observedAt),
      problems: standings.problems.map((problem) => normalizeProblem(problem, observedAt)).filter((problem) => problem !== null),
      rows: standings.rows.map((row) => ({
        members: row.party.members, participantType: row.party.participantType,
        ...(row.party.teamId === undefined ? {} : { teamId: String(row.party.teamId) }),
        ...(row.party.startTimeSeconds === undefined ? {} : { startedAt: utc(row.party.startTimeSeconds) }),
        rank: row.party.participantType === 'CONTESTANT' ? row.rank : null, nativeScore: row.points, penalty: row.penalty,
      })), coverage: 'official_public_only', sourceUrl: url.href, parserVersion: PARSER_VERSION, observedAt,
    });
  },
  async fetchProblem(contestId, index, ctx) {
    if (!index || index.length > 32) throw new ConnectorError('INVALID_INPUT', 'Invalid Codeforces problem index');
    const standings = await codeforcesConnector.fetchStandings!(contestId, ctx);
    return standings.problems.find((problem) => problem.problemKey === `${validContestId(contestId)}:${index}`) ?? null;
  },
};
