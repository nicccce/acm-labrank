import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const expected = readFileSync(resolve(root, '.node-version'), 'utf8').trim();
let failed = false;
function report(name, ok, detail) {
  if (!ok) failed = true;
  console.log((ok ? '[OK] ' : '[FAIL] ') + name + ': ' + detail);
}
report('Node', process.versions.node === expected, process.versions.node + ' (expected ' + expected + ')');
for (const [name, args] of [['Docker Compose', ['compose', 'version']], ['Docker engine', ['info', '--format', '{{.OSType}} {{.ServerVersion}}']]]) {
  try {
    const result = execFileSync('docker', args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    report(name, name !== 'Docker engine' || result.startsWith('linux '), result);
  } catch { report(name, false, 'Cannot access Docker Desktop; check startup and current user access.'); }
}
for (const path of ['.env', '.secrets/session-encryption-key', '.secrets/admin-bootstrap-password', 'pnpm-lock.yaml']) {
  report(path, existsSync(resolve(root, path)), existsSync(resolve(root, path)) ? 'present' : 'run pnpm setup / pnpm install');
}
process.exitCode = failed ? 1 : 0;
