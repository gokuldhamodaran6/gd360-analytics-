import { useMemo, useState } from "react";
import type { BlockResult, DashboardBlock } from "../../api/client";
import type { ChartExportApi } from "../../components/ChartCanvas";
import { formatValue, humanize, measureFormats, PLAIN_FORMAT, type ValueFormat } from "../format";
import { blockSingleColor, type ChartTheme } from "../theme/chartTheme";
import { dimInfo, resultDims, valueId } from "./dimensions";
import { barPath, categoryTicks, fitText, niceTicks } from "./geometry";
import { AXIS, ChartMessage, ChartTip, GRID, INK, LABEL_SIZE, layoutLegend, LegendRow, markNavigation, MUTED, SUBTLE, TICK_SIZE, useChartFrame, type LegendEntry } from "./kit";

// 2026-10-07 (chart-types round): the waterfall - a running total built
// from steps.
//
//   one dimension    every value a step (largest first, or the column's
//                    own order when it is a scale), ending in a Total bar;
//   a bridge         two dimensions where one has exactly TWO values (two
//                    years, plan and actual): a bar for the first, one
//                    step per value of the other dimension - what it added
//                    or took away - and a bar for the second. "Revenue
//                    2016 -> 2017 by market segment" is this.
//   colour           increases and decreases wear the theme's status
//                    colours (good / critical) and say which they are in
//                    words - a signed label on every step, a legend - so
//                    the colour is never alone; totals wear the single
//                    colour;
//   steps            more than 12 fold their smallest into one "Other".

export const WATERFALL_MAX_STEPS = 12;
const TILT_DEG = 38;
const TILT_RAD = (TILT_DEG * Math.PI) / 180;

export type WaterfallBar = { key: string; label: string; kind: "total" | "up" | "down"; value: number; from: number; to: number; raw: unknown; color: string };

export type WaterfallModel = {
  bars: WaterfallBar[];
  format: ValueFormat;
  measureName: string;
  // The column a step's click filters by, if the steps are its values.
  column: string | null;
  legend: LegendEntry[];
  note: string | null;
  summary: string;
};

export type WaterfallPlan = { kind: "ok"; model: WaterfallModel } | { kind: "message"; text: string };

