// The client-side "Explore" chart engine.
//
// Every analyze answer now comes back with (when the result was tabular -
// see backend/app/services/chart_builder.py:result_to_tidy) the tidy,
// row-level numbers the AI's chart was built from, not just the one fixed
// Plotly figure. This file is what turns those tidy rows into a NEW Plotly
// figure entirely in the browser, driven by an ExploreConfig the person
// edits directly (X axis, Y axis + aggregation, series/color-by, sort,
// top-N, filters) - the same job Hex's own "Explore" panel does when you
// remap a result cell's axes. No AI call, no network round trip: every
// edit here is a pure function of (columns, rows, config) and re-renders
// instantly.
//
// This deliberately only covers the "cartesian" chart family - the shapes
// that can be re-aggregated from tidy rows by a plain group-by (bar, line,
// area, scatter, pie, histogram, and their variants). Chart types that need
// a specific server-side shape (sankey, heatmap, candlestick, treemap, ...)
// are NOT built here - see CLIENT_PIVOTABLE_TYPES below, which is what
// Workspace.tsx checks before using this engine at all; anything outside it
// still goes through the existing AI chart_override round trip.
//
// The figure this returns is a plain, unstyled Plotly {data, layout} spec -
// intentionally the same shape build_figure() returns server-side - so it
// can be handed straight into the EXISTING styling pipeline
// (lib/chartStyle.ts's applyChartStyle) for colors/title/legend/fonts, and
// into the existing ChartCanvas for dark/light theming. Nothing about the
// rest of the app needs to know whether a given spec came from the backend
// or was built here.

import { deriveChartModel, figureFromModel, type ModelRoles } from "./chartModel";

export type ColumnDType = "number" | "string" | "date" | "boolean";
export type ColumnRole = "dimension" | "measure";

export type ResultColumn = {
  name: string;
  dtype: ColumnDType;
  role: ColumnRole;
  // 2026-10-09 (round 14): a project answer's columns say how they read -
  // "Total revenue", currency in USD - so the chart's axis and tooltip
  // write $1.08M, not 1084751.27.
  label?: string;
  format?: "currency" | "percent" | "ratio" | "integer" | "number";
  currency?: string;
};

export type Aggregation = "sum" | "avg" | "count" | "min" | "max";

export const AGGREGATIONS: { id: Aggregation; label: string }[] = [
  { id: "sum", label: "Sum" },
  { id: "avg", label: "Average" },
  { id: "count", label: "Count" },
  { id: "min", label: "Min" },
  { id: "max", label: "Max" },
];

export type ExploreChartType =
  | "bar" | "horizontal_bar" | "grouped_bar" | "stacked_bar"
  | "line" | "step_line" | "area" | "stacked_area"
  | "scatter" | "pie" | "donut" | "histogram";

// The one place that decides "can the Explore panel redraw this chart type
// instantly, client-side, from tidy rows?" - Workspace.tsx checks this
// before using buildExploreFigure at all, and the Explore panel's own
// chart-type picker uses it to label the rest "needs AI" instead of hiding
// them outright.
export const CLIENT_PIVOTABLE_TYPES: ExploreChartType[] = [
  "bar", "horizontal_bar", "grouped_bar", "stacked_bar",
  "line", "step_line", "area", "stacked_area",
  "scatter", "pie", "donut", "histogram",
];

export const EXPLORE_CHART_LABELS: Record<ExploreChartType, string> = {
  bar: "Bar", horizontal_bar: "Horizontal bar", grouped_bar: "Grouped bar", stacked_bar: "Stacked bar",
  line: "Line", step_line: "Step line", area: "Area", stacked_area: "Stacked area",
  scatter: "Scatter", pie: "Pie", donut: "Donut", histogram: "Histogram",
};

export type FilterOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "in";

export const FILTER_OPS: { id: FilterOp; label: string; forDtype: ColumnDType[] }[] = [
  { id: "=", label: "is", forDtype: ["string", "number", "date", "boolean"] },
  { id: "!=", label: "is not", forDtype: ["string", "number", "date", "boolean"] },
  { id: ">", label: ">", forDtype: ["number", "date"] },
  { id: ">=", label: "≥", forDtype: ["number", "date"] },
  { id: "<", label: "<", forDtype: ["number", "date"] },
  { id: "<=", label: "≤", forDtype: ["number", "date"] },
  { id: "contains", label: "contains", forDtype: ["string"] },
  { id: "in", label: "is one of", forDtype: ["string", "number"] },
];

