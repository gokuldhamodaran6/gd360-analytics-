// R54: small icon set for Automate data (stroke icons, inherit colour).
const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const I = {
  up: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>,
  check: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>,
  x: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>,
  play: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M7 5v14l12-7z" /></svg>,
  flow: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="12" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M8.5 6H12a3 3 0 0 1 3 3v.5M8.5 18H12a3 3 0 0 0 3-3v-.5" /></svg>,
  db: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg>,
  warn: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M12 3 2 20h20L12 3zM12 10v4M12 17h.01" /></svg>,
  clock: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  undo: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>,
  upload: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14" /></svg>,
  copy: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></svg>,
  plus: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  pause: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M9 5v14M15 5v14" /></svg>,
  open: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>,
  arrow: <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>,
};

/** The GD360 ring-and-dot mark used for GD360's messages. */
export function Mark({ className = "fl-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="rgb(var(--color-primary))" />
      <path d="M13.55 6.2 A6 6 0 1 0 17.8 10.45" fill="none" stroke="rgb(var(--color-on-primary))" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="16.6" cy="7.4" r="1.7" fill="rgb(var(--color-on-primary))" />
    </svg>
  );
}
