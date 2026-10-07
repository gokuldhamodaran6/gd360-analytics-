import type { Measure } from "./geometry";
import type { ValueScale } from "./scale";

// 2026-10-07 (chart-types round): the legend of a classed colour scale -
// a row of touching swatches (2 px of surface between them) with the class
// BREAKS written under their boundaries in real, formatted numbers:
//
//     ▇▇▇▇ ▇▇▇▇ ▇▇▇▇ ▇▇▇▇ ▇▇▇▇
//     1    10   50   250  1K   48.6K
//
// Labels are measured: when two would touch, every other interior break
// is dropped; when even that does not fit, only the ends stay. Shared by
// the map, the heatmap and the pivot table's shading.

export type ScaleLegendLayout = {
  width: number;
  height: number;
  swatches: { x: number; w: number; color: string; lo: number; hi: number }[];
  labels: { x: number; text: string; anchor: "start" | "middle" | "end" }[];
};

export const SCALE_SWATCH_H = 8;
const LABEL_SIZE = 11;
const GAP = 2;

export function layoutScaleLegend(scale: ValueScale, format: (v: number) => string, maxWidth: number, measure: Measure): ScaleLegendLayout {
  const k = scale.classes.length;
  if (!k) return { width: 0, height: 0, swatches: [], labels: [] };
  const bounds = [scale.min, ...scale.breaks, scale.max];
  const texts = bounds.map((v) => format(v));
  if (k === 1) {
    const w = 28;
    const text = scale.min === scale.max ? texts[0] : `${texts[0]} – ${texts[texts.length - 1]}`;
    return { width: Math.min(maxWidth, w + 8 + measure(text, LABEL_SIZE)), height: 14, swatches: [{ x: 0, w, color: scale.classes[0].color, lo: scale.min, hi: scale.max }], labels: [{ x: w + 8, text, anchor: "start" }] };
  }
  // Swatches as wide as a label under EVERY break needs (an end label and
  // the middle-anchored one beside it: 1.5 label widths and a gap), up to
  // 64 px, down to 18.
  const widest = Math.max(...texts.map((t) => measure(t, LABEL_SIZE)));
  const sw = Math.max(18, Math.min(64, Math.min((maxWidth - GAP * (k - 1)) / k, widest * 1.5 + 8)));
  const width = sw * k + GAP * (k - 1);
  const swatches = scale.classes.map((c, i) => ({ x: i * (sw + GAP), w: sw, color: c.color, lo: c.lo, hi: c.hi }));
  const at = (i: number) => (i === 0 ? 0 : i === k ? width : i * (sw + GAP) - GAP / 2);
  const all = bounds.map((_, i) => ({ i, x: at(i), text: texts[i], anchor: (i === 0 ? "start" : i === k ? "end" : "middle") as "start" | "middle" | "end" }));
  const span = (l: { x: number; text: string; anchor: string }) => {
    const w = measure(l.text, LABEL_SIZE);
    const x0 = l.anchor === "start" ? l.x : l.anchor === "end" ? l.x - w : l.x - w / 2;
    return [x0, x0 + w];
  };
  const fitsAll = (ls: typeof all) => ls.every((l, j) => j === 0 || span(l)[0] - span(ls[j - 1])[1] >= 6);
  let labels = all;
  if (!fitsAll(labels)) labels = all.filter((l) => l.i === 0 || l.i === k || l.i % 2 === 0);
  if (!fitsAll(labels)) labels = all.filter((l) => l.i === 0 || l.i === k);
  return { width, height: SCALE_SWATCH_H + 4 + 12, swatches, labels: labels.map(({ x, text, anchor }) => ({ x, text, anchor })) };
}
