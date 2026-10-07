import { columnFormat, formatValue, type ValueFormat } from "../format";
import { barPath, categoryTicks, fitText, fitValueTicks, niceTicks, timeTicks, valueDomain, type AxisTick, type DateParts, type Measure } from "./geometry";
import type { ChartKind, ChartModel, ChartPanel, LegendMark } from "./model";

// 2026-10-07 (dashboard polish round): ChartModel + the box it has ->
// every mark and label, in pixels. The rule this file exists for: a label
// is measured before it is placed. Room is reserved for the longest value
// label, axis ticks are thinned to what fits, a category name that is too
// long is cut with an ellipsis (and keeps its full text as a tooltip), and
// nothing is ever drawn outside the box or over another label.
//
// Marks (dataviz spec): bars at most 24 px thick with a 4 px rounded data
// end and a square baseline, a 2 px surface gap between touching bars and
// stacked segments, 2 px lines, >= 8 px markers with a 2 px surface ring,
// hairline solid grid.

export const TICK_SIZE = 11;
export const LABEL_SIZE = 11;
export const TITLE_SIZE = 12;
export const LEGEND_SIZE = 12;
const MAX_BAR = 24;
const GAP = 2;

export type Rect = { x: number; y: number; w: number; h: number };
export type TextMark = { x: number; y: number; text: string; anchor: "start" | "middle" | "end"; full?: string };
export type BarMark = { d: string; color: string; cat: number; series: number; box: Rect };
export type LineMark = { d: string; color: string; name?: string };
export type DotMark = { cx: number; cy: number; color: string; r: number; hollow?: boolean };
// 2026-10-07 (chart-types round): the forecast overlay of one panel.
export type BandMark = { d: string; color: string; level: "80" | "95" };
export type AnomalyDot = { cx: number; cy: number; category: number; series: number };

export type ScenePanel = {
  key: string;
  title: TextMark | null;
  plot: Rect;
  grid: { x1: number; y1: number; x2: number; y2: number }[];
  baseline: { x1: number; y1: number; x2: number; y2: number } | null;
  valueTicks: TextMark[];
  bars: BarMark[];
  areas: LineMark[];
  lines: LineMark[];
  dots: DotMark[];
  labels: TextMark[];
  // Per series, the pixel position of each category's value along the
  // value axis (null where there is none) - where the hover marker sits.
  points: (number | null)[][];
  // "full" | "compact" | null: how the direct labels were written.
  labelStyle: "full" | "compact" | null;
  // This panel's mark ("bar" | "line" | "area").
  kind: ChartKind;
  // Forecast: the interval bands (95% under 80%), the dashed forecast
  // lines; partial periods: the dashed segments into them; anomalies.
  bands: BandMark[];
  forecastLines: LineMark[];
  dashed: LineMark[];
  anomalies: AnomalyDot[];
  // Per forecast series (aligned with model.forecast.series): the pixel
  // position of each category's forecast value - where the hover marker sits.
  forecastPoints: { series: number; ys: (number | null)[] }[];
};

export type LegendItem = { x: number; y: number; name: string; color: string | null; text: string; full: string; identity?: { column: string; value: string }; mark?: LegendMark };

export type Scene = {
  width: number;
  height: number;
  orient: "v" | "h";
  legend: LegendItem[];
  panels: ScenePanel[];
  // Category axis: x ticks under the last panel (vertical) or row labels
  // down the left (horizontal).
  categoryTicks: (AxisTick & { y: number })[];
  xTitle: TextMark | null;
  note: TextMark | null;
  // More small-print lines under the note (a forecast's caption, the
  // partial-period note), each cut to the width.
  captions: TextMark[];
  // Forecast: the "last complete period" divider and the tinted region
  // to its right.
  divider: { x: number; y1: number; y2: number; label: TextMark | null } | null;
  futureRegion: Rect | null;
  // Hover: the centre of each category along the category axis, the band
  // each one owns, and the area that listens.
  positions: number[];
  band: number;
  area: Rect;
  // How many categories are drawn (fewer than the model's when they did
  // not fit).
  shown: number;
};

