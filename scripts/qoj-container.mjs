import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

// The container owns all these processes. CDP is loopback-only and never published.
const children = new Set();
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) terminate(child, 'SIGTERM');
  await Promise.race([
    Promise.all([...children].map(child => new Promise(resolve => child.once('exit', resolve)))),
    delay(20000, undefined, { ref: false }),
  ]);
  for (const child of children) terminate(child, 'SIGKILL');
  process.exitCode = code;
}
function terminate(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch { /* Already reaped. */ }
}
function start(name, command, args, stdio = 'ignore') {
  if (stopping) throw new Error('CONTAINER_STOPPING');
  const child = spawn(command, args, { stdio, detached: true });
  children.add(child);
  child.on('error', () => {
    children.delete(child);
    console.error(JSON.stringify({ event: 'qoj_container_process_failed', process: name }));
    void stop(1);
  });
  child.on('exit', code => {
    terminate(child, 'SIGTERM');
    children.delete(child);
    if (!stopping) {
      console.error(JSON.stringify({ event: 'qoj_container_process_exited', process: name, code }));
      void stop(code ?? 1);
    }
  });
  return child;
}
function run(command, args, input) {
  return new Promise((resolve, reject) => {
    if (stopping) { reject(new Error('CONTAINER_STOPPING')); return; }
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    children.add(child);
    const output = [];
    child.stdout.on('data', data => output.push(data));
    child.once('error', error => { children.delete(child); reject(error); });
    child.stdin.on('error', reject);
    child.once('exit', code => {
      children.delete(child);
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error('DESKTOP_HELPER_FAILED'));
    });
    child.stdin.end(input);
  });
}
process.once('SIGTERM', () => { void stop(0); });
process.once('SIGINT', () => { void stop(0); });
try {
  if (process.env.QOJ_TRANSPORT !== 'browser' || process.env.QOJ_BROWSER_HEADED !== 'true') throw new Error('DESKTOP_REQUIRES_HEADED_BROWSER');
  for (const directory of [process.env.TMPDIR, process.env.XDG_CONFIG_HOME, process.env.XDG_CACHE_HOME, '/app/.local']) {
    if (!directory) throw new Error('DESKTOP_DIRECTORY_REQUIRED');
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const password = await readFile(process.env.QOJ_VNC_PASSWORD_FILE ?? '/run/secrets/qoj_vnc_password');
  // Classic VNC authenticates with the first eight characters. Never put them in argv.
  if (!/^[A-Za-z0-9+/]{8}\r?\n?$/.test(password.toString('utf8'))) throw new Error('INVALID_VNC_SECRET');
  const authentication = await run('tigervncpasswd', ['-f'], password);
  password.fill(0);
  if (authentication.length !== 8) throw new Error('INVALID_VNC_AUTH_FILE');
  const authFile = `${process.env.TMPDIR}/vnc-auth`;
  await writeFile(authFile, authentication, { mode: 0o600 });
  authentication.fill(0);
  start('display', 'Xvfb', [':99', '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-noreset']);
  let ready = false;
  for (let attempt = 0; attempt < 50 && !stopping; attempt++) {
    try { await run('xdpyinfo', ['-display', ':99']); ready = true; break; }
    catch { await delay(100); }
  }
  if (!ready || stopping) throw new Error('DISPLAY_NOT_READY');
  start('windows', 'openbox', []);
  start('vnc', 'x11vnc', ['-display', ':99', '-localhost', '-rfbport', '5900', '-rfbauth', authFile, '-forever', '-shared', '-noclipboard', '-quiet']);
  start('novnc', 'websockify', ['--web=/usr/share/novnc/', '0.0.0.0:6080', '127.0.0.1:5900']);
  const browserProfile = `${process.env.TMPDIR}/profile`;
  await mkdir(browserProfile, { recursive: true, mode: 0o700 });
  const browserArguments = [
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9222',
    `--user-data-dir=${browserProfile}`,
  ];
  if (process.env.QOJ_BROWSER_PROXY_SERVER) {
    const proxy = new URL(process.env.QOJ_BROWSER_PROXY_SERVER);
    if (!['http:', 'https:', 'socks5:'].includes(proxy.protocol) || proxy.username || proxy.password || !proxy.hostname || !['', '/'].includes(proxy.pathname) || proxy.search || proxy.hash) throw new Error('INVALID_BROWSER_PROXY');
    browserArguments.push(`--proxy-server=${proxy.protocol}//${proxy.host}`);
  }
  const manualStart = process.env.QOJ_BROWSER_MANUAL_START === 'true';
  const target = process.env.QOJ_BROWSER_START_TARGET ?? 'muhammad';
  if (manualStart && (!target || target.length > 100 || /[\s/?#\\]/.test(target))) throw new Error('INVALID_BROWSER_START_TARGET');
  browserArguments.push(manualStart ? `https://qoj.ac/user/profile/${encodeURIComponent(target)}` : 'https://qoj.ac/login');
  start('browser', process.env.QOJ_BROWSER_EXECUTABLE ?? '/usr/bin/chromium', browserArguments);
  let browserReady = false;
  for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:9222/json/version');
      if (response.ok) { browserReady = true; break; }
    } catch { /* Chromium is still starting. */ }
    await delay(100);
  }
  if (!browserReady || stopping) throw new Error('BROWSER_NOT_READY');
  process.env.QOJ_BROWSER_CDP_ENDPOINT = 'http://127.0.0.1:9222';
  if (manualStart) {
    const id = randomUUID();
    const file = '/app/.local/qoj-browser-attach.json';
    const expiresAt = new Date(Date.now() + 600000).toISOString();
    await writeFile(file, JSON.stringify({ id, confirmed: false, expiresAt }), { mode: 0o600, flag: 'wx' });
    process.env.QOJ_BROWSER_ATTACH_ID = id;
    process.env.QOJ_BROWSER_ATTACH_FILE = file;
    console.log(JSON.stringify({ event: 'qoj_browser_manual_start', id, expiresAt, file, target, cdpConnected: false, message: 'Inspect the dedicated desktop before confirming browser attachment. Confirmation is not proof of successful collection.' }));
  }
  const command = process.argv.slice(2);
  if (!command.length) throw new Error('WORKER_COMMAND_REQUIRED');
  start('worker', command[0], command.slice(1), 'inherit');
  console.log(JSON.stringify({ event: 'qoj_container_desktop_started', display: ':99', desktopPort: 6080, browserOwner: 'container', cdp: 'loopback' }));
} catch {
  if (!stopping) console.error(JSON.stringify({ event: 'qoj_container_start_failed' }));
  await stop(1);
}
