import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ChartExportApi } from "../../components/ChartCanvas";
import { formatValue } from "../format";
import { clearMeasureCache, makeMeasure } from "./geometry";
import { LABEL_SIZE, layoutChart, LEGEND_SIZE, TICK_SIZE, TITLE_SIZE, type Scene } from "./layout";
import type { ChartKind } from "./model";
import type { ChartModel } from "./model";
import { downloadSvg } from "./exportSvg";
import { ColorSwatch, useChartTheme } from "../theme/ChartThemeContext";
import { useBox } from "./useBox";

// 2026-10-07 (dashboard polish round): the dashboard's own chart - bars,
// horizontal bars, lines and areas, one panel or small multiples - drawn
// as SVG at the pixel size of the card it sits in.
//
// Why not Plotly here: a warehouse chart has to reserve room for its
// longest value label, thin its ticks to the card's width, cut a long
// category name with an ellipsis, stack panels on one shared x axis with
// one crosshair, and follow the theme's tokens - all of which need the
// text MEASURED before it is placed (charts/layout.ts). Plotly lays text
// out after the fact, which is exactly what clipped "25,278,862." and
// collided "0 10M20M". File dashboards (a stored Plotly figure), scatter
// plots and histograms still draw through components/ChartCanvas.
//
// Everything text wears an ink token (text / secondary / muted), never the
// series colour; the colour is on the mark beside it. Every mark's colour
// is the ChartModel's, and the model's come from the ChartTheme
// (theme/chartTheme.ts) - this file names no series colour.
//
// 2026-10-07 (identity-colour round): while the dashboard's owner edits
// (theme.pin), each legend key is also a button - laid over the drawn key,
// so the picture does not move - that opens the colour pin popover for
// that value or measure.
//
// 2026-10-07 (chart-types round): the same renderer also draws
//   - 100% stacks (the tooltip gives the share AND the real number),
//   - combo panels (a bar panel over line panels, one shared x axis),
//   - histograms (touching bars, the axis ticked at the bin edges),
//   - partial periods (a dashed segment and a hollow point),
//   - the FORECAST: the history as the solid line; the forecast as a
//     dashed continuation in the same hue; the 80% and 95% intervals as
//     two bands of that hue at low opacity; a thin "last complete period"
//     divider with its label; the region to its right lightly tinted; a
//     legend that names History, Forecast, 80% and 95%; a tooltip that
//     gives the range in the forecast region; and the caption underneath
//     that says how it was made and how well it backtested,
//   - anomalies: ringed markers in the theme's status colour, with a
//     tooltip that says what was expected.

const INK = "rgb(var(--color-text))";
const SECONDARY = "rgb(var(--color-secondary))";
const MUTED = "rgb(var(--color-muted))";
const SURFACE = "rgb(var(--color-surface))";
const GRID = "rgb(var(--chart-grid))";
const AXIS = "rgb(var(--chart-axis))";

const DEFAULT_SIZE = { w: 560, h: 260 };

export type CartesianChartProps = {
  model: ChartModel;
  // The category the page is filtered to (the others dim), if any.
  selectedValue?: unknown;
  hasSelection?: boolean;
  // A click (or Enter) on a category: cross-filtering.
  onPick?: (value: unknown) => void;
  title?: string;
  onExportApi?: (api: ChartExportApi | null) => void;
  minHeight?: number;
};

