import type { BlockResult, BlockResultColumn, BlockSpec, BlockSpecMeasure, DashboardBlock, FilteredBlock } from "../api/client";
import { parseDateParts, type Grain } from "./charts/geometry";
import { MAX_SERIES } from "./format";

// 2026-10-07 (round 9): the ONE adapter between a FILE dashboard's block
// and the renderer a warehouse dashboard uses.
//
// A block on an uploaded CSV / Excel file stores its computed result on
// the block itself (and receives a recomputed copy - the "override" - from
// preview-filtered while a filter is on). Every shape that exists is read
// here, once, and turned into the same BlockResult a warehouse run returns
// (rows, dimensions, measures, a time column, a sparkline, a delta) plus a
// "view block" whose config carries a spec-shaped description of it. From
// there the KPI tile, the native charts, the donut, the kit table, the
// subtitles and the number formats are the warehouse code path, unchanged
// - so a CSV dashboard cannot look different from a warehouse one.
//
// The shapes (backend routers/dashboard_builder.py):
//   chart        {chart_spec, result_columns: [{name, dtype, role}], result_rows, recipe?, chart_type?}
//                (_run_manual_recipe / _run_grouped_measures / _ai_result_to_block_shape / _block_config_shape;
//                 preview-filtered returns the same with the filtered rows)
//   table        {columns: [name], rows, truncated, recipe?}
//   kpi          {value, label, recipe?, sparkline?: [n], format?, decimals?, good_direction?}
//   donut        {items: [{label, value}], recipe, result_columns?, result_rows?}
//   sparkline    {label, value, series: [n], categories: [text], delta_pct, recipe}
//   avatar_list  {items: [{rank, name, value}], label, recipe}
//   gauge        {value, min, max, target, label, recipe}
//   recipe       {metric_column, agg, group_by_column, block_type, chart_type?, time_grain?, alias?, count_rows?,
//                 measures?: [{alias, agg, column}], group_by?: [column], order_by?, limit?, metric_id?}
//
// A chart that is not a clean rows-and-columns table in one of the forms
// the native renderer draws (an AI-built scatter, histogram, box plot,
// heatmap, funnel, a chart with a forecast overlay...) keeps its Plotly
// figure: the adapter says so with kind "plotly" and BlockRenderer draws it
// through plotlyKit's restyle.

export const FILE_NATIVE_CHART_TYPES = new Set([
  "bar", "column", "horizontal_bar", "line", "area", "grouped_bar", "stacked_bar", "stacked_area", "step_line", "pie", "donut", "faceted_bar",
]);

export type FileAdapted =
  | {
      kind: "result";
      // What the warehouse renderer consumes.
      result: BlockResult;
      // The block with a spec-shaped description of its result in config
      // (formats, subtitles and chart decisions read it); never stored.
      block: DashboardBlock;
      // The stored result ended at a row cap ("Showing the first 200 rows").
      truncated: boolean;
    }
  | { kind: "plotly"; figure: any; reason: string }
  | { kind: "empty" };

export type FileAdaptOptions = {
  // The file's name as the person knows it ("Bookings export") - the
  // "table" of the subtitle. Absent on the published view.
  sourceName?: string | null;
};

type Column = { name: string; dtype: string | null; role: string | null };
type Table = { columns: Column[]; rows: Record<string, any>[] };

const AGG_WORD: Record<string, string> = { sum: "Sum", avg: "Average", count: "Count", min: "Min", max: "Max" };

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function columnsOf(raw: unknown): Column[] {
  if (!Array.isArray(raw)) return [];
  const out: Column[] = [];
  for (const c of raw) {
    if (typeof c === "string") out.push({ name: c, dtype: null, role: null });
    else if (c && typeof c === "object" && typeof (c as any).name === "string") {
      out.push({ name: (c as any).name, dtype: typeof (c as any).dtype === "string" ? (c as any).dtype : null, role: typeof (c as any).role === "string" ? (c as any).role : null });
    }
  }
  return out;
}

