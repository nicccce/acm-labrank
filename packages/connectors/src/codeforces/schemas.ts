import { z } from 'zod';

const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const seconds = z.number().int().nonnegative().max(253402300799);
export const memberSchema = z.object({ handle: z.string().min(1), name: z.string().optional() });
export const partySchema = z.object({
  members: z.array(memberSchema), participantType: z.string().min(1), contestId: id.optional(),
  teamId: id.optional(), teamName: z.string().optional(), ghost: z.boolean().optional(),
  startTimeSeconds: seconds.optional(),
});
export const problemSchema = z.object({
  contestId: id.optional(), problemsetName: z.string().optional(), index: z.string().min(1),
  name: z.string(), type: z.string(), points: z.number().optional(), rating: z.number().int().optional(),
  tags: z.array(z.string()),
});
export const submissionSchema = z.object({
  id, contestId: id.optional(), creationTimeSeconds: seconds, relativeTimeSeconds: z.number().int(),
  problem: problemSchema, author: partySchema, verdict: z.string().optional(), points: z.number().optional(),
  programmingLanguage: z.string(), testset: z.string(), passedTestCount: z.number().int().nonnegative(),
  timeConsumedMillis: z.number().nonnegative(), memoryConsumedBytes: z.number().nonnegative(),
});
export const userSchema = z.object({
  handle: z.string().min(1), rating: z.number().int().optional(), maxRating: z.number().int().optional(),
  rank: z.string().optional(), maxRank: z.string().optional(), organization: z.string().optional(),
  registrationTimeSeconds: seconds.optional(),
});
export const ratingSchema = z.object({
  contestId: id, contestName: z.string(), handle: z.string().min(1), rank: z.number().int().positive(),
  oldRating: z.number().int(), newRating: z.number().int(), ratingUpdateTimeSeconds: seconds,
});
export const contestSchema = z.object({
  id, name: z.string(), type: z.string(), phase: z.string(), durationSeconds: z.number().int().nonnegative(),
  startTimeSeconds: seconds.optional(),
});
export const standingsSchema = z.object({
  contest: contestSchema, problems: z.array(problemSchema),
  rows: z.array(z.object({ party: partySchema, rank: z.number().int().positive(), points: z.number(), penalty: z.number() })),
});
export const envelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('OK'), result: z.unknown() }),
  z.object({ status: z.literal('FAILED'), comment: z.string() }),
]);

const utc = z.iso.datetime();
const metadata = { parserVersion: z.string().min(1), observedAt: utc, sourceUrl: z.url() };
export const accountSchema = z.object({
  platform: z.literal('codeforces'), kind: z.literal('person'), handle: z.string().min(1), externalId: z.null(),
  resolutionEvidence: z.object({ requestedHandle: z.string(), historicHandlesChecked: z.boolean() }).optional(),
});
export const normalizedProblemSchema = z.object({
  platform: z.literal('codeforces'), problemKey: z.string().min(1), title: z.string(),
  nativeDifficulty: z.number().nullable(), ...metadata,
});
export const normalizedSubmissionSchema = z.object({
  platform: z.literal('codeforces'), externalSubmissionId: z.string().regex(/^\d+$/), problemKey: z.string().nullable(),
  submittedAt: utc, verdict: z.enum(['accepted', 'rejected', 'pending', 'unknown']),
  nativeScore: z.number().optional(), nativeVerdict: z.string().nullable(),
  subjectEvidence: z.object({
    authorAccountKeys: z.array(z.string()), authorMembers: z.array(memberSchema), teamId: z.string().optional(),
    contestId: z.string().optional(), participantType: z.string(), teamName: z.string().optional(),
    ghost: z.boolean().optional(), startedAt: utc.optional(), relativeTimeSeconds: z.number().int(), sourceUrl: z.url(),
    queriedAccountMatchesAuthor: z.boolean().optional(),
  }), ...metadata,
});
const wrapper = z.object({ version: z.literal(1), data: z.unknown() });
export const pageSchema = z.object({
  submissions: z.array(normalizedSubmissionSchema), problems: z.array(normalizedProblemSchema),
  nextCursor: wrapper.nullable(), nextCheckpoint: wrapper.nullable(),
  stopReason: z.enum(['more', 'history_end', 'checkpoint_reached', 'range_start']), coverage: z.literal('visible'),
  sourceUrl: z.url(), observedAt: utc,
});
export const profileSchema = z.object({
  account: accountSchema, rating: z.number().nullable(), maxRating: z.number().nullable(), rank: z.string().nullable(),
  maxRank: z.string().nullable(), organization: z.string().nullable(), registeredAt: utc.nullable(), ...metadata,
});
export const normalizedRatingSchema = z.object({
  coverage: z.literal('rated_contests_only'), changes: z.array(z.object({
    contestId: z.string(), contestName: z.string(), handle: z.string(), rank: z.number(), oldRating: z.number(), newRating: z.number(), updatedAt: utc,
  })), ...metadata,
});
export const normalizedContestSchema = z.object({
  platform: z.literal('codeforces'), externalContestId: z.string(), name: z.string(), type: z.string(), phase: z.string(),
  durationSeconds: z.number(), startedAt: utc.nullable(), ...metadata,
});
export const normalizedStandingsSchema = z.object({
  contest: normalizedContestSchema, problems: z.array(normalizedProblemSchema), coverage: z.literal('official_public_only'),
  rows: z.array(z.object({
    members: z.array(memberSchema), participantType: z.string(), teamId: z.string().optional(), startedAt: utc.optional(),
    rank: z.number().nullable(), nativeScore: z.number(), penalty: z.number(),
  })), ...metadata,
});
