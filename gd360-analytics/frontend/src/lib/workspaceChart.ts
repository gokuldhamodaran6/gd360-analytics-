// How ONE chat answer is drawn in the workspace (2026-10-07, chart-integrity
// round). Pure: (result rows + chart type + what the person changed in
// "Edit chart") -> which renderer draws it, and exactly what it is given.
// components/WorkspaceChart.tsx renders the outcome; Workspace.tsx also reads
// `figure` / `columns` / `rows` from it for "Save chart" and "Add to
// dashboard", so what is saved is what is on screen.
//
// The rule, in order:
//
//   1. THE ROWS DECIDE. When the answer carries result_columns/result_rows,
//      the chart is derived from them through the chart model
//      (lib/chartModel.ts) - never taken from the stored Plotly figure. A
//      stored figure that contradicts its rows is reported (checkedFigure,
//      one `[chart_audit]` console line) and not drawn.
//   2. NATIVE FIRST. A chart the model can express - line, area, bar,
//      horizontal bar, grouped / stacked bar, stacked area, step line, pie,
//      donut, a single value, a table - is drawn by the app's own renderer
//      (src/dashboard/charts): measured SVG, straight segments, a category
//      or time axis, small multiples for measures of very different scale.
//      The same renderer a dashboard uses, so the chart looks the same in
//      chat and on a dashboard.
//   3. PLOTLY ONLY WHERE NATIVE CANNOT. A chart the model does not describe
//      (scatter with its regression, histogram, box, heatmap, sankey, maps,
//      facet grids ...) keeps its Plotly figure, restyled by
//      dashboard/plotlyKit. And a standard chart on which the person has set
//      a Style option only Plotly honours (data labels on/off, a tilted
//      axis, a font size, no grid, a legend for one series, a palette on a
//      pie) is drawn by Plotly too, through lib/chartStyle - from the SAME
//      model-built figure, so it is still the right chart.
//   3b. (2026-10-07, chart-types round) ...EXCEPT WHERE THE ROWS HAVE A
//      NATIVE SHAPE. A scatter / bubble / heatmap / treemap / funnel /
//      waterfall / map answer whose rows are already one row per mark (a
//      dimension or two and the measures - what charts/recommend.fits
//      accepts for that form) is drawn by the dashboard's own renderer for
//      it (charts/SpecialChart). Raw point clouds, pre-binned figures and
//      anything the person has restyled stay on Plotly as before.
//   3c. A native line / area / bar over time can take a FORECAST ("Add
//      forecast" on the Chart tab): the series the chart already holds is
//      sent to POST /dashboard-builder/forecast/series - the same
//      forecaster a dashboard block uses - and drawn by the same renderer
//      (forecastRequest / withForecast below).
//   4. NEVER A WRONG CHART. Rows that cannot be drawn as the requested chart
//      without misrepresenting them are shown as their table, with the
//      plain sentence that says why.

import type { BlockForecast, BlockResult, BlockSpecMeasure, DashboardBlock } from "../api/client";
import { planChart, type ChartModel as NativeChartModel, type SpecialChartType } from "../dashboard/charts/model";
import { fits, shapeFromResult } from "../dashboard/charts/recommend";
import { DEFAULT_CHART_THEME, type ChartTheme } from "../dashboard/theme/chartTheme";
import type { DonutItem } from "../dashboard/charts/DonutChart";
import { parseDateParts } from "../dashboard/charts/geometry";
import { inferGrain } from "../dashboard/fileData";
import { blockFormat, formatValue, humanize, looksLikeRateName, type ValueFormat } from "../dashboard/format";
import {
  axisLabelOk, checkedFigure, classifyColumns, deriveChartModel, figureFromModel, isPlaceholderName, modelAxisTitles, PIE_TYPES, valueAxisLabelOk, yAxisNames,
  type ModelRoles, type ResultChartModel,
} from "./chartModel";
import { applyChartStyle, defaultChartStyle, stylePaletteColors, type ChartStyle } from "./chartStyle";
import { buildExploreFigure, CLIENT_PIVOTABLE_TYPES, exploreTable, type ExploreConfig, type ResultColumn } from "./exploreEngine";

