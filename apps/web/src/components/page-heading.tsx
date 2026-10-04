export function MemphisMark() {
  return <svg className="memphis-mark" viewBox="0 0 320 152" fill="none" aria-hidden="true">
    <defs><pattern id="memphis-dots" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="currentColor" /></pattern></defs>
    <path d="M210 19h67v67h-67z" fill="url(#memphis-dots)" />
    <path d="M66 106V72a46 46 0 0 1 92 0v34h-29V88H95v18H66Z M105 62a7 7 0 0 1 14 0v8h-14v-8Z" fill="var(--coral)" fillRule="evenodd" transform="rotate(-13 112 72)" />
    <path d="M220 22a34 34 0 1 0 0 48l-11-11a18.4 18.4 0 1 1 0-26l11-11Z" fill="var(--yellow)" stroke="currentColor" strokeWidth="1.5" transform="rotate(12 196 46)" />
    <path d="m228 115 10-42 23 28 23-28 10 42" stroke="var(--blue)" strokeWidth="13" strokeLinejoin="miter" />
    <path d="m44 32 7 9m-19-2 11 4m-6 11 9-5M97 129l75-12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="194" cy="106" r="4" fill="var(--coral)" />
  </svg>;
}
export function PageHeading({ title }: { title: string }) {
  return <div className="page-heading"><div><p className="eyebrow">ACM / LAB RANK</p><h1>{title}<span className="title-dot" aria-hidden="true">.</span></h1></div><MemphisMark /></div>;
}