function legendLayout(model: ChartModel, width: number, measure: Measure): { items: LegendItem[]; height: number } {
  if (!model.legend || model.legend.length < 2) return { items: [], height: 0 };
  const rowH = 18, key = 16, gap = 16, maxRows = 2;
  const items: LegendItem[] = [];
  let x = 0, row = 0;
  for (let i = 0; i < model.legend.length; i++) {
    const it = model.legend[i];
    const fit = fitText(it.name, Math.max(40, Math.min(width - key, 180)), measure, LEGEND_SIZE);
    const w = key + fit.width;
    if (x > 0 && x + w > width) {
      row++;
      x = 0;
    }
    if (row >= maxRows) {
      // Out of room: the last line ends in "+N more" (the tooltip and the
      // table view still name every series).
      const rest = model.legend.length - i;
      const more = `+${rest} more`;
      const mw = measure(more, LEGEND_SIZE);
      while (items.length && items[items.length - 1].y === (maxRows - 1) * rowH && items[items.length - 1].x + key + measure(items[items.length - 1].text, LEGEND_SIZE) + gap + mw > width) items.pop();
      const last = items[items.length - 1];
      const mx = last && last.y === (maxRows - 1) * rowH ? last.x + key + measure(last.text, LEGEND_SIZE) + gap : 0;
      items.push({ x: mx, y: (maxRows - 1) * rowH, name: more, color: null, text: more, full: model.legend.slice(i).map((l) => l.name).join(", ") });
      row = maxRows - 1;
      break;
    }
    items.push({ x, y: row * rowH, name: it.name, color: it.color, text: fit.text, full: it.name, identity: it.identity, mark: it.mark });
    x += w + gap;
  }
  return { items, height: (Math.min(row, maxRows - 1) + 1) * rowH + 6 };
}

function stackOf(panel: ChartPanel, n: number, stacked: boolean): { lo: (number | null)[][]; hi: (number | null)[][] } {
  const lo: (number | null)[][] = panel.series.map(() => new Array(n).fill(null));
  const hi: (number | null)[][] = panel.series.map(() => new Array(n).fill(null));
  for (let c = 0; c < n; c++) {
    let pos = 0, neg = 0;
    panel.series.forEach((s, si) => {
      const v = s.values[c];
      if (v === null || v === undefined) return;
      if (!stacked) {
        lo[si][c] = 0;
        hi[si][c] = v;
      } else if (v >= 0) {
        lo[si][c] = pos;
        pos += v;
        hi[si][c] = pos;
      } else {
        lo[si][c] = neg;
        neg += v;
        hi[si][c] = neg;
      }
    });
  }
  return { lo, hi };
}

function extent(stack: { lo: (number | null)[][]; hi: (number | null)[][] }, shown: number): number[] {
  const out: number[] = [];
  for (const arr of [stack.lo, stack.hi]) for (const s of arr) for (let c = 0; c < shown; c++) if (s[c] !== null) out.push(s[c] as number);
  return out;
}

// Direct labels of one panel share one number of decimals ("105.30" beside
// "94.95", never "105.3"): written in full, or all under a thousand, they
// are formatted as a column would be.
function labelText(fmt: ValueFormat, values: (number | null)[]): (v: number, style: "full" | "compact") => string {
  const column = columnFormat(fmt, values);
  const small = values.every((v) => v === null || Math.abs(v) < 1000);
  return (v, style) => formatValue(v, style === "full" || small ? column : fmt, style);
}

function tickLabel(fmt: ValueFormat): (v: number) => string {
  return (v) => formatValue(v, fmt, "compact");
}

function linePath(xs: number[], ys: (number | null)[], step: boolean): string {
  let d = "";
  let pen = false;
  let px = 0;
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    if (y === null) {
      pen = false;
      continue;
    }
    const x = Number(xs[i].toFixed(2)), yy = Number(y.toFixed(2));
    if (!pen) d += `M${x} ${yy}`;
    else if (step) d += `H${Number(((px + x) / 2).toFixed(2))}V${yy}H${x}`;
    else d += `L${x} ${yy}`;
    pen = true;
    px = x;
  }
  return d;
}

export type LayoutOptions = { measure: Measure };

export function layoutChart(model: ChartModel, width: number, height: number, { measure }: LayoutOptions): Scene {
  const W = Math.max(120, Math.floor(width));
  const H = Math.max(96, Math.floor(height));
  return model.kind === "hbar" ? layoutHorizontal(model, W, H, measure) : layoutVertical(model, W, H, measure);
}

// ---- vertical: bars / lines / areas over a category or period axis ----

/** A histogram's x ticks: bin edges at a round interval, thinned until
 *  their labels have air between them. */
function edgeTicks(edges: number[], x0: number, bandW: number, offset: number, integer: boolean, measure: Measure, left: number, right: number): (AxisTick & { y: number })[] {
  const text = (v: number) => (integer ? Math.round(v).toLocaleString() : Number(v.toPrecision(6)).toLocaleString(undefined, { maximumFractionDigits: 6 }));
  const n = edges.length;
  for (const step of [1, 2, 4, 5, 10, 20]) {
    const picked: (AxisTick & { y: number })[] = [];
    let lastEnd = -Infinity, ok = true;
    for (let i = 0; i < n; i += step) {
      const x = x0 + (i + offset) * bandW;
      const t = text(edges[i]);
      const w = measure(t, TICK_SIZE);
      let xa = x - w / 2, anchor: AxisTick["anchor"] = "middle", tx = x;
      if (xa < left) { xa = left; tx = left; anchor = "start"; }
      else if (xa + w > right) { xa = right - w; tx = right; anchor = "end"; }
      if (xa < lastEnd + 8) { ok = false; break; }
      lastEnd = xa + w;
      picked.push({ index: i, x: tx, text: t, full: t, cut: false, anchor, y: 0 });
    }
    if (ok && picked.length >= 2) return picked;
  }
  return [];
}

