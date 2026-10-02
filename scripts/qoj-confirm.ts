import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Operator confirmation contains no platform credentials. Worker revalidates the real page.
try {
  const { values } = parseArgs({ options: { id: { type: 'string' }, file: { type: 'string' }, attach: { type: 'boolean' } } });
  if (!values.id || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(values.id)) throw new Error('INVALID_EVENT_ID');
  const file = values.file ?? (values.attach ? '/app/.local/qoj-browser-attach.json' : process.env.QOJ_HUMAN_CONFIRM_FILE ?? '.local/qoj-confirm.json');
  let expiresAt: string | undefined;
  if (values.attach) {
    const pending = JSON.parse(await readFile(file, 'utf8'));
    if (pending.id !== values.id || pending.confirmed !== false || !Number.isFinite(Date.parse(pending.expiresAt)) || Date.parse(pending.expiresAt) <= Date.now()) throw new Error('STALE_ATTACH_EVENT');
    expiresAt = pending.expiresAt;
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ id: values.id, confirmed: true, ...(expiresAt ? { expiresAt } : {}) }), { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
  console.log(JSON.stringify({ event: values.attach ? 'qoj_browser_attachment_confirmed' : 'qoj_human_confirmation_written', id: values.id }));
} catch {
  console.error(JSON.stringify({ event: 'qoj_human_confirmation_failed' }));
  process.exitCode = 1;
}
