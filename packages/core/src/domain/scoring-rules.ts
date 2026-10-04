import { z } from 'zod';
import { CF_BANDS, LUOGU_POINTS } from './scoring';

const points = z.number().min(0).max(10000).multipleOf(0.001);
export const scoringRulesSchema = z.object({
  codeforces: z.object({ points: z.array(points).length(CF_BANDS.length + 1), unknownPoints: points }).strict(),
  luogu: z.object({ points: z.array(points).length(LUOGU_POINTS.length), unknownPoints: points }).strict(),
  qoj: z.object({ points }).strict(),
}).strict();
export const scoringSettingsSchema = z.object({ rules: scoringRulesSchema, version: z.number().int().positive() }).strict();