export type WorkspaceChartInput = {
  columns?: ResultColumn[] | null;
  rows?: Record<string, any>[] | null;
  truncated?: boolean;
  // The chart type the backend drew ("line", "grouped_bar", "scatter" ...,
  // or "table" when it declined to draw one).
  chartType?: string | null;
  // The stored / backend Plotly figure.
  storedSpec?: any;
  // The person's "Edit chart" mapping, once they have opened it.
  explore?: ExploreConfig | null;
  // ONLY the Style-panel options the person has actually set. Everything
  // else follows the defaults of the chart that is drawn (so switching a
  // bar to a line in Edit chart does not leave "data labels: on", a bar
  // default, behind as if the person had asked for it).
  styleOverrides?: Partial<ChartStyle> | null;
  title?: string | null;
  // A stable id for colour memory and the audit log (the message id).
  id?: string | null;
  // 2026-10-07 (identity-colour round): where the native chart's colours
  // come from - the workspace brand kit's palette and this data source's
  // own colour memory (WorkspaceChart passes useChartTheme()). Absent: the
  // kit's tokens, one colour a measure.
  theme?: ChartTheme | null;
};

export type NativeDrawing =
  // `source`: what the model was planned from, kept so a forecast can be
  // added to it later (withForecast) through the very same steps.
  | { kind: "cartesian"; model: NativeChartModel; source?: { result: BlockResult; block: DashboardBlock; finish: (m: NativeChartModel) => NativeChartModel; theme: ChartTheme } }
  // A form of its own (map, heatmap, scatter, treemap, funnel, waterfall),
  // drawn by charts/SpecialChart from the answer's rows.
  | { kind: "special"; type: SpecialChartType; result: BlockResult; block: DashboardBlock }
  | { kind: "donut"; items: DonutItem[]; pie: boolean; format: ValueFormat; scope: string; column: string | null }
  | { kind: "kpi"; tiles: { key: string; label: string; value: string }[] };

export type ResolvedWorkspaceChart = {
  path: "native" | "plotly" | "table" | "empty";
  native?: NativeDrawing;
  // mode "kit": restyled by dashboard/plotlyKit. mode "styled": the
  // person's Style options applied by lib/chartStyle.
  plotly?: { figure: any; mode: "kit" | "styled"; reason: string };
  table?: { reason: string | null };
  // The table that is charted (the Edit-chart mapping's table when there
  // is one) and the chart type it is charted as.
  columns: ResultColumn[];
  rows: Record<string, any>[];
  chartType: string | null;
  model: ResultChartModel | null;
  // The audited, unstyled Plotly figure of exactly what is shown - what
  // "Save chart" styles and saves, what the Style panel reads its series
  // from. null for a table.
  figure: any | null;
  // The effective style: the drawn chart's defaults + the person's own
  // choices. What "Save chart" applies and the Style panel shows.
  style: ChartStyle;
  // How a stored figure disagreed with its rows (empty when it did not).
  problems: string[];
  rebuilt: boolean;
  note: string | null;
};

const EMPTY: ResolvedWorkspaceChart = { path: "empty", columns: [], rows: [], chartType: null, model: null, figure: null, style: defaultChartStyle(), problems: [], rebuilt: false, note: null };

/** The drawn chart's default style with the person's own choices on top. */
export function effectiveStyle(figure: any, overrides: Partial<ChartStyle> | null | undefined): ChartStyle {
  return { ...defaultChartStyle(figure), ...(overrides || {}) };
}

// Options that never need a different renderer: the title is drawn by the
// page (above the chart), not by the figure.
const PAGE_ONLY_STYLE_KEYS = new Set(["title"]);

/** Why a Style choice sends a standard chart to Plotly, or null when the
 *  native renderer honours everything that is set. Compared against the
 *  defaults a fresh chart of this shape starts with, so an untouched chart
 *  is always native. */
