import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { getAdminConnectionAlerts } from '@acm/core/server';
import { currentSession } from '../lib/http';
import HomePage from './page';

vi.mock('../lib/http', () => ({ currentSession: vi.fn() }));
vi.mock('@acm/core/server', () => ({
  getAdminConnectionAlerts: vi.fn(async () => ({ items: [{ platform: 'luogu', name: '洛谷' }] })),
  getPersonalLeaderboard: vi.fn(async () => ({ items: [], range: { from: '2026-10-01', to: '2026-10-04' }, provisional: false, page: 1, limit: 20, total: 0 })),
}));
vi.mock('../lib/member-page', () => ({
  pageParams: async () => new URLSearchParams(),
  loadPage: async (fn: () => Promise<unknown>) => ({ data: await fn(), error: null }),
  scorePlatforms: async () => ['luogu'],
  MemberShell: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  PageError: () => null,
}));
vi.mock('../components/score-filter', () => ({ ScoreFilter: () => null }));
vi.mock('../components/score-display', () => ({ Pagination: () => null, formatTime: () => '' }));
beforeEach(() => vi.clearAllMocks());
function session(role: 'admin' | 'member') {
  return { user: { id: 'user', role }, csrfToken: 'csrf' } as NonNullable<Awaited<ReturnType<typeof currentSession>>>;
}
it('shows an administrator the login-expiry reminder when opening the homepage', async () => {
  vi.mocked(currentSession).mockResolvedValueOnce(session('admin'));
  const html = renderToStaticMarkup(await HomePage({ searchParams: Promise.resolve({}) }));
  expect(getAdminConnectionAlerts).toHaveBeenCalledOnce();
  expect(html).toContain('洛谷未登录或登录已过期');
  expect(html).toContain('前往连接管理重新登录');
  expect(html).toContain('href="/admin/connections"');
});
it.each(['member', 'guest'])('does not fetch or show administrator reminders to a %s', async role => {
  vi.mocked(currentSession).mockResolvedValueOnce(role === 'member' ? session('member') : null);
  const html = renderToStaticMarkup(await HomePage({ searchParams: Promise.resolve({}) }));
  expect(getAdminConnectionAlerts).not.toHaveBeenCalled();
  expect(html).not.toContain('前往连接管理重新登录');
});
it('keeps the leaderboard available when the initial reminder query fails', async () => {
  vi.mocked(currentSession).mockResolvedValueOnce(session('admin'));
  vi.mocked(getAdminConnectionAlerts).mockRejectedValueOnce(new Error('temporarily unavailable'));
  const html = renderToStaticMarkup(await HomePage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('当前区间暂无成绩');
  expect(html).not.toContain('登录已过期');
});
