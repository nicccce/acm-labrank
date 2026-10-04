import Link from 'next/link';
import { formatPoints } from '@acm/core/domain';
import { formatTime } from './score-display';

type LeaderboardEntry = {
  id: string;
  rank: number | null;
  name: string;
  points: number;
  solveCount: number;
  platformSolveCounts: Partial<Record<'codeforces' | 'qoj' | 'luogu', number>>;
  lastAcAt: string | Date | null;
  members?: { displayName: string }[];
  provisional?: boolean;
};

export function LeaderboardTable({ items, kind, userId, signedIn, detailQuery }: {
  items: LeaderboardEntry[];
  kind: 'personal' | 'team';
  userId?: string;
  signedIn: boolean;
  detailQuery: URLSearchParams;
}) {
  const team = kind === 'team';
  if (!items.length) return <div className="leaderboard-empty empty-state"><span className="empty-mark" aria-hidden="true" />{team ? '当前区间暂无队伍' : '当前区间暂无成绩'}{signedIn && <Link href={team ? '/teams' : '/profile'}>{team ? '创建队伍 ↗' : '绑定平台账号 ↗'}</Link>}</div>;
  return <div className="table-wrap leaderboard-scroll" role="region" aria-label={team ? '团队排名' : '个人排名'} tabIndex={0}>
    <table className="data-table leaderboard-table">
      <thead><tr>
        <th scope="col" className="rank-column">排名</th>
        <th scope="col" className="name-column">{team ? '队伍 / 成员' : '姓名'}</th>
        <th scope="col" className="number-column score-column">积分</th>
        <th scope="col" className="number-column">题数</th>
        <th scope="col" className="number-column platform-column"><span className="platform-label platform-cf">CF</span></th>
        <th scope="col" className="number-column platform-column"><span className="platform-label platform-qoj">QOJ</span></th>
        <th scope="col" className="number-column platform-column"><span className="platform-label platform-luogu">洛谷</span></th>
        <th scope="col" className="time-column">最近 AC</th>
      </tr></thead>
      <tbody>{items.map(row => {
        const self = !team && row.id === userId;
        const time = formatTime(row.lastAcAt);
        return <tr key={row.id} className={`${row.rank !== null && row.rank <= 3 ? `podium-row podium-${row.rank}` : ''}${self ? ' self-row' : ''}`}>
          <td className="rank-column"><span className={`rank-badge rank-${row.rank}`}>{row.rank === null ? '—' : String(row.rank).padStart(2, '0')}</span></td>
          <td className="name-column"><div className="entry-heading">{signedIn ? <Link href={`/${team ? 'teams' : 'members'}/${row.id}?${detailQuery}`}>{row.name}</Link> : <span className="entry-name">{row.name}</span>}{self && <span className="self-tag">我</span>}{row.provisional && <span className="entry-status">暂定</span>}</div>{row.members && <span className="entry-members">{row.members.map(member => member.displayName).join('、')}</span>}</td>
          <td className="points-cell number-column score-column">{formatPoints(row.points)}</td>
          <td className="number-column solve-column">{row.solveCount}</td>
          {(['codeforces', 'qoj', 'luogu'] as const).map(platform => <td key={platform} className={`number-column platform-column${!row.platformSolveCounts[platform] ? ' zero-count' : ''}`}>{row.platformSolveCounts[platform] ?? 0}</td>)}
          <td className="time-column">{row.lastAcAt ? <time dateTime={new Date(row.lastAcAt).toISOString()}>{time.slice(0, 10)}<span>{time.slice(11)}</span></time> : <span className="zero-count">—</span>}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}