export function CartesianChart({ model, selectedValue, hasSelection = false, onPick, title, onExportApi, minHeight }: CartesianChartProps) {
  const [setRoot, root, size] = useBox(DEFAULT_SIZE);
  const theme = useChartTheme();
  const svgRef = useRef<SVGSVGElement>(null);
  const [fontTick, setFontTick] = useState(0);
  const [hovered, setActive] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  // Widths are measured in the chart's own font; when the web font arrives
  // after the first paint every width is measured again.
  const family = useMemo(() => (root && typeof getComputedStyle === "function" ? getComputedStyle(root).fontFamily || undefined : undefined), [root]);
  useEffect(() => {
    const fonts = typeof document !== "undefined" ? (document as any).fonts : null;
    if (!fonts?.ready?.then) return;
    let live = true;
    fonts.ready.then(() => { if (live) { clearMeasureCache(); setFontTick((n) => n + 1); } }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const scene: Scene = useMemo(
    () => layoutChart(model, size.w, size.h, { measure: makeMeasure(family) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, size.w, size.h, family, fontTick]
  );

  useEffect(() => {
    if (!onExportApi) return;
    onExportApi({ download: async (format) => { if (svgRef.current) await downloadSvg(svgRef.current, format, title || "chart"); } });
    return () => onExportApi(null);
  }, [onExportApi, title]);

  useEffect(() => { setActive((a) => (a !== null && a >= scene.shown ? null : a)); }, [scene.shown]);
  // 2026-10-07 (real end-to-end run): the hovered index is only trusted
  // while it still points at a category of THIS render's model. Clicking
  // the 2nd bar cross-filters the page - and this very chart - down to
  // that one category while the pointer is still over it, so the next
  // render arrived with hovered = 1 and one category; the effect above
  // clears it only AFTER that render, which had already thrown on
  // `model.categories[1].label` and blanked the whole page.
  const active = hovered !== null && hovered < scene.shown && hovered < model.categories.length ? hovered : null;

  const vertical = scene.orient === "v";
  // A combo has a bar panel among line panels: the hover band (not a
  // crosshair) and square legend keys follow "any bars at all".
  const isBar = scene.panels.some((p) => p.kind === "bar" || p.kind === "hbar");
  const barPanel = (key: string) => { const k = scene.panels.find((p) => p.key === key)?.kind; return k === "bar" || k === "hbar"; };
  const forecast = model.forecast || null;
  const statusColor = theme.status.serious;
  const indexAt = (x: number, y: number): number | null => {
    const a = scene.area;
    if (x < a.x - 4 || x > a.x + a.w + 4 || y < a.y - 4 || y > a.y + a.h + 4) return null;
    const at = vertical ? x : y;
    let best = 0, dist = Infinity;
    for (let i = 0; i < scene.shown; i++) {
      const d = Math.abs(scene.positions[i] - at);
      if (d < dist) { dist = d; best = i; }
    }
    return best;
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    const i = indexAt(x, y);
    setActive(i);
    setPointer(i === null ? null : { x, y });
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const next = vertical ? "ArrowRight" : "ArrowDown", prev = vertical ? "ArrowLeft" : "ArrowUp";
    if (e.key === next || e.key === prev) {
      e.preventDefault();
      setPointer(null);
      setActive((a) => (a === null ? (e.key === next ? 0 : scene.shown - 1) : Math.min(scene.shown - 1, Math.max(0, a + (e.key === next ? 1 : -1)))));
    } else if ((e.key === "Enter" || e.key === " ") && active !== null && onPick) {
      e.preventDefault();
      onPick(model.categories[active].value);
    } else if (e.key === "Escape" && active !== null) {
      setActive(null);
    }
  };

  const dimmed = (cat: number) => hasSelection && String(model.categories[cat].value) !== String(selectedValue);
  const pos = active !== null ? scene.positions[active] : null;
  const half = Math.max(8, scene.band / 2);

  // Tooltip: every series at the hovered category, value first. A 100%
  // stack gives the share and the real number; the forecast region gives
  // the forecast and its ranges; an unusual point says what was expected.
  type TipRow = { key: string; name: string; color: string | null; value: string; mark: "bar" | "line" | "dash" | "band" | "ring" | "none"; muted?: boolean };
  const tipRows: TipRow[] = [];
  let tipNote: string | null = null;
  if (active !== null) {
    model.panels.forEach((p, pi) => p.series.forEach((s, si) => {
      const name = model.panels.length > 1 ? p.title || s.name : s.name;
      const v = s.values[active];
      const fo = forecast?.series.find((o) => o.panel === pi && o.series === si) || null;
      const inForecast = Boolean(fo && active > forecast!.anchor && fo.values[active] !== null && fo.values[active] !== undefined);
      if (v !== null && v !== undefined || !inForecast) {
        if (model.categories[active]?.future && (v === null || v === undefined)) return;
        const text = model.normalized && s.raw
          ? `${formatValue(v, p.format, "full")} · ${formatValue(s.raw[active], p.rawFormat || p.format, "full")}`
          : formatValue(v, p.format, "full");
        tipRows.push({ key: `${p.key}:${s.key}`, name: inForecast ? `${name} (so far)` : name, color: s.colors?.[active] ?? s.color, value: text, mark: barPanel(p.key) ? "bar" : "line" });
      }
      if (fo && inForecast) {
        const range = (lo: (number | null)[] | null, hi: (number | null)[] | null) => (lo && hi && lo[active] !== null && hi[active] !== null ? `${formatValue(lo[active], p.format, "full")} – ${formatValue(hi[active], p.format, "full")}` : null);
        tipRows.push({ key: `${p.key}:${s.key}:f`, name: forecast!.series.length > 1 || model.panels.length > 1 ? `${name} forecast` : "Forecast", color: fo.color, value: formatValue(fo.values[active], p.format, "full"), mark: "dash" });
        const r80 = range(fo.lo80, fo.hi80), r95 = range(fo.lo95, fo.hi95);
        if (r80) tipRows.push({ key: `${p.key}:${s.key}:80`, name: "80% range", color: fo.color, value: r80, mark: "band", muted: true });
        if (r95) tipRows.push({ key: `${p.key}:${s.key}:95`, name: "95% range", color: fo.color, value: r95, mark: "band", muted: true });
      }
    }));
    const odd = (model.anomalies || []).filter((a) => a.category === active);
    for (const a of odd) {
      const p = model.panels[a.panel];
      tipRows.push({ key: `a:${a.panel}:${a.series}`, name: `Expected${odd.length > 1 ? ` (${p.series[a.series]?.name})` : ""}`, color: statusColor, value: `≈ ${formatValue(a.expected, p.format, "full")}`, mark: "ring", muted: true });
      tipNote = `Unusually ${a.direction === "up" ? "high" : "low"}: outside the usual ${formatValue(a.lo, p.format, "full")} – ${formatValue(a.hi, p.format, "full")}.`;
    }
    if (model.partial && (model.partial.first === active || model.partial.last === active)) tipNote = tipNote || "Partial period: the data does not cover all of it.";
  }
  // Placed from its measured size, so it never leaves the chart: beside the
  // crosshair where there is room on either side, over it otherwise.
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipSize, setTipSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    setTipSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
  });
  let tipX = 0, tipY = 0;
  if (pos !== null) {
    const anchorX = vertical ? pos : pointer?.x ?? scene.area.x + scene.area.w / 2;
    const anchorY = vertical ? pointer?.y ?? scene.area.y + 24 : pos;
    tipX = anchorX + 12;
    if (tipX + tipSize.w > scene.width) tipX = anchorX - 12 - tipSize.w;
    if (tipX < 0) tipX = Math.min(Math.max(anchorX - tipSize.w / 2, 0), Math.max(0, scene.width - tipSize.w));
    tipY = Math.min(Math.max(anchorY - tipSize.h / 2, 0), Math.max(0, scene.height - tipSize.h));
  }

  return (
    <div
      ref={setRoot}
      data-chart={model.histogram ? "histogram" : (model.kind as ChartKind)}
      data-chart-panels={model.panels.length}
      data-chart-normalized={model.normalized ? "" : undefined}
      data-chart-forecast={forecast ? "" : undefined}
      data-color-by={model.colorBy || undefined}
      className="relative h-full w-full"
      style={{ minHeight }}
    >
      <svg
        ref={svgRef}
        width={scene.width}
        height={scene.height}
        viewBox={`0 0 ${scene.width} ${scene.height}`}
        role="img"
        aria-label={`${title ? `${title}. ` : ""}${model.summary}. ${scene.shown} ${model.time ? "periods" : "categories"}.`}
        tabIndex={0}
        className={`ui-focus absolute left-0 top-0 block select-none rounded-[6px] ${onPick ? "cursor-pointer" : "cursor-default"}`}
        style={{ fontFamily: "inherit", fontVariantNumeric: "tabular-nums", touchAction: "pan-y" }}
        onPointerMove={onMove}
        onPointerLeave={() => { setActive(null); setPointer(null); }}
        onClick={onPick ? (e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const i = indexAt(e.clientX - box.left, e.clientY - box.top);
          if (i !== null && !model.categories[i].future) onPick(model.categories[i].value);
        } : undefined}
        onKeyDown={onKey}
        onBlur={() => { setActive(null); setPointer(null); }}
      >
        {scene.legend.length > 0 && (
          <g data-chart-legend="">
            {scene.legend.map((it) => (
              <g key={`${it.name}-${it.x}-${it.y}`} transform={`translate(${it.x} ${it.y})`} data-legend-item={it.color ? it.name : undefined}>
                {it.color && (it.mark === "dash"
                  ? <line x1={0} y1={8} x2={11} y2={8} strokeWidth={2} strokeDasharray="4 3" style={{ stroke: it.color }} />
                  : it.mark === "band80" || it.mark === "band95"
                    ? <rect x={0} y={3} width={11} height={10} rx={2} style={{ fill: it.color, fillOpacity: it.mark === "band80" ? 0.3 : 0.14 }} />
                    : it.mark === "ring"
                      ? <circle cx={5} cy={8} r={3.5} fill="none" strokeWidth={2} style={{ stroke: it.color }} />
                      : it.mark !== "line" && (it.mark === "square" || isBar || model.kind === "area")
                        ? <rect x={0} y={3} width={10} height={10} rx={2} style={{ fill: it.color }} />
                        : <line x1={0} y1={8} x2={11} y2={8} strokeWidth={2} strokeLinecap="round" style={{ stroke: it.color }} />)}
                <text x={it.color ? 16 : 0} y={12} fontSize={LEGEND_SIZE} style={{ fill: SECONDARY }}>
                  {it.text}
                  {it.text !== it.full && <title>{it.full}</title>}
                </text>
              </g>
            ))}
          </g>
        )}

        {scene.futureRegion && <rect x={scene.futureRegion.x} y={scene.futureRegion.y} width={scene.futureRegion.w} height={scene.futureRegion.h} data-forecast-region="" style={{ fill: "rgb(var(--color-subtle))", fillOpacity: 0.6 }} />}
        {scene.panels.map((p) => (
          <g key={p.key} data-chart-panel={p.key} data-panel-kind={p.kind}>
            {p.title && (
              <text x={p.title.x} y={p.title.y} fontSize={TITLE_SIZE} fontWeight={500} data-panel-title="" style={{ fill: SECONDARY }}>
                {p.title.text}
                {p.title.text !== p.title.full && <title>{p.title.full}</title>}
              </text>
            )}
            {p.grid.map((g, i) => <line key={i} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} strokeWidth={1} shapeRendering="crispEdges" style={{ stroke: GRID }} />)}
            {/* Hover: the band a bar owns lights up; a line gets a crosshair. */}
            {pos !== null && isBar && (
              vertical
                ? <rect x={pos - half} y={p.plot.y - 4} width={half * 2} height={p.plot.h + 4} rx={4} style={{ fill: "rgb(var(--color-subtle))" }} />
                : <rect x={0} y={pos - half} width={scene.width} height={half * 2} rx={4} style={{ fill: "rgb(var(--color-subtle))" }} />
            )}
            {pos !== null && !isBar && <line data-crosshair="" x1={pos} y1={p.plot.y - 4} x2={pos} y2={p.plot.y + p.plot.h} strokeWidth={1} shapeRendering="crispEdges" style={{ stroke: AXIS }} />}
            {p.baseline && <line x1={p.baseline.x1} y1={p.baseline.y1} x2={p.baseline.x2} y2={p.baseline.y2} strokeWidth={1} shapeRendering="crispEdges" style={{ stroke: AXIS }} />}
            {/* The intervals: 95% under 80%, both the series' own hue. One
                series: 0.12 / 0.2; several: lighter still, so they overlap. */}
            {p.bands.map((b, i) => <path key={`band-${i}`} d={b.d} data-forecast-band={b.level} style={{ fill: b.color, fillOpacity: (b.level === "95" ? 0.12 : 0.2) * ((forecast?.series.length || 1) > 1 ? 0.6 : 1) }} />)}
            {p.areas.map((a, i) => <path key={i} d={a.d} style={{ fill: a.color, fillOpacity: model.stacked ? 0.55 : 0.1 }} />)}
            {p.bars.map((b) => (
              <path key={`${b.cat}-${b.series}`} d={b.d} data-bar="" data-bar-category={model.categories[b.cat]?.label} data-bar-series={model.panels.find((x) => x.key === p.key)?.series[b.series]?.name} style={{ fill: b.color, opacity: dimmed(b.cat) ? 0.35 : model.partial && (model.partial.first === b.cat || model.partial.last === b.cat) ? 0.5 : 1 }} />
            ))}
            {p.lines.map((l, i) => <path key={i} d={l.d} data-line="" data-line-series={l.name} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" style={{ stroke: l.color }} />)}
            {p.dashed.map((l, i) => <path key={`dash-${i}`} d={l.d} data-partial-segment="" fill="none" strokeWidth={2} strokeDasharray="2 4" strokeLinecap="round" style={{ stroke: l.color }} />)}
            {p.forecastLines.map((l, i) => <path key={`fc-${i}`} d={l.d} data-forecast-line="" data-line-series={l.name} fill="none" strokeWidth={2} strokeDasharray="6 4" strokeLinejoin="round" strokeLinecap="round" style={{ stroke: l.color }} />)}
            {p.dots.map((d, i) => <circle key={i} cx={d.cx} cy={d.cy} r={d.r} strokeWidth={2} data-dot={d.hollow ? "hollow" : ""} style={d.hollow ? { fill: SURFACE, stroke: d.color } : { fill: d.color, stroke: SURFACE }} />)}
            {p.anomalies.map((a, i) => <circle key={`an-${i}`} cx={a.cx} cy={a.cy} r={6.5} fill="none" strokeWidth={2} data-anomaly={model.categories[a.category]?.label} style={{ stroke: statusColor }} />)}
            {pos !== null && !barPanel(p.key) && active !== null && p.points.map((ys, si) => (ys[active] === null || ys[active] === undefined ? null : (
              <circle key={si} cx={pos} cy={ys[active] as number} r={4.5} strokeWidth={2} style={{ fill: model.panels.find((x) => x.key === p.key)!.series[si].color, stroke: SURFACE }} />
            )))}
            {pos !== null && active !== null && forecast && active > forecast.anchor && p.forecastPoints.map((fp) => (fp.ys[active] === null || fp.ys[active] === undefined ? null : (
              <circle key={`fp-${fp.series}`} cx={pos} cy={fp.ys[active] as number} r={4.5} strokeWidth={2} style={{ fill: SURFACE, stroke: forecast.series[fp.series].color }} />
            )))}
            {p.labels.map((l, i) => (
              <text key={i} x={l.x} y={l.y} textAnchor={l.anchor} fontSize={LABEL_SIZE} fontWeight={500} data-value-label="" style={{ fill: INK }}>{l.text}</text>
            ))}
            {p.valueTicks.map((t, i) => (
              <text key={i} x={t.x} y={t.y} dy={vertical ? "0.32em" : undefined} textAnchor={t.anchor} fontSize={TICK_SIZE} data-value-tick="" style={{ fill: MUTED }}>{t.text}</text>
            ))}
          </g>
        ))}

        {scene.categoryTicks.map((t) => (
          <text
            key={t.index}
            x={t.x}
            y={t.y}
            textAnchor={t.anchor}
            fontSize={vertical ? TICK_SIZE : TITLE_SIZE}
            data-category-tick=""
            style={{ fill: vertical ? MUTED : SECONDARY, opacity: !vertical && dimmed(t.index) ? 0.55 : 1, pointerEvents: t.cut ? "auto" : undefined }}
          >
            {t.text}
            {t.cut && <title>{t.full}</title>}
          </text>
        ))}
        {scene.xTitle && <text x={scene.xTitle.x} y={scene.xTitle.y} textAnchor="middle" fontSize={TICK_SIZE} data-axis-title="" style={{ fill: MUTED }}>{scene.xTitle.text}</text>}
        {scene.note && (
          <text x={scene.note.x} y={scene.note.y} fontSize={TICK_SIZE} data-chart-note="" style={{ fill: MUTED }}>
            {scene.note.text}
            {scene.note.full && scene.note.full !== scene.note.text && <title>{scene.note.full}</title>}
          </text>
        )}
        {scene.divider && (
          <g data-forecast-divider="">
            <line x1={scene.divider.x} y1={scene.divider.y1} x2={scene.divider.x} y2={scene.divider.y2} strokeWidth={1} shapeRendering="crispEdges" style={{ stroke: SECONDARY }} />
            {scene.divider.label && <text x={scene.divider.label.x} y={scene.divider.label.y} textAnchor={scene.divider.label.anchor} fontSize={TICK_SIZE} style={{ fill: SECONDARY }}>{scene.divider.label.text}</text>}
          </g>
        )}
        {scene.captions.map((c, i) => (
          <text key={i} x={c.x} y={c.y} fontSize={TICK_SIZE} data-chart-caption="" style={{ fill: MUTED }}>
            {c.text}
            {c.full && c.full !== c.text && <title>{c.full}</title>}
          </text>
        ))}
      </svg>

      {/* Edit mode: a real button over each legend key (the drawn key stays
          where it is underneath). */}
      {theme.pin && scene.legend.filter((it) => it.color && it.identity).map((it) => (
        <span key={`pin-${it.name}`} className="absolute z-[1] flex" style={{ left: it.x - 4, top: it.y - 1 }} data-no-drag="">
          <ColorSwatch column={it.identity!.column} value={it.identity!.value} label={it.name} color={it.color!} ghost />
        </span>
      ))}
      {active !== null && pos !== null && (
        <div
          ref={tipRef}
          role="status"
          data-chart-tooltip=""
          className="pointer-events-none absolute z-10 rounded-ctl border border-border bg-surface px-2.5 py-2 text-caption shadow-pop"
          style={{ left: tipX, top: tipY, maxWidth: Math.max(120, Math.min(280, scene.width - 8)), visibility: tipSize.w ? "visible" : "hidden" }}
        >
          <div className="mb-1 truncate font-medium text-text">{model.categories[active].label}</div>
          {tipRows.map((r) => (
            <div key={r.key} className="flex items-center gap-2 whitespace-nowrap leading-[1.5]" data-tip-row={r.mark}>
              <span
                aria-hidden="true"
                className="inline-block shrink-0 rounded-full"
                style={
                  r.mark === "dash" ? { width: 10, height: 0, borderTop: `2px dashed ${r.color}`, borderRadius: 0 }
                    : r.mark === "band" ? { width: 10, height: 8, borderRadius: 2, background: r.color || undefined, opacity: 0.3 }
                      : r.mark === "ring" ? { width: 8, height: 8, border: `2px solid ${r.color}` }
                        : r.mark === "bar" ? { width: 8, height: 8, borderRadius: 2, background: r.color || undefined }
                          : { width: 10, height: 2, background: r.color || undefined }
                }
              />
              <span className={`min-w-0 truncate ${r.muted ? "text-muted" : "text-secondary"}`}>{r.name}</span>
              <span className={`ml-auto pl-3 tabular-nums ${r.muted ? "text-secondary" : "font-semibold text-text"}`}>{r.value}</span>
            </div>
          ))}
          {tipNote && <div className="mt-1 max-w-[240px] whitespace-normal text-muted" data-tip-note="">{tipNote}</div>}
        </div>
      )}
    </div>
  );
}
