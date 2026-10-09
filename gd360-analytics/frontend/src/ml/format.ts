// 2026-10-09 (round 15): number formats for ML Studio's generic results -
// one place so tables, bars, charts and heatmaps read the same way.
import type { ValueFormat } from "../api/mlStudio";

function compact(a: number, v: number): string | null {
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return null;
}

/** A plain number: 12.3k, 1,234, 12.34, 0.0123. */
export function fmtNumber(v: number): string {
  const a = Math.abs(v);
  const c = compact(a, v);
  if (c) return c;
  if (Number.isInteger(v)) return v.toLocaleString();
  if (a >= 100) return Math.round(v).toLocaleString();
  if (a >= 1) return v.toFixed(2);
  if (a === 0) return "0";
  return Number(v.toPrecision(3)).toString();
}

/** Money with a $ and k / M for big amounts. */
export function fmtCurrency(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(1)}k`;
  if (a >= 100) return `${sign}$${Math.round(a).toLocaleString()}`;
  return Number.isInteger(a) ? `${sign}$${a}` : `${sign}$${a.toFixed(2)}`;
}

export function fmtValue(v: unknown, format: ValueFormat | string | undefined, opts: { pctDigits?: number } = {}): string {
  if (v === null || v === undefined || v === "") return "—";
  if (format === "text") return String(v);
  if (format === "date") {
    const s = String(v);
    return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s;
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  switch (format) {
    case "percent":
      return `${(n * 100).toFixed(opts.pctDigits ?? 1)}%`;
    case "integer":
      return Math.round(n).toLocaleString();
    case "currency":
      return fmtCurrency(n);
    default:
      return fmtNumber(n);
  }
}

export function isNumericFormat(format: string | undefined): boolean {
  return format === "number" || format === "integer" || format === "percent" || format === "currency";
}

/** Round axis ticks: about `count` steps between lo and hi on 1 / 2 / 5. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) {
    const d = Math.abs(lo) || 1;
    lo -= d * 0.5;
    hi += d * 0.5;
  }
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let t = start; t <= end + step * 0.5; t += step) out.push(Number(t.toPrecision(12)));
  return out;
}