export type ExploreFilter = {
  id: string;
  field: string;
  op: FilterOp;
  // Raw text the person typed; "in" splits on commas. Kept as a string so
  // the filter chip's input is always controllable, parsed at apply time.
  value: string;
};

export type YField = { field: string; agg: Aggregation };

export type ExploreConfig = {
  chartType: ExploreChartType;
  xField: string | null;
  yFields: YField[];
  // A dimension column to split into separate series/slices - e.g. "Market"
  // on a "Profit by Sub-Category" bar chart turns one flat bar chart into
  // one colored series per market, grouped or stacked depending on
  // chartType. Ignored for histogram/scatter-without-color and pie/donut
  // (pie/donut use xField as the slice dimension directly).
  colorField: string | null;
  sortDir: "none" | "asc" | "desc";
  // Caps the number of X-axis categories/slices shown, ranked by the first
  // Y value - Hex's own filter row does the same with a plain row-count
  // limit; here it is a "Top N categories" concept instead, which is what
  // actually keeps a 90-category bar chart readable.
  limit: number | null;
  filters: ExploreFilter[];
};

const uid = () => `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function newFilter(field: string, op: FilterOp = "="): ExploreFilter {
  return { id: uid(), field, op, value: "" };
}

// ---- defaults ----------------------------------------------------------

// Maps a backend chart_type (chart_builder.py's vocabulary, e.g. "faceted_bar",
// "heatmap", "waterfall") onto the nearest client-pivotable Explore type, so
// opening Explore on ANY analyze answer starts from something sensible
// instead of always resetting to a plain bar chart.
const CHART_TYPE_ALIASES: Record<string, ExploreChartType> = {
  faceted_bar: "grouped_bar",
  polar_bar: "bar",
  column: "bar",
  dot_plot: "scatter",
  bubble: "scatter",
  density_heatmap: "scatter",
  funnel_area: "pie",
};

export function normalizeChartType(backendType: string | null | undefined): ExploreChartType {
  if (!backendType) return "bar";
  if ((CLIENT_PIVOTABLE_TYPES as string[]).includes(backendType)) return backendType as ExploreChartType;
  return CHART_TYPE_ALIASES[backendType] || "bar";
}

// Whether the BACKEND's own chart type (chart_builder.py's vocabulary, e.g.
// "gauge", "sankey", "bar") can actually be redrawn client-side at all -
// true only when it is directly in CLIENT_PIVOTABLE_TYPES or has a
// deliberate, listed alias in CHART_TYPE_ALIASES. Deliberately NOT the same
// question normalizeChartType answers: normalizeChartType always returns
// SOME client-pivotable type (falling back to "bar" for anything it doesn't
// recognize) so the Explore panel's own chart-type dropdown always has a
// sensible value once Explore is already open - but that fallback must
// never be mistaken for "this chart type is safe to silently redraw
// client-side the moment Explore opens". A gauge, heatmap, sankey,
// candlestick, treemap, waterfall, choropleth, sunburst, or parallel-
// coordinates chart all normalize to "bar" for picker purposes, but none of
// them are actually pivotable - only this function tells the two apart.
export function isBackendTypePivotable(backendType: string | null | undefined): boolean {
  if (!backendType) return false;
  if ((CLIENT_PIVOTABLE_TYPES as string[]).includes(backendType)) return true;
  return Object.prototype.hasOwnProperty.call(CHART_TYPE_ALIASES, backendType);
}

export function defaultExploreConfig(columns: ResultColumn[], backendChartType?: string | null, rows?: Record<string, any>[] | null): ExploreConfig {
  const chartType = normalizeChartType(backendChartType);

  // 2026-10-07 (chart-integrity round): opening "Edit chart" must show the
  // SAME chart that was on screen a moment ago. The starting mapping is
  // therefore read off the chart model of the result table (lib/chartModel
  // - the derivation the chart itself is drawn from): its x dimension, its
  // series dimension, and EVERY measure it plots. This used to take "the
  // first dimension, the first measure" - which silently dropped the
  // second hotel from a two-hotel chart, and treated a year column of
  // whole numbers as something to add up - and capped the axis at the
  // first 25 values with no sign that anything had been cut.
  if (rows && rows.length && chartType !== "scatter" && chartType !== "histogram") {
    const model = deriveChartModel(columns, rows, chartType);
    if ((model.kind === "cartesian" || model.kind === "pie") && model.x && !model.transposed) {
      return {
        chartType,
        xField: model.x.name,
        yFields: model.series_by && model.measure
          ? [{ field: model.measure, agg: "sum" }]
          : model.series.map((s) => ({ field: s.name, agg: "sum" as Aggregation })),
        colorField: model.series_by,
        sortDir: "none",
        limit: null,
        filters: [],
      };
    }
  }

  const dimensions = columns.filter((c) => c.role === "dimension");
  const measures = columns.filter((c) => c.role === "measure");
  const dateCol = dimensions.find((c) => c.dtype === "date");
  const xField = (dateCol || dimensions[0] || columns[0])?.name ?? null;
  const firstMeasure = measures.find((c) => c.name !== xField)?.name ?? (columns.find((c) => c.name !== xField)?.name ?? null);
  const yFields: YField[] = firstMeasure ? [{ field: firstMeasure, agg: "sum" }] : [];

  // A second dimension (distinct from X) becomes the default series split
  // for a fresh grouped/stacked bar or multi-line chart.
  const secondDimension = dimensions.find((c) => c.name !== xField)?.name ?? null;
  const colorField =
    (chartType === "grouped_bar" || chartType === "stacked_bar" || chartType === "stacked_area") && secondDimension
      ? secondDimension
      : null;

  return {
    chartType,
    xField,
    yFields,
    colorField,
    sortDir: chartType === "pie" || chartType === "donut" ? "desc" : "none",
    // No default cap: a chart never opens with part of its axis cut off.
    // "Top N" is the person's own choice.
    limit: null,
    filters: [],
  };
}

// ---- aggregation --------------------------------------------------------

function toNumber(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function aggregate(values: number[], agg: Aggregation): number {
  if (agg === "count") return values.length;
  if (values.length === 0) return 0;  // (exploreTable keeps an empty bucket as a gap instead - see there)
  if (agg === "sum") return values.reduce((a, b) => a + b, 0);
  if (agg === "avg") return values.reduce((a, b) => a + b, 0) / values.length;
  if (agg === "min") return Math.min(...values);
  return Math.max(...values);
}

// ---- filtering ------------------------------------------------------

function passesFilter(row: Record<string, any>, filter: ExploreFilter, columns: ResultColumn[]): boolean {
  if (!filter.field || filter.value === "") return true;
  const col = columns.find((c) => c.name === filter.field);
  const raw = row[filter.field];
  if (filter.op === "in") {
    const wanted = filter.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return wanted.includes(String(raw ?? "").toLowerCase());
  }
  if (filter.op === "contains") {
    return String(raw ?? "").toLowerCase().includes(filter.value.toLowerCase());
  }
  if (col?.dtype === "number") {
    const a = toNumber(raw);
    const b = toNumber(filter.value);
    if (a === null || b === null) return true;
    switch (filter.op) {
      case "=": return a === b;
      case "!=": return a !== b;
      case ">": return a > b;
      case ">=": return a >= b;
      case "<": return a < b;
      case "<=": return a <= b;
      default: return true;
    }
  }
  if (col?.dtype === "date") {
    const a = raw ? new Date(raw).getTime() : NaN;
    const b = filter.value ? new Date(filter.value).getTime() : NaN;
    if (Number.isNaN(a) || Number.isNaN(b)) return true;
    switch (filter.op) {
      case "=": return a === b;
      case "!=": return a !== b;
      case ">": return a > b;
      case ">=": return a >= b;
      case "<": return a < b;
      case "<=": return a <= b;
      default: return true;
    }
  }
  const a = String(raw ?? "").toLowerCase();
  const b = filter.value.toLowerCase();
  return filter.op === "!=" ? a !== b : a === b;
}

export function applyFilters(
  rows: Record<string, any>[], filters: ExploreFilter[], columns: ResultColumn[]
): Record<string, any>[] {
  if (!filters.length) return rows;
  return rows.filter((row) => filters.every((f) => passesFilter(row, f, columns)));
}

// ---- figure building ------------------------------------------------

const PALETTE = [
  "#6C5CE7", "#00D1B2", "#FF6B6B", "#FFD166", "#4D96FF",
  "#F72585", "#43AA8B", "#F8961E", "#90BE6D", "#577590",
];

type Figure = { data: any[]; layout: any };

function baseLayout(): any {
  return {
    template: "plotly_dark",
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Inter, system-ui, sans-serif", size: 13, color: "#E8E8F0" },
    margin: { l: 50, r: 20, t: 40, b: 50 },
    legend: { bgcolor: "rgba(0,0,0,0)" },
    barmode: "group",
  };
}

// Groups tidy rows by an X value (and optionally a color/series value),
// aggregating one Y field per group - the single operation every
// bar/line/area chart in this engine is built from.
function groupBy(
  rows: Record<string, any>[], xField: string, yField: string, agg: Aggregation, colorField: string | null
): { x: any; series: Record<string, number> }[] {
  const order: any[] = [];
  const buckets = new Map<string, { x: any; values: Record<string, number[]> }>();
  for (const row of rows) {
    const x = row[xField];
    const key = String(x);
    if (!buckets.has(key)) {
      buckets.set(key, { x, values: {} });
      order.push(key);
    }
    const seriesKey = colorField ? String(row[colorField] ?? "—") : "value";
    const bucket = buckets.get(key)!;
    if (!bucket.values[seriesKey]) bucket.values[seriesKey] = [];
    const n = toNumber(row[yField]);
    if (n !== null) bucket.values[seriesKey].push(n);
    else if (agg === "count") bucket.values[seriesKey].push(0); // still counts the row
  }
  return order.map((key) => {
    const b = buckets.get(key)!;
    const series: Record<string, number> = {};
    for (const [k, vals] of Object.entries(b.values)) series[k] = aggregate(vals, agg);
    return { x: b.x, series };
  });
}

function sortAndLimit<T extends { x: any; series: Record<string, number> }>(
  grouped: T[], sortDir: ExploreConfig["sortDir"], limit: number | null
): T[] {
  let out = grouped;
  if (sortDir !== "none") {
    out = [...out].sort((a, b) => {
      const av = Object.values(a.series).reduce((s, v) => s + v, 0);
      const bv = Object.values(b.series).reduce((s, v) => s + v, 0);
      return sortDir === "asc" ? av - bv : bv - av;
    });
  }
  if (limit && out.length > limit) out = out.slice(0, limit);
  return out;
}

function seriesNames(grouped: { series: Record<string, number> }[]): string[] {
  const names = new Set<string>();
  for (const g of grouped) for (const k of Object.keys(g.series)) names.add(k);
  return Array.from(names);
}

function histogramFigure(rows: Record<string, any>[], xField: string): Figure {
  const values = rows.map((r) => toNumber(r[xField])).filter((v): v is number => v !== null);
  return {
    data: [{ type: "histogram", x: values, marker: { color: PALETTE[0] }, nbinsx: 30 }],
    layout: { ...baseLayout(), xaxis: { title: xField }, yaxis: { title: "Count" } },
  };
}

function scatterFigure(rows: Record<string, any>[], config: ExploreConfig): Figure {
  const { xField, yFields, colorField } = config;
  const y = yFields[0]?.field;
  if (!xField || !y) return { data: [], layout: baseLayout() };
  if (!colorField) {
    const pts = rows
      .map((r) => ({ x: toNumber(r[xField]) ?? r[xField], y: toNumber(r[y]) }))
      .filter((p) => p.y !== null);
    return {
      data: [{
        type: "scatter", mode: "markers", x: pts.map((p) => p.x), y: pts.map((p) => p.y),
        marker: { color: PALETTE[0], size: 8, opacity: 0.8 }, name: y,
      }],
      layout: { ...baseLayout(), xaxis: { title: xField }, yaxis: { title: y } },
    };
  }
  const groups = new Map<string, { x: any[]; y: number[] }>();
  for (const r of rows) {
    const yv = toNumber(r[y]);
    if (yv === null) continue;
    const key = String(r[colorField] ?? "—");
    if (!groups.has(key)) groups.set(key, { x: [], y: [] });
    const g = groups.get(key)!;
    g.x.push(toNumber(r[xField]) ?? r[xField]);
    g.y.push(yv);
  }
  const data = Array.from(groups.entries()).map(([name, g], i) => ({
    type: "scatter", mode: "markers", name, x: g.x, y: g.y,
    marker: { color: PALETTE[i % PALETTE.length], size: 8, opacity: 0.8 },
  }));
  return { data, layout: { ...baseLayout(), xaxis: { title: xField }, yaxis: { title: y }, showlegend: true } };
}

function pieFigure(rows: Record<string, any>[], config: ExploreConfig): Figure {
  const { xField, yFields, sortDir, limit } = config;
  const y = yFields[0];
  if (!xField || !y) return { data: [], layout: baseLayout() };
  let grouped = groupBy(rows, xField, y.field, y.agg, null);
  grouped = sortAndLimit(grouped, sortDir === "none" ? "desc" : sortDir, limit);
  return {
    data: [{
      type: "pie",
      hole: config.chartType === "donut" ? 0.55 : 0,
      labels: grouped.map((g) => g.x),
      values: grouped.map((g) => g.series.value ?? 0),
      marker: { colors: PALETTE },
      textinfo: "label+percent",
    }],
    layout: { ...baseLayout(), showlegend: true },
  };
}

function cartesianFigure(rows: Record<string, any>[], config: ExploreConfig): Figure {
  const { xField, yFields, colorField, chartType, sortDir, limit } = config;
  if (!xField || !yFields.length) return { data: [], layout: baseLayout() };

  const horizontal = chartType === "horizontal_bar";
  const isBar = chartType === "bar" || chartType === "horizontal_bar" || chartType === "grouped_bar" || chartType === "stacked_bar";
  const isArea = chartType === "area" || chartType === "stacked_area";
  const isLine = chartType === "line" || chartType === "step_line" || isArea;
  const stacked = chartType === "stacked_bar" || chartType === "stacked_area";

  let data: any[];
  let xTitle = xField;
  let yTitle = yFields.map((y) => y.field).join(", ");

  if (colorField && (isBar || isLine)) {
    // One series per distinct color-field value, sharing the same X axis -
    // e.g. "Profit by Sub-Category" split into one series per Market.
    const y = yFields[0];
    let grouped = groupBy(rows, xField, y.field, y.agg, colorField);
    grouped = sortAndLimit(grouped, sortDir, limit);
    const names = seriesNames(grouped);
    yTitle = y.field;
    data = names.map((name, i) => {
      const xs = grouped.map((g) => g.x);
      const ys = grouped.map((g) => g.series[name] ?? 0);
      const color = PALETTE[i % PALETTE.length];
      if (isBar) {
        return horizontal
          ? { type: "bar", orientation: "h", name, y: xs, x: ys, marker: { color } }
          : { type: "bar", name, x: xs, y: ys, marker: { color } };
      }
      return {
        type: "scatter",
        mode: "lines" + (chartType === "step_line" ? "" : "+markers"),
        line: { shape: chartType === "step_line" ? "hv" : "linear", color, width: 2.5 },
        fill: isArea ? (stacked ? "tonexty" : "tozeroy") : undefined,
        stackgroup: isArea && stacked ? "one" : undefined,
        name, x: xs, y: ys,
      };
    });
  } else {
    // One series per Y field (multi-measure mode), all against the same X.
    data = yFields.map((y, i) => {
      let grouped = groupBy(rows, xField, y.field, y.agg, null);
      grouped = sortAndLimit(grouped, sortDir, i === 0 ? limit : null);
      const xs = grouped.map((g) => g.x);
      const ys = grouped.map((g) => g.series.value ?? 0);
      const color = PALETTE[i % PALETTE.length];
      const name = y.field;
      if (isBar) {
        return horizontal
          ? { type: "bar", orientation: "h", name, y: xs, x: ys, marker: { color } }
          : { type: "bar", name, x: xs, y: ys, marker: { color } };
      }
      return {
        type: "scatter",
        mode: "lines" + (chartType === "step_line" ? "" : "+markers"),
        line: { shape: chartType === "step_line" ? "hv" : "linear", color, width: 2.5 },
        fill: isArea ? (stacked ? "tonexty" : "tozeroy") : undefined,
        stackgroup: isArea && stacked ? "one" : undefined,
        name, x: xs, y: ys,
      };
    });
  }

  const layout: any = {
    ...baseLayout(),
    barmode: stacked ? "stack" : "group",
    showlegend: data.length > 1,
  };
  if (horizontal) {
    layout.xaxis = { title: yTitle };
    layout.yaxis = { title: xTitle, automargin: true };
  } else {
    layout.xaxis = { title: xTitle };
    layout.yaxis = { title: yTitle };
  }
  return { data, layout };
}

// ---- the table an Edit-chart mapping describes --------------------------
//
// 2026-10-07 (chart-integrity round): every bar / line / area / pie the
// "Edit chart" panel can describe is first reduced to ONE small table -
// (x, measures...) or (x, series, measure) - with the roles the person
// chose. That table goes through the same chart model as any other result
// (lib/chartModel.deriveChartModel), so an edited chart is drawn by the
// same renderer, audited by the same rules and saved with the same rows
// as an untouched one. A bucket with no numeric value is a GAP (null),
// not a zero: "no previous year" is not "a previous year of 0".

export type ExploreTable = {
  columns: ResultColumn[];
  rows: Record<string, any>[];
  chartType: ExploreChartType;
  roles: ModelRoles;
};

const TABLE_TYPES = new Set<ExploreChartType>(["bar", "horizontal_bar", "grouped_bar", "stacked_bar", "line", "step_line", "area", "stacked_area", "pie", "donut"]);

function bucketValue(values: number[] | undefined, counted: number, agg: Aggregation): number | null {
  if (agg === "count") return counted;
  if (!values || !values.length) return null;
  return aggregate(values, agg);
}

/** The aggregated table of an Edit-chart mapping, or null when the mapping
 *  is incomplete or the chart type is not a rows-by-category chart
 *  (scatter, histogram - those are drawn by buildExploreFigure). */
export function exploreTable(columns: ResultColumn[], rows: Record<string, any>[], config: ExploreConfig): ExploreTable | null {
  const { xField, yFields, colorField, chartType, sortDir, limit } = config;
  if (!TABLE_TYPES.has(chartType) || !xField || !yFields.length || !rows.length) return null;
  const filtered = applyFilters(rows, config.filters, columns);
  const xCol = columns.find((c) => c.name === xField);
  const pie = chartType === "pie" || chartType === "donut";
  const split = Boolean(colorField) && colorField !== xField && !pie;
  const ys = (split || pie ? yFields.slice(0, 1) : yFields).filter((y) => y.field && y.field !== xField);
  if (!ys.length) return null;
  // Two Y entries on the same field (sum and average, say) need two names.
  const seenNames = new Map<string, number>();
  for (const y of ys) seenNames.set(y.field, (seenNames.get(y.field) || 0) + 1);
  const yName = (y: YField) => ((seenNames.get(y.field) || 0) > 1 ? `${y.field} (${y.agg})` : y.field);

  type Bucket = { x: any; cells: Map<string, { values: number[]; counted: number }> };
  const order: string[] = [];
  const buckets = new Map<string, Bucket>();
  const seriesOrder: string[] = [];
  for (const row of filtered) {
    const key = String(row[xField]);
    let b = buckets.get(key);
    if (!b) {
      b = { x: row[xField] ?? null, cells: new Map() };
      buckets.set(key, b);
      order.push(key);
    }
    for (const y of ys) {
      const cellKey = split ? String(row[colorField as string] ?? "—") : yName(y);
      if (split && !seriesOrder.includes(cellKey)) seriesOrder.push(cellKey);
      let cell = b.cells.get(cellKey);
      if (!cell) {
        cell = { values: [], counted: 0 };
        b.cells.set(cellKey, cell);
      }
      cell.counted += 1;
      const n = toNumber(row[y.field]);
      if (n !== null) cell.values.push(n);
    }
  }
  const agg0 = ys[0].agg;
  const total = (key: string) => {
    let sum = 0;
    for (const [name, cell] of buckets.get(key)!.cells) {
      const agg = split ? agg0 : (ys.find((y) => yName(y) === name)?.agg ?? agg0);
      if (split || name === yName(ys[0])) sum += bucketValue(cell.values, cell.counted, agg) ?? 0;
    }
    return sum;
  };
  let keys = order;
  const dir = pie && sortDir === "none" ? "desc" : sortDir;
  if (dir !== "none") keys = [...keys].sort((a, b) => (dir === "asc" ? total(a) - total(b) : total(b) - total(a)));
  if (limit && keys.length > limit) keys = keys.slice(0, limit);

  const xColumn: ResultColumn = { name: xField, dtype: xCol?.dtype ?? "string", role: "dimension" };
  if (split) {
    const measure = yName(ys[0]);
    const out: Record<string, any>[] = [];
    for (const key of keys) {
      const b = buckets.get(key)!;
      for (const s of seriesOrder) {
        const cell = b.cells.get(s);
        if (!cell) continue;
        out.push({ [xField]: b.x, [colorField as string]: s, [measure]: bucketValue(cell.values, cell.counted, agg0) });
      }
    }
    return {
      columns: [xColumn, { name: colorField as string, dtype: "string", role: "dimension" }, { name: measure, dtype: "number", role: "measure" }],
      rows: out,
      chartType,
      roles: { x: xField, seriesBy: colorField, measures: [measure], keepOrder: dir !== "none" },
    };
  }
  const out = keys.map((key) => {
    const b = buckets.get(key)!;
    const row: Record<string, any> = { [xField]: b.x };
    for (const y of ys) {
      const cell = b.cells.get(yName(y));
      row[yName(y)] = cell ? bucketValue(cell.values, cell.counted, y.agg) : null;
    }
    return row;
  });
  return {
    columns: [xColumn, ...ys.map((y) => ({ name: yName(y), dtype: "number" as ColumnDType, role: "measure" as ColumnRole }))],
    rows: out,
    chartType,
    roles: { x: xField, seriesBy: null, measures: ys.map(yName), keepOrder: dir !== "none" },
  };
}

// The single entry point: (tidy columns + rows + config) -> a plain Plotly
// figure, or null when the config is not yet complete enough to plot
// (e.g. no X field chosen yet).
export function buildExploreFigure(
  columns: ResultColumn[], rows: Record<string, any>[], config: ExploreConfig
): Figure | null {
  if (!rows.length) return null;
  const filtered = applyFilters(rows, config.filters, columns);
  if (config.chartType === "histogram") {
    if (!config.xField) return null;
    return histogramFigure(filtered, config.xField);
  }
  if (config.chartType === "scatter") {
    return scatterFigure(filtered, config);
  }
  // 2026-10-07 (chart-integrity round): bars, lines, areas and pies are the
  // figure of the chart model of the mapping's table (exploreTable) - x on
  // a category axis, one trace per series, straight segments, gaps left as
  // gaps. The two hand-built figures below remain only as the fallback for
  // a mapping the model declines (it then says why, and the workspace
  // shows the table instead of this figure).
  const table = exploreTable(columns, rows, config);
  if (table) {
    const model = deriveChartModel(table.columns, table.rows, table.chartType, table.roles);
    // Axis titles as this engine has always written them: the field names
    // (figureFromModel keeps them only because they name those fields).
    const figure = model.kind === "cartesian" || model.kind === "pie"
      ? figureFromModel(model, { xLabel: table.roles.x, yLabel: table.roles.measures.join(", ") })
      : null;
    if (figure) return figure;
  }
  if (config.chartType === "pie" || config.chartType === "donut") {
    return pieFigure(filtered, config);
  }
  return cartesianFigure(filtered, config);
}