export function styleNeedsPlotly(style: ChartStyle | null | undefined, baseFigure: any, kind: "cartesian" | "pie" | "kpi"): string | null {
  if (!style || kind === "kpi") return null;
  const d = defaultChartStyle(baseFigure);
  if (!style.showGrid) return "gridlines are switched off";
  if (style.dataLabels !== d.dataLabels) return `data labels are switched ${style.dataLabels ? "on" : "off"}`;
  if (style.xAxisTilt !== d.xAxisTilt) return "the axis labels are tilted";
  if (style.fontSize !== "medium") return "a custom font size is set";
  if (style.showLegend && !d.showLegend) return "a legend is switched on for a single series";
  if (kind === "pie" && style.paletteId !== "original") return "a custom palette is set on a pie";
  return null;
}

function rateFormat(name: string, values: (number | null)[]): BlockSpecMeasure["agg"] {
  // "avg" lets dashboard/format infer a percent for a 0-1 rate; anything
  // else is "max": a value that is NOT claimed to be additive (so a long
  // result's tail is never summed into an "Other" it may not be).
  const present = values.filter((v): v is number => v !== null);
  return present.length > 0 && looksLikeRateName(name) && present.every((v) => v >= 0 && v <= 1) ? "avg" : "max";
}

/** The chart model as the BlockResult + view block the native renderer's
 *  own planner (dashboard/charts/model.planChart) consumes - the same
 *  shapes a dashboard block has, so the same code draws both. */
export function modelToBlock(model: ResultChartModel, id: string, title: string | null): { result: BlockResult; block: DashboardBlock } | null {
  if (!model.x || (model.kind !== "cartesian" && model.kind !== "pie")) return null;
  const xName = model.x.name;
  const labels = model.x.labels;
  const isTime = model.x.axis === "time" && labels.length > 0 && labels.every((l) => parseDateParts(l) !== null);
  let rows: Record<string, any>[];
  let dimensions: string[];
  let measures: string[];
  let aggs: Record<string, BlockSpecMeasure["agg"]>;
  if (model.series_by && model.measure) {
    const measure = model.measure;
    rows = [];
    labels.forEach((lab, i) => {
      for (const s of model.series) if (s.values[i] !== null) rows.push({ [xName]: lab, [model.series_by as string]: s.name, [measure]: s.values[i] });
    });
    dimensions = [xName, model.series_by];
    measures = [measure];
    aggs = { [measure]: rateFormat(measure, model.series.flatMap((s) => s.values)) };
  } else {
    rows = labels.map((lab, i) => {
      const row: Record<string, any> = { [xName]: lab };
      for (const s of model.series) row[s.name] = s.values[i];
      return row;
    });
    dimensions = [xName];
    measures = model.series.map((s) => s.name);
    aggs = Object.fromEntries(model.series.map((s) => [s.name, rateFormat(s.name, s.values)]));
  }
  const grain = isTime ? inferGrain(rows, xName) : null;
  const groupBy = isTime ? dimensions.slice(1) : dimensions;
  const spec = {
    table: "",
    time: isTime && grain ? { column: xName, grain } : null,
    group_by: groupBy,
    measures: measures.map((m) => ({ alias: m, agg: aggs[m], column: m })),
  };
  const ct = model.chart_type;
  const result: BlockResult = {
    status: "ok",
    columns: [{ name: xName, type: null }, ...(model.series_by ? [{ name: model.series_by, type: "string" }] : []), ...measures.map((m) => ({ name: m, type: "number" }))],
    rows,
    row_count: rows.length,
    computed_in: "gd360",
    dimensions: groupBy,
    measures,
    time_column: isTime ? xName : null,
    period: grain || undefined,
    spec,
  };
  const block: DashboardBlock = {
    id, type: "chart", title, x: 0, y: 0, w: 12, h: 6, position: 0,
    config: {
      chart_type: ct,
      spec,
      // A grouped / stacked chart is ONE quantity with a column per series:
      // its columns share an axis whatever their sizes (dashboard/fileData
      // sets the same flag for a stored grouped chart).
      shared_axis: ct === "grouped_bar" || ct === "stacked_bar" || ct === "stacked_area" || undefined,
    },
  } as DashboardBlock;
  return { result, block };
}

