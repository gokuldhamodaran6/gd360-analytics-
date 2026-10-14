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

export type DateParts = { y: number; m: number; d: number; h?: number; mi?: number };

const MONTH_WORD: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function validParts(y: number, mo: number, d: number, h = 0, mi = 0): DateParts | null {
  if (!Number.isInteger(y) || y < 1000 || y > 9999 || mo < 0 || mo > 11 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h || mi ? { y, m: mo, d, h, mi } : { y, m: mo, d };
}

/** "2015-07-01", "2015-07-01T00:00:00Z", "2015-07" -> parts, read as
 *  written (a period bucket is a calendar label, never shifted by the
 *  viewer's time zone).
 *  2026-10-13 (R45): also "2025-03-04 14:00" (the hour is kept - intraday
 *  data no longer collapses to days), "2025/03/04", "Mar 2025" /
 *  "March 2025", "04 Mar 2025", and "DD/MM/YYYY" or "MM/DD/YYYY" when the
 *  value itself says which (a part above 12). An ambiguous "03/04/2025" is
 *  read the way `slashOrder` says (see slashOrderOf), month-first by default. */
export function parseDateParts(v: unknown, slashOrder: "dmy" | "mdy" = "mdy"): DateParts | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return validParts(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate(), v.getUTCHours(), v.getUTCMinutes());
  if (typeof v !== "string") return null;
  const t = v.trim();
  let m = /^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(t);
  if (m) return validParts(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1, m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T ](\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(t);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    const dmy = a > 12 ? true : b > 12 ? false : slashOrder === "dmy";
    return validParts(Number(m[3]), (dmy ? b : a) - 1, dmy ? a : b, m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0);
  }
  m = /^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(t);
  if (m && m[1].toLowerCase() in MONTH_WORD) return validParts(Number(m[2]), MONTH_WORD[m[1].toLowerCase()], 1);
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(t);
  if (m && m[2].toLowerCase() in MONTH_WORD) return validParts(Number(m[3]), MONTH_WORD[m[2].toLowerCase()], Number(m[1]));
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  if (m && m[1].toLowerCase() in MONTH_WORD) return validParts(Number(m[3]), MONTH_WORD[m[1].toLowerCase()], Number(m[2]));
  return null;
}

/** 2026-10-13 (R45): which way a column writes its slashed dates - "dmy"
 *  when any value has a first part above 12 (31/01/2025), else "mdy". */
export function slashOrderOf(values: unknown[]): "dmy" | "mdy" {
  for (const v of values) {
    if (typeof v !== "string") continue;
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{4}/.exec(v.trim());
    if (m && Number(m[1]) > 12) return "dmy";
  }
  return "mdy";
}

/** 2026-10-13 (R45): an Excel serial day number (45000 = 2023-03-15) as
 *  parts - only ever asked for a column whose role is a date. */
export function excelSerialParts(n: unknown): DateParts | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 20000 || n > 80000) return null;
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  return validParts(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
}

/** Milliseconds of a date's parts (UTC) - an order and a spacing. */
export function partsTime(p: DateParts): number {
  return Date.UTC(p.y, p.m, p.d, p.h || 0, p.mi || 0);
}

export type Grain = "hour" | "day" | "week" | "month" | "quarter" | "year";

