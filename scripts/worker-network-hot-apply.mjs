import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';

// Deployment repair for a logged-in browser container: update only the worker's
// Node proxy dispatcher, never restart Chromium or publish an inspector port.
const upstream = process.env.PLATFORM_HTTPS_PROXY;
const reloadWorker = process.argv.includes('--reload-worker');
if (reloadWorker) {
  // Check the freshly copied code against the migrated database before replacing
  // the healthy process, including the exact migration count used at startup.
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "const db = await import('./packages/db/src/index.ts'); try { if (!await db.checkDatabaseReady()) throw new Error('Schema not ready'); if ((await db.getCollectionControl()).enabled) throw new Error('Pause collection first'); } finally { await db.closeDb(); }"], { cwd: '/app', stdio: 'pipe' });
}
if (!upstream && !reloadWorker) throw new Error('PLATFORM_HTTPS_PROXY_REQUIRED');
const proxy = upstream ? new URL(upstream) : null;
if (proxy && (proxy.protocol !== 'http:' || proxy.username || proxy.password || !['', '/'].includes(proxy.pathname) || proxy.search || proxy.hash)) throw new Error('INVALID_PROXY');
const matches = [];
for (const name of await readdir('/proc')) {
  if (!/^\d+$/.test(name)) continue;
  try {
    const args = (await readFile(`/proc/${name}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    if (args[0]?.endsWith('/node') && args.some(arg => arg === '--import' || arg.startsWith('--import=')) && ['src/index.ts', '/app/apps/worker/src/index.ts'].includes(args.at(-1))) matches.push(Number(name));
  } catch { /* Process exited. */ }
}
if (matches.length !== 1) throw new Error('EXACT_WORKER_PROCESS_REQUIRED');
process.kill(matches[0], 'SIGUSR1');
let target;
for (let i = 0; i < 50; i++) {
  try {
    const targets = await (await fetch('http://127.0.0.1:9229/json/list')).json();
    target = targets.find(value => value.webSocketDebuggerUrl);
    if (target) break;
  } catch { /* Local-only inspector is starting. */ }
  await delay(100);
}
if (!target) throw new Error('LOCAL_INSPECTOR_UNAVAILABLE');
const socket = new globalThis.WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let sequence = 0;
async function evaluate(expression) {
  const id = ++sequence;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('INSPECTOR_TIMEOUT')); }, 10000);
    const receive = event => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer); socket.removeEventListener('message', receive);
      if (message.error || message.result?.exceptionDetails) reject(new Error('NETWORK_APPLY_FAILED'));
      else resolve(message.result?.result?.value);
    };
    socket.addEventListener('message', receive);
  });
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  return response;
}
try {
  if (reloadWorker && !await evaluate("typeof process.execve === 'function'")) throw new Error('WORKER_RELOAD_UNSUPPORTED');
  if (upstream) {
    const proxyEnv = { HTTP_PROXY: upstream, HTTPS_PROXY: upstream, NO_PROXY: 'localhost,127.0.0.1,::1,web,worker,db' };
    const result = await evaluate(`(() => { const settings = ${JSON.stringify(proxyEnv)}; Object.assign(process.env, settings, { NODE_USE_ENV_PROXY: '1' }); process.getBuiltinModule('node:http').setGlobalProxyFromEnv(settings); return { applied: true }; })()`);
    if (!result?.applied) throw new Error('NETWORK_APPLY_FAILED');
    console.log(JSON.stringify({ event: 'worker_network_applied', browserRestarted: false, inspectorPublished: false }));
  }
  if (reloadWorker) {
    // Linux execve replaces this Node process in place: the desktop supervisor
    // observes no child exit and Chromium/CDP/VNC retain their existing sessions.
    // Pause collection and drain active jobs before using this deployment option.
    await evaluate("setTimeout(() => process.execve(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'))), 1000); true");
    console.log(JSON.stringify({ event: 'worker_reload_scheduled', browserRestarted: false, pidPreserved: true }));
  }
} finally {
  await evaluate("setTimeout(() => process.getBuiltinModule('node:inspector').close(), 250); true").catch(() => undefined);
  socket.close();
}