/** The histogram's end bars say what they hold: "575+" under the bar of
 *  everything above the drawn range, "< 0" under the one below it. Edge
 *  ticks that would touch those labels give way. */
function endBinTicks(ticks: (AxisTick & { y: number })[], hist: NonNullable<ChartModel["histogram"]>, x0: number, bandW: number, nBars: number, measure: Measure, left: number, right: number): (AxisTick & { y: number })[] {
  const text = (v: number) => (hist.integer ? Math.round(v).toLocaleString() : Number(v.toPrecision(6)).toLocaleString(undefined, { maximumFractionDigits: 6 }));
  const extra: (AxisTick & { y: number; x0: number; x1: number })[] = [];
  const add = (barIndex: number, label: string, full: string) => {
    const w = measure(label, TICK_SIZE);
    let cx = x0 + (barIndex + 0.5) * bandW;
    cx = Math.max(left + w / 2, Math.min(right - w / 2, cx));
    extra.push({ index: -1 - extra.length, x: cx, text: label, full, cut: false, anchor: "middle", y: 0, x0: cx - w / 2, x1: cx + w / 2 });
  };
  if (hist.underflow) add(0, `< ${text(hist.edges[0])}`, `Below ${text(hist.edges[0])}`);
  if (hist.overflow) add(nBars - 1, `${text(hist.edges[hist.edges.length - 1])}+`, `${text(hist.edges[hist.edges.length - 1])} and above`);
  if (!extra.length) return ticks;
  const kept = ticks.filter((t) => {
    const w = measure(t.text, TICK_SIZE);
    const a = t.anchor === "start" ? t.x : t.anchor === "end" ? t.x - w : t.x - w / 2;
    return extra.every((e) => a + w + 6 <= e.x0 || a >= e.x1 + 6);
  });
  return [...kept, ...extra.map(({ x0: _a, x1: _b, ...t }) => t)].sort((a, b) => a.x - b.x);
}

/** `text` on at most `maxLines` lines of `width` (the last one cut with an ellipsis). */
function wrapLines(text: string, width: number, measure: Measure, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (measure(next, TICK_SIZE) <= width || !line) { line = next; continue; }
    lines.push(line);
    line = words[i];
    if (lines.length === maxLines - 1) {
      lines.push(fitText([line, ...words.slice(i + 1)].join(" "), width, measure, TICK_SIZE).text);
      return lines;
    }
  }
  if (line) lines.push(measure(line, TICK_SIZE) <= width ? line : fitText(line, width, measure, TICK_SIZE).text);
  return lines;
}