export function normalizeGrain(g: string | null | undefined): Grain {
  return g === "hour" || g === "day" || g === "week" || g === "quarter" || g === "year" ? g : "month";
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The axis label of one period. `withYear` is set on the first tick and
 *  wherever the year turns, so "Oct 2014 · Jan 2015 · Apr · Jul" reads
 *  without a year on every tick. */
export function periodTick(p: DateParts, grain: Grain, withYear: boolean): string {
  if (grain === "year") return String(p.y);
  if (grain === "quarter") return withYear ? `Q${Math.floor(p.m / 3) + 1} ${p.y}` : `Q${Math.floor(p.m / 3) + 1}`;
  if (grain === "month") return withYear ? `${MONTHS[p.m]} ${p.y}` : MONTHS[p.m];
  if (grain === "hour") return (p.h || 0) === 0 || withYear ? `${MONTHS[p.m]} ${p.d} ${pad2(p.h || 0)}:00` : `${pad2(p.h || 0)}:00`;
  return withYear ? `${MONTHS[p.m]} ${p.d}, ${p.y}` : `${MONTHS[p.m]} ${p.d}`;
}

/** The same period spelled out (tooltip title, screen readers). */
export function periodLabel(p: DateParts, grain: Grain): string {
  if (grain === "year") return String(p.y);
  if (grain === "quarter") return `Q${Math.floor(p.m / 3) + 1} ${p.y}`;
  if (grain === "month") return `${MONTHS_LONG[p.m]} ${p.y}`;
  if (grain === "week") return `Week of ${MONTHS[p.m]} ${p.d}, ${p.y}`;
  if (grain === "hour") return `${MONTHS[p.m]} ${p.d}, ${p.y} ${pad2(p.h || 0)}:${pad2(p.mi || 0)}`;
  return `${MONTHS[p.m]} ${p.d}, ${p.y}`;
}

/** 2026-10-13 (R45): the period a date falls in, as one integer per grain
 *  (consecutive periods are consecutive integers) - the key that lets a
 *  time axis fill the periods the data skipped. Weeks count from `weekAnchor`
 *  (the first week's day number) so a Sunday-start series stays aligned. */
export function periodIndex(p: DateParts, grain: Grain, weekAnchor = 0): number {
  const day = Math.floor(Date.UTC(p.y, p.m, p.d) / 86400000);
  switch (grain) {
    case "year": return p.y;
    case "quarter": return p.y * 4 + Math.floor(p.m / 3);
    case "month": return p.y * 12 + p.m;
    case "week": return Math.floor((day - weekAnchor) / 7);
    case "hour": return day * 24 + (p.h || 0);
    default: return day;
  }
}

/** The first moment of period `index` (periodIndex's inverse). */
export function periodStart(index: number, grain: Grain, weekAnchor = 0): DateParts {
  const fromDay = (day: number, h = 0): DateParts => {
    const d = new Date(day * 86400000);
    return validParts(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h) || { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
  };
  switch (grain) {
    case "year": return { y: index, m: 0, d: 1 };
    case "quarter": return { y: Math.floor(index / 4), m: (((index % 4) + 4) % 4) * 3, d: 1 };
    case "month": return { y: Math.floor(index / 12), m: ((index % 12) + 12) % 12, d: 1 };
    case "week": return fromDay(index * 7 + weekAnchor);
    case "hour": return fromDay(Math.floor(index / 24), ((index % 24) + 24) % 24);
    default: return fromDay(index);
  }
}

/** A period's ISO key ("2025-03-01", "2025-03-01T14:00:00"). */
export function partsIso(p: DateParts, withTime = false): string {
  const day = `${p.y}-${pad2(p.m + 1)}-${pad2(p.d)}`;
  return withTime ? `${day}T${pad2(p.h || 0)}:${pad2(p.mi || 0)}:00` : day;
}

const TIME_STEPS: Record<Grain, number[]> = {
  hour: [1, 2, 3, 6, 12, 24, 48, 168],
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
  if (grain === "hour") return step >= 24 ? (p.h || 0) === 0 && index % (step / 24) === 0 : (p.h || 0) % step === 0;
  return index % step === 0;
}

// `rotate` (degrees, 2026-10-13 R45): a crowded category label drawn on a slant.
export type AxisTick = { index: number; x: number; text: string; full: string; cut: boolean; anchor: "start" | "middle" | "end"; rotate?: number };

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
      // An hourly axis names the day where the day turns (and on the first tick).
      const turn = grain === "hour" ? parts[i].y * 400 + parts[i].m * 32 + parts[i].d : parts[i].y;
      const withYear = grain === "year" || lastYear !== turn;
      const text = periodTick(parts[i], grain, withYear);
      const w = measure(text, size);
      let x0 = xs[i] - w / 2;
      let anchor: AxisTick["anchor"] = "middle";
      let x = xs[i];
      if (x0 < left) { x0 = left; x = left; anchor = "start"; }
      else if (x0 + w > right) { x0 = right - w; x = right; anchor = "end"; }
      if (x0 < lastEnd + gap) continue;
      lastEnd = x0 + w;
      lastYear = grain === "hour" ? parts[i].y * 400 + parts[i].m * 32 + parts[i].d : parts[i].y;
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

export const ROTATE_DEG = -35;
const SIN = Math.sin((Math.abs(ROTATE_DEG) * Math.PI) / 180), COS = Math.cos((Math.abs(ROTATE_DEG) * Math.PI) / 180);

/** 2026-10-13 (R45): category labels too long for their band are drawn on
 *  a -35 degree slant instead of being cut to "Offl…": each label gets up to
 *  `maxLen` px along its slant (cut with an ellipsis beyond that, full text
 *  kept for the tooltip), every k-th one when even slanted ones would
 *  touch. `height` is the vertical room the slanted labels need. */
export function rotatedCategoryTicks(labels: string[], xs: number[], band: number, measure: Measure, left: number, maxLen = 110, size = 11): { ticks: AxisTick[]; height: number } {
  const n = labels.length;
  if (!n) return { ticks: [], height: 0 };
  // Two slanted labels need about a line height / sin(35) between them.
  const need = (size * 1.3) / SIN;
  const step = band >= need ? 1 : Math.max(1, Math.ceil(need / Math.max(1, band)));
  const out: AxisTick[] = [];
  let widest = 0;
  for (let i = 0; i < n; i += step) {
    // The slant runs left from the tick: never past the chart's left edge.
    const room = Math.max(24, Math.min(maxLen, (xs[i] - left) / COS));
    const fit = fitText(labels[i], room, measure, size);
    widest = Math.max(widest, fit.width);
    out.push({ index: i, x: xs[i], text: fit.text, full: labels[i], cut: fit.cut, anchor: "end", rotate: ROTATE_DEG });
  }
  return { ticks: out, height: Math.ceil(widest * SIN + size * COS + 6) };
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