/** The rows-and-columns table a config carries, whichever keys it uses. */
export function storedTable(cfg: any): Table | null {
  if (!cfg || typeof cfg !== "object") return null;
  const pairs: [unknown, unknown][] = [[cfg.result_columns, cfg.result_rows], [cfg.columns, cfg.rows]];
  for (const [cols, rows] of pairs) {
    const columns = columnsOf(cols);
    if (columns.length && Array.isArray(rows)) return { columns, rows: rows.filter((r) => r && typeof r === "object") as Record<string, any>[] };
  }
  return null;
}

const YEAR_NAME_RE = /(^|[_\s])(year|yr)([_\s]|$)/i;

function looksLikeYearColumn(name: string, values: unknown[]): boolean {
  if (!YEAR_NAME_RE.test(name)) return false;
  const nums = values.filter((v) => v !== null && v !== undefined);
  return nums.length > 0 && nums.every((v) => isNum(v) && Number.isInteger(v) && v >= 1000 && v <= 2999);
}

/** Is this column a quantity (a measure) rather than a label? */
function isMeasureColumn(c: Column, rows: Record<string, any>[]): boolean {
  const values = rows.map((r) => r[c.name]);
  const numeric = values.some(isNum) && values.every((v) => v === null || v === undefined || isNum(v));
  if (!numeric) return false;
  // A whole-number column named as a year is something to group by.
  if (looksLikeYearColumn(c.name, values)) return false;
  if (c.role === "dimension" && c.dtype !== "number") return false;
  return true;
}

function allDates(rows: Record<string, any>[], name: string): boolean {
  let seen = 0;
  for (const r of rows) {
    const v = r[name];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v !== "string" || !parseDateParts(v)) return false;
    seen++;
  }
  return seen > 0;
}

/** The grain a column of period starts is in, read off the dates: every
 *  date the 1st of January -> years; every date the 1st of a quarter's
 *  first month, three or more of them -> quarters; every date a 1st ->
 *  months; dates a whole number of weeks apart -> weeks; else days. */
export function inferGrain(rows: Record<string, any>[], name: string): Grain {
  const parts = rows.map((r) => parseDateParts(r[name])).filter((p): p is NonNullable<ReturnType<typeof parseDateParts>> => p !== null);
  if (!parts.length) return "month";
  if (parts.every((p) => p.d === 1)) {
    if (parts.every((p) => p.m === 0)) return "year";
    if (parts.length >= 3 && parts.every((p) => p.m % 3 === 0)) return "quarter";
    return "month";
  }
  const days = Array.from(new Set(parts.map((p) => Date.UTC(p.y, p.m, p.d) / 86400000))).sort((a, b) => a - b);
  const steps = days.slice(1).map((d, i) => d - days[i]);
  if (steps.length >= 2 && steps.every((s) => s % 7 === 0)) return "week";
  return "day";
}

function normGrain(g: unknown): Grain | null {
  return g === "day" || g === "week" || g === "month" || g === "quarter" || g === "year" ? g : null;
}

/** How a measure with no alias of its own reads ("Average of ADR"). */
export function measureWords(agg: string | null | undefined, column: string | null | undefined, countRows = false): string {
  const a = String(agg || "").toLowerCase();
  if (a === "count" && (countRows || !column)) return "Rows";
  if (!column) return AGG_WORD[a] || "Value";
  if (a === "sum" && /^(total|sum)\b/i.test(column.trim())) return column;
  return AGG_WORD[a] ? `${AGG_WORD[a]} of ${column}` : column;
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base || "Value";
  let n = 2;
  while (taken.has(name)) name = `${base} ${n++}`;
  taken.add(name);
  return name;
}

type Shape = {
  time: string | null;
  grain: Grain | null;
  dimensions: string[]; // without the time column
  measures: BlockSpecMeasure[];
  // result column -> the name it is shown (and keyed) under
  rename: Record<string, string>;
};