function layoutVertical(model: ChartModel, W: number, H: number, measure: Measure): Scene {
  const n = model.categories.length;
  const kindOf = (p: ChartPanel): ChartKind => p.kind || model.kind;
  const anyBar = model.panels.some((p) => kindOf(p) === "bar");
  const isBar = anyBar;
  const legend = legendLayout(model, W, measure);
  const noteFit = model.note ? fitText(model.note, W, measure, TICK_SIZE) : null;
  // A caption (the partial-period line, the forecast line) wraps onto a
  // second line on a narrow card rather than ending in "...".
  const captionFits = (model.captions || []).flatMap((c) => wrapLines(c, W, measure, 2).map((line) => ({ full: c, fit: { text: line } })));
  const noteH = (noteFit ? 16 : 0) + captionFits.length * 15 + (captionFits.length && !noteFit ? 1 : 0);
  const xAxisH = 22;
  const xTitleH = model.xTitle ? 16 : 0;
  const count = model.panels.length;
  const gap = count > 1 ? 14 : 0;
  const forecast = model.forecast || null;
  const hist = model.histogram || null;
  // The divider's label sits in a strip above the plot.
  const top = legend.height + (forecast ? 14 : 0);
  const availH = Math.max(40 * count, H - top - xAxisH - xTitleH - noteH);
  const panelH = (availH - gap * (count - 1)) / count;

  // A bar panel with one series keeps room above its tallest bar for the
  // value label, whether or not the labels end up fitting.
  const wantsBarLabels = (p: ChartPanel) => kindOf(p) === "bar" && p.series.length === 1 && !model.stacked && n <= 24 && !hist;
  const wantsEndLabel = (p: ChartPanel) => kindOf(p) !== "bar" && p.series.length === 1 && n > 1 && !forecast;

  const pre = model.panels.map((p, i) => {
    const barPanel = kindOf(p) === "bar";
    const titleH = p.title ? 18 : 0;
    const head = wantsBarLabels(p) ? 15 : 7;
    const y = top + i * (panelH + gap) + titleH + head;
    const h = Math.max(24, panelH - titleH - head);
    const stack = stackOf(p, n, model.stacked);
    const values = extent(stack, n);
    if (forecast) {
      for (const o of forecast.series) {
        if (o.panel !== i) continue;
        for (const arr of [o.values, o.lo95 || o.lo80, o.hi95 || o.hi80]) if (arr) for (const v of arr) if (v !== null) values.push(v);
      }
    }
    if (model.anomalies) for (const a of model.anomalies) if (a.panel === i) values.push(a.value);
    let [lo, hi] = valueDomain(values, barPanel || model.stacked || kindOf(p) === "area");
    let ticks = niceTicks(lo, hi, Math.max(2, Math.min(5, Math.round(h / 38))));
    if (model.normalized) {
      // A 100% stack: the axis is exactly 0 to 100%.
      lo = 0; hi = 1;
      ticks = h >= 150 ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
    }
    const label = tickLabel(p.format);
    const tickW = Math.max(...ticks.map((t) => measure(label(t), TICK_SIZE)));
    let endText: string | null = null;
    if (wantsEndLabel(p)) {
      const vals = p.series[0].values;
      let last: number | null = null;
      for (let c = n - 1; c >= 0 && last === null; c--) last = vals[c] ?? null;
      if (last !== null) endText = formatValue(last, p.format, W >= 420 ? "auto" : "compact");
    }
    return { p, titleH, y, h, stack, ticks, label, tickW, endText, panelTop: top + i * (panelH + gap), barPanel };
  });

  const left = Math.ceil(Math.max(20, ...pre.map((x) => x.tickW)) + 8);
  const endW = Math.max(0, ...pre.map((x) => (x.endText ? measure(x.endText, LABEL_SIZE, 500) : 0)));
  // No room for an end label on a very narrow chart: the tooltip has it.
  const showEnd = endW > 0 && endW + 14 < (W - left) * 0.3;
  const right = showEnd ? Math.ceil(endW + 14) : isBar ? 2 : 8;
  const plotX = left;
  const plotW = Math.max(40, W - left - right);

  let xs: number[];
  let band: number;
  if (isBar || n === 1) {
    band = plotW / n;
    xs = model.categories.map((_, i) => plotX + band * (i + 0.5));
  } else {
    const pad = Math.min(10, plotW * 0.03);
    band = (plotW - pad * 2) / (n - 1);
    xs = model.categories.map((_, i) => plotX + pad + band * i);
  }
  const partial = model.partial || null;
  const isPartial = (c: number) => Boolean(partial && (partial.first === c || partial.last === c));

  const panels: ScenePanel[] = pre.map(({ p, y, h, stack, ticks, label, endText, panelTop, barPanel }, pi) => {
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const py = (v: number) => y + h - ((v - lo) / (hi - lo || 1)) * h;
    const zero = py(Math.min(Math.max(0, lo), hi));
    const plot: Rect = { x: plotX, y, w: plotW, h };
    const scene: ScenePanel = {
      key: p.key,
      title: p.title ? { x: 0, y: panelTop + 12, text: fitText(p.title, W, measure, TITLE_SIZE, 500).text, anchor: "start", full: p.title } : null,
      plot,
      grid: ticks.filter((t) => t !== 0 || lo !== 0).filter((t) => Math.abs(py(t) - zero) > 0.5).map((t) => ({ x1: plotX, y1: py(t), x2: plotX + plotW, y2: py(t) })),
      baseline: { x1: plotX, y1: zero, x2: plotX + plotW, y2: zero },
      valueTicks: ticks.map((t) => ({ x: plotX - 8, y: py(t), text: label(t), anchor: "end" as const })),
      bars: [], areas: [], lines: [], dots: [], labels: [],
      points: p.series.map((_, si) => stack.hi[si].map((v) => (v === null ? null : py(v)))),
      labelStyle: null,
      kind: kindOf(p),
      bands: [], forecastLines: [], dashed: [], anomalies: [], forecastPoints: [],
    };

    if (barPanel) {
      const k = model.stacked ? 1 : p.series.length;
      // A histogram's bars touch (2 px of surface between them), as wide
      // as their bin; every other bar is at most 24 px.
      const inner = hist ? Math.max(1, band - (band > 6 ? GAP : 1)) : Math.max(1, Math.min(band * 0.72, band - GAP));
      const barW = hist ? inner : Math.max(1, Math.min(MAX_BAR, (inner - GAP * (k - 1)) / k));
      const groupW = barW * k + GAP * (k - 1);
      for (let c = 0; c < n; c++) {
        // The outermost segment of a stack is the only rounded one.
        let topSeries = -1, bottomSeries = -1;
        if (model.stacked) p.series.forEach((s, si) => { const v = s.values[c]; if (v === null || v === undefined) return; if (v >= 0) topSeries = si; else bottomSeries = si; });
        p.series.forEach((s, si) => {
          const a = stack.lo[si][c], b = stack.hi[si][c];
          if (a === null || b === null) return;
          const x = xs[c] - groupW / 2 + (model.stacked ? 0 : si * (barW + GAP));
          const up = b >= a;
          let y0 = py(Math.max(a, b)), y1 = py(Math.min(a, b));
          // 2 px of surface between a segment and the one beneath it.
          if (model.stacked && a !== 0 && y1 - y0 > GAP + 1) { if (up) y1 -= GAP; else y0 += GAP; }
          const hh = Math.max(b === 0 ? 0 : 1, y1 - y0);
          const rounded = !model.stacked || (up ? si === topSeries : si === bottomSeries);
          const radius = hist ? Math.min(2, barW / 2) : 4;
          const d = rounded ? barPath(x, up ? y1 - hh : y0, barW, hh, up ? "top" : "bottom", radius) : barPath(x, up ? y1 - hh : y0, barW, hh, "top", 0);
          if (d) scene.bars.push({ d, color: s.colors?.[c] ?? s.color, cat: c, series: si, box: { x, y: up ? y1 - hh : y0, w: barW, h: hh } });
        });
      }
      if (wantsBarLabels(p)) {
        const vals = p.series[0].values;
        const write = labelText(p.format, vals);
        const fits = (style: "full" | "compact") => vals.every((v) => v === null || measure(write(v, style), LABEL_SIZE, 500) <= band - 4);
        const style = fits("full") ? "full" : fits("compact") ? "compact" : null;
        scene.labelStyle = style;
        if (style) {
          vals.forEach((v, c) => {
            if (v === null) return;
            const text = write(v, style);
            const half = measure(text, LABEL_SIZE, 500) / 2;
            const x = Math.min(Math.max(xs[c], half), W - half);
            scene.labels.push({ x, y: v >= 0 ? py(v) - 5 : Math.min(py(v) + 12, y + h - 2), text, anchor: "middle" });
          });
        }
      }
    } else {
      const baseY = (si: number, c: number) => (stack.lo[si][c] === null ? null : py(Math.min(Math.max(stack.lo[si][c] as number, lo), hi)));
      p.series.forEach((s, si) => {
        const ys = scene.points[si];
        // The solid line stops short of a partial period; the segment
        // into it is drawn dashed and its point hollow.
        const solid = partial && !model.stacked ? ys.map((v, c) => (isPartial(c) ? null : v)) : ys;
        if (scene.kind === "area") {
          // The fill: along the line, back along its base (the series under
          // it when stacked, the baseline otherwise).
          let run: number[] = [];
          const flush = () => {
            if (run.length > 1) {
              const fwd = linePath(run.map((c) => xs[c]), run.map((c) => ys[c]), model.step);
              const back = [...run].reverse().map((c) => `L${Number(xs[c].toFixed(2))} ${Number((baseY(si, c) ?? zero).toFixed(2))}`).join("");
              scene.areas.push({ d: `${fwd}${back}Z`, color: s.color });
            }
            run = [];
          };
          for (let c = 0; c < n; c++) { if (ys[c] === null) flush(); else run.push(c); }
          flush();
        }
        const d = linePath(xs, solid, model.step);
        if (d) scene.lines.push({ d, color: s.color, name: s.name });
        if (solid !== ys) {
          for (const c of [partial!.first, partial!.last]) {
            if (c === null || c === undefined || ys[c] === null) continue;
            const neighbour = c === 0 ? 1 : c - 1;
            if (ys[neighbour] !== null && ys[neighbour] !== undefined) {
              scene.dashed.push({ d: `M${xs[neighbour].toFixed(2)} ${(ys[neighbour] as number).toFixed(2)}L${xs[c].toFixed(2)} ${(ys[c] as number).toFixed(2)}`, color: s.color, name: s.name });
            }
            scene.dots.push({ cx: xs[c], cy: ys[c] as number, color: s.color, r: 3.5, hollow: true });
          }
        }
        const present = solid.map((v, c) => (v === null ? -1 : c)).filter((c) => c >= 0);
        if (!present.length) return;
        if (present.length <= 12 && band >= 22) {
          for (const c of present) scene.dots.push({ cx: xs[c], cy: solid[c] as number, color: s.color, r: 4 });
        } else {
          // Isolated points (no neighbour to draw a line to) and the end point.
          for (const c of present) if (solid[c - 1] == null && solid[c + 1] == null) scene.dots.push({ cx: xs[c], cy: solid[c] as number, color: s.color, r: 4 });
          const last = present[present.length - 1];
          if (!scene.dots.some((dot) => dot.cx === xs[last] && dot.cy === solid[last])) scene.dots.push({ cx: xs[last], cy: solid[last] as number, color: s.color, r: 4 });
        }
      });
      if (showEnd && endText) {
        const ys = scene.points[0];
        let last = -1;
        for (let c = n - 1; c >= 0 && last < 0; c--) if (ys[c] !== null) last = c;
        if (last >= 0) {
          scene.labels.push({ x: xs[last] + 9, y: Math.min(Math.max(ys[last] as number, y + 6), y + h - 4) + 4, text: endText, anchor: "start" });
          scene.labelStyle = "full";
        }
      }
    }

    // ---- forecast: bands (95% first, under the 80%), then the dashed line ----
    if (forecast) {
      const clampY = (v: number) => Math.min(Math.max(py(v), y - 2), y + h + 2);
      forecast.series.forEach((o, oi) => {
        if (o.panel !== pi) return;
        const idx: number[] = [];
        for (let c = 0; c < n; c++) if (o.values[c] !== null && o.values[c] !== undefined) idx.push(c);
        if (idx.length < 2) return;
        const bandPath = (loArr: (number | null)[], hiArr: (number | null)[]) => {
          const pts = idx.filter((c) => loArr[c] !== null && hiArr[c] !== null);
          if (pts.length < 2) return "";
          const upper = pts.map((c, i) => `${i ? "L" : "M"}${xs[c].toFixed(2)} ${clampY(hiArr[c] as number).toFixed(2)}`).join("");
          const lower = [...pts].reverse().map((c) => `L${xs[c].toFixed(2)} ${clampY(loArr[c] as number).toFixed(2)}`).join("");
          return `${upper}${lower}Z`;
        };
        if (o.lo95 && o.hi95) { const d = bandPath(o.lo95, o.hi95); if (d) scene.bands.push({ d, color: o.color, level: "95" }); }
        if (o.lo80 && o.hi80) { const d = bandPath(o.lo80, o.hi80); if (d) scene.bands.push({ d, color: o.color, level: "80" }); }
        const ys = o.values.map((v) => (v === null || v === undefined ? null : clampY(v)));
        const d = linePath(xs, ys, false);
        if (d) scene.forecastLines.push({ d, color: o.color, name: p.series[o.series]?.name });
        const lastIdx = idx[idx.length - 1];
        scene.dots.push({ cx: xs[lastIdx], cy: ys[lastIdx] as number, color: o.color, r: 3.5, hollow: true });
        scene.forecastPoints.push({ series: oi, ys });
      });
    }
    if (model.anomalies) {
      for (const a of model.anomalies) {
        if (a.panel !== pi || a.category >= n) continue;
        scene.anomalies.push({ cx: xs[a.category], cy: py(a.value), category: a.category, series: a.series });
      }
    }
    return scene;
  });

  const lastPlot = panels[panels.length - 1].plot;
  const tickY = lastPlot.y + lastPlot.h + 16;
  const ticks = hist
    ? endBinTicks(edgeTicks(hist.edges, plotX, band, hist.underflow ? 1 : 0, hist.integer, measure, 0, W), hist, plotX, band, n, measure, 0, W)
    : model.time
      ? timeTicks(model.categories.map((c) => c.date as DateParts), xs, model.grain, measure, 0, W, TICK_SIZE)
      : categoryTicks(model.categories.map((c) => c.label), xs, isBar || n === 1 ? band : Math.max(band, 1), measure, 0, W, TICK_SIZE);

  const firstPlot = panels[0].plot;
  let divider: Scene["divider"] = null;
  let futureRegion: Rect | null = null;
  if (forecast && forecast.anchor >= 0 && forecast.anchor < n) {
    // Between the last fitted period and the first forecast one.
    const ax = xs[forecast.anchor];
    const next = xs[Math.min(n - 1, forecast.anchor + 1)];
    const dx = isBar ? ax + band / 2 : ax + (next - ax) / 2;
    const text = forecast.dividerLabel;
    const tw = measure(text, TICK_SIZE);
    // The label sits left of the line (over history) where it fits there.
    const fitsLeft = dx - 6 - tw >= plotX;
    divider = {
      x: dx, y1: firstPlot.y - 4, y2: lastPlot.y + lastPlot.h,
      label: { x: fitsLeft ? dx - 6 : Math.min(dx + 6, W - tw), y: firstPlot.y - 8, text, anchor: fitsLeft ? "end" : "start" },
    };
    futureRegion = { x: dx, y: firstPlot.y - 4, w: Math.max(0, plotX + plotW - dx), h: lastPlot.y + lastPlot.h - firstPlot.y + 4 };
  }
  let lineY = H - 4 - captionFits.length * 15;
  const note = noteFit ? { x: 0, y: lineY, text: noteFit.text, anchor: "start" as const, full: model.note || undefined } : null;
  const captions: TextMark[] = captionFits.map((c, i) => ({ x: 0, y: H - 4 - (captionFits.length - 1 - i) * 15, text: c.fit.text, anchor: "start" as const, full: c.full }));
  void lineY;
  return {
    width: W,
    height: H,
    orient: "v",
    legend: legend.items,
    panels,
    categoryTicks: ticks.map((t) => ({ ...t, y: tickY })),
    xTitle: model.xTitle ? { x: plotX + plotW / 2, y: tickY + 16, text: fitText(model.xTitle, plotW, measure, TICK_SIZE).text, anchor: "middle" } : null,
    note,
    captions,
    divider,
    futureRegion,
    positions: xs,
    band,
    area: { x: plotX, y: firstPlot.y, w: plotW, h: lastPlot.y + lastPlot.h - firstPlot.y },
    shown: n,
  };
}

