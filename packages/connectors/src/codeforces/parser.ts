import { z } from 'zod';
import type { NormalizedProblem, NormalizedSubmission, Verdict } from '../contracts/index';
import { ConnectorError } from '../contracts/index';
import { normalizedProblemSchema, normalizedSubmissionSchema, problemSchema, submissionSchema } from './schemas';

export const PARSER_VERSION = 'codeforces-api-v1';
export const utc = (seconds: number): string => new Date(seconds * 1000).toISOString();
const rejected = new Set([
  'FAILED', 'PARTIAL', 'COMPILATION_ERROR', 'RUNTIME_ERROR', 'WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED', 'IDLENESS_LIMIT_EXCEEDED', 'SECURITY_VIOLATED', 'CRASHED',
  'INPUT_PREPARATION_CRASHED', 'CHALLENGED', 'SKIPPED', 'REJECTED',
]);
export function normalizeVerdict(verdict: string | undefined): Verdict {
  if (verdict === 'OK') return 'accepted';
  if (verdict === 'TESTING' || verdict === 'SUBMITTED') return 'pending';
  return verdict && rejected.has(verdict) ? 'rejected' : 'unknown';
}
export function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ConnectorError('PARSE_CHANGED', 'Codeforces response does not match the expected schema', { cause: parsed.error });
  return parsed.data;
}
export function contestPath(contestId: number | string): string {
  return `${Number(contestId) >= 100000 ? 'gym' : 'contest'}/${contestId}`;
}
export function normalizeProblem(problem: z.infer<typeof problemSchema>, observedAt: string): NormalizedProblem | null {
  if (problem.contestId === undefined) return null;
  return validated(normalizedProblemSchema, {
    platform: 'codeforces', problemKey: `${problem.contestId}:${problem.index}`, title: problem.name,
    nativeDifficulty: problem.rating ?? null,
    sourceUrl: `https://codeforces.com/${contestPath(problem.contestId)}/problem/${encodeURIComponent(problem.index)}`,
    parserVersion: PARSER_VERSION, observedAt,
  });
}
export function normalizeSubmission(raw: z.infer<typeof submissionSchema>, sourceUrl: string, observedAt: string, queriedHandle?: string): NormalizedSubmission {
  const problem = normalizeProblem(raw.problem, observedAt);
  return validated(normalizedSubmissionSchema, {
    platform: 'codeforces', externalSubmissionId: String(raw.id), problemKey: problem?.problemKey ?? null,
    submittedAt: utc(raw.creationTimeSeconds), verdict: normalizeVerdict(raw.verdict), nativeVerdict: raw.verdict ?? null,
    ...(raw.points === undefined ? {} : { nativeScore: raw.points }),
    sourceUrl: raw.contestId === undefined ? sourceUrl : `https://codeforces.com/${contestPath(raw.contestId)}/submission/${raw.id}`,
    subjectEvidence: {
      authorAccountKeys: raw.author.members.map((member) => member.handle), authorMembers: raw.author.members,
      ...(queriedHandle === undefined ? {} : { queriedAccountMatchesAuthor: raw.author.members.some((member) => member.handle.toLowerCase() === queriedHandle.toLowerCase()) }),
      ...(raw.author.teamId === undefined ? {} : { teamId: String(raw.author.teamId) }),
      ...(raw.contestId === undefined ? {} : { contestId: String(raw.contestId) }),
      participantType: raw.author.participantType, teamName: raw.author.teamName, ghost: raw.author.ghost,
      ...(raw.author.startTimeSeconds === undefined ? {} : { startedAt: utc(raw.author.startTimeSeconds) }),
      relativeTimeSeconds: raw.relativeTimeSeconds, sourceUrl,
    }, parserVersion: PARSER_VERSION, observedAt,
  });
}
