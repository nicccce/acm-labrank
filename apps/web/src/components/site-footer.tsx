import { version } from '../../../../package.json';

export function SiteFooter({ headerText = '', loginText = '', compact = false }: { headerText?: string; loginText?: string; compact?: boolean }) {
  return <footer className={`site-footer${compact ? ' auth-footer' : ''}`}>
    <div className="footer-project">
      {headerText && <span>{headerText}</span>}
      <span>© 2026 nicccce · ACM LabRank · v{version}</span>
      {!compact && <span>用于汇总训练记录与积分，非各 OJ 官方排名。</span>}
    </div>
    {!compact && <span className="footer-shapes" aria-hidden="true">● ◒ ■</span>}
    <div className="footer-links">
      <div className="footer-resource-links">
        <a href="https://github.com/nicccce/acm-labrank" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
        <a href="https://github.com/nicccce/acm-labrank/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">Apache-2.0 ↗</a>
      </div>
      {loginText && <span className="footer-login-text">{loginText}</span>}
    </div>
  </footer>;
}