// The answer chart types that have a native form of their own, and the
// most rows one is drawn from (a mark per row).
const SPECIAL_FROM_CHAT: Record<string, SpecialChartType> = {
  scatter: "scatter", bubble: "bubble", heatmap: "heatmap", treemap: "treemap", funnel: "funnel", waterfall: "waterfall", choropleth: "map", map: "map",
};
export const SPECIAL_MAX_ROWS = 400;
// Forms that only make sense for a quantity that adds up.
const PART_TO_WHOLE = new Set(["treemap", "funnel", "waterfall"]);

/** An answer's rows as the native form of its chart type, when they have
 *  that form's shape: one row per mark, a dimension or two, the measures.
 *  null = not this shape (the caller keeps the Plotly figure). */
export function specialDrawing(columns: ResultColumn[], rows: Record<string, any>[], chartType: string, id: string, title: string | null): Extract<NativeDrawing, { kind: "special" }> | null {
  const type = SPECIAL_FROM_CHAT[chartType];
  if (!type || !rows.length || rows.length > SPECIAL_MAX_ROWS) return null;
  const roles = classifyColumns(columns as any, rows);
  const dims = roles.filter((c) => c.role === "dimension").map((c) => c.name);
  const measures = roles.filter((c) => c.role === "measure").map((c) => c.name);
  if (!measures.length || dims.length < 1 || dims.length > 2) return null;
  // One row per mark: an aggregated result, never raw rows.
  const seen = new Set<string>();
  for (const r of rows) {
    const key = dims.map((d) => String(r[d])).join("\u0001");
    if (seen.has(key)) return null;
    seen.add(key);
  }
  const aggOf = (m: string): BlockSpecMeasure["agg"] => {
    const kind = rateFormat(m, rows.map((r) => (typeof r[m] === "number" ? r[m] : null)));
    return kind === "avg" ? "avg" : PART_TO_WHOLE.has(type) ? "sum" : "max";
  };
  const spec = { table: "", time: null, group_by: dims, measures: measures.map((m) => ({ alias: m, agg: aggOf(m), column: m })) };
  const result: BlockResult = {
    status: "ok",
    columns: [...dims.map((d) => ({ name: d, type: "string" })), ...measures.map((m) => ({ name: m, type: "number" }))],
    rows, row_count: rows.length, computed_in: "gd360", dimensions: dims, measures, time_column: null, spec,
  };
  if (!fits(shapeFromResult(result, spec), type).ok) return null;
  const block = { id, type: "chart", title, x: 0, y: 0, w: 12, h: 6, position: 0, config: { chart_type: type, spec } } as DashboardBlock;
  return { kind: "special", type, result, block };
}

export type ForecastRequest = {
  periods: string[]; grain: string; measure: string; series_by: boolean;
  series: { key: string; values: (number | null)[] }[]; additive: boolean; rate: boolean;
};
export const FORECAST_MAX_SERIES = 4;

/** What "Add forecast" sends for the chart on screen, or null when that
 *  chart is not a line / area / bar over time (or was drawn by Plotly). */
