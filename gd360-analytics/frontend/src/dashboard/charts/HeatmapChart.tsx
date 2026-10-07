import { useMemo, useState } from "react";
import type { ChartExportApi } from "../../components/ChartCanvas";
import { columnFormat, formatValue } from "../format";
import { shareText } from "./DonutChart";
import { categoryTicks, fitText, timeTicks, type DateParts, parseDateParts } from "./geometry";
import { ChartMessage, ChartTip, INK, MUTED, ON_DARK, ON_LIGHT, SECONDARY, SUBTLE, TICK_SIZE, TITLE_SIZE, useChartFrame, wrapText } from "./kit";
import type { MatrixModel } from "./matrixModel";
import { needsLightText } from "./scale";
import { layoutScaleLegend, SCALE_SWATCH_H } from "./scaleLegend";

// 2026-10-07 (chart-types round): the heatmap - one measure by two
// dimensions (hotel x market segment, month x weekday, segment x period).
//
//   cells    each its value's class on the theme's sequential ramp
//            (diverging when the values run both sides of zero), 2 px of
//            surface between them; a combination with no rows stays empty;
//   labels   row names down the left (cut with an ellipsis, full text on
//            hover), column names across the top (thinned to what fits);
//            the value is written IN the cell only when every cell is
//            large enough for it, in white or ink by the fill's luminance;
//   totals   a "Totals" toggle adds a row and a column of sums - offered
//            only for a measure that can be added up;
//   legend   the class breaks in real numbers, and how the classes were
//            chosen when that needs saying;
//   hover    row x column, the value, its share of the total; arrow keys
//            move cell by cell, Enter cross-filters by the row (or column)
//            the result's first dimension is on.

export type HeatmapChartProps = {
  model: MatrixModel;
  title?: string | null;
  selectedValue?: unknown;
  hasSelection?: boolean;
  onPick?: (value: unknown) => void;
  onExportApi?: (api: ChartExportApi | null) => void;
  minHeight?: number;
  defaultTotals?: boolean;
  compact?: boolean;
};

const MIN_ROW = 14, MAX_ROW = 34, MAX_COL = 120, GAP = 2;
// Vertical rhythm under the cells: 12 px to the legend, 14 px from the
// legend to the first note line, 15 px a note line, 5 px under the last.
const LEGEND_GAP = 12, NOTE_GAP = 14, NOTE_LINE = 15, NOTE_PAD = 5;

