import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Initial } from '@acm/core/contracts';
import { PlatformConnections } from './platform-connections';
import { CollectionManager } from './collection-manager';

it('renders login instructions and hides a historical identity when a session expires', () => {
  const html = renderToStaticMarkup(createElement(PlatformConnections, {
    csrfToken: 'test', vncUrl: '/desktop', initialControl: { enabled: false, version: 1 },
    initialConnections: { luogu: { state: 'auth_required', collector: 'stale-luogu' }, qoj: { state: 'auth_required', collector: 'stale-qoj' } },
  }));
  expect(html).not.toContain('stale-luogu');
  expect(html).not.toContain('stale-qoj');
  expect(html).toContain('重新获取验证码并登录');
  expect(html).toContain('远程桌面重新登录');
  expect(html).toContain('role="alert"');
});

const initial: Initial = {
  control: { enabled: true, version: 1 }, jobs: { items: [], nextCursor: null },
  leaderboard: { range: { from: '2026-10-01', to: '2026-10-04' }, provisional: false, total: 0, items: [] },
  settings: { platforms: ['luogu'], autoSyncEnabled: false, syncIntervalMinutes: 360, scoreRange: { kind: 'rolling', days: 30 }, version: 1, items: [] },
  platforms: [{ platform: 'luogu', name: '洛谷', rateLimit: { minIntervalMs: 3000, maxIntervalMs: 5000, version: 1 }, connection: { state: 'auth_required', collector: null } }],
};
it('shows the administrator a direct re-login link on the collection page after authentication fails', () => {
  const html = renderToStaticMarkup(createElement(CollectionManager, { csrfToken: 'test', initial }));
  expect(html).toContain('洛谷未登录或登录已过期');
  expect(html).toContain('href="/admin/connections"');
  expect(html).toContain('前往连接管理重新登录');
});
it('removes the re-login warning once a new session is confirmed', () => {
  const recovered = { ...initial, platforms: initial.platforms.map(platform => ({ ...platform, connection: { state: 'ready', collector: 'current' } })) };
  const html = renderToStaticMarkup(createElement(CollectionManager, { csrfToken: 'test', initial: recovered }));
  expect(html).not.toContain('前往连接管理重新登录');
});
