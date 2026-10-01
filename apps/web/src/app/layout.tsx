import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'ACM 实验室榜单', description: '实验室训练记录与榜单' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
