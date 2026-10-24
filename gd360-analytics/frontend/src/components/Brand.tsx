// 2026-10-24 (R61, Euliv brand): the final Euliv logo (canvas "Euliv Logo", Strata option A "Forward").
// The symbol is the Euliv orb cut into three layers with the middle layer shifted right (data -> understanding -> answer,
// the data coming alive and moving forward), mint -> periwinkle on dark grounds and the deep pair on light ones.
// The wordmark is lowercase "euliv" in Geist SemiBold, outlined, with the orb as the i-dot.
import { useId } from "react";

type Tone = "auto" | "bright" | "deep" | "white" | "black";

function stops(tone: Tone): [string, string] {
  if (tone === "bright") return ["#43E5A0", "#9DBDFF"];
  if (tone === "deep") return ["#0E9F6B", "#5F7FE8"];
  if (tone === "white") return ["#FFFFFF", "#FFFFFF"];
  if (tone === "black") return ["#07090A", "#07090A"];
  return ["var(--eu-a, #43E5A0)", "var(--eu-b, #9DBDFF)"];   // follows the theme (index.css)
}

/** The Euliv symbol: the three-layer orb. */
export function EulivMark({ size = 32, tone = "auto", className, title }: { size?: number; tone?: Tone; className?: string; title?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [a, b] = stops(tone);
  const shine = tone !== "white" && tone !== "black";
  const layer = (clip: string, cx: number) => (
    <g style={{ clipPath: `url(#${id}${clip})` }}>
      <circle cx={cx} cy="60" r="46" fill={`url(#${id}g)`} />
      {shine && <circle cx={cx} cy="60" r="46" fill={`url(#${id}h)`} />}
    </g>
  );
  return (
    <svg className={className} width={size} height={size} viewBox="14 9.5 101 101" role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true} aria-label={title} data-eu-mark="">
      <defs>
        <linearGradient id={`${id}g`} x1="0.1" y1="0.05" x2="0.9" y2="1">
          <stop offset="0" style={{ stopColor: a }} />
          <stop offset="1" style={{ stopColor: b }} />
        </linearGradient>
        <radialGradient id={`${id}h`} cx="0.34" cy="0.28" r="0.5">
          <stop offset="0" style={{ stopColor: "#fff", stopOpacity: 0.5 }} />
          <stop offset="1" style={{ stopColor: "#fff", stopOpacity: 0 }} />
        </radialGradient>
        <clipPath id={`${id}a`}><rect x="-10" y="0" width="140" height="42" /></clipPath>
        <clipPath id={`${id}b`}><rect x="-10" y="48" width="140" height="24" /></clipPath>
        <clipPath id={`${id}c`}><rect x="-10" y="78" width="140" height="42" /></clipPath>
      </defs>
      {layer("a", 60)}
      {layer("b", 69)}
      {layer("c", 60)}
    </svg>
  );
}

/** Kept for the places that used the old mark: the Euliv symbol now. */
export function BrandMark({ size = 32, className, title }: { size?: number; radius?: number; className?: string; title?: string }) {
  return <EulivMark size={size} className={className} title={title} />;
}

const WORD = "M4.2 -26.5C4.2 -9.7 14.6 1.2 30.4 1.2C41.9 1.2 51.5 -5.1 54.6 -15.3L41.4 -16.3C39.5 -11.7 35.2 -9 30.4 -9C22.9 -9 18.3 -14.2 17.7 -23H55.4L55.3 -26.2C55.1 -45 44 -54.2 30.4 -54.2C14.6 -54.2 4.2 -43.3 4.2 -26.5ZM17.9 -31.6C18.9 -39.3 23.4 -44 30.4 -44C36 -44 41 -40.6 42 -31.6Z M111.3 0V-53H98.3V-23.1C98.3 -14.2 94.3 -9.3 87.5 -9.3C80.9 -9.3 78.6 -14.2 78.6 -23.1V-53H65.6V-18.9C65.6 -7 72 1.2 83.5 1.2C90.4 1.2 96.3 -1.5 99.2 -8.5L99.4 0Z M124.3 -71V-13.3C124.3 -4.9 129.7 0 137.6 0H145.1V-10.1H141C138.6 -10.1 137.3 -11.4 137.3 -13.9V-71Z M154.6 -53V0H167.6V-53Z M230.1 -53H216.6L202.9 -13.1L189.1 -53H175.7L195.3 0H210.5Z";

/** The "euliv" wordmark; `size` is its height in px. The letters take the text colour, the i-dot is the orb. */
export function Wordmark({ size = 18, tone = "auto", color }: { size?: number; tone?: Tone; color?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [a, b] = stops(tone);
  return (
    <svg width={(size * 227.9) / 73} height={size} viewBox="3.2 -72 227.9 73" style={{ overflow: "visible", display: "block" }}
      role="img" aria-label="Euliv" data-eu-word="">
      <defs>
        <linearGradient id={`${id}w`} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" style={{ stopColor: a }} />
          <stop offset="1" style={{ stopColor: b }} />
        </linearGradient>
      </defs>
      <path d={WORD} fill={color || "currentColor"} />
      <circle cx="161.1" cy="-68.7" r="10.38" fill={tone === "white" || tone === "black" ? (color || "currentColor") : `url(#${id}w)`} />
    </svg>
  );
}

/** Symbol + wordmark side by side (top bars, sign-in, the website). */
export function EulivLogo({ size = 28, tone = "auto", color }: { size?: number; tone?: Tone; color?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.32) }} data-eu-logo="">
      <EulivMark size={size} tone={tone} />
      <Wordmark size={Math.round(size * 0.62)} tone={tone} color={color} />
    </span>
  );
}
