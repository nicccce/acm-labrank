import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const sourceRoot = resolve(import.meta.dirname, '..');
// This host-side script never runs setup, changes credentials, recreates db,
// deletes volumes, or restores an old schema automatically.
export async function updateDeployment({ directory = sourceRoot, build = false, check = false } = {}, hooks = {}) {
  const root = resolve(directory);
  const files = ['compose.yaml', ...(build ? ['compose.build.yaml'] : [])];
  const prefix = ['compose', '--project-directory', root, ...files.flatMap(file => ['-f', resolve(root, file)])];
  const execute = hooks.execute ?? ((args, capture = false) => execFileSync('docker', args, {
    cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 16 * 1024 * 1024,
  }));
  const compose = (args, capture = false) => execute([...prefix, ...args], capture);
  let stage = 'preflight', backup, stopped = false;
  await mkdir(resolve(root, '.local'), { recursive: true, mode: 0o700 });
  const lockPath = resolve(root, '.local/update.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('UPDATE_LOCKED: check whether another update is running; inspect .local/update.lock before removing a stale lock.'); });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    // Required files must already exist. Generating missing keys during an
    // upgrade would make existing encrypted platform sessions unreadable.
    await readFile(resolve(root, '.env'));
    const config = JSON.parse(compose(['config', '--format', 'json'], true));
    const dbId = compose(['ps', '-q', 'db'], true).trim();
    if (!dbId || dbId.split(/\s+/).length !== 1) throw new Error('EXISTING_DATABASE_REQUIRED');
    const db = JSON.parse(execute(['inspect', dbId], true))[0];
    const expectedVolume = config.volumes?.pgdata?.name;
    if (!db.State.Running || db.State.Health?.Status !== 'healthy' || !expectedVolume ||
      !db.Mounts.some(mount => mount.Type === 'volume' && mount.Name === expectedVolume && mount.Destination === '/var/lib/postgresql/data')) {
      throw new Error('DATABASE_VOLUME_OR_HEALTH_MISMATCH');
    }
    for (const name of ['POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD']) {
      if (!db.Config.Env.includes(`${name}=${config.services.db.environment[name]}`)) throw new Error('DATABASE_CONFIGURATION_CHANGED');
    }
    for (const secret of Object.values(config.secrets ?? {})) {
      if (!secret.file) throw new Error('FILE_SECRETS_REQUIRED');
      await readFile(resolve(root, secret.file));
    }
    const containerJson = compose(['ps', '-a', '--format', 'json'], true).trim();
    const containers = containerJson.startsWith('[') ? JSON.parse(containerJson) : containerJson.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const oldContainers = containers.map(({ ID, Name, Image, State }) => ({ ID, Name, Image, State }));
    stage = 'prepare-images';
    compose(build ? ['build', 'migrate', 'worker'] : ['pull', 'migrate', 'worker']);
    stage = 'verify-target-image';
    // Old releases ignore --check and would run a migration immediately. Check
    // their files without opening a database connection before invoking it.
    const journal = JSON.parse(await readFile(resolve(sourceRoot, 'packages/db/drizzle/meta/_journal.json'), 'utf8'));
    const protocolOutput = compose(['run', '--rm', '--no-deps', 'migrate', 'node', '--input-type=module', '-e',
      "import { readFileSync } from 'node:fs'; const protocol=JSON.parse(readFileSync('packages/db/upgrade-protocol.json','utf8')); const journal=JSON.parse(readFileSync('packages/db/drizzle/meta/_journal.json','utf8')); console.log(JSON.stringify({event:'upgrade_protocol',protocol:protocol.version,total:journal.entries.length,target:journal.entries.at(-1).tag}));"], true);
    const protocol = protocolOutput.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(value => value.event === 'upgrade_protocol');
    if (!protocol || protocol.protocol !== 1 || protocol.total !== journal.entries.length || protocol.target !== journal.entries.at(-1).tag) throw new Error('TARGET_IMAGE_VERSION_MISMATCH');
    stage = 'check-migrations';
    const output = compose(['run', '--rm', '--no-deps', 'migrate', 'pnpm', 'db:migrate', '--check', '--require-paused'], true);
    const plan = output.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(value => value.event === 'migration_plan');
    if (!plan || plan.total !== journal.entries.length || plan.target !== journal.entries.at(-1).tag) throw new Error('TARGET_IMAGE_VERSION_MISMATCH');
    console.log(JSON.stringify(plan));
    if (check) { console.log('Upgrade preflight passed; database and running services were not changed.'); return; }

    stage = 'backup-config';
    backup = resolve(root, '.local', `upgrade-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
    await mkdir(backup, { mode: 0o700 });
    if (process.platform === 'win32') {
      const user = execFileSync('whoami', { encoding: 'utf8' }).trim();
      const owner = process.env.USERDOMAIN + '\\' + process.env.USERNAME;
      execFileSync('icacls', [backup, '/inheritance:r', '/grant:r', ...new Set([user, owner].map(value => value + ':(OI)(CI)F')), 'SYSTEM:(OI)(CI)F'], { stdio: 'ignore' });
    }
    await copyFile(resolve(root, '.env'), resolve(backup, '.env'));
    await mkdir(resolve(backup, 'secrets'), { mode: 0o700 });
    for (const [name, secret] of Object.entries(config.secrets)) await copyFile(resolve(root, secret.file), resolve(backup, 'secrets', name));
    for (const file of files) await copyFile(resolve(root, file), resolve(backup, basename(file)));
    stage = 'stop-applications';
    console.log('Stopping Web and Worker for a consistent backup. Recreating Worker may require signing into the QOJ browser again.');
    compose(['stop', 'web', 'worker']);
    stopped = true;
    stage = 'backup-database';
    const dumpPath = resolve(backup, 'database.dump');
    const dbEnv = config.services.db.environment;
    const dump = hooks.dump ?? dumpDatabase;
    await dump([...prefix, 'exec', '-T', 'db', 'pg_dump', '-U', dbEnv.POSTGRES_USER, '-d', dbEnv.POSTGRES_DB, '-Fc'], dumpPath);
    // Verify that pg_restore recognizes the custom archive before any DDL.
    const verify = hooks.verify ?? verifyArchive;
    await verify([...prefix, 'exec', '-T', 'db', 'pg_restore', '--list'], dumpPath);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(dumpPath)) hash.update(chunk);
    const manifest = await open(resolve(backup, 'manifest.json'), 'wx', 0o600);
    try { await manifest.writeFile(JSON.stringify({ createdAt: new Date().toISOString(), project: config.name, volume: expectedVolume, containers: oldContainers, sha256: hash.digest('hex'), archiveVerified: true }, null, 2)); }
    finally { await manifest.close(); }
    console.log(`Verified backup: ${backup}`);
    stage = 'migrate';
    // Always run a new one-off container; do not rely on an old Exited (0)
    // migration service being reused by Compose up.
    compose(['run', '--rm', '--no-deps', 'migrate']);
    stage = 'bootstrap';
    compose(['run', '--rm', '--no-deps', 'bootstrap']);
    stage = 'start-applications';
    compose(['up', '-d', '--no-deps', '--wait', 'web', 'worker']);
    console.log(`Update complete. Existing database volume and credentials were preserved. Backup: ${backup}`);
  } catch (error) {
    const code = /^[A-Z_]+$/.test(error.message) ? ` (${error.message})` : '';
    const failure = new Error(`UPDATE_FAILED at ${stage}${code}. ${backup ? `Backup directory: ${backup}. ` : ''}${stopped ? 'Applications may be stopped; inspect the failure before starting matching versions. ' : ''}No automatic downgrade or database restore was attempted.`, { cause: error });
    throw failure;
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

async function streamCommand(args, connect, executable) {
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume(); // Never echo database credentials or SQL on failure.
  const completed = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error('DATABASE_ARCHIVE_COMMAND_FAILED')));
  });
  try { await Promise.all([completed, connect(child)]); }
  catch (error) { child.kill(); throw error; }
}
export async function dumpDatabase(args, path, executable = 'docker') {
  await streamCommand(args, async child => {
    child.stdin.end();
    await pipeline(child.stdout, createWriteStream(`${path}.partial`, { flags: 'wx', mode: 0o600 }));
  }, executable);
  await rename(`${path}.partial`, path);
}
export async function verifyArchive(args, path, executable = 'docker') {
  await streamCommand(args, async child => {
    child.stdout.resume();
    await pipeline(createReadStream(path), child.stdin);
  }, executable);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { directory: { type: 'string' }, build: { type: 'boolean' }, check: { type: 'boolean' } } });
    await updateDeployment(values);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
