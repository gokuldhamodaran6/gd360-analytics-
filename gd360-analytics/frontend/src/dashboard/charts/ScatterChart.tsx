import { useMemo, useState } from "react";
import type { BlockResult, DashboardBlock } from "../../api/client";
import type { ChartExportApi } from "../../components/ChartCanvas";
import { formatValue, humanize, measureFormats, PLAIN_FORMAT, type ValueFormat } from "../format";
import { blockColorMode, blockSingleColor, valueKey, type ChartTheme } from "../theme/chartTheme";
import { dimInfo, resultDims } from "./dimensions";
import { fitText, fitValueTicks, niceTicks, valueDomain, type Measure } from "./geometry";
import { AXIS, ChartMessage, ChartTip, GRID, INK, LABEL_SIZE, layoutLegend, LegendRow, MUTED, SECONDARY, SURFACE, TICK_SIZE, TITLE_SIZE, useChartFrame, type LegendEntry } from "./kit";

// 2026-10-07 (chart-types round): scatter and bubble - TWO measures per
// value of a dimension (a third as the bubble's area). One x scale and one
// y scale: each axis is one measure, which is what a scatter is - it is not
// a dual axis (two measures sharing one direction).
//
//   colour   each point its dimension value's identity colour from the
//            theme (the colour that value has on every other chart) when
//            colour is "by value" and the column has few enough values;
//            the single colour otherwise;
//   labels   only the points worth naming - the extremes of each axis, the
//            largest bubble, the points furthest from the pack - each
//            placed beside its point where it collides with nothing,
//            skipped where it would (the tooltip and the table name all);
//   trend    a least-squares line with r squared and n stated beside it,
//            for six points or more (config.trend === false hides it);
//   hover    the NEAREST point answers (a 24 px reach), not a pinpoint.

export type ScatterPoint = { key: string; label: string; raw: unknown; x: number; y: number; size: number | null; color: string };

export type ScatterModel = {
  dim: string;
  dimName: string;
  x: { key: string; name: string; format: ValueFormat };
  y: { key: string; name: string; format: ValueFormat };
  size: { key: string; name: string; format: ValueFormat } | null;
  points: ScatterPoint[];
  dropped: number;
  trend: { slope: number; intercept: number; r2: number; n: number } | null;
  legend: LegendEntry[] | null;
  colored: boolean;
  pickable: boolean;
  summary: string;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Ordinary least squares y = intercept + slope x, with r squared. */
export function leastSquares(points: { x: number; y: number }[]): { slope: number; intercept: number; r2: number; n: number } | null {
  const n = points.length;
  if (n < 3) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / n, my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); syy += (p.y - my) ** 2; }
  if (!(sxx > 0) || !(syy > 0)) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: (sxy * sxy) / (sxx * syy), n };
}

/** The scatter model: the first measure up the y axis, the second along
 *  the x axis ("ADR vs lead time": ADR is y), a third as bubble size. */
