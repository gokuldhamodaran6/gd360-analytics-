// 2026-10-07 (dashboard polish round): the measuring half of the native
// chart renderer - text widths, ellipsis, round axis ticks, period labels.
// Pure functions; nothing here touches React.

// ---- text ---------------------------------------------------------------

export type Measure = (text: string, size?: number, weight?: number) => number;

let ctx: CanvasRenderingContext2D | null | undefined;
const widthCache = new Map<string, number>();

function canvasContext(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  ctx = null;
  if (typeof document === "undefined" || typeof window === "undefined") return ctx;
  // jsdom has a <canvas> with no 2d context (and says so on the console).
  const ua = `${window.navigator?.userAgent || ""} ${typeof navigator !== "undefined" ? navigator.userAgent || "" : ""}`;
  if (/jsdom|node\.js/i.test(ua)) return ctx;
  try {
    ctx = document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  return ctx;
}

// Average advance of a UI sans at 1 px, by character class - the estimate
// used where no canvas exists (server render, tests). Slightly generous so
// a label that "fits" on paper fits on screen.
function estimate(text: string, size: number, weight: number): number {
  let w = 0;
  for (const ch of text) {
    if (ch === " " || ch === "." || ch === "," || ch === ":" || ch === "'" || ch === "i" || ch === "l" || ch === "|" || ch === "!") w += 0.3;
    else if (/[0-9]/.test(ch)) w += 0.6;
    else if (/[MW%@]/.test(ch)) w += 0.9;
    else if (/[A-Z]/.test(ch)) w += 0.68;
    else w += 0.56;
  }
  return w * size * (weight >= 600 ? 1.05 : 1);
}

/** A text-width function bound to a font family (the chart's own, read off
 *  the element it is drawn in). */
export function makeMeasure(fontFamily = "system-ui, sans-serif"): Measure {
  return (text, size = 11, weight = 400) => {
    if (!text) return 0;
    const key = `${weight}|${size}|${fontFamily}|${text}`;
    const hit = widthCache.get(key);
    if (hit !== undefined) return hit;
    const c = canvasContext();
    let w: number;
    if (c) {
      c.font = `${weight} ${size}px ${fontFamily}`;
      w = c.measureText(text).width;
    } else {
      w = estimate(text, size, weight);
    }
    if (widthCache.size > 4000) widthCache.clear();
    widthCache.set(key, w);
    return w;
  };
}

/** Called when a web font finishes loading: every cached width is stale. */
export function clearMeasureCache() {
  widthCache.clear();
}

/** `text` cut to `maxWidth` with an ellipsis ("Offline TA/T…"). `cut` says
 *  whether anything was dropped (the caller then adds the full text as a
 *  tooltip). */
export function fitText(text: string, maxWidth: number, measure: Measure, size = 11, weight = 400): { text: string; cut: boolean; width: number } {
  const full = measure(text, size, weight);
  if (full <= maxWidth) return { text, cut: false, width: full };
  const chars = Array.from(text);
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${chars.slice(0, mid).join("").trimEnd()}…`, size, weight) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  const out = lo > 0 ? `${chars.slice(0, lo).join("").trimEnd()}…` : "…";
  return { text: out, cut: true, width: measure(out, size, weight) };
}

// ---- value axis ---------------------------------------------------------

/** Round tick values covering [min, max]: steps of 1, 2, 2.5 or 5 x 10^k,
 *  about `count` of them. The first and last tick enclose the data. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    if (min === 0) return [0, 1];
    const pad = Math.abs(min) * 0.1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(min / step + 1e-9) * step;
  const end = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step * 1e-6; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks.length >= 2 ? ticks : [start, start + step];
}

/** The value domain of a panel. Bars always start at zero; a line sits
 *  tight to its data unless zero is close by anyway. */
export function valueDomain(values: number[], fromZero: boolean): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return [0, 1];
  let lo = Math.min(...finite), hi = Math.max(...finite);
  if (fromZero) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  } else if (lo >= 0 && lo <= hi * 0.4) {
    lo = 0;
  } else if (hi <= 0 && hi >= lo * 0.4) {
    hi = 0;
  }
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else if (lo > 0) lo = 0;
    else hi = 0;
  }
  return [lo, hi];
}

// ---- time axis ----------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type DateParts = { y: number; m: number; d: number };

/** "2015-07-01", "2015-07-01T00:00:00Z", "2015-07" -> parts, read as
 *  written (a period bucket is a calendar label, never shifted by the
 *  viewer's time zone). */
export function parseDateParts(v: unknown): DateParts | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return { y: v.getUTCFullYear(), m: v.getUTCMonth(), d: v.getUTCDate() };
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ].*)?$/.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = m[3] ? Number(m[3]) : 1;
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

export type Grain = "day" | "week" | "month" | "quarter" | "year";

export function normalizeGrain(g: string | null | undefined): Grain {
  return g === "day" || g === "week" || g === "quarter" || g === "year" ? g : "month";
}

/** The axis label of one period. `withYear` is set on the first tick and
 *  wherever the year turns, so "Oct 2014 · Jan 2015 · Apr · Jul" reads
 *  without a year on every tick. */
export function periodTick(p: DateParts, grain: Grain, withYear: boolean): string {
  if (grain === "year") return String(p.y);
  if (grain === "quarter") return withYear ? `Q${Math.floor(p.m / 3) + 1} ${p.y}` : `Q${Math.floor(p.m / 3) + 1}`;
  if (grain === "month") return withYear ? `${MONTHS[p.m]} ${p.y}` : MONTHS[p.m];
  return withYear ? `${MONTHS[p.m]} ${p.d}, ${p.y}` : `${MONTHS[p.m]} ${p.d}`;
}

/** The same period spelled out (tooltip title, screen readers). */
export function periodLabel(p: DateParts, grain: Grain): string {
  if (grain === "year") return String(p.y);
  if (grain === "quarter") return `Q${Math.floor(p.m / 3) + 1} ${p.y}`;
  if (grain === "month") return `${MONTHS_LONG[p.m]} ${p.y}`;
  if (grain === "week") return `Week of ${MONTHS[p.m]} ${p.d}, ${p.y}`;
  return `${MONTHS[p.m]} ${p.d}, ${p.y}`;
}

const TIME_STEPS: Record<Grain, number[]> = {
  day: [1, 2, 7, 14, 28, 56, 91, 182, 365],
  week: [1, 2, 4, 8, 13, 26, 52],
  month: [1, 2, 3, 6, 12, 24, 60, 120],
  quarter: [1, 2, 4, 8, 20, 40],
  year: [1, 2, 5, 10, 20, 50, 100],
};

/** Is period `p` a tick at this step? Ticks land on calendar boundaries
 *  (every 3rd month = Jan / Apr / Jul / Oct), not on "every 3rd point from
 *  wherever the data happens to start". */
function onStep(p: DateParts, index: number, grain: Grain, step: number): boolean {
  if (step <= 1) return true;
  if (grain === "month") return step >= 12 ? p.m === 0 && p.y % (step / 12) === 0 : p.m % step === 0;
  if (grain === "quarter") return step >= 4 ? p.m < 3 && p.y % (step / 4) === 0 : Math.floor(p.m / 3) % step === 0;
  if (grain === "year") return p.y % step === 0;
  return index % step === 0;
}

export type AxisTick = { index: number; x: number; text: string; full: string; cut: boolean; anchor: "start" | "middle" | "end" };

/** Which periods get an x tick, so that no two labels touch and none
 *  leaves [left, right]. */
export function timeTicks(parts: DateParts[], xs: number[], grain: Grain, measure: Measure, left: number, right: number, size = 11): AxisTick[] {
  const n = parts.length;
  if (!n) return [];
  const gap = 14;
  const spacing = n > 1 ? Math.abs(xs[n - 1] - xs[0]) / (n - 1) : right - left;
  const widest = Math.max(...parts.map((p) => measure(periodTick(p, grain, true), size)));
  const steps = TIME_STEPS[grain];
  let step = steps[steps.length - 1];
  for (const s of steps) {
    if (s * spacing >= widest + gap) { step = s; break; }
  }
  const build = (s: number): AxisTick[] => {
    const out: AxisTick[] = [];
    let lastYear: number | null = null;
    let lastEnd = -Infinity;
    for (let i = 0; i < n; i++) {
      if (!onStep(parts[i], i, grain, s)) continue;
      const withYear = grain === "year" || lastYear !== parts[i].y;
      const text = periodTick(parts[i], grain, withYear);
      const w = measure(text, size);
      let x0 = xs[i] - w / 2;
      let anchor: AxisTick["anchor"] = "middle";
      let x = xs[i];
      if (x0 < left) { x0 = left; x = left; anchor = "start"; }
      else if (x0 + w > right) { x0 = right - w; x = right; anchor = "end"; }
      if (x0 < lastEnd + gap) continue;
      lastEnd = x0 + w;
      lastYear = parts[i].y;
      out.push({ index: i, x, text, full: periodLabel(parts[i], grain), cut: false, anchor });
    }
    return out;
  };
  let ticks = build(step);
  // A short series that starts off the calendar boundary (Oct .. Dec at a
  // 6-month step) could end up with no tick at all: label the ends.
  if (ticks.length < 2 && n >= 2) ticks = build(1).filter((_t, i, all) => i === 0 || i === all.length - 1);
  return ticks;
}

/** Category ticks for a band axis: every label when it fits (cut with an
 *  ellipsis to its band), every k-th when the bands are too thin to hold
 *  even a short one. */
export function categoryTicks(labels: string[], xs: number[], band: number, measure: Measure, left: number, right: number, size = 11): AxisTick[] {
  const n = labels.length;
  if (!n) return [];
  const minLabel = 34;
  const step = band >= minLabel ? 1 : Math.max(1, Math.ceil(minLabel / Math.max(1, band)));
  const room = Math.max(minLabel, band * step) - 8;
  const out: AxisTick[] = [];
  let lastEnd = -Infinity;
  for (let i = 0; i < n; i += step) {
    const fit = fitText(labels[i], room, measure, size);
    let x = xs[i];
    let x0 = x - fit.width / 2;
    let anchor: AxisTick["anchor"] = "middle";
    if (x0 < left) { x0 = left; x = left; anchor = "start"; }
    else if (x0 + fit.width > right) { x0 = right - fit.width; x = right; anchor = "end"; }
    if (x0 < lastEnd + 6) continue;
    lastEnd = x0 + fit.width;
    out.push({ index: i, x, text: fit.text, full: labels[i], cut: fit.cut, anchor });
  }
  return out;
}

/** Value ticks thinned until their labels have air between them along a
 *  horizontal axis of `length` px ("0 10M20M" never happens). */
export function fitValueTicks(min: number, max: number, length: number, label: (v: number) => string, measure: Measure, size = 11): number[] {
  for (const count of [5, 4, 3, 2]) {
    const ticks = niceTicks(min, max, count);
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const px = (v: number) => ((v - lo) / (hi - lo || 1)) * length;
    let ok = true;
    for (let i = 1; i < ticks.length && ok; i++) {
      const need = measure(label(ticks[i - 1]), size) / 2 + measure(label(ticks[i]), size) / 2 + 12;
      if (px(ticks[i]) - px(ticks[i - 1]) < need) ok = false;
    }
    if (ok) return ticks;
  }
  const ticks = niceTicks(min, max, 2);
  return [ticks[0], ticks[ticks.length - 1]];
}

/** A rectangle with only its data end rounded (4 px), square at the
 *  baseline. `end` is the side the value grows towards. */
export function barPath(x: number, y: number, w: number, h: number, end: "top" | "bottom" | "left" | "right", radius = 4): string {
  if (w <= 0 || h <= 0) return "";
  const r = Math.max(0, Math.min(radius, (end === "top" || end === "bottom" ? w : h) / 2, end === "top" || end === "bottom" ? h : w));
  const f = (n: number) => Number(n.toFixed(2));
  const x1 = x + w, y1 = y + h;
  if (end === "top") return `M${f(x)} ${f(y1)}V${f(y + r)}Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}H${f(x1 - r)}Q${f(x1)} ${f(y)} ${f(x1)} ${f(y + r)}V${f(y1)}Z`;
  if (end === "bottom") return `M${f(x)} ${f(y)}V${f(y1 - r)}Q${f(x)} ${f(y1)} ${f(x + r)} ${f(y1)}H${f(x1 - r)}Q${f(x1)} ${f(y1)} ${f(x1)} ${f(y1 - r)}V${f(y)}Z`;
  if (end === "right") return `M${f(x)} ${f(y)}H${f(x1 - r)}Q${f(x1)} ${f(y)} ${f(x1)} ${f(y + r)}V${f(y1 - r)}Q${f(x1)} ${f(y1)} ${f(x1 - r)} ${f(y1)}H${f(x)}Z`;
  return `M${f(x1)} ${f(y)}H${f(x + r)}Q${f(x)} ${f(y)} ${f(x)} ${f(y + r)}V${f(y1 - r)}Q${f(x)} ${f(y1)} ${f(x + r)} ${f(y1)}H${f(x1)}Z`;
}
