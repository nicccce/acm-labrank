import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb } from './client';

export function migrateSchema(migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))) {
  return migrate(getDb(), { migrationsFolder });
}
