// 2026-10-07 (chart-types round): value -> colour CLASS, for the map, the
// heatmap and the pivot table's shading. Pure functions; every colour they
// hand back is one the caller took from the ChartTheme (theme.sequential()
// / theme.diverging() - 7 steps, index 0 = lowest / strongest negative).
//
// A value scale here is always CLASSED (5-7 steps with the breaks written
// in the legend), never a continuous gradient: a reader can match a fill
// to a legend swatch, and cannot match it to a point on a gradient.
//
// Which classes?
//   equal intervals   the default: breaks at round numbers a reader can
//                     hold in their head (0 / 2,000 / 4,000 ...).
//   quantiles         when the values are SKEWED - when equal intervals
//                     would put more than 60% of the marks in the lowest
//                     class (bookings by country: Portugal 48,590, the
//                     median country 12 - equal steps of 8,000 would paint
//                     170 countries one colour and Portugal another).
//                     Quantile classes hold the same number of marks each,
//                     so the map shows the order of the long tail; the
//                     breaks are rounded to two significant figures and
//                     the legend says "equal counts per class".
//   diverging         when the values run both sides of zero (a change, a
//                     delta): classes symmetric around 0, the neutral step
//                     of the diverging ramp across zero.

export type ScaleMethod = "equal" | "quantile" | "diverging" | "single";

export type ValueClass = { lo: number; hi: number; color: string; index: number };

export type ValueScale = {
  method: ScaleMethod;
  classes: ValueClass[];
  // Interior class boundaries (classes.length - 1 of them), ascending.
  breaks: number[];
  min: number;
  max: number;
  // The class of a value (null for a non-number).
  classOf: (v: unknown) => ValueClass | null;
  colorOf: (v: unknown) => string | null;
  // Said under the legend when the method needs explaining.
  note: string | null;
};

function finite(values: unknown[]): number[] {
  const out: number[] = [];
  for (const v of values) if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  return out;
}

/** v rounded to `digits` significant figures. */
export function roundSig(v: number, digits = 2): number {
  if (v === 0 || !Number.isFinite(v)) return v;
  const mag = Math.pow(10, digits - 1 - Math.floor(Math.log10(Math.abs(v))));
  return Math.round(v * mag) / mag;
}

function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
}

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** k indexes into a 7-step ramp, spread from its first to its last step. */
export function rampSteps(k: number, rampLength = 7): number[] {
  if (k <= 1) return [Math.min(rampLength - 1, 3)];
  return Array.from({ length: k }, (_, i) => Math.round((i * (rampLength - 1)) / (k - 1)));
}

/** How many classes a set of n marks reads well with (5-7). */
export function classCount(n: number): number {
  return n >= 60 ? 7 : n >= 25 ? 6 : 5;
}

function build(method: ScaleMethod, breaks: number[], min: number, max: number, colors: string[], note: string | null): ValueScale {
  const classes: ValueClass[] = colors.map((color, i) => ({ lo: i === 0 ? min : breaks[i - 1], hi: i === colors.length - 1 ? max : breaks[i], color, index: i }));
  const classOf = (v: unknown): ValueClass | null => {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    let i = 0;
    while (i < breaks.length && v >= breaks[i]) i++;
    return classes[Math.min(i, classes.length - 1)];
  };
  return { method, classes, breaks, min, max, classOf, colorOf: (v) => classOf(v)?.color ?? null, note };
}

export type ScaleOptions = {
  // 7-step ramps from the theme.
  sequential: readonly string[];
  diverging: readonly string[];
  // Force a method ("auto" decides as described at the top).
  method?: "auto" | "equal" | "quantile";
  // Class count override (2-7).
  classes?: number;
  // What the marks are, for the quantile note ("countries", "cells").
  marks?: string;
};

