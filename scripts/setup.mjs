import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const secrets = resolve(root, '.secrets');
await mkdir(secrets, { recursive: true, mode: 0o700 });
for (const [name, bytes] of [['session-encryption-key', 32], ['admin-bootstrap-password', 24]]) {
  const path = resolve(secrets, name);
  if (!existsSync(path)) await writeFile(path, randomBytes(bytes).toString('hex'), { flag: 'wx', mode: 0o600 });
}
if (process.platform === 'win32') {
  const user = execFileSync('whoami', { encoding: 'utf8' }).trim();
  const owner = process.env.USERDOMAIN + '\\' + process.env.USERNAME;
  const principals = [...new Set([user, owner])].map(value => value + ':(OI)(CI)F');
  execFileSync('icacls', [secrets, '/inheritance:r', '/grant:r', ...principals, 'SYSTEM:(OI)(CI)F'], { stdio: 'ignore' });
} else {
  await chmod(secrets, 0o700);
  for (const name of ['session-encryption-key', 'admin-bootstrap-password']) await chmod(resolve(secrets, name), 0o600);
}
const envPath = resolve(root, '.env');
if (!existsSync(envPath)) {
  const password = randomBytes(24).toString('hex');
  const template = await readFile(resolve(root, '.env.example'), 'utf8');
  await writeFile(envPath, template.replaceAll('replace-with-random-password', password), { flag: 'wx', mode: 0o600 });
  console.log('Created .env with random local database credentials.');
} else { console.log('Preserved existing .env.'); }
console.log('Administrator: ADMIN_BOOTSTRAP_USERNAME in .env.');
console.log('Read the initial password from .secrets/admin-bootstrap-password locally; it is never printed.');
