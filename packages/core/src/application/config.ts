import { z } from 'zod';

const schema = z.object({
  APP_URL: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  }, 'Use HTTPS, or localhost HTTP for development'),
  SYNC_ENABLED: z.enum(['true', 'false']).default('false'),
  CF_MIN_INTERVAL_MS: z.coerce.number().int().min(2000).default(2000),
  QOJ_TRANSPORT: z.enum(['node', 'browser']).default('node'),
  QOJ_CONNECTION_ID: z.string().min(1).default('qoj-lab'),
  QOJ_BROWSER_CHANNEL: z.enum(['msedge', 'chrome', 'chromium']).optional(),
  QOJ_BROWSER_EXECUTABLE: z.string().optional(),
  QOJ_BROWSER_PROXY_SERVER: z.preprocess(value => value === '' ? undefined : value, z.url().optional()),
  QOJ_BROWSER_CDP_ENDPOINT: z.preprocess(value => value === '' ? undefined : value, z.url().optional()),
  QOJ_BROWSER_ATTACH_FILE: z.string().optional(),
  QOJ_BROWSER_ATTACH_ID: z.uuid().optional(),
  QOJ_BROWSER_HEADED: z.enum(['true', 'false']).default('true'),
  QOJ_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1).max(120000).default(30000),
  QOJ_HTTP_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  QOJ_HUMAN_TIMEOUT_MS: z.coerce.number().int().min(1).max(600000).default(120000),
  QOJ_HUMAN_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  QOJ_HUMAN_CONFIRM_FILE: z.string().optional(),
  QOJ_LOGIN_HANDLE: z.string().optional(),
}).superRefine((config, ctx) => {
  if (Boolean(config.QOJ_BROWSER_ATTACH_FILE) !== Boolean(config.QOJ_BROWSER_ATTACH_ID) || (config.QOJ_BROWSER_ATTACH_FILE && (!config.QOJ_BROWSER_CDP_ENDPOINT || config.QOJ_TRANSPORT !== 'browser'))) {
    ctx.addIssue({ code: 'custom', message: 'Browser attachment requires a paired local event and CDP browser transport' });
  }
});
export function getConfig() {
  const result = schema.safeParse(process.env);
  if (!result.success) throw new Error('Invalid application configuration');
  return result.data;
}