/** Which columns of a recipe block's table are what - the recipe says. */
function recipeShape(recipe: any, table: Table): Shape | null {
  if (!recipe || typeof recipe !== "object" || recipe.metric_id) return null;
  const names = table.columns.map((c) => c.name);
  const groups: string[] = (Array.isArray(recipe.group_by) && recipe.group_by.length ? recipe.group_by : recipe.group_by_column ? [recipe.group_by_column] : []).filter(
    (g: unknown): g is string => typeof g === "string" && names.includes(g)
  );
  if (!groups.length) return null;
  const rest = names.filter((n) => !groups.includes(n));
  if (!rest.length) return null;
  const taken = new Set<string>(groups);
  const rename: Record<string, string> = {};
  const measures: BlockSpecMeasure[] = [];
  const listed: any[] = Array.isArray(recipe.measures) && recipe.measures.length ? recipe.measures.filter((m: any) => m && typeof m === "object") : [];
  if (listed.length) {
    for (const m of listed) {
      const key = typeof m.alias === "string" && rest.includes(m.alias) ? m.alias : null;
      if (!key) continue;
      rename[key] = uniqueName(key, taken);
      measures.push({ alias: rename[key], agg: m.agg, column: m.column ?? null });
    }
  }
  if (!measures.length) {
    // One measure over one group-by: the other column is the measure.
    const key = rest.find((n) => n === recipe.alias) || rest.find((n) => n === recipe.metric_column) || rest[0];
    const shown = typeof recipe.alias === "string" && recipe.alias.trim() ? key : measureWords(recipe.agg, recipe.metric_column, Boolean(recipe.count_rows));
    rename[key] = uniqueName(shown, taken);
    measures.push({ alias: rename[key], agg: recipe.agg, column: recipe.count_rows ? null : recipe.metric_column ?? null });
  }
  const grain = normGrain(recipe.time_grain);
  const timeCol = grain && allDates(table.rows, groups[0]) ? groups[0] : null;
  return { time: timeCol, grain: timeCol ? grain : null, dimensions: timeCol ? groups.slice(1) : groups, measures, rename };
}

/** The same for a result nobody described (an AI answer): numbers are
 *  measures, everything else is a dimension, a column of dates is time. */
function inferredShape(table: Table, chartType: string | null): Shape | null {
  const measureCols = table.columns.filter((c) => isMeasureColumn(c, table.rows));
  let dimCols = table.columns.filter((c) => !measureCols.includes(c));
  if (!measureCols.length) return null;
  if (!dimCols.length) return { time: null, grain: null, dimensions: [], measures: measureCols.map((c) => ({ alias: c.name, agg: "sum", column: c.name })), rename: {} };
  // A facet grid stores (facet, category, value): the category is the axis.
  if (chartType === "faceted_bar" && dimCols.length >= 2) dimCols = [dimCols[1], dimCols[0], ...dimCols.slice(2)];
  const first = dimCols[0];
  const dateTyped = first.dtype === "date" || first.dtype === "datetime";
  const time = (dateTyped || allDates(table.rows, first.name)) && allDates(table.rows, first.name) ? first.name : null;
  return {
    time,
    grain: time ? inferGrain(table.rows, time) : null,
    dimensions: (time ? dimCols.slice(1) : dimCols).map((c) => c.name),
    // The aggregation is unknown; "sum" only says "this can be added up"
    // to nothing here that folds series - an AI result is drawn as it is.
    measures: measureCols.map((c) => ({ alias: c.name, agg: "sum", column: c.name })),
    rename: {},
  };
}

