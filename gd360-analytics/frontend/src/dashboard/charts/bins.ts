// 2026-10-13 (R45): histogram bins computed in the browser, for a
// histogram whose result came back WITHOUT bins (an answer's rows, a file
// block): either raw values (one row per observation) or values with a
// count / weight beside them (one row per distinct value). The bars are
// drawn with y = how many fall in each bin - never one bar per distinct
// value with its count ignored (the old Plotly fallback did that).
//
// Bin width: Freedman-Diaconis (2 * IQR / n^(1/3)), rounded to a "nice"
// width (1, 2, 2.5, 5 x 10^k) and held to 5-20 bins; whole-number data
// gets whole-number widths.

export type BinPlan = { start: number; width: number; count: number; integer: boolean };
export type BinnedRow = { lo: number; hi: number; value: number };

function niceWidth(raw: number, integer: boolean): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let w = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  if (integer) w = Math.max(1, Math.round(w));
  return w;
}

/** The weighted quantile q (0-1) of sorted values. */
function quantile(sorted: { v: number; w: number }[], total: number, q: number): number {
  const target = q * total;
  let acc = 0;
  for (const p of sorted) {
    acc += p.w;
    if (acc >= target) return p.v;
  }
  return sorted[sorted.length - 1].v;
}

/** The bins for these values (weights default to 1 each). */
export function planBins(values: number[], weights?: number[] | null, minBins = 5, maxBins = 20): BinPlan | null {
  const pts = values
    .map((v, i) => ({ v, w: weights ? weights[i] : 1 }))
    .filter((p) => Number.isFinite(p.v) && Number.isFinite(p.w) && p.w > 0);
  if (!pts.length) return null;
  pts.sort((a, b) => a.v - b.v);
  const total = pts.reduce((s, p) => s + p.w, 0);
  const lo = pts[0].v, hi = pts[pts.length - 1].v;
  const integer = pts.every((p) => Number.isInteger(p.v));
  if (lo === hi) return { start: lo, width: 1, count: 1, integer };
  const iqr = quantile(pts, total, 0.75) - quantile(pts, total, 0.25);
  const fd = iqr > 0 ? (2 * iqr) / Math.cbrt(total) : (hi - lo) / Math.max(minBins, Math.min(maxBins, Math.ceil(Math.sqrt(total))));
  let width = niceWidth(Math.max(fd, (hi - lo) / maxBins), integer);
  const binsFor = (w: number) => Math.floor(hi / w) - Math.floor(lo / w) + 1;
  // At least `minBins` (narrower), at most `maxBins` (wider).
  for (let guard = 0; guard < 40 && binsFor(width) > maxBins; guard++) width = niceWidth(width * 1.5, integer);
  for (let guard = 0; guard < 40 && binsFor(width) < minBins; guard++) {
    const next = niceWidth(width / 2.2, integer);
    if (next >= width || binsFor(next) > maxBins) break;
    width = next;
  }
  const start = Math.floor(lo / width) * width;
  const count = Math.max(1, Math.floor((hi - start) / width) + 1);
  return { start: Number(start.toPrecision(12)), width, count, integer };
}

/** values (+ weights) counted into the plan's bins. */
export function binValues(plan: BinPlan, values: number[], weights?: number[] | null): BinnedRow[] {
  const rows: BinnedRow[] = Array.from({ length: plan.count }, (_, i) => ({
    lo: Number((plan.start + i * plan.width).toPrecision(12)),
    hi: Number((plan.start + (i + 1) * plan.width).toPrecision(12)),
    value: 0,
  }));
  values.forEach((v, i) => {
    const w = weights ? weights[i] : 1;
    if (!Number.isFinite(v) || !Number.isFinite(w) || w <= 0) return;
    const k = Math.min(plan.count - 1, Math.max(0, Math.floor((v - plan.start) / plan.width + 1e-9)));
    rows[k].value += w;
  });
  return rows;
}

/** "0–10 min": a bin's label ("0–9" for whole numbers in bins of 10). */
export function binLabel(lo: number, hi: number, integer: boolean, unit = ""): string {
  const f = (v: number) => (Number.isInteger(v) ? v.toLocaleString("en-US") : Number(v.toPrecision(6)).toLocaleString("en-US", { maximumFractionDigits: 6 }));
  const u = unit ? (unit === "%" ? "%" : ` ${unit}`) : "";
  // A count is discrete (0–9, 10–19); a measured quantity is an interval (0–10 min).
  const discrete = integer && !unit;
  if (discrete && hi - lo === 1) return `${f(lo)}`;
  return discrete ? `${f(lo)}–${f(hi - 1)}` : `${f(lo)}–${f(hi)}${u}`;
}
