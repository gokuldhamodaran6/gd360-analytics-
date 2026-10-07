import { useMemo, type ReactNode } from "react";
import type { BlockResult, DashboardBlock, DashboardBuilderPage } from "../../api/client";
import { donutItems, firstDimension, resultOk } from "../blockData";
import { CartesianChart } from "../charts/CartesianChart";
import { DonutChart } from "../charts/DonutChart";
import { planChart } from "../charts/model";
import { adaptFileBlock } from "../fileData";
import { blockFormat } from "../format";
import type { DashboardRun } from "../useDashboardRun";
import type { ColorAssignments, DashboardAppearance, PaletteChoice } from "./appearance";
import { ChartThemeProvider, useChartTheme } from "./ChartThemeContext";

// 2026-10-07 (identity-colour round): the tiny bar + line + donut on each
// palette card of the Appearance sheet. They are the dashboard's REAL
// charts - the same planner (charts/model.planChart) and the same
// renderers (CartesianChart, DonutChart), fed this dashboard's own results
// when it has suitable ones - drawn at normal size and scaled down (their
// text hidden: index.css .palette-thumb), so a palette is judged on the
// data it will actually colour. A workspace kit
// (no dashboard yet) and a dashboard with nothing chartable use a small
// built-in sample.

export type PreviewSample = { block: DashboardBlock; result: BlockResult };
export type PreviewSamples = { bar: PreviewSample; line: PreviewSample; donut: PreviewSample; assignments: ColorAssignments };

const SAMPLE_SPEC = (group: string[], time: boolean) => ({ table: "Sample", time: time ? { column: "month", grain: "month" as const } : null, group_by: group, measures: [{ alias: "Revenue", agg: "sum", column: "revenue" }] });
function sampleBlock(id: string, type: "chart" | "donut", chart_type: string, group: string[], time = false): DashboardBlock {
  return { id, type, title: "Revenue", x: 0, y: 0, w: 6, h: 6, position: 0, config: { chart_type, spec: SAMPLE_SPEC(group, time) } } as DashboardBlock;
}
function sampleResult(columns: string[], rows: Record<string, any>[], dimensions: string[], time: string | null): BlockResult {
  return { status: "ok", columns: columns.map((name) => ({ name, type: null })), rows, row_count: rows.length, computed_in: "gd360", dimensions, measures: ["Revenue"], time_column: time, period: time ? "month" : undefined, spec: SAMPLE_SPEC(dimensions, Boolean(time)) } as BlockResult;
}
const CHANNELS = ["Online", "Partners", "Direct", "Corporate", "Groups"];
const MONTHS = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"];

export const SAMPLE_PREVIEWS: PreviewSamples = {
  bar: {
    block: sampleBlock("sample-bar", "chart", "bar", ["Channel"]),
    result: sampleResult(["Channel", "Revenue"], CHANNELS.map((c, i) => ({ Channel: c, Revenue: [92, 71, 58, 44, 27][i] })), ["Channel"], null),
  },
  line: {
    block: sampleBlock("sample-line", "chart", "line", ["Channel"], true),
    result: sampleResult(
      ["period", "Channel", "Revenue"],
      MONTHS.flatMap((m, i) => CHANNELS.slice(0, 3).map((c, j) => ({ period: m, Channel: c, Revenue: [40, 28, 18][j] + [0, 6, 4, 11, 9, 16][i] * (j === 1 ? -0.4 : 1) }))),
      ["Channel"], "period"
    ),
  },
  donut: {
    block: sampleBlock("sample-donut", "donut", "donut", ["Channel"]),
    result: sampleResult(["Channel", "Revenue"], CHANNELS.map((c, i) => ({ Channel: c, Revenue: [92, 71, 58, 44, 27][i] })), ["Channel"], null),
  },
  assignments: { Channel: Object.fromEntries(CHANNELS.map((c, i) => [c, i])) },
};

