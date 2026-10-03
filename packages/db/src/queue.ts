import { PgBoss } from 'pg-boss';
export type { PgBoss as ReadQueueClient } from 'pg-boss';

export const PROBE_QUEUE = 'system.probe';
export const QOJ_READ_QUEUE = 'platform.qoj.read';
export const CF_READ_QUEUE = 'platform.codeforces.read';
export const LUOGU_READ_QUEUE = 'platform.luogu.read';
export const PLATFORM_READ_QUEUES = { codeforces: CF_READ_QUEUE, luogu: LUOGU_READ_QUEUE, qoj: QOJ_READ_QUEUE } as const;
export const QOJ_SESSION_QUEUE = 'platform.qoj.session';
export const PERSONAL_QUEUES = { codeforces: 'platform.codeforces.personal', luogu: 'platform.luogu.personal', qoj: 'platform.qoj.personal' } as const;
export function createBoss(migrate = false) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    migrate,
    supervise: migrate ? false : true,
    schedule: false,
  });
  boss.on('error', () => console.error(JSON.stringify({ code: 'QUEUE_ERROR' })));
  return boss;
}
