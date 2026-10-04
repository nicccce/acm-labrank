import Link from 'next/link';
import { AuthForm } from './auth-form';
import { MemphisMark } from './page-heading';
import { SiteFooter } from './site-footer';

export function AuthShell({ mode, loginText }: { mode: 'login' | 'register'; loginText: string }) {
  const login = mode === 'login';
  return <div className="auth-layout"><main className="auth-page"><div className="auth-card"><aside className="auth-art"><MemphisMark />{loginText && <div className="auth-custom-text">{loginText}</div>}</aside><section className="auth-form-panel"><h1>{login ? '欢迎回来' : '加入实验室'}</h1><AuthForm mode={mode} /><p className="auth-switch">{login ? '还没有账号？' : '已有账号？'}<Link href={login ? '/register' : '/login'}>{login ? '注册' : '登录'} ↗</Link></p><Link className="auth-back" href="/">返回榜单</Link></section></div></main><SiteFooter compact /></div>;
}
