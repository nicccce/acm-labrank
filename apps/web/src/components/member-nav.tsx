'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { LogoutButton } from './logout-button';

export function MemberNav({ userId, name = '', admin = false, csrfToken = '' }: { userId?: string; name?: string; admin?: boolean; csrfToken?: string }) {
  const path = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function close(event: PointerEvent) { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false; }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape' && menu.current?.open) { menu.current.open = false; menu.current.querySelector('summary')?.focus(); } }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, []);
  const links = [{ href: '/', label: '个人榜' }, { href: '/team-leaderboard', label: '团队榜' }, ...(userId ? [{ href: `/members/${userId}`, label: '我的积分' }, { href: '/teams', label: '我的队伍' }] : [])];
  function active(href: string) { return href === '/teams' ? path.startsWith('/teams') : path === href; }
  return <>
    <nav className="member-nav" aria-label="主导航">{links.map(link => <Link key={link.href} href={link.href} aria-current={active(link.href) ? 'page' : undefined}>{link.label}</Link>)}</nav>
    {userId ? <details ref={menu} className="account-menu" key={path}><summary aria-label="账户菜单"><span className="avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span><span className="account-name">{name}</span><span aria-hidden="true">⌄</span></summary><div className="account-popover"><Link href="/profile" aria-current={path === '/profile' ? 'page' : undefined}>资料与账号</Link>{admin && <><Link href="/admin/collection">采集管理</Link><Link href="/admin/connections">平台连接</Link><Link href="/admin/scoring">赋分设置</Link><Link href="/admin/site">站点设置</Link></>}<LogoutButton csrfToken={csrfToken} /></div></details> : <Link className="button primary login-link" href="/login">登录</Link>}
  </>;
}