function axisTitle(figure: any, key: string): string | null {
  const t = figure?.layout?.[key]?.title;
  const text = typeof t === "string" ? t : t?.text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

/** A wide "one column per series" table (what a grouped / stacked chart
 *  was built from) as long rows: (category, series, value). */
function meltSeries(table: Table, shape: Shape, figure: any): { table: Table; shape: Shape } | null {
  if (shape.dimensions.length + (shape.time ? 1 : 0) !== 1 || shape.measures.length < 2) return null;
  const x = shape.time || shape.dimensions[0];
  const legend = figure?.layout?.legend?.title;
  const seriesName = uniqueName((typeof legend === "string" ? legend : legend?.text) || "Series", new Set([x]));
  const valueName = uniqueName(axisTitle(figure, "yaxis") || "Value", new Set([x, seriesName]));
  const rows: Record<string, any>[] = [];
  for (const r of table.rows) for (const m of shape.measures) rows.push({ [x]: r[x], [seriesName]: m.alias, [valueName]: r[m.alias] });
  return {
    table: { columns: [{ name: x, dtype: null, role: "dimension" }, { name: seriesName, dtype: "string", role: "dimension" }, { name: valueName, dtype: "number", role: "measure" }], rows },
    shape: { time: shape.time, grain: shape.grain, dimensions: shape.time ? [seriesName] : [x, seriesName], measures: [{ alias: valueName, agg: "sum", column: null }], rename: {} },
  };
}

/** The chart type of a stored Plotly figure when the block never recorded
 *  one (backend _detect_restyle_chart_type, ported). null = not a form the
 *  native renderer draws. */
export function detectChartType(figure: any): string | null {
  const traces: any[] = Array.isArray(figure?.data) ? figure.data.filter((t: any) => t && typeof t === "object") : [];
  if (!traces.length) return null;
  const t = traces[0];
  if (traces.some((x) => x.type !== t.type)) return null;
  if (t.type === "bar") {
    if (traces.some((x) => x?.meta?.role === "facet_panel")) return "faceted_bar";
    if (traces.length > 1) return figure?.layout?.barmode === "stack" ? "stacked_bar" : "grouped_bar";
    return t.orientation === "h" ? "horizontal_bar" : "bar";
  }
  if (t.type === "pie") return typeof t.hole === "number" && t.hole > 0 ? "donut" : "pie";
  if (t.type === "scatter" || t.type === undefined) {
    const mode = String(t.mode || "");
    if (t.fill && t.fill !== "none") return traces.length > 1 ? "stacked_area" : "area";
    if (mode.includes("lines")) return "line";
    return "scatter";
  }
  return null;
}

/** The chart type a file chart is drawn as: what the block itself says
 *  (a restyle writes it there), then the filtered copy, then the recipe,
 *  then the stored figure. */
export function fileChartType(block: Pick<DashboardBlock, "config">, cfg: any): string | null {
  const own = block.config || {};
  const named = [own.chart_type, cfg?.chart_type, own.recipe?.chart_type, cfg?.recipe?.chart_type].find((t) => typeof t === "string" && t.trim());
  if (named) return String(named).toLowerCase().trim();
  return detectChartType(cfg?.chart_spec ?? own.chart_spec);
}

function buildSpec(shape: Shape, sourceName: string | null | undefined, extra: Partial<BlockSpec> = {}): BlockSpec {
  return {
    // "" keeps describeSpecShort from printing " · undefined"; the grid
    // never treats a view block as runnable (it is not the stored block).
    table: sourceName || "",
    time: shape.time && shape.grain ? { column: shape.time, grain: shape.grain } : null,
    group_by: shape.dimensions,
    measures: shape.measures,
    ...extra,
  };
}

function viewBlock(block: DashboardBlock, cfg: any, spec: BlockSpec, patch: Record<string, any> = {}): DashboardBlock {
  const own = block.config || {};
  return {
    ...block,
    config: {
      ...cfg,
      // Presentation the owner set lives on the block, never on the
      // recomputed copy a filter returns.
      format: own.format, format_inferred: own.format_inferred, decimals: own.decimals, currency: own.currency,
      good_direction: own.good_direction, unit: own.unit, target: own.target ?? cfg?.target, max: own.max ?? cfg?.max, min: own.min ?? cfg?.min,
      label: own.label ?? cfg?.label,
      spec,
      ...patch,
    },
  };
}

function baseResult(columns: BlockResultColumn[], rows: Record<string, any>[], shape: Shape, spec: BlockSpec): BlockResult {
  return {
    status: "ok",
    columns,
    rows,
    row_count: rows.length,
    computed_in: "gd360",
    dimensions: shape.dimensions,
    measures: shape.measures.map((m) => m.alias),
    time_column: shape.time,
    period: shape.grain || undefined,
    spec,
  };
}

function renameRows(table: Table, rename: Record<string, string>): Table {
  const keys = Object.keys(rename).filter((k) => rename[k] !== k);
  if (!keys.length) return table;
  return {
    columns: table.columns.map((c) => (rename[c.name] ? { ...c, name: rename[c.name] } : c)),
    rows: table.rows.map((r) => {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(r)) out[rename[k] ?? k] = v;
      return out;
    }),
  };
}

