import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { dumpDatabase, updateDeployment, verifyArchive } from './update.mjs';

const roots = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    expect(root.startsWith(resolve(tmpdir(), 'acm-update-'))).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(failure) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const root = await mkdtemp(resolve(tmpdir(), 'acm-update-'));
  roots.push(root);
  await mkdir(resolve(root, '.secrets'));
  await writeFile(resolve(root, '.env'), 'EXISTING_CONFIGURATION=preserve-me');
  await writeFile(resolve(root, 'compose.yaml'), 'existing compose fixture');
  for (const name of ['session', 'admin', 'qoj']) await writeFile(resolve(root, '.secrets', name), `existing-${name}`);
  const calls = [];
  const config = { name: 'existing-project', services: { db: { environment: { POSTGRES_USER: 'existing_user', POSTGRES_DB: 'existing_db', POSTGRES_PASSWORD: 'existing_password' } } }, volumes: { pgdata: { name: 'existing-project_pgdata' } }, secrets: Object.fromEntries(['session', 'admin', 'qoj'].map(name => [name, { file: resolve(root, '.secrets', name) }])) };
  const journal = JSON.parse(await readFile(new URL('../packages/db/drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  const execute = (args) => {
    calls.push(args);
    if (args[0] === 'inspect') return JSON.stringify([{ State: { Running: true, Health: { Status: 'healthy' } }, Config: { Env: Object.entries(config.services.db.environment).map(([key, value]) => `${key}=${value}`) }, Mounts: [{ Type: 'volume', Name: failure === 'volume' ? 'another_volume' : config.volumes.pgdata.name, Destination: '/var/lib/postgresql/data' }] }]);
    if (args.includes('config')) return JSON.stringify(config);
    if (args.includes('ps')) return args.includes('-q') ? 'existing_db_container' : JSON.stringify({ ID: 'old_web', Name: 'old-web', Image: 'old-image', State: 'running' });
    if (args.includes('--input-type=module')) return JSON.stringify({ event: 'upgrade_protocol', protocol: 1, total: journal.entries.length, target: failure === 'image' ? '0000_initial' : journal.entries.at(-1).tag });
    if (args.includes('--check')) {
      if (failure === 'preflight') throw new Error('preflight failed');
      return JSON.stringify({ event: 'migration_plan', total: journal.entries.length, target: failure === 'image' ? '0000_initial' : journal.entries.at(-1).tag, applied: journal.entries.length - 1, pending: [journal.entries.at(-1).tag], checkOnly: true });
    }
    if (args.at(-1) === 'migrate' && failure === 'migrate') throw new Error('migration failed');
    return '';
  };
  return { root, calls, hooks: { execute, dump: async (_args, path) => { calls.push(['dump']); if (failure === 'dump') throw new Error('disk full'); await writeFile(path, Buffer.from([80, 71, 68, 77, 80, 0, 255])); }, verify: async () => { calls.push(['verify-archive']); if (failure === 'archive') throw new Error('archive invalid'); } } };
}
describe('data preserving deployment update', () => {
  it('preserves binary backup bytes through process pipes on Windows and Unix', async () => {
    const { root } = await fixture();
    const path = resolve(root, 'binary.dump');
    await dumpDatabase(['-e', 'process.stdout.write(Buffer.alloc(1048576, 255))'], path, process.execPath);
    const data = await readFile(path);
    expect(data.length).toBe(1048576);
    expect(createHash('sha256').update(data).digest('hex')).toBe(createHash('sha256').update(Buffer.alloc(1048576, 255)).digest('hex'));
    await verifyArchive(['-e', "let n=0; process.stdin.on('data', b=>{ if(b.some(v=>v!==255)) process.exit(2); n+=b.length; }); process.stdin.on('end', ()=>process.exit(n===1048576?0:3));"], path, process.execPath);
    expect((await readdir(root)).includes('binary.dump.partial')).toBe(false);
  }, 15000);
  it('does not publish incomplete backups when the export command fails', async () => {
    const { root } = await fixture();
    const path = resolve(root, 'incomplete.dump');
    await expect(dumpDatabase(['-e', 'process.stdout.write(Buffer.alloc(512)); process.exitCode=2'], path, process.execPath)).rejects.toThrow('DATABASE_ARCHIVE_COMMAND_FAILED');
    expect((await readdir(root)).includes('incomplete.dump')).toBe(false);
    await writeFile(path, 'invalid archive');
    await expect(verifyArchive(['-e', 'process.exit(2)'], path, process.execPath)).rejects.toThrow();
  });
  it('checks the target image without stopping services or creating a backup', async () => {
    const { root, calls, hooks } = await fixture();
    await updateDeployment({ directory: root, check: true }, hooks);
    expect(calls.some(args => args.includes('stop') || args.includes('up') || args[0] === 'dump')).toBe(false);
    expect(await readdir(resolve(root, '.local'))).toEqual([]);
  });
  it('backs up original credentials and a verified binary archive before migration, then starts only web/worker', async () => {
    const { root, calls, hooks } = await fixture();
    await updateDeployment({ directory: root }, hooks);
    const stop = calls.findIndex(args => args.includes('stop'));
    const dump = calls.findIndex(args => args[0] === 'dump');
    const verify = calls.findIndex(args => args[0] === 'verify-archive');
    const migrate = calls.findIndex(args => args.at(-1) === 'migrate');
    expect(stop).toBeLessThan(dump); expect(dump).toBeLessThan(verify); expect(verify).toBeLessThan(migrate);
    expect(calls.at(-1).slice(-5)).toEqual(['-d', '--no-deps', '--wait', 'web', 'worker']);
    const backup = resolve(root, '.local', (await readdir(resolve(root, '.local')))[0]);
    expect(await readFile(resolve(root, '.env'), 'utf8')).toBe('EXISTING_CONFIGURATION=preserve-me');
    expect(await readFile(resolve(backup, '.env'), 'utf8')).toBe('EXISTING_CONFIGURATION=preserve-me');
    expect(await readFile(resolve(backup, 'secrets/session'), 'utf8')).toBe('existing-session');
    expect(JSON.parse(await readFile(resolve(backup, 'manifest.json'), 'utf8')).sha256).toBe(createHash('sha256').update(await readFile(resolve(backup, 'database.dump'))).digest('hex'));
    expect(calls.some(args => args.includes('down') || args.includes('--force-recreate'))).toBe(false);
  });
  it.each(['volume', 'preflight', 'image'])('stops before touching services when %s validation fails', async failure => {
    const { root, calls, hooks } = await fixture(failure);
    await expect(updateDeployment({ directory: root }, hooks)).rejects.toThrow('UPDATE_FAILED');
    expect(calls.some(args => args.includes('stop') || args.includes('up'))).toBe(false);
    if (failure === 'image') expect(calls.some(args => args.includes('--check'))).toBe(false);
  });
  it.each(['dump', 'archive'])('never migrates after a %s failure', async failure => {
    const { root, calls, hooks } = await fixture(failure);
    await expect(updateDeployment({ directory: root }, hooks)).rejects.toThrow('backup-database');
    expect(calls.some(args => args.at(-1) === 'migrate' || args.includes('up'))).toBe(false);
    expect((await readdir(resolve(root, '.local'))).some(name => name.startsWith('upgrade-'))).toBe(true);
  });
  it('does not start applications or automatically restore a database after failed DDL', async () => {
    const { root, calls, hooks } = await fixture('migrate');
    await expect(updateDeployment({ directory: root }, hooks)).rejects.toThrow('at migrate');
    expect(calls.some(args => args.includes('bootstrap') || args.includes('up'))).toBe(false);
    expect(await readFile(resolve(root, '.secrets/session'), 'utf8')).toBe('existing-session');
  });
  it('refuses to compete with another updater', async () => {
    const { root, calls, hooks } = await fixture();
    await mkdir(resolve(root, '.local')); await writeFile(resolve(root, '.local/update.lock'), 'another updater');
    await expect(updateDeployment({ directory: root }, hooks)).rejects.toThrow('UPDATE_LOCKED');
    expect(calls).toEqual([]);
  });
});