export function waterfallModel(result: BlockResult, block: Pick<DashboardBlock, "config" | "title">, theme: ChartTheme): WaterfallPlan {
  const dims = resultDims(result);
  const measure = (result.measures || [])[0];
  if (!dims.length || !measure) return { kind: "message", text: "A waterfall needs a measure and a category." };
  const format = measureFormats(block, result)[measure] || PLAIN_FORMAT;
  const measureName = humanize(measure);
  const total = block.config?.color_mode === "single" ? blockSingleColor(theme, block.config) : theme.primary;
  const up = theme.status.good, down = theme.status.critical;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  let steps: { key: string; label: string; value: number; raw: unknown }[] = [];
  let start: { label: string; value: number } | null = null;
  let endLabel = "Total";
  let column: string | null = null;
  let note: string | null = null;

  if (dims.length === 1) {
    const info = dimInfo(result, dims[0]);
    column = info.kind === "time" || info.kind === "part" ? null : dims[0];
    const acc = new Map<string, { raw: unknown; v: number }>();
    for (const row of result.rows || []) {
      const v = num(row[measure]);
      if (v === null) continue;
      const id = valueId(row[dims[0]]);
      const e = acc.get(id);
      if (e) e.v += v; else acc.set(id, { raw: row[dims[0]] ?? null, v });
    }
    let list = info.values.filter((v) => acc.has(valueId(v))).map((v) => ({ key: valueId(v), label: info.label(v), value: acc.get(valueId(v))!.v, raw: v }));
    if (info.kind === "category") list = list.sort((a, b) => b.value - a.value);
    steps = list;
  } else {
    // A bridge: the dimension with exactly two values is the "from -> to".
    const a = dimInfo(result, dims[0]), b = dimInfo(result, dims[1]);
    const pair = a.values.length === 2 ? a : b.values.length === 2 ? b : null;
    const by = pair === a ? b : a;
    if (!pair) {
      return { kind: "message", text: `A waterfall bridge compares exactly two values (two years, plan and actual); this result has ${a.values.length} × ${b.values.length}. Filter one of them down to two, or draw it as a heatmap.` };
    }
    column = by.kind === "time" || by.kind === "part" ? null : by.name;
    const [fromV, toV] = pair.values;
    const cells = new Map<string, { from: number; to: number; raw: unknown }>();
    let fromTotal = 0, toTotal = 0;
    for (const row of result.rows || []) {
      const v = num(row[measure]);
      if (v === null) continue;
      const id = valueId(row[by.name]);
      let e = cells.get(id);
      if (!e) { e = { from: 0, to: 0, raw: row[by.name] ?? null }; cells.set(id, e); }
      if (valueId(row[pair.name]) === valueId(fromV)) { e.from += v; fromTotal += v; }
      else if (valueId(row[pair.name]) === valueId(toV)) { e.to += v; toTotal += v; }
    }
    start = { label: pair.label(fromV), value: fromTotal };
    endLabel = pair.label(toV);
    steps = [...cells.entries()].map(([id, e]) => ({ key: id, label: by.label(e.raw), value: e.to - e.from, raw: e.raw })).sort((x, y) => y.value - x.value);
  }
  steps = steps.filter((s) => s.value !== 0 || dims.length === 1);
  if (!steps.length && !start) return { kind: "message", text: "No rows to chart." };
  if (steps.length > WATERFALL_MAX_STEPS) {
    const ranked = [...steps].sort((x, y) => Math.abs(y.value) - Math.abs(x.value));
    const keep = new Set(ranked.slice(0, WATERFALL_MAX_STEPS - 1).map((s) => s.key));
    const rest = steps.filter((s) => !keep.has(s.key));
    steps = [...steps.filter((s) => keep.has(s.key)), { key: "\u0000other", label: "Other", value: rest.reduce((s, x) => s + x.value, 0), raw: null }];
    note = `${rest.length} smaller steps are added together as "Other".`;
  }
  const bars: WaterfallBar[] = [];
  let running = 0;
  if (start) {
    bars.push({ key: "\u0000start", label: start.label, kind: "total", value: start.value, from: 0, to: start.value, raw: null, color: total });
    running = start.value;
  }
  for (const s of steps) {
    const to = running + s.value;
    bars.push({ key: s.key, label: s.label, kind: s.value >= 0 ? "up" : "down", value: s.value, from: running, to, raw: s.raw, color: s.value >= 0 ? up : down });
    running = to;
  }
  bars.push({ key: "\u0000end", label: endLabel, kind: "total", value: running, from: 0, to: running, raw: null, color: total });
  const hasUp = bars.some((b) => b.kind === "up"), hasDown = bars.some((b) => b.kind === "down");
  const legend: LegendEntry[] = [...(hasUp ? [{ name: "Increase", color: up }] : []), ...(hasDown ? [{ name: "Decrease", color: down }] : []), { name: start ? "Start and end" : "Total", color: total }];
  return {
    kind: "ok",
    model: {
      bars, format, measureName, column, legend, note,
      summary: start ? `${measureName}: from ${start.label} to ${endLabel}, by ${humanize(column || dims[1] || dims[0]).toLowerCase()}` : `${measureName} by ${humanize(dims[0]).toLowerCase()}, building to the total`,
    },
  };
}

function signed(v: number, format: ValueFormat): string {
  const text = formatValue(Math.abs(v), format, "compact");
  return v > 0 ? `+${text}` : v < 0 ? `−${text}` : text;
}

export type WaterfallChartProps = {
  model: WaterfallModel;
  title?: string | null;
  selectedValue?: unknown;
  hasSelection?: boolean;
  onPick?: (value: unknown) => void;
  onExportApi?: (api: ChartExportApi | null) => void;
  minHeight?: number;
  compact?: boolean;
};