export function forecastRequest(resolved: ResolvedWorkspaceChart): ForecastRequest | null {
  const native = resolved.path === "native" && resolved.native?.kind === "cartesian" ? resolved.native : null;
  if (!native?.source || !native.model.time || native.model.kind === "hbar" || native.model.stacked || native.model.normalized) return null;
  const { result } = native.source;
  const time = result.time_column;
  const measures = result.measures || [];
  if (!time || !measures.length) return null;
  const rows = result.rows || [];
  const periods = Array.from(new Set(rows.map((r) => String(r[time])))).sort();
  if (periods.length < 3) return null;
  const at = new Map(periods.map((p, i) => [p, i]));
  const blank = () => new Array<number | null>(periods.length).fill(null);
  const by = (result.dimensions || [])[0] || null;
  const series: { key: string; values: (number | null)[] }[] = [];
  if (by) {
    const m = measures[0];
    const byKey = new Map<string, (number | null)[]>();
    for (const r of rows) {
      const key = r[by] === null || r[by] === undefined ? "(Blanks)" : String(r[by]);
      if (!byKey.has(key)) byKey.set(key, blank());
      if (typeof r[m] === "number") (byKey.get(key) as (number | null)[])[at.get(String(r[time])) as number] = r[m];
    }
    for (const [key, values] of byKey) series.push({ key, values });
  } else {
    for (const m of measures) {
      const values = blank();
      for (const r of rows) if (typeof r[m] === "number") values[at.get(String(r[time])) as number] = r[m];
      series.push({ key: m, values });
    }
  }
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const rate = measures.every((m) => looksLikeRateName(m)) && all.every((v) => v >= 0 && v <= 1);
  // A chat answer does not say how its numbers were aggregated: a period
  // with no row is treated as missing, never as a zero.
  return { periods, grain: result.period || "month", measure: measures[0], series_by: Boolean(by), series, additive: false, rate };
}

/** The same chart with a forecast on it: planned again from the rows it
 *  was planned from, with the forecast attached - so the forecast is drawn
 *  by exactly the code that draws a dashboard block's. */
export function withForecast(resolved: ResolvedWorkspaceChart, forecast: BlockForecast | null): ResolvedWorkspaceChart {
  const native = resolved.path === "native" && resolved.native?.kind === "cartesian" ? resolved.native : null;
  if (!native?.source || !forecast) return resolved;
  const { result, block, finish, theme } = native.source;
  const plan = planChart({ ...result, forecast, anomalies: forecast.anomalies || null }, { ...block, config: { ...block.config, forecast: { horizon: forecast.horizon, interval: forecast.interval } } }, theme);
  if (plan.kind !== "chart") return resolved;
  return { ...resolved, native: { ...native, model: finish(plan.model) } };
}

/** The Style options the native renderer honours, applied to its model:
 *  series names, axis titles, legend off, a palette on bars / lines. */
function styleNative(native: NativeChartModel, style: ChartStyle | null | undefined, hints: { x: string; y: string }): NativeChartModel {
  const panels = native.panels.map((p) => ({ ...p, series: p.series.map((s) => ({ ...s })) }));
  let legend = native.legend ? native.legend.map((l) => ({ ...l })) : null;
  let xTitle = native.xTitle;
  const flat = panels.flatMap((p) => p.series);
  const single = panels.length === 1;

  // Axis wording the answer itself supplied, already checked to name the
  // columns on that axis (chartModel.modelAxisTitles).
  if (hints.x && !native.time) xTitle = hints.x;
  if (hints.y && single) panels[0].title = hints.y;
  // A lone series whose column has no real name (an older answer's rows
  // are just "label" / "value") is called what the value axis is called -
  // the tooltip reads "Total revenue 11,673,501", not "Value 11,673,501".
  if (hints.y && flat.length === 1 && isPlaceholderName(flat[0].key)) flat[0].name = hints.y;
  if (style) {
    if (style.xAxisLabel.trim()) xTitle = style.xAxisLabel.trim();
    if (style.yAxisLabel.trim() && single) panels[0].title = style.yAxisLabel.trim();
    if (style.seriesNames.length && flat.length > 1) {
      flat.forEach((s, i) => {
        const name = (style.seriesNames[i] || "").trim();
        if (!name) return;
        if (legend) legend = legend.map((l) => (l.name === s.name ? { ...l, name } : l));
        if (!single) {
          const panel = panels.find((p) => p.series.includes(s));
          if (panel && panel.series.length === 1) panel.title = name;
        }
        s.name = name;
      });
    }
    const colors = stylePaletteColors(style, flat.length);
    if (colors) {
      // A palette the person picked in the Style panel is their own choice
      // for THIS chart: it replaces the theme's colours, per-bar ones included.
      flat.forEach((s, i) => {
        if (legend) legend = legend.map((l) => (l.color === s.color && l.name === s.name ? { ...l, color: colors[i] } : l));
        s.color = colors[i];
        delete s.colors;
      });
    }
    // (A forecast's legend - History, Forecast, the intervals - is not the
    // series legend the Style switch is about: it stays.)
    if (!style.showLegend && !native.forecast) legend = null;
  }
  return { ...native, panels, legend, xTitle };
}