/** The classed colour scale of a set of values. */
export function valueScale(values: unknown[], opts: ScaleOptions): ValueScale {
  const nums = finite(values);
  const seq = opts.sequential, div = opts.diverging;
  if (!nums.length) return build("single", [], 0, 0, [seq[3]], null);
  const sorted = [...nums].sort((a, b) => a - b);
  const min = sorted[0], max = sorted[sorted.length - 1];
  const distinct = Array.from(new Set(sorted));
  if (distinct.length === 1) return build("single", [], min, max, [seq[4]], null);

  // Both sides of zero: a diverging scale, symmetric around 0.
  if (min < 0 && max > 0) {
    const reach = Math.max(Math.abs(min), Math.abs(max));
    // Three classes a side and a neutral band across zero.
    const absSorted = sorted.map((v) => Math.abs(v)).sort((a, b) => a - b);
    const equalTop = reach / 3.5;
    const skewed = absSorted.filter((v) => v < equalTop * 1.5).length / absSorted.length > 0.75;
    let b1: number, b2: number, b3: number;
    if (skewed) {
      b1 = roundSig(quantile(absSorted, 0.25), 2);
      b2 = roundSig(quantile(absSorted, 0.6), 2);
      b3 = roundSig(quantile(absSorted, 0.88), 2);
    } else {
      const step = niceStep(reach / 3.5);
      b1 = step * 0.5; b2 = step * 1.5; b3 = step * 2.5;
    }
    if (!(b1 > 0)) b1 = reach / 7;
    if (!(b2 > b1)) b2 = b1 + (reach - b1) / 3;
    if (!(b3 > b2)) b3 = b2 + (reach - b2) / 2;
    const breaks = [-b3, -b2, -b1, b1, b2, b3];
    return build("diverging", breaks, min, max, [...div], skewed ? `Classes follow the spread of the ${opts.marks || "values"}: most are close to zero.` : null);
  }

  let k = Math.max(2, Math.min(7, opts.classes ?? classCount(nums.length)));
  if (distinct.length <= k) {
    // Fewer different values than classes: one class per value.
    const breaks = distinct.slice(1).map((v, i) => (distinct[i] + v) / 2);
    return build("equal", breaks, min, max, rampSteps(distinct.length).map((i) => seq[i]), null);
  }

  // Equal intervals at round numbers, from a round floor.
  const step = niceStep((max - min) / k);
  const floor = Math.floor(min / step + 1e-9) * step;
  let equalBreaks: number[] = [];
  for (let v = floor + step; v < max - step * 1e-9; v += step) equalBreaks.push(Number(v.toPrecision(12)));
  if (equalBreaks.length > k - 1) equalBreaks = equalBreaks.slice(0, k - 1);
  const lowestShare = equalBreaks.length ? nums.filter((v) => v < equalBreaks[0]).length / nums.length : 1;
  const wantQuantile = opts.method === "quantile" || (opts.method !== "equal" && lowestShare > 0.6);

  if (!wantQuantile && equalBreaks.length >= 1) {
    return build("equal", equalBreaks, min, max, rampSteps(equalBreaks.length + 1).map((i) => seq[i]), null);
  }

  // Quantiles: the same number of marks in each class, breaks rounded to
  // two significant figures and kept strictly increasing.
  const breaks: number[] = [];
  for (let i = 1; i < k; i++) {
    let b = roundSig(quantile(sorted, i / k), 2);
    // Whole-number data reads best with whole-number breaks.
    if (nums.every((v) => Number.isInteger(v))) b = Math.max(1, Math.round(b));
    if (b <= min || b > max) continue;
    if (breaks.length && b <= breaks[breaks.length - 1]) continue;
    breaks.push(b);
  }
  if (!breaks.length) return build("equal", [(min + max) / 2], min, max, [seq[1], seq[5]], null);
  k = breaks.length + 1;
  return build("quantile", breaks, min, max, rampSteps(k).map((i) => seq[i]), `Each colour holds a similar number of ${opts.marks || "values"}: the values are too skewed for equal steps.`);
}

// ---- text on a fill ----------------------------------------------------------

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a "#rrggbb" or "rgb(r, g, b)" colour; null
 *  when it cannot be read (a CSS variable). */
export function luminance(color: string): number | null {
  let r: number, g: number, b: number;
  const hex = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  if (hex) {
    r = parseInt(hex[1], 16); g = parseInt(hex[2], 16); b = parseInt(hex[3], 16);
  } else {
    const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(color.trim());
    if (!m) return null;
    r = Number(m[1]); g = Number(m[2]); b = Number(m[3]);
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** True when light text reads better than dark text on this fill. */
export function needsLightText(fill: string): boolean {
  const l = luminance(fill);
  if (l === null) return false;
  // Contrast with white vs with near-black (#18181b ~ 0.009).
  return 1.05 / (l + 0.05) > (l + 0.05) / 0.059;
}
