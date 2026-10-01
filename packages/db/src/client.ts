import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

let pool: Pool | undefined;
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
    pool.on('error', () => console.error(JSON.stringify({ code: 'DB_POOL_ERROR' })));
  }
  return pool;
}
export function getDb() { return drizzle(getPool(), { schema }); }
export async function closeDb() { await pool?.end(); pool = undefined; }
