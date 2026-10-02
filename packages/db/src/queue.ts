import { PgBoss } from 'pg-boss';

export const PROBE_QUEUE = 'system.probe';
export const QOJ_READ_QUEUE = 'platform.qoj.read';
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
