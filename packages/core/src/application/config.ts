import { z } from 'zod';

const schema = z.object({
  APP_URL: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  }, 'Use HTTPS, or localhost HTTP for development'),
  SYNC_ENABLED: z.enum(['true', 'false']).default('false'),
  CF_MIN_INTERVAL_MS: z.coerce.number().int().min(2000).default(2000),
});
export function getConfig() {
  const result = schema.safeParse(process.env);
  if (!result.success) throw new Error('Invalid application configuration');
  return result.data;
}
