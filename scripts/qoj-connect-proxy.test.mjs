import http from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { createQojRelay } from './qoj-connect-proxy.mjs';

const servers = [], sockets = new Set();
async function listen(server) {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return server.address().port;
}
async function connect(port, target = 'qoj.ac:443') {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method: 'CONNECT', path: target, agent: false });
    request.on('connect', (response, socket, head) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); resolve({ status: response.statusCode, socket, head }); });
    request.on('error', reject); request.end();
  });
}
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  sockets.clear();
});

test('upstream CONNECT preserves the destination and tunnel bytes in both directions', async () => {
  const proxy = http.createServer(); let destination;
  proxy.on('connect', (request, socket) => {
    destination = request.url;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\npreface');
    socket.on('data', data => socket.write(data));
  });
  const proxyPort = await listen(proxy);
  const port = await listen(createQojRelay({ upstream: `http://127.0.0.1:${proxyPort}` }));
  const result = await connect(port);
  expect(result.status).toBe(200); expect(destination).toBe('qoj.ac:443');
  expect(result.head.toString()).toBe('preface');
  const reply = once(result.socket, 'data'); result.socket.write('opaque TLS bytes');
  expect((await reply)[0].toString()).toBe('opaque TLS bytes');
});

test('unapproved destinations and ports never reach the upstream', async () => {
  const proxy = http.createServer(); let attempts = 0;
  proxy.on('connect', (_request, socket) => { attempts++; socket.destroy(); });
  const proxyPort = await listen(proxy);
  const port = await listen(createQojRelay({ upstream: `http://127.0.0.1:${proxyPort}` }));
  for (const target of ['example.com:443', 'qoj.ac.example.com:443', 'qoj.ac:80', 'user:password@qoj.ac:443', 'qoj.ac:443/path']) expect((await connect(port, target)).status).toBe(403);
  expect(attempts).toBe(0);
});

test('upstream rejection becomes a bounded 502 without forwarding upstream data', async () => {
  const proxy = http.createServer();
  proxy.on('connect', (_request, socket) => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: secret\r\n\r\nprivate'));
  const proxyPort = await listen(proxy);
  const port = await listen(createQojRelay({ upstream: `http://127.0.0.1:${proxyPort}` }));
  const result = await connect(port);
  expect(result.status).toBe(502); expect(result.head.length).toBe(0);
});

test('stalled upstream handshake returns 502 before the client stalls indefinitely', async () => {
  const proxy = http.createServer(); proxy.on('connect', () => {});
  const proxyPort = await listen(proxy);
  const port = await listen(createQojRelay({ upstream: `http://127.0.0.1:${proxyPort}`, connectTimeoutMs: 50 }));
  expect((await connect(port)).status).toBe(502);
});

test('upstream endpoints reject credentials, paths and unsupported schemes', () => {
  for (const upstream of ['not-a-url', 'https://localhost:7890', 'http://user:password@localhost:7890', 'http://localhost:7890/path', 'http://localhost:7890/?secret=value']) expect(() => createQojRelay({ upstream })).toThrow('INVALID_RELAY_UPSTREAM');
});