function tableResult(block: DashboardBlock, cfg: any, table: Table, shape: Shape, opts: FileAdaptOptions, patch: Record<string, any> = {}): FileAdapted {
  const renamed = renameRows(table, shape.rename);
  const spec = buildSpec(shape, opts.sourceName);
  const columns: BlockResultColumn[] = renamed.columns.map((c) => ({ name: c.name, type: c.dtype }));
  return { kind: "result", result: baseResult(columns, renamed.rows, shape, spec), block: viewBlock(block, cfg, spec, patch), truncated: Boolean(cfg?.truncated) };
}

/** A single stored number (a KPI, a gauge) as a one-row result. */
function valueResult(block: DashboardBlock, cfg: any, override: FilteredBlock | undefined, opts: FileAdaptOptions): FileAdapted {
  const own = block.config || {};
  const recipe = cfg?.recipe ?? own.recipe;
  const hasRecipe = recipe && typeof recipe === "object" && !recipe.metric_id;
  const alias = (hasRecipe && typeof recipe.alias === "string" && recipe.alias.trim()) || (typeof (own.label ?? cfg?.label) === "string" && String(own.label ?? cfg?.label).trim()) || "Value";
  const measure: BlockSpecMeasure = { alias, agg: hasRecipe ? recipe.agg : "sum", column: hasRecipe && !recipe.count_rows ? recipe.metric_column ?? null : null };
  const shape: Shape = { time: null, grain: null, dimensions: [], measures: [measure], rename: {} };
  const spec = buildSpec(shape, opts.sourceName);
  const value = cfg?.value ?? null;
  const result = baseResult([{ name: alias, type: isNum(value) ? "number" : null }], [{ [alias]: value }], shape, spec);
  // The trend the backend computed over the dashboard's date column (or
  // the series a legacy warehouse copy carried).
  const series: unknown[] = Array.isArray(cfg?.sparkline) ? cfg.sparkline : Array.isArray(cfg?.sparkline_series) ? cfg.sparkline_series : [];
  const points = series.filter(isNum);
  if (points.length > 1) result.sparkline = { columns: [{ name: alias }], rows: points.map((v) => ({ [alias]: v })), grain: typeof cfg?.sparkline_grain === "string" ? cfg.sparkline_grain : undefined };
  // Filtered: how the number moved against the unfiltered one this block
  // stores. Nothing is compared when there is no such number, or it is 0.
  const base = own.value;
  if (override && isNum(value) && isNum(base) && base !== 0) {
    const pct = ((value - base) / Math.abs(base)) * 100;
    const flat = Math.abs(pct) < 0.05;
    result.delta = { [alias]: { current: value, prior: base, abs: flat ? 0 : value - base, pct: flat ? 0 : Number(pct.toFixed(2)) } };
  }
  return { kind: "result", result, block: viewBlock(block, cfg, spec), truncated: false };
}

