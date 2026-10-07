import { useMemo, type ReactNode } from "react";
import type { BlockResult, DashboardBlock } from "../../api/client";
import { cn } from "../../ui";
import { CartesianChart } from "../charts/CartesianChart";
import { DonutChart } from "../charts/DonutChart";
import { planChart } from "../charts/model";
import { CHART_TYPES, fits, fitsBeforeRun, recommend, type ChartShape, type ChartTypeInfo } from "../charts/recommend";
import { SpecialChart } from "../charts/SpecialChart";
import { donutItems, firstDimension } from "../blockData";
import { blockFormat } from "../format";
import { useChartTheme } from "../theme/ChartThemeContext";

// 2026-10-07 (chart-types round): the chart gallery - every form the
// dashboard draws, as a tile.
//
//   thumbnail    drawn by the REAL renderer from a small sample of the
//                block's own result (the same component the card uses, at
//                card size, scaled down) - what you pick is what you get;
//   Recommended  the form charts/recommend.ts picks for this data, with
//                its one-line reason above the tiles (the same function
//                the server uses when it chooses);
//   cannot draw  a form the block's current shape cannot be drawn as is
//                not hidden: its tile says what it needs - "needs a
//                country column", "needs two dimensions";
//   keyboard     the tiles are a radio group: Tab reaches each tile that
//                can be picked, Enter / Space picks it. A tile is a
//                role="radio" element (not a <button>: its thumbnail is a
//                real chart, whose legend has controls of its own - they
//                are inert here, and a button may not contain a button).

export const GALLERY_TYPES: ChartTypeInfo[] = CHART_TYPES.filter((t) => t.type !== "kpi" && t.type !== "table");
const SAMPLE_ROWS = 60;
const THUMB = { w: 300, h: 168, scale: 0.4 };

/** A block's result cut down to what a thumbnail needs. Time series keep
 *  their latest periods; a map and a matrix keep every row (their marks
 *  ARE the rows). */
export function sampleResult(result: BlockResult, type: string): BlockResult {
  const rows = result.rows || [];
  if (type === "map" || type === "heatmap" || type === "pivot" || type === "histogram" || rows.length <= SAMPLE_ROWS) return result;
  const sliced = result.time_column ? rows.slice(-SAMPLE_ROWS * 4) : rows.slice(0, SAMPLE_ROWS);
  return { ...result, rows: sliced, row_count: sliced.length, forecast: null, anomalies: null };
}

function Thumb({ type, block, result }: { type: string; block: DashboardBlock; result: BlockResult }) {
  const theme = useChartTheme();
  const sample = useMemo(() => sampleResult(result, type), [result, type]);
  const probe = useMemo<DashboardBlock>(() => ({ ...block, id: `${block.id}:thumb:${type}`, title: null, type: type === "donut" ? "donut" : "chart", config: { ...block.config, chart_type: type, forecast: undefined } }), [block, type]);
  let body: ReactNode = null;
  if (type === "donut" || type === "pie") {
    body = <DonutChart items={donutItems(sample)} format={blockFormat(probe, sample)} scope={probe.id} column={firstDimension(sample)} pie={type === "pie"} />;
  } else {
    const plan = planChart(sample, probe, theme);
    if (plan.kind === "special") body = <SpecialChart type={plan.type} result={sample} block={probe} compact />;
    else if (plan.kind === "chart") body = <CartesianChart model={plan.model} />;
  }
  if (!body) return null;
  return (
    <div aria-hidden="true" {...({ inert: "" } as Record<string, string>)} data-gallery-thumb={type} className="pointer-events-none relative overflow-hidden" style={{ width: THUMB.w * THUMB.scale, height: THUMB.h * THUMB.scale }}>
      <div style={{ width: THUMB.w, height: THUMB.h, transform: `scale(${THUMB.scale})`, transformOrigin: "0 0" }}>{body}</div>
    </div>
  );
}