export function scatterModel(result: BlockResult, block: Pick<DashboardBlock, "id" | "config" | "title">, theme: ChartTheme, bubble = false): ScatterModel | null {
  const dims = resultDims(result);
  const measures = result.measures || [];
  if (!dims.length || measures.length < 2) return null;
  const dim = dims[0];
  const info = dimInfo(result, dim);
  const formats = measureFormats(block, result);
  const m = (key: string) => ({ key, name: humanize(key), format: formats[key] || PLAIN_FORMAT });
  const yKey = measures[0], xKey = measures[1], sKey = bubble && measures.length >= 3 ? measures[2] : null;
  const cfg = block.config || {};
  const mode = blockColorMode(theme, cfg);
  const single = blockSingleColor(theme, cfg);
  const isTime = info.kind === "time";
  const rows = (result.rows || []).map((row) => ({ row, x: num(row[xKey]), y: num(row[yKey]), s: sKey ? num(row[sKey]) : null }));
  const ok = rows.filter((r) => r.x !== null && r.y !== null);
  if (!isTime && info.kind === "category") {
    const ranked = [...ok].sort((a, b) => Math.abs((b.s ?? b.y) as number) - Math.abs((a.s ?? a.y) as number));
    theme.observe(dim, ranked.map((r) => r.row[dim]));
  }
  const known = !isTime && info.kind === "category" && theme.column(dim).known;
  const colored = known && mode === "by_value" && (!theme.column(dim).overflow || ok.length <= 12);
  const points: ScatterPoint[] = ok.map((r, i) => ({
    key: `${valueKey(r.row[dim])}-${i}`,
    label: info.label(r.row[dim]),
    raw: r.row[dim] ?? null,
    x: r.x as number,
    y: r.y as number,
    size: r.s,
    color: colored ? theme.colorFor(dim, r.row[dim]) : single,
  }));
  const trend = cfg.trend === false || points.length < 6 ? null : leastSquares(points);
  const distinctColors = new Set(points.map((p) => p.color));
  return {
    dim, dimName: humanize(dim), x: m(xKey), y: m(yKey), size: sKey ? m(sKey) : null, points,
    dropped: rows.length - ok.length,
    trend,
    legend: colored && distinctColors.size > 1 && points.length <= 12 ? points.map((p) => ({ name: p.label, color: p.color, mark: "dot" as const, identity: { column: dim, value: valueKey(p.raw) } })) : null,
    colored,
    pickable: !isTime && info.kind !== "part",
    summary: `${humanize(yKey)} against ${humanize(xKey)}, one point per ${humanize(dim).toLowerCase()}${sKey ? `, sized by ${humanize(sKey)}` : ""}`,
  };
}

type Box = { x0: number; y0: number; x1: number; y1: number };
const hit = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

// A point this far from the pack (standard deviations, both axes combined)
// is an outlier: it is named on the chart.
export const OUTLIER_SCORE = 1.5;

/** Which points get a direct label, and where: the most notable first
 *  (only those scoring at least `minScore`), each tried right / left /
 *  above / below its point, kept only where it overlaps no other label,
 *  no point, no `obstacles` (the trend line) and no plot edge. */
export function scatterLabels(
  points: { label: string; px: number; py: number; r: number; score: number }[], plot: Box, measure: Measure, max = 7,
  obstacles: Box[] = [], minScore = 0,
): { index: number; x: number; y: number; anchor: "start" | "end" | "middle"; text: string }[] {
  const order = points.map((p, i) => ({ p, i })).filter(({ p }) => p.score >= minScore).sort((a, b) => b.p.score - a.p.score);
  const taken: Box[] = [...points.map((p) => ({ x0: p.px - p.r - 1, y0: p.py - p.r - 1, x1: p.px + p.r + 1, y1: p.py + p.r + 1 })), ...obstacles];
  const out: { index: number; x: number; y: number; anchor: "start" | "end" | "middle"; text: string }[] = [];
  for (const { p, i } of order) {
    if (out.length >= max) break;
    const fit = fitText(p.label, 120, measure, LABEL_SIZE, 500);
    const w = fit.width, h = 13;
    const tries: { x: number; y: number; anchor: "start" | "end" | "middle"; box: Box }[] = [
      { x: p.px + p.r + 5, y: p.py + 4, anchor: "start", box: { x0: p.px + p.r + 4, y0: p.py - h / 2, x1: p.px + p.r + 6 + w, y1: p.py + h / 2 } },
      { x: p.px - p.r - 5, y: p.py + 4, anchor: "end", box: { x0: p.px - p.r - 6 - w, y0: p.py - h / 2, x1: p.px - p.r - 4, y1: p.py + h / 2 } },
      { x: p.px, y: p.py - p.r - 5, anchor: "middle", box: { x0: p.px - w / 2 - 1, y0: p.py - p.r - 5 - h, x1: p.px + w / 2 + 1, y1: p.py - p.r - 3 } },
      { x: p.px, y: p.py + p.r + 14, anchor: "middle", box: { x0: p.px - w / 2 - 1, y0: p.py + p.r + 3, x1: p.px + w / 2 + 1, y1: p.py + p.r + 5 + h } },
    ];
    for (const t of tries) {
      if (t.box.x0 < plot.x0 || t.box.x1 > plot.x1 || t.box.y0 < plot.y0 || t.box.y1 > plot.y1) continue;
      if (taken.some((b, bi) => bi !== i && hit(t.box, b))) continue;
      taken.push(t.box);
      out.push({ index: i, x: t.x, y: t.y, anchor: t.anchor, text: fit.text });
      break;
    }
  }
  return out;
}