// ---- horizontal bars: categories down the left, one column per panel ----

function layoutHorizontal(model: ChartModel, W: number, H: number, measure: Measure): Scene {
  const total = model.categories.length;
  const legend = legendLayout(model, W, measure);
  const count = model.panels.length;
  const titleH = model.panels.some((p) => p.title) ? 20 : 0;
  const axisH = 22;
  const plotTop = legend.height + titleH + 2;
  let noteText = model.note;
  let plotH = Math.max(40, H - plotTop - axisH - (noteText ? 16 : 0));

  // Rows: at least 18 px each. More categories than fit -> the first that
  // do, and a line that says so (the table view has them all).
  let shown = total;
  if (plotH / total < 18) {
    plotH = Math.max(40, H - plotTop - axisH - 16);
    shown = Math.max(1, Math.floor(plotH / 18));
    noteText = `${noteText ? `${noteText} ` : ""}First ${shown} of ${total.toLocaleString()} shown.`;
  }
  // Two bars in a tall card: the rows share the height (the bars stay thin,
  // the rest is air), up to a point - past it the chart ends where its
  // rows do.
  const rowH = Math.min(104, plotH / shown);
  const rowsH = rowH * shown;

  const labels = model.categories.slice(0, shown).map((c) => c.label);
  const catMax = Math.max(48, Math.min(180, W * 0.36));
  const catW = Math.ceil(Math.min(catMax, Math.max(...labels.map((l) => measure(l, TITLE_SIZE)))));
  const gutter = catW + 10;
  const colGap = count > 1 ? 22 : 0;
  const colW = Math.max(40, (W - gutter - colGap * (count - 1) - 2) / count);
  const ys = labels.map((_, i) => plotTop + rowH * (i + 0.5));

  // Value labels sit past the end of each bar. The longest one decides
  // how much of the column the bars may use - written in full when the
  // column is wide enough for it, compact (25.3M) otherwise, left to the
  // tooltip when even that would squeeze the bars. Side-by-side panels are
  // labelled alike: all of them, or none.
  const labelPlan = model.panels.map((p) => {
    const vals = p.series[0].values.slice(0, shown);
    const write = labelText(p.format, vals);
    let style: "full" | "compact" | null = null;
    let width = 0;
    if (p.series.length === 1 && !model.stacked && vals.every((v) => v === null || v >= 0) && shown <= 40) {
      const widest = (st: "full" | "compact") => Math.max(0, ...vals.map((v) => (v === null ? 0 : measure(write(v, st), LABEL_SIZE, 500))));
      const full = widest("full"), small = widest("compact");
      if (full + 8 <= colW * 0.3) { style = "full"; width = full; }
      else if (small + 8 <= colW * (count > 1 ? 0.65 : 0.5)) { style = "compact"; width = small; }
    }
    return { vals, write, style, width };
  });
  if (labelPlan.some((l) => l.style === null)) labelPlan.forEach((l) => { l.style = null; l.width = 0; });

  const panels: ScenePanel[] = model.panels.map((p, pi) => {
    const colX = gutter + pi * (colW + colGap);
    const stack = stackOf(p, total, model.stacked);
    const [lo, hi] = valueDomain(extent(stack, shown), true);
    const label = tickLabel(p.format);
    const { vals, write, style: labelStyle, width: labelW } = labelPlan[pi];
    const reserve = labelStyle ? labelW + 8 : 0;
    const ticks = fitValueTicks(lo, hi, Math.max(24, colW - reserve - 4), label, measure, TICK_SIZE);
    const tLo = ticks[0], tHi = ticks[ticks.length - 1];
    const lastHalf = measure(label(tHi), TICK_SIZE) / 2;
    // The axis may run on past the longest bar's label room (its round top
    // tick is usually beyond the data), but never past the column.
    const dataHi = Math.max(hi, tLo + (tHi - tLo) * 1e-6);
    const scaleW = Math.max(24, Math.min(colW - lastHalf, labelStyle ? ((colW - reserve) * (tHi - tLo)) / (dataHi - tLo) : colW - lastHalf));
    const px = (v: number) => colX + ((v - tLo) / (tHi - tLo || 1)) * scaleW;
    const zero = px(Math.min(Math.max(0, tLo), tHi));
    const plot: Rect = { x: colX, y: plotTop, w: scaleW, h: rowsH };
    const scene: ScenePanel = {
      key: p.key,
      title: p.title ? { x: colX, y: legend.height + 13, text: fitText(p.title, colW, measure, TITLE_SIZE, 500).text, anchor: "start", full: p.title } : null,
      plot,
      grid: ticks.filter((t) => Math.abs(px(t) - zero) > 0.5).map((t) => ({ x1: px(t), y1: plotTop, x2: px(t), y2: plotTop + rowsH })),
      baseline: { x1: zero, y1: plotTop, x2: zero, y2: plotTop + rowsH },
      valueTicks: ticks.map((t) => ({ x: px(t), y: plotTop + rowsH + 15, text: label(t), anchor: "middle" as const })),
      bars: [], areas: [], lines: [], dots: [], labels: [],
      points: p.series.map((_, si) => stack.hi[si].slice(0, shown).map((v) => (v === null ? null : px(v)))),
      labelStyle,
      kind: "hbar",
      bands: [], forecastLines: [], dashed: [], anomalies: [], forecastPoints: [],
    };
    const k = model.stacked ? 1 : p.series.length;
    const inner = Math.max(1, Math.min(rowH * 0.7, rowH - 4));
    const barH = Math.max(1, Math.min(MAX_BAR, (inner - GAP * (k - 1)) / k));
    const groupH = barH * k + GAP * (k - 1);
    for (let c = 0; c < shown; c++) {
      let endSeries = -1, startSeries = -1;
      if (model.stacked) p.series.forEach((s, si) => { const v = s.values[c]; if (v === null || v === undefined) return; if (v >= 0) endSeries = si; else startSeries = si; });
      p.series.forEach((s, si) => {
        const a = stack.lo[si][c], b = stack.hi[si][c];
        if (a === null || b === null) return;
        const y = ys[c] - groupH / 2 + (model.stacked ? 0 : si * (barH + GAP));
        const fwd = b >= a;
        let x0 = px(Math.min(a, b)), x1 = px(Math.max(a, b));
        if (model.stacked && a !== 0 && x1 - x0 > GAP + 1) { if (fwd) x0 += GAP; else x1 -= GAP; }
        const ww = Math.max(b === 0 ? 0 : 1, x1 - x0);
        const rounded = !model.stacked || (fwd ? si === endSeries : si === startSeries);
        const d = barPath(fwd ? x0 : x1 - ww, y, ww, barH, fwd ? "right" : "left", rounded ? 4 : 0);
        if (d) scene.bars.push({ d, color: s.colors?.[c] ?? s.color, cat: c, series: si, box: { x: fwd ? x0 : x1 - ww, y, w: ww, h: barH } });
      });
      if (labelStyle) {
        const v = vals[c];
        if (v !== null && v !== undefined) scene.labels.push({ x: px(v) + 6, y: ys[c] + 4, text: write(v, labelStyle), anchor: "start" });
      }
    }
    return scene;
  });

  const noteFit = noteText ? fitText(noteText, W, measure, TICK_SIZE) : null;
  return {
    width: W,
    height: H,
    orient: "h",
    legend: legend.items,
    panels,
    categoryTicks: labels.map((l, i) => {
      const fit = fitText(l, catW, measure, TITLE_SIZE);
      return { index: i, x: catW, y: ys[i] + 4, text: fit.text, full: l, cut: fit.cut, anchor: "end" as const };
    }),
    xTitle: null,
    note: noteFit ? { x: 0, y: H - 4, text: noteFit.text, anchor: "start", full: noteText || undefined } : null,
    captions: [],
    divider: null,
    futureRegion: null,
    positions: ys,
    band: rowH,
    area: { x: 0, y: plotTop, w: W, h: rowsH },
    shown,
  };
}
