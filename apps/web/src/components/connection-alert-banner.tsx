import Link from 'next/link';
import type { ConnectionAlert } from '@acm/core/contracts';

export function ConnectionAlertBanner({ items, className = '' }: { items: ConnectionAlert[]; className?: string }) {
  if (!items.length) return null;
  return <p role="alert" className={`rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 ${className}`}>
    {items.map(platform => platform.name).join('、')}未登录或登录已过期，相关平台采集已暂停。请管理员<Link className="ml-1 font-medium underline" href="/admin/connections">前往连接管理重新登录</Link>，完成登录核验后可继续采集。
  </p>;
}