function figureAxisTitle(figure: any, key: string): string {
  const t = figure?.layout?.[key]?.title;
  return typeof t === "string" ? t : typeof t?.text === "string" ? t.text : "";
}

/** How a chat answer's chart is drawn. See the module comment. */
export function resolveWorkspaceChart(input: WorkspaceChartInput): ResolvedWorkspaceChart {
  const { storedSpec, explore } = input;
  const overrides = input.styleOverrides || null;
  const title = (input.title || "").trim() || null;
  const id = input.id || "workspace-chart";
  const sourceColumns = input.columns?.length ? input.columns : null;
  const sourceRows = Array.isArray(input.rows) && input.rows.length ? input.rows : null;
  const editing = Boolean(explore && sourceColumns && sourceRows && (CLIENT_PIVOTABLE_TYPES as string[]).includes(explore.chartType));

  const plotly = (figure: any, reason: string, extra: Partial<ResolvedWorkspaceChart> = {}): ResolvedWorkspaceChart => {
    // The person's Style choices only apply through lib/chartStyle; an
    // untouched figure is restyled by the kit like a dashboard's.
    const style = effectiveStyle(figure, overrides);
    const custom = Object.keys(overrides || {}).some((k) => !PAGE_ONLY_STYLE_KEYS.has(k));
    return {
      ...EMPTY, path: "plotly", figure, style, columns: sourceColumns || [], rows: sourceRows || [], chartType: input.chartType ?? null,
      plotly: custom ? { figure: applyChartStyle(figure, style, title || undefined), mode: "styled", reason } : { figure, mode: "kit", reason },
      ...extra,
    };
  };

  // ---- no rows: nothing to derive from, the stored figure is all there is ----
  if (!sourceColumns || !sourceRows) {
    if (!storedSpec) return EMPTY;
    return plotly(storedSpec, "this answer was saved without its rows");
  }

  // ---- the table that is charted, and as what ----
  let columns = sourceColumns;
  let rows = sourceRows;
  let chartType = input.chartType ?? null;
  let roles: ModelRoles | null = null;
  if (editing && explore) {
    chartType = explore.chartType;
    if (explore.chartType === "scatter" || explore.chartType === "histogram") {
      const figure = buildExploreFigure(sourceColumns, sourceRows, explore);
      if (!figure) return { ...EMPTY, path: "table", table: { reason: "Choose the fields to plot in Edit chart." }, columns, rows, chartType };
      return plotly(figure, `a ${explore.chartType} has no rows-by-category form`, { chartType });
    }
    const table = exploreTable(sourceColumns, sourceRows, explore);
    if (!table) return { ...EMPTY, path: "table", table: { reason: "Choose an X-axis field and at least one Y-axis field in Edit chart." }, columns, rows, chartType };
    columns = table.columns;
    rows = table.rows;
    roles = table.roles;
  }

  const model = deriveChartModel(columns, rows, chartType, roles);
  if (editing && explore && !model.note) {
    // Edit chart plots one Y field on a pie, and one when a series field
    // splits the chart - the others stay mapped but are not drawn. Say so
    // on the chart, exactly as the model does for an answer's own pie.
    const mapped = explore.yFields.map((y) => y.field).filter((f) => f && f !== explore.xField);
    const drawn = new Set(roles?.measures || []);
    const left = mapped.filter((f) => !drawn.has(f));
    if (left.length && roles?.measures.length) model.note = `Showing ${roles.measures.join(", ")}. ${left.join(", ")} ${left.length === 1 ? "is" : "are"} not drawn on this chart.`;
  }
  const common = { columns, rows, chartType: model.chart_type, model };

  if (model.kind === "passthrough") {
    // A form the dashboard draws natively, when the rows have its shape
    // and the person has not restyled the figure (Style is Plotly's).
    const restyled = Object.keys(overrides || {}).some((k) => !PAGE_ONLY_STYLE_KEYS.has(k));
    const special = !input.truncated && !editing && !restyled ? specialDrawing(columns, rows, model.chart_type, id, title) : null;
    if (special) {
      return { ...EMPTY, ...common, path: "native", native: special, figure: storedSpec ?? null, style: effectiveStyle(storedSpec, overrides) };
    }
    if (!storedSpec) return { ...EMPTY, ...common, path: "table", table: { reason: `A ${model.chart_type.replace(/_/g, " ")} chart is built by GD360's analysis engine; its figure is not available here, so the rows are shown.` } };
    return plotly(storedSpec, `a ${model.chart_type.replace(/_/g, " ")} chart has no rows-by-category form`, common);
  }
  if (input.truncated && !editing) {
    return { ...EMPTY, ...common, path: "table", table: { reason: `This result has more than ${rows.length.toLocaleString("en-US")} rows; a chart of only the first ${rows.length.toLocaleString("en-US")} would be misleading, so it is shown as a table.` } };
  }
  if (model.kind === "table") return { ...EMPTY, ...common, path: "table", table: { reason: model.reason } };

  // ---- the audited figure of what is shown ----
  let figure: any;
  let problems: string[] = [];
  let rebuilt = false;
  if (editing) {
    // Opening Edit chart must not change the chart: the answer's own axis
    // titles ("Arrival Year", "Total Revenue (USD)") stay for as long as
    // they still describe what is on that axis. A different X field, a
    // single different measure or a count drops them for the field's name.
    const storedPrimary = (Array.isArray(storedSpec?.data) ? storedSpec.data : []).find((t: any) => t && !(t.meta && typeof t.meta === "object" && t.meta.role && t.meta.role !== "primary"));
    const storedHorizontal = storedPrimary?.orientation === "h";
    const storedCategory = figureAxisTitle(storedSpec, storedHorizontal ? "yaxis" : "xaxis");
    const storedValue = figureAxisTitle(storedSpec, storedHorizontal ? "xaxis" : "yaxis");
    const counted = Boolean(explore?.yFields.some((y) => y.agg === "count"));
    const measureNames = roles?.measures || [];
    const xLabel = storedCategory && model.x && axisLabelOk(storedCategory, [model.x.name], yAxisNames(model)) ? storedCategory : roles?.x;
    const yLabel = storedValue && !counted && valueAxisLabelOk(storedValue, model) ? storedValue : measureNames.length === 1 ? measureNames[0] : "";
    figure = figureFromModel(model, { xLabel, yLabel });
  } else {
    const checked = checkedFigure(storedSpec, columns, rows, chartType, { context: `message=${id}` });
    figure = checked.figure;
    problems = storedSpec ? checked.problems : [];
    rebuilt = checked.rebuilt && Boolean(storedSpec);
  }
  if (!figure) return { ...EMPTY, ...common, path: "table", table: { reason: "This result could not be drawn as a chart without misrepresenting it, so it is shown as a table." }, problems };
  const style = effectiveStyle(figure, overrides);
  const audited = { ...common, figure, style, problems, rebuilt, note: model.note };

  // ---- a single value ----
  if (model.kind === "kpi") {
    const tiles = model.series.filter((s) => s.values[0] !== null).map((s) => {
      const view = { title, config: { spec: { table: "", measures: [{ alias: s.name, agg: rateFormat(s.name, s.values), column: s.name }] } } };
      const format = blockFormat(view as any, { status: "ok", columns: [], rows: [{ [s.name]: s.values[0] }], row_count: 1, measures: [s.name] } as BlockResult);
      return { key: s.name, label: isPlaceholderName(s.name) ? title || "Value" : humanize(s.name), value: formatValue(s.values[0], format, "auto") };
    });
    return { ...EMPTY, ...audited, path: "native", native: { kind: "kpi", tiles } };
  }

  // ---- a Style option only Plotly honours ----
  const why = styleNeedsPlotly(style, figure, model.kind);
  if (why) {
    return { ...EMPTY, ...audited, path: "plotly", plotly: { figure: applyChartStyle(figure, style, title || undefined), mode: "styled", reason: why } };
  }

  // ---- native ----
  // Identity colour is keyed by column name. An older answer's rows are
  // just "label" / "value": those names say nothing about what the values
  // are, so such a chart keeps the palette's fixed order instead of
  // registering unrelated values under one made-up column.
  const namedColumns = Boolean(model.x && !isPlaceholderName(model.x.name) && !(model.series_by && isPlaceholderName(model.series_by)));
  const given = input.theme || DEFAULT_CHART_THEME;
  const theme: ChartTheme = namedColumns ? given : { ...given, observe: () => undefined, column: () => ({ known: false, overflow: false }) };
  const adapted = modelToBlock(model, id, title);
  if (!adapted) return { ...EMPTY, ...audited, path: "plotly", plotly: { figure, mode: "kit", reason: "the chart has no native form" } };
  const horizontal = model.horizontal;
  const hints = model.transposed
    ? { x: "", y: "" }
    : modelAxisTitles(model, figureAxisTitle(figure, horizontal ? "yaxis" : "xaxis"), figureAxisTitle(figure, horizontal ? "xaxis" : "yaxis"));
  if (model.kind === "pie") {
    const names = style.seriesNames || [];
    const items: DonutItem[] = [];
    model.x!.labels.forEach((label, i) => {
      const value = model.series[0].values[i];
      if (value !== null) items.push({ label: (names[i] || "").trim() || label, value });
    });
    return { ...EMPTY, ...audited, path: "native", native: { kind: "donut", items, pie: model.chart_type === "pie", format: blockFormat(adapted.block, adapted.result), scope: id, column: namedColumns ? model.x!.name : null } };
  }
  const plan = planChart(adapted.result, adapted.block, theme);
  if (plan.kind === "table") return { ...EMPTY, ...audited, figure: null, path: "table", table: { reason: plan.reason } };
  if (plan.kind !== "chart") {
    return { ...EMPTY, ...audited, path: "plotly", plotly: { figure, mode: "kit", reason: "the chart has no native form" } };
  }
  // Everything done to the planned model before it is drawn - kept as one
  // step so a chart with a forecast added goes through it too.
  const finish = (planned: NativeChartModel): NativeChartModel => {
    let native = planned;
    if (isPlaceholderName(model.x!.name) || model.transposed) native = { ...native, xTitle: null };
    native = styleNative(native, style, { x: isPlaceholderName(model.x!.name) ? "" : hints.x, y: hints.y });
    // Both notes matter: what the native chart folded ("the 6 largest of 7")
    // and what the model left out ("Showing bookings. canceled_bookings is in
    // the table.").
    if (model.note) native = { ...native, note: native.note ? `${model.note} ${native.note}` : model.note };
    return native;
  };
  return { ...EMPTY, ...audited, path: "native", native: { kind: "cartesian", model: finish(plan.model), source: { result: adapted.result, block: adapted.block, finish, theme } } };
}

/** Which of an answer's chart features run on which renderer - the one
 *  place the report's "native vs Plotly" table is true by construction. */
export function describePath(resolved: ResolvedWorkspaceChart): string {
  if (resolved.path === "native") return `native ${resolved.native?.kind}`;
  if (resolved.path === "plotly") return `plotly (${resolved.plotly?.mode}): ${resolved.plotly?.reason}`;
  if (resolved.path === "table") return `table${resolved.table?.reason ? `: ${resolved.table.reason}` : ""}`;
  return "empty";
}

export const isPieType = (t: string | null | undefined) => PIE_TYPES.has(String(t || ""));
