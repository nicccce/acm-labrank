export function MemphisMark() {
  return <div className="memphis-mark" aria-hidden="true"><span className="mark-disc" /><span className="mark-stairs" /><span className="mark-ring" /><span className="mark-spark">✳</span><span className="mark-line" /></div>;
}
export function PageHeading({ title }: { title: string }) {
  return <div className="page-heading"><div><p className="eyebrow">ACM / LAB RANK</p><h1>{title}<span className="title-dot" aria-hidden="true">.</span></h1></div><MemphisMark /></div>;
}