export type ChartGalleryProps = {
  block: DashboardBlock;
  // The shape the tiles are judged against, and whether it came from a
  // run (values known) or only from a spec.
  shape: ChartShape;
  ran: boolean;
  // A result whose shape IS `shape` (thumbnails are drawn from it); null
  // when the shape is a draft that has not run.
  result: BlockResult | null;
  // The form in use (a chart_type, or "donut").
  current: string | null;
  onPick: (chartType: string) => void;
  busy?: boolean;
  // A narrower grid (inside the Edit-query sheet).
  dense?: boolean;
};

export function ChartGallery({ block, shape, ran, result, current, onPick, busy = false, dense = false }: ChartGalleryProps) {
  const rec = useMemo(() => recommend(shape), [shape]);
  const tiles = useMemo(
    () => GALLERY_TYPES.map((t) => {
      const f = ran ? fits(shape, t.type) : fitsBeforeRun(shape, t.type);
      return { ...t, ok: f.ok, why: f.ok ? null : f.why || t.needs, recommended: rec.chart_type === t.type };
    }),
    [shape, ran, rec]
  );
  const currentKey = current === "grouped_bar" ? "bar" : current === "step_line" ? "line" : current;
  const recommendedIsChart = tiles.some((t) => t.recommended);
  return (
    <div data-chart-gallery="" className="flex flex-col gap-2">
      <div className="text-caption text-secondary" data-gallery-reason="">
        <span className="font-medium text-brand-ink">Recommended:</span> {rec.reason}
        {!recommendedIsChart && <span className="text-muted"> (a {rec.chart_type === "kpi" ? "KPI tile" : "table"}, in "Swap to")</span>}
      </div>
      <div role="radiogroup" aria-label="Chart type" className={cn("grid gap-2", dense ? "grid-cols-[repeat(auto-fill,minmax(128px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(136px,1fr))]")}>
        {tiles.map((t) => {
          const selected = currentKey === t.type;
          const usable = t.ok && !busy;
          const choose = () => { if (usable && !selected) onPick(t.type); };
          return (
            <div
              key={t.type}
              role="radio"
              aria-checked={selected}
              aria-disabled={!usable}
              aria-label={`${t.label}${t.recommended && t.ok ? " (recommended)" : ""}${t.ok ? "" : ` - ${t.why}`}`}
              tabIndex={usable ? 0 : -1}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } }}
              data-gallery-tile={t.type}
              data-tile-state={!t.ok ? "blocked" : selected ? "current" : "ok"}
              data-tile-recommended={t.recommended ? "" : undefined}
              title={t.ok ? t.when.charAt(0).toUpperCase() + t.when.slice(1) : `${t.label} ${t.why}`}
              onClick={choose}
              className={cn(
                "ui-focus relative flex min-w-0 select-none flex-col items-stretch gap-1.5 rounded-ctl border p-2 text-left",
                selected ? "border-text bg-surface" : t.ok ? "cursor-pointer border-border bg-surface hover:border-border-strong hover:bg-subtle" : "cursor-default border-dashed border-border bg-transparent",
                busy && "opacity-70"
              )}
            >
              <span className="flex h-[68px] items-center justify-center overflow-hidden rounded-[6px] bg-base">
                {t.ok && result ? <Thumb type={t.type} block={block} result={result} /> : <span className="px-2 text-center text-caption text-faint" data-tile-needs="">{t.ok ? "Preview after saving" : t.why}</span>}
              </span>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn("min-w-0 truncate text-caption font-medium", t.ok ? "text-text" : "text-muted")}>{t.label}</span>
                {t.recommended && t.ok && <span className="ml-auto shrink-0 rounded-full bg-tint px-1.5 py-[1px] text-[10.5px] font-medium text-brand-ink" data-recommended-badge="">Recommended</span>}
                {selected && !t.recommended && <span className="ml-auto shrink-0 text-[10.5px] text-muted">In use</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