function itemsTable(items: unknown, labelKey: string, group: string, measure: string): Table | null {
  if (!Array.isArray(items) || !items.length) return null;
  const rows = items
    .filter((it) => it && typeof it === "object")
    .map((it: any) => ({ [group]: it[labelKey] ?? null, [measure]: typeof it.value === "number" ? it.value : Number(it.value) }))
    .filter((r) => Number.isFinite(r[measure] as number));
  if (!rows.length) return null;
  return { columns: [{ name: group, dtype: "string", role: "dimension" }, { name: measure, dtype: "number", role: "measure" }], rows };
}

/** Why a chart keeps its Plotly figure, or null when it is drawn natively. */
export function plotlyFallbackReason(block: Pick<DashboardBlock, "config">, cfg: any): string | null {
  const own = block.config || {};
  if (cfg?.forecast_enabled || cfg?.anomalies_enabled || own.forecast_enabled || own.anomalies_enabled) return "a forecast or anomaly overlay is drawn on the figure itself";
  const type = fileChartType(block, cfg);
  if (!type) return "the chart's type could not be read from its stored figure";
  if (!FILE_NATIVE_CHART_TYPES.has(type)) return `a ${type.replace(/_/g, " ")} chart has no rows-by-category form`;
  if (!storedTable(cfg)?.rows.length) return "the chart was saved without its rows";
  return null;
}

/** A file block (and its filtered copy, when a filter is on) as the
 *  result + view block the warehouse renderer draws. */
