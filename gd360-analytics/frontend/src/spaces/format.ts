// 2026-10-09 (round 15): compact number formatting for the Space page's
// tables and chart (412.6k, 3.84M, $42.3k, 3.2%, 3.6x). KPI tiles use the
// backend's own `display` strings; these are for table cells and axes.

const DASH = "—";

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function body(a: number): string {
  if (a >= 1e9) return `${(a / 1e9).toFixed(a < 1e10 ? 2 : 1)}B`;
  if (a >= 1e6) return `${(a / 1e6).toFixed(a < 1e7 ? 2 : 1)}M`;
  if (a >= 1e4) return `${(a / 1e3).toFixed(1)}k`;
  if (a >= 100) return Math.round(a).toLocaleString("en-US");
  if (a === 0) return "0";
  return a.toLocaleString("en-US", { maximumFractionDigits: a < 1 ? 2 : 1 });
}

/** 412.6k, 3.84M, 9,800 */
export function compact(v: number | null | undefined): string {
  if (!finite(v)) return DASH;
  return `${v < 0 ? "−" : ""}${body(Math.abs(v))}`;
}

/** $42.3k, $980, $12.40 */
export function money(v: number | null | undefined, symbol = "$"): string {
  if (!finite(v)) return DASH;
  const a = Math.abs(v);
  const b = a >= 100 ? body(a) : a.toFixed(2);
  return `${v < 0 ? "−" : ""}${symbol}${b}`;
}

/** A value that is already a percentage: 3.2% */
export function pct(v: number | null | undefined, digits = 1): string {
  if (!finite(v)) return DASH;
  return `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}%`;
}

/** A signed percentage change: +2.9%, −1.2% */
export function signedPct(v: number | null | undefined, digits = 1): string {
  if (!finite(v)) return DASH;
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return `${s}%`;
  return `${v < 0 ? "−" : "+"}${s}%`;
}

/** Return on ad spend: 3.6× */
export function times(v: number | null | undefined): string {
  if (!finite(v)) return DASH;
  return `${v.toFixed(1)}×`;
}

/** Average search position: 4.8 */
export function position(v: number | null | undefined): string {
  if (!finite(v)) return DASH;
  return v.toFixed(1);
}

/** "8 Sep" from an ISO date (no time zone shift for date-only strings). */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Evenly spaced, round axis ticks from 0 to just above `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return ticks;
}