export type ScatterChartProps = {
  model: ScatterModel;
  title?: string | null;
  selectedValue?: unknown;
  hasSelection?: boolean;
  onPick?: (value: unknown) => void;
  onExportApi?: (api: ChartExportApi | null) => void;
  minHeight?: number;
  compact?: boolean;
};

export function ScatterChart({ model, title, selectedValue, hasSelection = false, onPick, onExportApi, minHeight, compact = false }: ScatterChartProps) {
  const frame = useChartFrame({ w: 560, h: 280 }, title, onExportApi);
  const { size, measure } = frame;
  const [active, setActive] = useState<number | null>(null);
  const W = Math.max(120, Math.floor(size.w)), H = Math.max(96, Math.floor(size.h));

  const scene = useMemo(() => {
    const pts = model.points;
    const legend = compact || !model.legend ? { items: [], height: 0 } : layoutLegend(model.legend, W, measure);
    const xLabel = (v: number) => formatValue(v, model.x.format, "compact");
    const yLabel = (v: number) => formatValue(v, model.y.format, "compact");
    const captionParts: string[] = [];
    if (model.trend) captionParts.push(`Trend line: r² = ${model.trend.r2.toFixed(2)} (n = ${model.trend.n})`);
    if (model.size) captionParts.push(`Bubble area: ${model.size.name}`);
    if (model.dropped) captionParts.push(`${model.dropped} without both values left out`);
    const caption = compact ? null : captionParts.join(" · ") || null;
    const top = legend.height + (compact ? 4 : 20);
    const bottom = compact ? 4 : 22 + 16 + (caption ? 16 : 0);
    const plotH = Math.max(40, H - top - bottom);
    const [ylo, yhi] = valueDomain(pts.map((p) => p.y), false);
    const yTicks = niceTicks(ylo, yhi, Math.max(2, Math.min(5, Math.round(plotH / 40))));
    const left = compact ? 4 : Math.ceil(Math.max(20, ...yTicks.map((t) => measure(yLabel(t), TICK_SIZE))) + 8);
    const right = compact ? 4 : 14;
    const plotW = Math.max(40, W - left - right);
    const [xlo, xhi] = valueDomain(pts.map((p) => p.x), false);
    const xTicks = fitValueTicks(xlo, xhi, plotW, xLabel, measure, TICK_SIZE);
    const x0 = xTicks[0], x1 = xTicks[xTicks.length - 1], y0 = yTicks[0], y1 = yTicks[yTicks.length - 1];
    const sx = (v: number) => left + ((v - x0) / (x1 - x0 || 1)) * plotW;
    const sy = (v: number) => top + plotH - ((v - y0) / (y1 - y0 || 1)) * plotH;
    const maxSize = Math.max(0, ...pts.map((p) => Math.abs(p.size ?? 0)));
    const radius = (p: { size: number | null }) => (model.size && maxSize > 0 ? 4 + Math.sqrt(Math.abs(p.size ?? 0) / maxSize) * (compact ? 6 : 14) : compact ? 3 : 5);
    const placed = pts.map((p) => ({ ...p, px: sx(p.x), py: sy(p.y), r: radius(p) }));
    // How notable a point is: its distance from the pack on either axis
    // (in standard deviations), plus a bonus for the largest bubbles.
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
    const sd = (a: number[], mu: number) => Math.sqrt(mean(a.map((v) => (v - mu) ** 2))) || 1;
    const mx = mean(pts.map((p) => p.x)), my = mean(pts.map((p) => p.y));
    const sdx = sd(pts.map((p) => p.x), mx), sdy = sd(pts.map((p) => p.y), my);
    const scored = placed.map((p) => ({ label: p.label, px: p.px, py: p.py, r: p.r, score: Math.hypot((p.x - mx) / sdx, (p.y - my) / sdy) + (maxSize > 0 ? Math.abs(p.size ?? 0) / maxSize : 0) }));
    let trendPath: string | null = null;
    const trendBoxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
    if (model.trend) {
      const { slope, intercept } = model.trend;
      // Drawn across the data's own x range, clipped to the plot.
      const xa = Math.min(...pts.map((p) => p.x)), xb = Math.max(...pts.map((p) => p.x));
      const clip = (v: number) => Math.min(Math.max(v, y0), y1);
      const ax = sx(xa), ay = sy(clip(intercept + slope * xa)), bx = sx(xb), by = sy(clip(intercept + slope * xb));
      trendPath = `M${ax.toFixed(1)} ${ay.toFixed(1)}L${bx.toFixed(1)} ${by.toFixed(1)}`;
      // The line as a chain of small boxes a label must stay clear of.
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 6));
      for (let k = 0; k <= steps; k++) {
        const tx = ax + ((bx - ax) * k) / steps, ty = ay + ((by - ay) * k) / steps;
        trendBoxes.push({ x0: tx - 3, y0: ty - 3, x1: tx + 3, y1: ty + 3 });
      }
    }
    // Direct labels are for what stands out. With a legend naming every
    // point's colour, only the outliers are also named on the plot (three
    // at most); without one, a small set (8 points or fewer) is named in
    // full and a larger one by its outliers.
    const hasLegend = legend.items.length > 0;
    const labels = compact ? [] : scatterLabels(
      scored, { x0: left, y0: top - 14, x1: W, y1: top + plotH }, measure,
      hasLegend ? 3 : pts.length <= 8 ? 8 : 7, trendBoxes, hasLegend || pts.length > 8 ? OUTLIER_SCORE : 0,
    );
    return { legend, top, left, plotW, plotH, xTicks, yTicks, sx, sy, placed, labels, trendPath, caption, xLabel, yLabel };
  }, [model, W, H, measure, compact]);

  if (!model.points.length) return <ChartMessage kind="scatter-empty" minHeight={minHeight}>No rows with both {model.y.name} and {model.x.name} to plot.</ChartMessage>;

  const { legend, top, left, plotW, plotH, xTicks, yTicks, sx, sy, placed, labels, trendPath, caption, xLabel, yLabel } = scene;
  const nearest = (x: number, y: number): number | null => {
    let best: number | null = null, dist = Infinity;
    placed.forEach((p, i) => {
      const d = Math.hypot(p.px - x, p.py - y) - p.r;
      if (d < dist) { dist = d; best = i; }
    });
    return dist <= 24 ? best : null;
  };
  const live = active !== null && active < placed.length ? active : null;
  const selectedKey = hasSelection ? String(selectedValue) : null;
  const dim = (p: ScatterPoint, i: number) => (selectedKey !== null ? String(p.raw) !== selectedKey : live !== null && live !== i);
  // Keyboard order: left to right.
  const byX = placed.map((_, i) => i).sort((a, b) => placed[a].px - placed[b].px);
  const onKey = (e: React.KeyboardEvent) => {
    const at = live === null ? -1 : byX.indexOf(live);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); setActive(byX[Math.min(byX.length - 1, at + 1)]); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); setActive(byX[Math.max(0, at < 0 ? byX.length - 1 : at - 1)]); }
    else if ((e.key === "Enter" || e.key === " ") && live !== null && onPick && model.pickable) { e.preventDefault(); onPick(placed[live].raw); }
    else if (e.key === "Escape") setActive(null);
  };
  const xTitle = fitText(model.x.name, plotW, measure, TICK_SIZE);
  const yTitle = fitText(model.y.name, W, measure, TITLE_SIZE, 500);

  return (
    <div ref={frame.setRoot} data-chart={model.size ? "bubble" : "scatter"} data-color-by={model.colored ? model.dim : undefined} className="relative h-full w-full" style={{ minHeight }}>
      <svg
        ref={frame.svgRef}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title ? `${title}. ` : ""}${model.summary}. ${placed.length} points.${model.trend ? ` Trend r squared ${model.trend.r2.toFixed(2)}.` : ""}`}
        tabIndex={compact ? -1 : 0}
        className={`ui-focus absolute left-0 top-0 block select-none rounded-[6px] ${onPick && model.pickable ? "cursor-pointer" : "cursor-default"}`}
        style={{ fontFamily: "inherit", fontVariantNumeric: "tabular-nums", touchAction: "pan-y" }}
        onPointerMove={compact ? undefined : (e) => { const b = e.currentTarget.getBoundingClientRect(); setActive(nearest(e.clientX - b.left, e.clientY - b.top)); }}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={compact ? undefined : onKey}
        onClick={onPick && model.pickable ? (e) => { const b = e.currentTarget.getBoundingClientRect(); const i = nearest(e.clientX - b.left, e.clientY - b.top); if (i !== null) onPick(placed[i].raw); } : undefined}
      >
        <LegendRow items={legend.items} />
        {!compact && <text x={0} y={legend.height + 12} fontSize={TITLE_SIZE} fontWeight={500} data-axis-title="y" style={{ fill: SECONDARY }}>{yTitle.text}</text>}
        {yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={left} y1={sy(t)} x2={left + plotW} y2={sy(t)} strokeWidth={1} shapeRendering="crispEdges" style={{ stroke: i === 0 ? AXIS : GRID }} />
            {!compact && <text x={left - 8} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={TICK_SIZE} data-value-tick="" style={{ fill: MUTED }}>{yLabel(t)}</text>}
          </g>
        ))}
        {xTicks.map((t, i) => (
          <g key={`x${i}`}>
            <line x1={sx(t)} y1={top} x2={sx(t)} y2={top + plotH} strokeWidth={1} shapeRendering="crispEdges" style={{ stroke: i === 0 ? AXIS : GRID }} />
            {!compact && <text x={sx(t)} y={top + plotH + 15} textAnchor={i === 0 ? "start" : "middle"} fontSize={TICK_SIZE} data-category-tick="" style={{ fill: MUTED }}>{xLabel(t)}</text>}
          </g>
        ))}
        {!compact && <text x={left + plotW / 2} y={top + plotH + 32} textAnchor="middle" fontSize={TICK_SIZE} data-axis-title="x" style={{ fill: MUTED }}>{xTitle.text}</text>}
        {trendPath && <path d={trendPath} data-trend-line="" fill="none" strokeWidth={1.5} strokeDasharray="5 4" style={{ stroke: SECONDARY }} />}
        {/* Largest first, so a small bubble is never hidden under a big one. */}
        {placed.map((p, i) => ({ p, i })).sort((a, b) => b.p.r - a.p.r).map(({ p, i }) => (
          <circle
            key={p.key}
            cx={p.px}
            cy={p.py}
            r={live === i ? p.r + 1.5 : p.r}
            data-scatter-point={p.label}
            strokeWidth={2}
            style={{ fill: p.color, fillOpacity: model.size ? 0.82 : 1, stroke: live === i ? INK : SURFACE, opacity: dim(p, i) ? 0.35 : 1 }}
          />
        ))}
        {labels.map((l) => (
          <text key={l.index} x={l.x} y={l.y} textAnchor={l.anchor} fontSize={LABEL_SIZE} fontWeight={500} data-point-label="" style={{ fill: INK, opacity: dim(placed[l.index], l.index) ? 0.45 : 1 }}>{l.text}</text>
        ))}
        {caption && <text x={0} y={H - 4} fontSize={TICK_SIZE} data-chart-note="" style={{ fill: MUTED }}>{fitText(caption, W, measure, TICK_SIZE).text}<title>{caption}</title></text>}
      </svg>
      {live !== null && !compact && (
        <ChartTip
          x={placed[live].px}
          y={placed[live].py}
          width={W}
          height={H}
          content={{
            title: placed[live].label,
            rows: [
              { key: "y", name: model.y.name, value: formatValue(placed[live].y, model.y.format, "full"), color: placed[live].color, mark: "dot" },
              { key: "x", name: model.x.name, value: formatValue(placed[live].x, model.x.format, "full") },
              ...(model.size ? [{ key: "s", name: model.size.name, value: formatValue(placed[live].size, model.size.format, "full") }] : []),
            ],
          }}
        />
      )}
    </div>
  );
}