export function HeatmapChart({ model, title, selectedValue, hasSelection = false, onPick, onExportApi, minHeight, defaultTotals = false, compact = false }: HeatmapChartProps) {
  const frame = useChartFrame({ w: 560, h: 280 }, title, onExportApi);
  const { size, measure } = frame;
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const m = model.measures[0];
  const canTotal = m.additive && model.rows.values.length > 1 && model.cols.values.length > 1;
  const [totals, setTotals] = useState(defaultTotals && canTotal);
  const showTotals = totals && canTotal && !compact;
  const W = Math.max(120, Math.floor(size.w)), H = Math.max(96, Math.floor(size.h));

  const scene = useMemo(() => {
    const nrAll = model.rows.values.length, ncAll = model.cols.values.length;
    const cellFmt = (v: number) => formatValue(v, m.format, "compact");
    const rowLabels = model.rows.values.map((v) => model.rows.label(v));
    const gutter = compact ? 0 : Math.ceil(Math.min(Math.max(...rowLabels.map((l) => measure(l, TITLE_SIZE)), 24), Math.max(64, W * 0.3))) + 10;
    const totalFmt = columnFormat(m.format, model.rowTotals[0]);
    const totalTexts = model.rowTotals[0].map((v) => (v === null ? "" : formatValue(v, totalFmt, W < 420 ? "compact" : "full")));
    const totalColW = showTotals ? Math.ceil(Math.max(measure("Total", TICK_SIZE, 500), ...totalTexts.map((t) => measure(t, TICK_SIZE, 500)))) + 12 : 0;
    const topH = compact ? 0 : 18;
    const legend = layoutScaleLegend(model.scale, cellFmt, Math.max(120, Math.min(W - 96, 340)), measure);
    const legendH = compact ? 0 : LEGEND_GAP + legend.height;
    const notesH = (lines: number) => (lines ? NOTE_GAP + NOTE_LINE * (lines - 1) + NOTE_PAD : 2);
    const plotW = Math.max(24, W - gutter - totalColW);
    // Columns: every one when at least 3 px wide, else the latest (a time
    // axis) or the first that fit - and a line that says so.
    let nc = ncAll, colStart = 0;
    const notes: string[] = [];
    if (plotW / ncAll < 3) {
      nc = Math.max(1, Math.floor(plotW / 3));
      colStart = model.cols.kind === "time" ? ncAll - nc : 0;
      notes.push(`${model.cols.kind === "time" ? "Latest" : "First"} ${nc.toLocaleString()} of ${ncAll.toLocaleString()} columns shown; the table has them all.`);
    }
    const cellW = Math.min(MAX_COL, plotW / nc);
    if (model.scale.note && !compact) notes.push(model.scale.note);
    const noteProbe = notes.flatMap((t) => wrapText(t, W, measure, TICK_SIZE, 2));
    let availH = H - topH - legendH - notesH(noteProbe.length) - (showTotals ? 22 : 0);
    let nr = nrAll;
    if (availH / nrAll < MIN_ROW) {
      // One more note line is coming: leave room for it.
      availH -= noteProbe.length ? NOTE_LINE : notesH(1) - 2;
      nr = Math.max(1, Math.floor(availH / MIN_ROW));
      notes.unshift(`Largest ${nr.toLocaleString()} of ${nrAll.toLocaleString()} rows shown; the table has them all.`);
    }
    const rowH = Math.max(compact ? 3 : MIN_ROW, Math.min(MAX_ROW, availH / nr));
    const noteLines = compact ? [] : notes.flatMap((t) => wrapText(t, W, measure, TICK_SIZE, 2).map((line) => ({ line, full: t })));
    const xs = Array.from({ length: nc }, (_, i) => gutter + cellW * (i + 0.5));
    const colValues = model.cols.values.slice(colStart, colStart + nc);
    let ticks: { index: number; x: number; text: string; anchor: "start" | "middle" | "end"; full: string }[] = [];
    if (!compact) {
      const dates = model.cols.kind === "time" ? colValues.map((v) => parseDateParts(v)) : null;
      if (dates && dates.every(Boolean) && model.cols.grain) ticks = timeTicks(dates as DateParts[], xs, model.cols.grain, measure, gutter, gutter + cellW * nc, TICK_SIZE);
      else ticks = categoryTicks(colValues.map((v) => model.cols.short(v)), xs, cellW, measure, Math.max(0, gutter - 20), Math.min(W, gutter + cellW * nc + 20), TICK_SIZE).map((t) => ({ ...t, full: model.cols.label(colValues[t.index]) }));
    }
    // Values inside the cells only when EVERY one fits (one treatment a chart).
    let widest = 0;
    for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
      const v = model.value(0, r, colStart + c);
      if (v !== null) widest = Math.max(widest, measure(cellFmt(v), TICK_SIZE, 500));
    }
    const valueLabels = !compact && rowH >= 17 && widest > 0 && widest + 8 <= cellW - GAP;
    return { gutter, totalColW, topH, legend, legendH, nr, nc, colStart, cellW, rowH, noteLines, ticks, valueLabels, cellFmt, totalTexts, totalFmt, colValues };
  }, [model, m, W, H, measure, showTotals, compact]);

  if (!model.rows.values.length || !model.cols.values.length) return <ChartMessage kind="heatmap-empty" minHeight={minHeight}>No rows to chart.</ChartMessage>;

  const { gutter, topH, legend, nr, nc, colStart, cellW, rowH, noteLines, ticks, valueLabels, cellFmt, totalTexts, totalFmt, colValues } = scene;
  const plotW = cellW * nc, plotH = rowH * nr;
  const grand = model.grand[0];
  const crossId = hasSelection && model.cross ? String(selectedValue) : null;
  const dimmed = (r: number, c: number) => {
    if (crossId === null || !model.cross) return false;
    const v = model.cross.axis === "row" ? model.rows.values[r] : colValues[c];
    return String(v) !== crossId;
  };
  const pick = (r: number, c: number) => {
    if (!onPick || !model.cross) return;
    onPick(model.cross.axis === "row" ? model.rows.values[r] : colValues[c]);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const delta: Record<string, [number, number]> = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
    if (e.key in delta) {
      e.preventDefault();
      const [dr, dc] = delta[e.key];
      setActive((a) => (a === null ? { r: 0, c: 0 } : { r: Math.min(nr - 1, Math.max(0, a.r + dr)), c: Math.min(nc - 1, Math.max(0, a.c + dc)) }));
    } else if ((e.key === "Enter" || e.key === " ") && active) {
      e.preventDefault();
      pick(active.r, active.c);
    } else if (e.key === "Escape") setActive(null);
  };
  const live = active && active.r < nr && active.c < nc ? active : null;
  const liveValue = live ? model.value(0, live.r, colStart + live.c) : null;
  const legendY = topH + plotH + (showTotals ? 22 : 0) + LEGEND_GAP;
  const colTotalTexts = showTotals ? colValues.map((_, c) => { const v = model.colTotals[0][colStart + c]; return v === null ? "" : formatValue(v, m.format, "compact"); }) : [];
  const colTotalsFit = showTotals && colTotalTexts.every((t) => measure(t, TICK_SIZE, 500) <= cellW - 2);

  return (
    <div ref={frame.setRoot} data-chart="heatmap" data-heatmap-rows={nr} data-heatmap-cols={nc} data-heatmap-method={model.scale.method} className="relative h-full w-full" style={{ minHeight }}>
      <svg
        ref={frame.svgRef}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title ? `${title}. ` : ""}${model.summary}. ${nr} rows by ${nc} columns.`}
        tabIndex={compact ? -1 : 0}
        className={`ui-focus absolute left-0 top-0 block select-none rounded-[6px] ${onPick && model.cross ? "cursor-pointer" : "cursor-default"}`}
        style={{ fontFamily: "inherit", fontVariantNumeric: "tabular-nums" }}
        onKeyDown={compact ? undefined : onKey}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        {ticks.map((t) => (
          <text key={t.index} x={t.x} y={12} textAnchor={t.anchor} fontSize={TICK_SIZE} data-heatmap-col="" style={{ fill: MUTED }}>
            {t.text}
            {t.text !== t.full && <title>{t.full}</title>}
          </text>
        ))}
        {showTotals && <text x={gutter + plotW + scene.totalColW} y={12} textAnchor="end" fontSize={TICK_SIZE} fontWeight={500} style={{ fill: SECONDARY }}>Total</text>}
        {!compact && model.rows.values.slice(0, nr).map((v, r) => {
          const fit = fitText(model.rows.label(v), gutter - 10, measure, TITLE_SIZE);
          return (
            <text key={r} x={gutter - 10} y={topH + rowH * (r + 0.5) + 4} textAnchor="end" fontSize={TITLE_SIZE} data-heatmap-row="" style={{ fill: SECONDARY, opacity: crossId !== null && model.cross?.axis === "row" && String(v) !== crossId ? 0.55 : 1 }}>
              {fit.text}
              {fit.cut && <title>{model.rows.label(v)}</title>}
            </text>
          );
        })}
        {Array.from({ length: nr }, (_, r) => Array.from({ length: nc }, (_, c) => {
          const v = model.value(0, r, colStart + c);
          const x = gutter + cellW * c, y = topH + rowH * r;
          const w = Math.max(1, cellW - GAP), h = Math.max(1, rowH - GAP);
          const color = v === null ? null : model.scale.colorOf(v);
          const on = live?.r === r && live?.c === c;
          return (
            <g key={`${r}-${c}`} style={{ opacity: dimmed(r, c) ? 0.35 : 1 }}>
              <rect
                x={x} y={y} width={w} height={h} rx={2}
                data-heatmap-cell={v === null ? "empty" : ""}
                data-cell-row={model.rows.label(model.rows.values[r])}
                data-cell-col={model.cols.label(colValues[c])}
                data-cell-value={v ?? undefined}
                strokeWidth={on ? 1.5 : 0}
                style={{ fill: color || SUBTLE, stroke: on ? INK : "none" }}
                onPointerEnter={compact ? undefined : () => setActive({ r, c })}
                onClick={onPick && model.cross ? () => pick(r, c) : undefined}
              />
              {valueLabels && v !== null && color && (
                <text x={x + w / 2} y={y + h / 2 + 4} textAnchor="middle" fontSize={TICK_SIZE} fontWeight={500} pointerEvents="none" data-heatmap-value="" style={{ fill: needsLightText(color) ? ON_DARK : ON_LIGHT }}>{cellFmt(v)}</text>
              )}
            </g>
          );
        }))}
        {showTotals && model.rows.values.slice(0, nr).map((_, r) => (
          <text key={r} x={gutter + plotW + scene.totalColW} y={topH + rowH * (r + 0.5) + 4} textAnchor="end" fontSize={TICK_SIZE} fontWeight={500} data-heatmap-row-total="" style={{ fill: INK }}>{totalTexts[r]}</text>
        ))}
        {showTotals && (
          <g data-heatmap-col-totals="">
            <text x={gutter - 10} y={topH + plotH + 15} textAnchor="end" fontSize={TICK_SIZE} fontWeight={500} style={{ fill: SECONDARY }}>Total</text>
            {colTotalsFit && colTotalTexts.map((t, c) => (
              <text key={c} x={gutter + cellW * c + (cellW - GAP) / 2} y={topH + plotH + 15} textAnchor="middle" fontSize={TICK_SIZE} fontWeight={500} data-heatmap-col-total="" style={{ fill: INK }}>{t}</text>
            ))}
            {grand !== null && <text x={gutter + plotW + scene.totalColW} y={topH + plotH + 15} textAnchor="end" fontSize={TICK_SIZE} fontWeight={600} data-heatmap-grand="" style={{ fill: INK }}>{formatValue(grand, totalFmt, W < 420 ? "compact" : "full")}</text>}
          </g>
        )}
        {!compact && (
          <g data-heatmap-legend="" transform={`translate(0 ${legendY})`}>
            {legend.swatches.map((s, i) => <rect key={i} x={s.x} y={0} width={s.w} height={SCALE_SWATCH_H} rx={2} data-legend-swatch={i} style={{ fill: s.color }} />)}
            {legend.labels.map((l, i) => <text key={i} x={l.x} y={SCALE_SWATCH_H + 13} textAnchor={l.anchor} fontSize={TICK_SIZE} data-legend-break="" style={{ fill: MUTED }}>{l.text}</text>)}
            {/* The measure's name beside the scale - whole, or not at all. */}
            {measure(m.name, TICK_SIZE) <= W - legend.width - 100 && <text x={legend.width + 12} y={SCALE_SWATCH_H} fontSize={TICK_SIZE} style={{ fill: MUTED }}>{m.name}</text>}
          </g>
        )}
        {noteLines.map((n, i) => (
          <text key={i} x={0} y={legendY + legend.height + NOTE_GAP + i * NOTE_LINE} fontSize={TICK_SIZE} data-chart-note="" style={{ fill: MUTED }}>
            {n.line}
            {n.line !== n.full && <title>{n.full}</title>}
          </text>
        ))}
      </svg>
      {canTotal && !compact && (
        <button
          type="button"
          data-heatmap-totals=""
          data-no-drag=""
          aria-pressed={showTotals}
          className={`ui-focus absolute right-0 rounded-full border px-2 py-[1px] text-caption ${showTotals ? "border-tint-border bg-tint text-brand-ink" : "border-border bg-surface text-secondary hover:border-border-strong hover:text-text"}`}
          style={{ top: legendY - 4 }}
          onClick={() => setTotals((t) => !t)}
        >
          Totals
        </button>
      )}
      {live && !compact && (
        <ChartTip
          x={gutter + cellW * (live.c + 0.5)}
          y={topH + rowH * (live.r + 0.5)}
          width={W}
          height={H}
          content={{
            title: `${model.rows.label(model.rows.values[live.r])} · ${model.cols.label(colValues[live.c])}`,
            rows: liveValue === null
              ? [{ key: "v", name: m.name, value: "No rows", muted: true }]
              : [
                  { key: "v", name: m.name, value: formatValue(liveValue, m.format, "full"), color: model.scale.colorOf(liveValue) },
                  ...(grand && grand > 0 && liveValue >= 0 ? [{ key: "s", name: "Share of total", value: shareText(liveValue / grand), muted: true }] : []),
                  ...(model.rowTotals[0][live.r] !== null ? [{ key: "rt", name: `${model.rows.label(model.rows.values[live.r])} total`, value: formatValue(model.rowTotals[0][live.r], m.format, "full"), muted: true }] : []),
                ],
          }}
        />
      )}
    </div>
  );
}
