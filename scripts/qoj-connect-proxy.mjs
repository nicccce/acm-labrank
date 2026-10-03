import http from 'node:http';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// TLS stays end-to-end; only CONNECT destinations and the upstream status are inspected.
export function createQojRelay({ upstream = '', connectTimeoutMs = 10000 } = {}) {
  let proxy;
  if (upstream) {
    try { proxy = new URL(upstream); } catch { throw new Error('INVALID_RELAY_UPSTREAM'); }
    if (proxy.protocol !== 'http:' || !proxy.hostname || proxy.username || proxy.password || !['', '/'].includes(proxy.pathname) || proxy.search || proxy.hash) throw new Error('INVALID_RELAY_UPSTREAM');
  }
  const server = http.createServer((_request, response) => response.writeHead(405).end());
  server.on('connect', (request, socket, head) => {
    let target;
    try { target = new URL(`https://${request.url}`); } catch { socket.destroy(); return; }
    const allowed = target.hostname === 'qoj.ac' || target.hostname.endsWith('.qoj.ac') || target.hostname === 'challenges.cloudflare.com';
    if (!allowed || target.port && target.port !== '443' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    let tunnel, pending, established = false, failed = false;
    const fail = () => {
      if (socket.destroyed || established || failed) return;
      failed = true;
      clearTimeout(timer); pending?.destroy(); tunnel?.destroy();
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    };
    const timer = setTimeout(fail, connectTimeoutMs);
    const connected = (stream, received = Buffer.alloc(0)) => {
      if (socket.destroyed || failed) { stream.destroy(); return; }
      established = true; clearTimeout(timer); tunnel = stream;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (received.length) socket.write(received);
      if (head.length) tunnel.write(head);
      tunnel.setTimeout(180000, () => tunnel.destroy());
      tunnel.on('error', () => socket.destroy()); tunnel.on('close', () => socket.destroy());
      tunnel.pipe(socket); socket.pipe(tunnel);
    };
    socket.setTimeout(180000, () => socket.destroy());
    socket.on('error', () => { pending?.destroy(); tunnel?.destroy(); });
    socket.on('close', () => { clearTimeout(timer); pending?.destroy(); tunnel?.destroy(); });
    if (proxy) {
      pending = http.request({ hostname: proxy.hostname, port: proxy.port || 80, method: 'CONNECT', path: `${target.hostname}:443`, agent: false });
      pending.on('connect', (response, stream, received) => {
        tunnel = stream;
        if (response.statusCode !== 200) { fail(); return; }
        connected(stream, received);
      });
      pending.on('response', response => { response.resume(); fail(); });
      pending.on('error', fail); pending.end();
    } else {
      tunnel = net.connect({ host: target.hostname, port: 443 }, () => connected(tunnel));
      tunnel.on('error', fail);
    }
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.QOJ_RELAY_PORT ?? 3875);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_RELAY_PORT');
  const upstream = process.env.QOJ_RELAY_UPSTREAM ?? '';
  createQojRelay({ upstream }).listen(port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'qoj_tls_relay_ready', port, mode: upstream ? 'upstream' : 'direct' })));
}