export function adaptFileBlock(block: DashboardBlock, override?: FilteredBlock, opts: FileAdaptOptions = {}): FileAdapted {
  const type = override?.type ?? block.type;
  const cfg = override?.config ?? block.config ?? {};
  const own = block.config || {};
  const recipe = cfg.recipe ?? own.recipe;

  if (type === "kpi" || type === "gauge") {
    if (cfg.value === undefined && own.value === undefined) return { kind: "empty" };
    return valueResult(block, cfg, override, opts);
  }

  if (type === "chart") {
    const figure = cfg.chart_spec ?? own.chart_spec ?? null;
    const reason = plotlyFallbackReason(block, cfg);
    const chartType = fileChartType(block, cfg);
    if (!reason) {
      const table = storedTable(cfg)!;
      let shape = recipeShape(recipe, table) ?? inferredShape(table, chartType);
      let shaped = table;
      // A stored grouped / stacked chart is ONE quantity with a column per
      // series ("Online TA", "Groups", ...): its columns share an axis. Up
      // to six stay as they are (each column a named series); more than the
      // palette holds become (category, series, value) rows, so the chart
      // can fold the tail into "Other".
      let sharedAxis = false;
      if (shape && !recipe && (chartType === "grouped_bar" || chartType === "stacked_bar" || chartType === "stacked_area") && shape.measures.length > 1) {
        if (shape.measures.length <= MAX_SERIES) sharedAxis = true;
        else {
          const melted = meltSeries(table, shape, figure);
          if (melted) { shaped = melted.table; shape = melted.shape; }
        }
      }
      const hasAxis = shape && (shape.time || shape.dimensions.length > 0);
      if (shape && hasAxis && shape.measures.length) return tableResult(block, cfg, shaped, shape, opts, { chart_type: chartType, shared_axis: sharedAxis || undefined });
      return figure ? { kind: "plotly", figure, reason: "its result has no category and measure to draw" } : { kind: "empty" };
    }
    // A recipe chart recomputed under a filter that left no rows: nothing
    // to draw (not the stale unfiltered figure).
    if (override && recipe && FILE_NATIVE_CHART_TYPES.has(chartType || "") && !storedTable(cfg)?.rows.length) return { kind: "empty" };
    return figure ? { kind: "plotly", figure, reason } : { kind: "empty" };
  }

  if (type === "table") {
    const table = storedTable(cfg);
    if (!table) return { kind: "empty" };
    const shape = recipeShape(recipe, table) ?? inferredShape(table, null) ?? { time: null, grain: null, dimensions: table.columns.map((c) => c.name), measures: [], rename: {} };
    // A table lists its time column like any other; nothing is bucketed.
    const flat: Shape = { ...shape, dimensions: shape.time ? [shape.time, ...shape.dimensions] : shape.dimensions, time: null, grain: null };
    const adapted = tableResult(block, cfg, table, flat, opts);
    if (adapted.kind === "result" && shape.time && shape.grain) {
      adapted.result.time_column = shape.time;
      adapted.result.period = shape.grain;
      adapted.result.dimensions = shape.dimensions;
    }
    return adapted;
  }

  // The one-measure-by-category widgets: rows when the block kept them,
  // else the items / series it was reduced to.
  const groupName: string = (recipe && typeof recipe.group_by_column === "string" && recipe.group_by_column) || "Category";
  const measureName: string = recipe && !recipe.metric_id
    ? (typeof recipe.alias === "string" && recipe.alias.trim() ? recipe.alias : measureWords(recipe.agg, recipe.metric_column, Boolean(recipe.count_rows)))
    : (typeof cfg.label === "string" && cfg.label.trim()) || "Value";
  const fallbackShape = (group: string, measure: string): Shape => ({
    time: null, grain: null, dimensions: [group],
    measures: [{ alias: measure, agg: recipe && !recipe.metric_id ? recipe.agg : "sum", column: recipe && !recipe.metric_id && !recipe.count_rows ? recipe.metric_column ?? null : null }],
    rename: {},
  });

  if (type === "donut") {
    const table = storedTable(cfg);
    if (table?.rows.length) {
      const shape = recipeShape(recipe, table) ?? inferredShape(table, "donut");
      if (shape && (shape.dimensions.length || shape.time) && shape.measures.length) {
        const flat: Shape = { ...shape, dimensions: shape.time ? [shape.time, ...shape.dimensions] : shape.dimensions, time: null, grain: null };
        return tableResult(block, cfg, table, flat, opts);
      }
    }
    const items = itemsTable(cfg.items, "label", groupName, measureName === groupName ? `${measureName} value` : measureName);
    if (!items) return { kind: "empty" };
    return tableResult(block, cfg, items, fallbackShape(items.columns[0].name, items.columns[1].name), opts);
  }

  if (type === "avatar_list") {
    const items = itemsTable(cfg.items, "name", groupName, measureName === groupName ? `${measureName} value` : measureName);
    if (!items) return { kind: "empty" };
    return tableResult(block, cfg, items, fallbackShape(items.columns[0].name, items.columns[1].name), opts);
  }

  if (type === "sparkline") {
    const series: unknown[] = Array.isArray(cfg.series) ? cfg.series : [];
    const categories: unknown[] = Array.isArray(cfg.categories) ? cfg.categories : [];
    const measure = measureName === groupName ? `${measureName} value` : measureName;
    const rows = series.map((v, i) => ({ [groupName]: categories[i] ?? i + 1, [measure]: isNum(v) ? v : null })).filter((r) => r[measure] !== null);
    if (!rows.length) return { kind: "empty" };
    const table: Table = { columns: [{ name: groupName, dtype: null, role: "dimension" }, { name: measure, dtype: "number", role: "measure" }], rows };
    return tableResult(block, cfg, table, fallbackShape(groupName, measure), opts);
  }

  return { kind: "empty" };
}

/** A file block's description for its card subtitle - the same sentence a
 *  warehouse block gets from its spec ("Bookings by month · Bookings
 *  export"). null when the block has nothing to describe. */
export function fileBlockSpec(block: DashboardBlock, override?: FilteredBlock, opts: FileAdaptOptions = {}): BlockSpec | null {
  const adapted = adaptFileBlock(block, override, opts);
  if (adapted.kind !== "result") return null;
  const spec = adapted.block.config?.spec as BlockSpec | undefined;
  if (!spec || !spec.measures?.length) return null;
  return spec;
}
