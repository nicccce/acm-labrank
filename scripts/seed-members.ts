import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { closeDb, getPool, listBindings } from '@acm/db/server';
import { hashPassword, putMemberBinding } from '../packages/core/src/application/index';
const { values } = parseArgs({ options: { cf: { type: 'string', default: 'tourist' }, luogu: { type: 'string', default: '863154' }, qoj: { type: 'string', default: 'muhammad' }, 'password-file': { type: 'string', default: process.env.MEMBER_TEST_PASSWORD_FILE ?? '.local/member-test-password' } } });
try {
  let password: string;
  try { password = (await readFile(values['password-file'], 'utf8')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    password = randomBytes(24).toString('hex'); await mkdir(dirname(values['password-file']), { recursive: true }); await writeFile(values['password-file'], password, { flag: 'wx', mode: 0o600 });
  }
  const hash = await hashPassword(password);
  for (const username of ['test_member', 'test_empty']) await getPool().query("INSERT INTO users(username,password_hash,role) VALUES ($1,$2,'member') ON CONFLICT(username) DO NOTHING", [username, hash]);
  password = '';
  const member = (await getPool().query<{ id: string }>("SELECT id FROM users WHERE username='test_member'")).rows[0]!;
  const existing = await listBindings(member.id);
  for (const [platform, target] of [['codeforces', values.cf], ['luogu', values.luogu], ['qoj', values.qoj]] as const) {
    if (!existing.some(b => b.platform === platform && (b.account_id || b.candidate))) await putMemberBinding(member.id, platform, { target });
  }
  console.log(JSON.stringify({ event: 'members_seeded', usernames: ['test_member', 'test_empty'], passwordFile: values['password-file'], verification: 'queued; waits while collection is paused' }));
} finally { await closeDb(); }
