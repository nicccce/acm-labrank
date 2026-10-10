import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { LeaderboardTable } from './leaderboard-table';

it('labels starred entries without podium styling and keeps the following real rank', () => {
  const entry = { id: 'star', name: '打星用户', isStarred: true, rank: null, points: 100, solveCount: 10, platformSolveCounts: {}, lastAcAt: null };
  const html = renderToStaticMarkup(createElement(LeaderboardTable, { kind: 'personal', signedIn: false, userId: 'star', detailQuery: new URLSearchParams(), items: [entry, { ...entry, id: 'ranked', name: '正式用户', isStarred: false, rank: 1 }] }));
  const [starred, ranked] = html.split('<tbody>')[1]!.split('</tr>');
  expect(starred).toContain('starred-row');
  expect(starred).toContain('不参与排名');
  expect(starred).not.toContain('podium-row');
  expect(starred).toContain('>*</span>');
  expect(ranked).toContain('podium-1');
  expect(ranked).toContain('>01</span>');
});
