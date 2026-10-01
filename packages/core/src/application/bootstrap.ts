import { readFile } from 'node:fs/promises';
import { closeDb, bootstrapFirstAdmin } from '@acm/db/server';
import { credentialsSchema, hashPassword } from './auth';

try {
  const created = await bootstrapFirstAdmin(async () => {
    const secretFile = process.env.ADMIN_BOOTSTRAP_PASSWORD_FILE;
    if (!secretFile) throw new Error('Missing bootstrap secret file');
    const password = (await readFile(secretFile, 'utf8')).replace(/[\r\n]+$/, '');
    const credentials = credentialsSchema.parse({ username: process.env.ADMIN_BOOTSTRAP_USERNAME, password });
    return { username: credentials.username, passwordHash: await hashPassword(credentials.password) };
  });
  console.log(JSON.stringify({ event: created ? 'admin_bootstrap_complete' : 'admin_bootstrap_skipped' }));
} catch {
  console.error(JSON.stringify({ code: 'BOOTSTRAP_FAILED', message: 'Check username conflict and bootstrap secret configuration.' }));
  process.exitCode = 1;
} finally { await closeDb(); }
