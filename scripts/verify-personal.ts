import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeDb, getPool } from '@acm/db/server';
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error('DATABASE_URL required');
const name = `acm_personal_verify_${randomUUID().replaceAll('-', '')}`;
if (!/^acm_personal_verify_[a-f0-9]{32}$/.test(name)) throw new Error('Invalid isolated database name');
let passed = false;
try {
  await getPool().query(`CREATE DATABASE "${name}"`); await closeDb();
  const target = new URL(baseUrl); target.pathname = `/${name}`; process.env.DATABASE_URL = target.href;
  const migrate = spawnSync('pnpm', ['db:migrate'], { env: process.env, encoding: 'utf8' });
  if (migrate.status !== 0) throw new Error('Isolated database migration failed');
  await import('./personal-probe'); passed = true;
} finally {
  await closeDb(); process.env.DATABASE_URL = baseUrl;
  if (passed) await getPool().query(`DROP DATABASE "${name}" WITH (FORCE)`);
  else console.error(JSON.stringify({ code: 'PERSONAL_PROBE_FAILED', isolatedDatabase: name }));
  await closeDb();
}