export function WaterfallChart({ model, title, selectedValue, hasSelection = false, onPick, onExportApi, minHeight, compact = false }: WaterfallChartProps) {
  const frame = useChartFrame({ w: 560, h: 280 }, title, onExportApi);
  const { size, measure } = frame;
  const [active, setActive] = useState<number | null>(null);
  const W = Math.max(120, Math.floor(size.w)), H = Math.max(96, Math.floor(size.h));
  const n = model.bars.length;

  const scene = useMemo(() => {
    const legend = compact ? { items: [], height: 0 } : layoutLegend(model.legend, W, measure);
    const noteFit = !compact && model.note ? fitText(model.note, W, measure, TICK_SIZE) : null;
    const top = legend.height + (compact ? 4 : 16);
    // Category names: flat under their bars when every one fits its band,
    // else tilted (a name cut to "Co…" names nothing).
    const names = model.bars.map((b) => fitText(b.label, 96, measure, TICK_SIZE));
    const widestName = Math.max(0, ...names.map((f) => f.width));
    const tilt = !compact && widestName > (W - 48) / n - 6;
    const tickH = tilt ? Math.min(76, Math.ceil(widestName * Math.sin(TILT_RAD)) + 18) : 22;
    const bottom = compact ? 4 : tickH + (noteFit ? 16 : 0);
    const plotH = Math.max(40, H - top - bottom);
    const all = model.bars.flatMap((b) => [b.from, b.to]);
    const lo = Math.min(0, ...all), hi = Math.max(0, ...all);
    const ticks = niceTicks(lo, hi, Math.max(2, Math.min(5, Math.round(plotH / 40))));
    const label = (v: number) => formatValue(v, model.format, "compact");
    // A tilted first name reaches left of its bar: the plot starts far enough in.
    const left = compact ? 2 : Math.ceil(Math.max(20, ...ticks.map((t) => measure(label(t), TICK_SIZE)), tilt ? names[0].width * Math.cos(TILT_RAD) - (W - 48) / n / 2 : 0) + 8);
    const plotW = Math.max(40, W - left - 2);
    const band = plotW / n;
    const barW = Math.max(2, Math.min(40, band * 0.62));
    const xs = model.bars.map((_, i) => left + band * (i + 0.5));
    const t0 = ticks[0], t1 = ticks[ticks.length - 1];
    const py = (v: number) => top + plotH - ((v - t0) / (t1 - t0 || 1)) * plotH;
    const texts = model.bars.map((b) => (b.kind === "total" ? label(b.value) : signed(b.value, model.format)));
    const fitsBand = texts.map((t) => !compact && measure(t, LABEL_SIZE, 500) <= band - 2);
    // One treatment for the steps: all of them labelled, or none (hover has
    // every value); the totals keep theirs either way.
    const stepsFit = model.bars.every((b, i) => b.kind === "total" || fitsBand[i]);
    const labelFits = model.bars.map((b, i) => fitsBand[i] && (b.kind === "total" || stepsFit));
    const catTicks = compact || tilt ? [] : categoryTicks(model.bars.map((b) => b.label), xs, band, measure, 0, W, TICK_SIZE);
    return { legend, noteFit, top, plotH, ticks, label, left, plotW, band, barW, xs, py, texts, labelFits, catTicks, tilt, names };
  }, [model, W, H, measure, compact, n]);

  if (!n) return <ChartMessage kind="waterfall-empty" minHeight={minHeight}>No rows to chart.</ChartMessage>;

  const { legend, noteFit, top, plotH, ticks, label, left, plotW, barW, xs, py, texts, labelFits, catTicks, tilt, names } = scene;
  const zero = py(0);
  const selectedKey = hasSelection ? String(selectedValue) : null;
  const dim = (b: WaterfallBar, i: number) => (selectedKey !== null && model.column ? b.kind !== "total" && String(b.raw) !== selectedKey : active !== null && active !== i);
  const pickable = (b: WaterfallBar) => Boolean(onPick && model.column && b.kind !== "total" && b.key !== "\u0000other");
  const live = active !== null && active < n ? active : null;

  return (
    <div ref={frame.setRoot} data-chart="waterfall" className="relative h-full w-full" style={{ minHeight }}>
      <svg
        ref={frame.svgRef}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title ? `${title}. ` : ""}${model.summary}. ${model.bars.map((b) => `${b.label} ${b.kind === "total" ? formatValue(b.value, model.format, "compact") : signed(b.value, model.format)}`).join(", ")}.`}
        tabIndex={compact ? -1 : 0}
        className="ui-focus absolute left-0 top-0 block select-none rounded-[6px]"
        style={{ fontFamily: "inherit", fontVariantNumeric: "tabular-nums" }}
        onKeyDown={compact ? undefined : markNavigation(n, live, setActive, (i) => { if (pickable(model.bars[i])) onPick!(model.bars[i].raw); })}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        <LegendRow items={legend.items} />
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={left} y1={py(t)} x2={left + plotW} y2={py(t)} strokeWidth={1} shapeRendering="crispEdges" style={{ stroke: t === 0 ? AXIS : GRID }} />
            {!compact && <text x={left - 8} y={py(t)} dy="0.32em" textAnchor="end" fontSize={TICK_SIZE} data-value-tick="" style={{ fill: MUTED }}>{label(t)}</text>}
          </g>
        ))}
        {live !== null && <rect x={xs[live] - scene.band / 2} y={top - 4} width={scene.band} height={plotH + 4} rx={4} style={{ fill: SUBTLE }} />}
        {model.bars.map((b, i) => {
          const y0 = py(Math.max(b.from, b.to)), y1 = py(Math.min(b.from, b.to));
          const h = Math.max(b.value === 0 ? 1 : 1.5, y1 - y0);
          const upward = b.to >= b.from;
          const d = barPath(xs[i] - barW / 2, upward ? y1 - h : y0, barW, h, upward ? "top" : "bottom", b.kind === "total" ? 4 : 2);
          const next = model.bars[i + 1];
          return (
            <g key={b.key} data-waterfall-bar={b.label} data-bar-kind={b.kind} data-bar-value={b.value} style={{ opacity: dim(b, i) ? 0.4 : 1, cursor: pickable(b) ? "pointer" : undefined }} onPointerEnter={compact ? undefined : () => setActive(i)} onClick={pickable(b) ? () => onPick!(b.raw) : undefined}>
              {/* Full-band hit area: a thin step is easy to miss. */}
              <rect x={xs[i] - scene.band / 2} y={top} width={scene.band} height={plotH} fill="transparent" />
              <path d={d} style={{ fill: b.color }} />
              {next && <line x1={xs[i] + barW / 2} y1={py(b.to)} x2={xs[i + 1] - barW / 2} y2={py(b.to)} strokeWidth={1} shapeRendering="crispEdges" data-waterfall-link="" style={{ stroke: AXIS }} />}
              {labelFits[i] && (
                <text x={xs[i]} y={upward ? Math.max(y1 - h - 5, 10) : Math.min(y0 + h + 13, top + plotH - 2)} textAnchor="middle" fontSize={LABEL_SIZE} fontWeight={500} data-value-label="" style={{ fill: INK }}>{texts[i]}</text>
              )}
            </g>
          );
        })}
        <line x1={left} y1={zero} x2={left + plotW} y2={zero} strokeWidth={1} shapeRendering="crispEdges" style={{ stroke: AXIS }} />
        {catTicks.map((t) => (
          <text key={t.index} x={t.x} y={top + plotH + 16} textAnchor={t.anchor} fontSize={TICK_SIZE} data-category-tick="" style={{ fill: MUTED }}>
            {t.text}
            {t.cut && <title>{t.full}</title>}
          </text>
        ))}
        {tilt && names.map((f, i) => (
          <text key={i} transform={`translate(${(xs[i] + 3).toFixed(1)} ${top + plotH + 12}) rotate(-${TILT_DEG})`} textAnchor="end" fontSize={TICK_SIZE} data-category-tick="" style={{ fill: MUTED }}>
            {f.text}
            {f.cut && <title>{model.bars[i].label}</title>}
          </text>
        ))}
        {noteFit && <text x={0} y={H - 4} fontSize={TICK_SIZE} data-chart-note="" style={{ fill: MUTED }}>{noteFit.text}{noteFit.cut && <title>{model.note}</title>}</text>}
      </svg>
      {live !== null && !compact && (
        <ChartTip
          x={xs[live]}
          y={py(Math.max(model.bars[live].from, model.bars[live].to)) + 12}
          width={W}
          height={H}
          content={{
            title: model.bars[live].label,
            rows: model.bars[live].kind === "total"
              ? [{ key: "v", name: model.measureName, value: formatValue(model.bars[live].value, model.format, "full"), color: model.bars[live].color }]
              : [
                  { key: "v", name: model.bars[live].kind === "up" ? "Increase" : "Decrease", value: `${model.bars[live].value > 0 ? "+" : model.bars[live].value < 0 ? "−" : ""}${formatValue(Math.abs(model.bars[live].value), model.format, "full")}`, color: model.bars[live].color },
                  { key: "t", name: "Running total", value: formatValue(model.bars[live].to, model.format, "full"), muted: true },
                ],
          }}
        />
      )}
    </div>
  );
}
