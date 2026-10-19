// 2026-10-19 (R55, brand v2): the GD360 mark - a Signal-green rounded square with a ring (the 360° view of a
// business) and a dot (the one thing to act on now) - and the wordmark (GD in Geist, 360 in Geist Mono, green).
export function BrandMark({ size = 32, radius = 7, className, title }: { size?: number; radius?: number; className?: string; title?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <rect width="24" height="24" rx={radius} fill="rgb(var(--color-primary))" />
      <path d="M13.55 6.2 A6 6 0 1 0 17.8 10.45" fill="none" stroke="rgb(var(--color-on-primary))" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="16.6" cy="7.4" r="1.7" fill="rgb(var(--color-on-primary))" />
    </svg>
  );
}

export function Wordmark({ size = 18 }: { size?: number }) {
  return (
    <span style={{ fontWeight: 600, letterSpacing: "-.02em", fontSize: size, lineHeight: 1 }}>
      GD<span style={{ fontFamily: "'Geist Mono', ui-monospace, monospace", fontWeight: 500, color: "rgb(var(--color-primary))" }}>360</span>
    </span>
  );
}
