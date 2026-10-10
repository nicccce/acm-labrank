import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { PoolClient } from 'pg';
import { getPool } from './client';

export const MIGRATION_LOCK = 73192401;
const defaultFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
export class MigrationSafetyError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function readManifest(migrationsFolder: string) {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
    dialect: string; entries: { idx: number; tag: string; when: number }[];
  };
  if (journal.dialect !== 'postgresql' || !Array.isArray(journal.entries) || !journal.entries.length ||
    journal.entries.some((entry, index) => entry.idx !== index || !/^\d{4}_[a-z0-9_]+$/.test(entry.tag) ||
      !Number.isSafeInteger(entry.when) || entry.when <= (journal.entries[index - 1]?.when ?? 0))) {
    throw new MigrationSafetyError('INVALID_MIGRATION_MANIFEST');
  }
  const migrations = readMigrationFiles({ migrationsFolder });
  return journal.entries.map((entry, index) => {
    // Git may check out LF on Linux and CRLF on Windows. Accept only that
    // difference; actual edits to already applied SQL must stop the upgrade.
    const lf = readFileSync(join(migrationsFolder, `${entry.tag}.sql`), 'utf8').replaceAll('\r\n', '\n');
    const hashes = [migrations[index]!.hash, ...[lf, lf.replaceAll('\n', '\r\n')].map(text => createHash('sha256').update(text).digest('hex'))];
    return { ...migrations[index]!, tag: entry.tag, hashes };
  });
}

export async function inspectMigrations(migrationsFolder = defaultFolder, client?: PoolClient) {
  const manifest = readManifest(migrationsFolder);
  const connection = client ?? await getPool().connect();
  try {
    const exists = (await connection.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS history")).rows[0].history;
    const applied = exists ? (await connection.query<{ hash: string; created_at: string }>(
      'SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id')).rows : [];
    if (applied.length > manifest.length) throw new MigrationSafetyError('DATABASE_NEWER_THAN_CODE');
    for (const [index, row] of applied.entries()) {
      const expected = manifest[index]!;
      if (Number(row.created_at) !== expected.folderMillis || !expected.hashes.includes(row.hash)) {
        throw new MigrationSafetyError('MIGRATION_HISTORY_MISMATCH');
      }
    }
    if (!applied.length) {
      const existing = await connection.query("SELECT to_regclass('public.users') AS users, to_regclass('public.teams') AS teams, to_regclass('public.submissions') AS submissions");
      if (Object.values(existing.rows[0]).some(value => value !== null)) throw new MigrationSafetyError('UNTRACKED_DATABASE_SCHEMA');
    }
    return { applied: applied.length, total: manifest.length, target: manifest.at(-1)!.tag, pending: manifest.slice(applied.length).map(entry => entry.tag) };
  } finally { if (!client) connection.release(); }
}

export async function migrateSchema(migrationsFolder = defaultFolder, client?: PoolClient) {
  const manifest = readManifest(migrationsFolder);
  const connection = client ?? await getPool().connect();
  try {
    await connection.query('BEGIN');
    const lock = await connection.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [MIGRATION_LOCK]);
    if (!lock.rows[0].locked) throw new MigrationSafetyError('MIGRATION_ALREADY_RUNNING');
    await connection.query("SET LOCAL lock_timeout = '10s'");
    await connection.query("SET LOCAL statement_timeout = '5min'");
    const plan = await inspectMigrations(migrationsFolder, connection);
    // Preserve Drizzle's existing ledger format. All pending DDL and its
    // history rows commit together, including on a fresh installation.
    await connection.query('CREATE SCHEMA IF NOT EXISTS drizzle');
    await connection.query('CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)');
    for (const migration of manifest.slice(plan.applied)) {
      for (const statement of migration.sql) if (statement.trim()) await connection.query(statement);
      await connection.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ($1,$2)', [migration.hash, migration.folderMillis]);
    }
    await connection.query('COMMIT');
    return { ...plan, appliedNow: plan.pending.length };
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
  finally { if (!client) connection.release(); }
}
