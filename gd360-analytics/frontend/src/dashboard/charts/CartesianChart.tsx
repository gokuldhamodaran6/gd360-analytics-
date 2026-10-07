import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ChartExportApi } from "../../components/ChartCanvas";
import { formatValue } from "../format";
import { clearMeasureCache, makeMeasure } from "./geometry";
import { LABEL_SIZE, layoutChart, LEGEND_SIZE, TICK_SIZE, TITLE_SIZE, type Scene } from "./layout";
import type { ChartModel } from "./model";
import { downloadSvg } from "./exportSvg";
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
// series colour; the colour is on the mark beside it.

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
  const isBar = model.kind === "bar" || model.kind === "hbar";
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

  // Tooltip: every series at the hovered category, value first.
  const tipRows = active === null ? [] : model.panels.flatMap((p) => p.series.map((s) => ({ key: `${p.key}:${s.key}`, name: model.panels.length > 1 ? p.title || s.name : s.name, color: s.color, value: formatValue(s.values[active], p.format, "full") })));
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
      data-chart={model.kind}
      data-chart-panels={model.panels.length}
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
          if (i !== null) onPick(model.categories[i].value);
        } : undefined}
        onKeyDown={onKey}
        onBlur={() => { setActive(null); setPointer(null); }}
      >
        {scene.legend.length > 0 && (
          <g data-chart-legend="">
            {scene.legend.map((it) => (
              <g key={`${it.name}-${it.x}-${it.y}`} transform={`translate(${it.x} ${it.y})`}>
                {it.color && (isBar || model.kind === "area"
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

        {scene.panels.map((p) => (
          <g key={p.key} data-chart-panel={p.key}>
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
            {p.areas.map((a, i) => <path key={i} d={a.d} style={{ fill: a.color, fillOpacity: 0.1 }} />)}
            {p.bars.map((b) => (
              <path key={`${b.cat}-${b.series}`} d={b.d} data-bar="" style={{ fill: b.color, opacity: dimmed(b.cat) ? 0.35 : 1 }} />
            ))}
            {p.lines.map((l, i) => <path key={i} d={l.d} data-line="" fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" style={{ stroke: l.color }} />)}
            {p.dots.map((d, i) => <circle key={i} cx={d.cx} cy={d.cy} r={d.r} strokeWidth={2} style={{ fill: d.color, stroke: SURFACE }} />)}
            {pos !== null && !isBar && active !== null && p.points.map((ys, si) => (ys[active] === null ? null : (
              <circle key={si} cx={pos} cy={ys[active] as number} r={4.5} strokeWidth={2} style={{ fill: model.panels.find((x) => x.key === p.key)!.series[si].color, stroke: SURFACE }} />
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
      </svg>

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
            <div key={r.key} className="flex items-center gap-2 whitespace-nowrap leading-[1.5]">
              <span aria-hidden="true" className="inline-block shrink-0 rounded-full" style={isBar ? { width: 8, height: 8, borderRadius: 2, background: r.color } : { width: 10, height: 2, background: r.color }} />
              <span className="min-w-0 truncate text-secondary">{r.name}</span>
              <span className="ml-auto pl-3 font-semibold tabular-nums text-text">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