/** This dashboard's own results, as the three previews - whichever it has. */
export function previewSamples(page: Pick<DashboardBuilderPage, "blocks"> | undefined, run: Pick<DashboardRun, "results" | "overrides"> | null | undefined, mode: "warehouse" | "file", sourceName?: string | null): PreviewSamples {
  const found: PreviewSample[] = [];
  for (const block of page?.blocks || []) {
    if (block.type !== "chart" && block.type !== "donut") continue;
    if (mode === "file") {
      const adapted = adaptFileBlock(block, run?.overrides?.[block.id], { sourceName });
      if (adapted.kind === "result" && adapted.result.rows.length) found.push({ block: adapted.block, result: adapted.result });
    } else {
      const r = run?.results?.[block.id];
      if (resultOk(r) && r.rows.length) found.push({ block, result: r });
    }
  }
  const dims = (s: PreviewSample) => s.result.dimensions || [];
  const isDonut = (s: PreviewSample) => s.block.type === "donut" || ["pie", "donut"].includes(String(s.block.config?.chart_type || ""));
  const nominalBar = found.find((s) => !isDonut(s) && !s.result.time_column && dims(s).length === 1 && (s.result.measures || []).length === 1 && s.result.rows.length >= 2 && s.result.rows.length <= 8 && s.result.rows.every((row) => typeof row[dims(s)[0]] !== "number"));
  const series = found.find((s) => !isDonut(s) && Boolean(s.result.time_column) && dims(s).length === 1);
  const trend = series || found.find((s) => !isDonut(s) && Boolean(s.result.time_column));
  const donut = found.find(isDonut) || (nominalBar ? { block: { ...nominalBar.block, type: "donut" as const, id: `${nominalBar.block.id}-as-donut` }, result: nominalBar.result } : undefined);
  return {
    bar: nominalBar ? { block: { ...nominalBar.block, config: { ...nominalBar.block.config, chart_type: "bar" } }, result: nominalBar.result } : SAMPLE_PREVIEWS.bar,
    line: trend || SAMPLE_PREVIEWS.line,
    donut: donut || SAMPLE_PREVIEWS.donut,
    assignments: SAMPLE_PREVIEWS.assignments,
  };
}

const SCALE = 0.42;

function Thumb({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  // Drawn at full size, shown small; inert so the scaled chart is neither
  // focusable nor read out (the palette's name and swatches say what it is).
  return (
    <div aria-hidden="true" className="palette-thumb shrink-0 overflow-hidden" style={{ width, height }} {...({ inert: "" } as Record<string, string>)}>
      <div style={{ width: width / SCALE, height: height / SCALE, transform: `scale(${SCALE})`, transformOrigin: "0 0", pointerEvents: "none" }}>{children}</div>
    </div>
  );
}

function Charts({ samples, width }: { samples: PreviewSamples; width: number }) {
  const theme = useChartTheme();
  const bar = useMemo(() => planChart(samples.bar.result, samples.bar.block, theme), [samples.bar, theme]);
  const line = useMemo(() => planChart(samples.line.result, samples.line.block, theme), [samples.line, theme]);
  const w = Math.floor((width - 16) / 3);
  const h = 58;
  return (
    <div className="flex items-end justify-between gap-2" data-palette-preview="">
      <Thumb width={w} height={h}>{bar.kind === "chart" && <CartesianChart model={bar.model} />}</Thumb>
      <Thumb width={w} height={h}>{line.kind === "chart" && <CartesianChart model={line.model} />}</Thumb>
      <Thumb width={w} height={h}>
        <DonutChart items={donutItems(samples.donut.result)} format={blockFormat(samples.donut.block, samples.donut.result)} scope={samples.donut.block.id} column={firstDimension(samples.donut.result)} />
      </Thumb>
    </div>
  );
}

/** Bar + line + donut in `palette`, with this dashboard's pins and registry. */
export function PalettePreview({ appearance, palette, samples, width = 216, mode }: { appearance: DashboardAppearance; palette: PaletteChoice; samples: PreviewSamples; width?: number; mode?: "light" | "dark" }) {
  const preview = useMemo<DashboardAppearance>(
    () => ({ ...appearance, palette, color_mode: "by_value", single_color: null, assignments: { ...samples.assignments, ...appearance.assignments } }),
    [appearance, palette, samples.assignments]
  );
  return (
    <ChartThemeProvider appearance={preview} numbers={false} mode={mode}>
      <Charts samples={samples} width={width} />
    </ChartThemeProvider>
  );
}
