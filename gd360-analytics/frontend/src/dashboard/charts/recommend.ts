import type { BlockResult, BlockSpec } from "../../api/client";
import { isPositionWord } from "../theme/chartTheme";
import { countryColumnScore, resolveCountry } from "./worldMap";

// 2026-10-07 (chart-types round): choosing the best view - the browser's
// copy of backend/app/services/chart_recommender.py, rule for rule and
// word for word. The backend decides which chart a block is drawn as when
// it is proposed, asked for, built or "swapped to best"; this copy is what
// the chart gallery's "Recommended" badge, its "needs a country column"
// lines and the swap menu's disabled reasons are read from, and what
// confirms an automatic choice against the values of the first run. Both
// run over the same case table in their test suites (the backend's
// recommender_cases fixture), so a rule changed on one side fails a test.
//
// A "shape" is what a block's query returns, described without its rows -
// see the Python module's docstring for the fields.

export const COUNTRY_SCORE_MIN = 0.8;
export const COUNTRY_MIN_COUNT = 6;
export const SERIES_MAX = 6;
export const DONUT_MIN = 3, DONUT_MAX = 6;
export const RANKING_MAX = 30;
export const TABLE_MIN_CATEGORIES = 200;
export const HEATMAP_MAX_CELLS = 2500;
export const SCATTER_MIN_POINTS = 6;
export const SCALE_RATIO = 8;

export type ChartTypeKey =
  | "bar" | "horizontal_bar" | "line" | "area" | "stacked_bar" | "stacked_bar_100" | "stacked_area" | "stacked_area_100" | "combo"
  | "donut" | "pie" | "treemap" | "map" | "heatmap" | "pivot" | "scatter" | "bubble" | "funnel" | "waterfall" | "histogram" | "bullet"
  | "table" | "kpi";

export type ChartTypeInfo = { type: ChartTypeKey; label: string; when: string; needs: string };

// Every chart form the dashboard draws, in gallery order (backend
// CHART_TYPES, verbatim - charts/README.md documents the same list).
export const CHART_TYPES: ChartTypeInfo[] = [
  { type: "bar", label: "Bars", when: "compare one measure across a few categories or ordered buckets", needs: "needs a category or a date" },
  { type: "horizontal_bar", label: "Horizontal bars", when: "a ranking of 7-30 named categories (long names fit)", needs: "needs a category" },
  { type: "line", label: "Line", when: "one or a few measures over time", needs: "needs a date or an ordered column" },
  { type: "area", label: "Area", when: "one measure over time where the volume matters", needs: "needs a date or an ordered column" },
  { type: "stacked_bar", label: "Stacked bars", when: "a total split into up to 6 parts across categories or periods", needs: "needs a second dimension to stack by" },
  { type: "stacked_bar_100", label: "100% stacked bars", when: "how the MIX changes across categories or periods (shares, not totals)", needs: "needs a second dimension to stack by" },
  { type: "stacked_area", label: "Stacked area", when: "a total and its parts over time", needs: "needs a date and a dimension to stack by" },
  { type: "stacked_area_100", label: "100% stacked area", when: "how the mix shifts over time", needs: "needs a date and a dimension to stack by" },
  { type: "combo", label: "Bars + line panels", when: "two measures of different scale over one axis - drawn as aligned panels, never two y-axes", needs: "needs two measures over one axis" },
  { type: "donut", label: "Donut", when: "share of a whole across 3-6 categories", needs: "needs one category and one measure" },
  { type: "pie", label: "Pie", when: "share of a whole across 3-6 categories", needs: "needs one category and one measure" },
  { type: "treemap", label: "Treemap", when: "part-to-whole across many categories (one or two levels)", needs: "needs one or two categories and one measure" },
  { type: "map", label: "Map", when: "one measure by a country column with more than 6 countries", needs: "needs a country column" },
  { type: "heatmap", label: "Heatmap", when: "one measure by two dimensions (segment x month, weekday x month)", needs: "needs two dimensions" },
  { type: "pivot", label: "Pivot table", when: "several measures by a row dimension and a column dimension", needs: "needs two dimensions" },
  { type: "scatter", label: "Scatter", when: "the relationship between two measures, one point per category", needs: "needs two measures" },
  { type: "bubble", label: "Bubble", when: "two measures per category with a third as size", needs: "needs three measures" },
  { type: "funnel", label: "Funnel", when: "ordered stages with the drop between them", needs: "needs ordered stages (one category, or several measures)" },
  { type: "waterfall", label: "Waterfall", when: "how parts add up to a total, or the change between two periods by category", needs: "needs one category, or two where one has exactly two values" },
  { type: "histogram", label: "Histogram", when: "the distribution of one numeric column", needs: "needs a numeric column to bin" },
  { type: "bullet", label: "Bullet", when: "one number against a target", needs: "needs one measure (and a target)" },
  { type: "table", label: "Table", when: "exact values, many columns, or more categories than a chart reads", needs: "" },
  { type: "kpi", label: "KPI tile", when: "one headline number", needs: "needs a single number (no grouping)" },
];
const BY_TYPE = new Map(CHART_TYPES.map((t) => [t.type as string, t]));

const ALIASES: Record<string, string> = {
  column: "bar", grouped_bar: "bar", hbar: "horizontal_bar", barh: "horizontal_bar", choropleth: "map", geo: "map", matrix: "heatmap",
  heat_map: "heatmap", pivot_table: "pivot", "100_stacked_bar": "stacked_bar_100", percent_stacked_bar: "stacked_bar_100",
  stacked_100: "stacked_bar_100", distribution: "histogram", progress: "bullet", bridge: "waterfall", step_line: "line", tree_map: "treemap",
};

/** A chart type as this module names it ("grouped_bar" and "step_line"
 *  stay themselves: forms of bar / line), or null when unknown. */
export function normalizeChartTypeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (key === "grouped_bar" || key === "step_line") return key;
  const mapped = ALIASES[key] ?? key;
  return BY_TYPE.has(mapped) ? mapped : null;
}

export function chartTypeLabel(type: string): string {
  const plain = type === "grouped_bar" ? "bar" : type === "step_line" ? "line" : type;
  return BY_TYPE.get(plain)?.label ?? type;
}

export function blockTypeFor(chartType: string): "chart" | "kpi" | "table" | "donut" {
  if (chartType === "kpi") return "kpi";
  if (chartType === "table") return "table";
  if (chartType === "donut") return "donut";
  return "chart";
}

// ---- shapes ----------------------------------------------------------------

export type ShapeDim = { name: string; role: "category" | "ordinal" | "country"; distinct: number | null; countries?: number; few_countries?: number };
export type ShapeMeasure = { name: string; additive: boolean; unit: "number" | "percent" | "currency" };
export type ChartShape = {
  time: { grain: string; periods: number | null } | null;
  dims: ShapeDim[];
  measures: ShapeMeasure[];
  bins: boolean;
  target: boolean;
  negative: boolean;
  max_ratio: number | null;
};

const ADDITIVE = new Set(["sum", "count", "count_distinct"]);
const NUMERIC_TYPE_RE = /int|float|numeric|decimal|double|real|number|bigint|smallint/i;
const DATE_TYPE_RE = /date|time/i;
const ORDINAL_NAME_RE = /(^|[_\s])(year|yr|month|week|weekday|day|quarter|hour|bucket|band|tier|bin|range|age)([_\s]|$)/i;

/** Does the column's NAME say it holds countries? (backend
 *  countries.looks_like_country_name) */
export function looksLikeCountryName(column: string | null | undefined): boolean {
  if (!column) return false;
  const words = column.replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ").match(/[A-Za-z]+/g) || [];
  return words.some((w) => ["country", "countries", "nation", "nationality"].includes(w.toLowerCase()));
}

function distinctCount(values: unknown[]): number {
  return new Set(values.map((v) => (v === null || v === undefined ? "None" : String(v)))).size;
}

/** One dimension of a shape, decided by the values a run returned. */
/** Share (0-1) of the WEIGHT (an additive measure) that sits on values
 *  resolving to a country - backend countries.country_weight_share. */
export function countryWeightShare(values: unknown[], weights: unknown[]): number {
  let total = 0, hit = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i], w = weights[i];
    if (v === null || v === undefined) continue;
    if (typeof v !== "string" && typeof v !== "number") continue;
    const raw = String(v).trim();
    if (!raw) continue;
    if (typeof w !== "number" || !Number.isFinite(w) || w <= 0) continue;
    total += w;
    if (typeof v === "number" || /^\d+$/.test(raw)) continue;
    if (resolveCountry(raw)) hit += w;
  }
  return total > 0 ? hit / total : 0;
}

/** `weights`: the rows' additive measure - a column is a country column
 *  when 80% of its distinct values resolve to a country, OR 80% of that
 *  measure sits on values that do (a long tail of unknown codes with a
 *  handful of rows each does not unmake it). */
export function dimFromValues(name: string, values: unknown[], weights?: unknown[] | null): ShapeDim {
  const present = values.filter((v) => v !== null && v !== undefined && !(typeof v === "string" && !v.trim()));
  const out: ShapeDim = { name, role: "category", distinct: values.length ? distinctCount(values) : 0 };
  if (!present.length) return out;
  if (present.every((v) => typeof v === "number") || present.every((v) => isPositionWord(String(v)))) {
    out.role = "ordinal";
    return out;
  }
  let score = countryColumnScore(present);
  if (weights && score < COUNTRY_SCORE_MIN) score = Math.max(score, countryWeightShare(values, weights));
  if (score >= COUNTRY_SCORE_MIN) {
    const codes = new Set<string>();
    const seen = new Set<string>();
    for (const v of present) {
      const key = String(v).trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const iso = resolveCountry(v);
      if (iso) codes.add(iso);
    }
    if (codes.size > COUNTRY_MIN_COUNT) {
      out.role = "country";
      out.countries = codes.size;
    } else {
      out.few_countries = codes.size;
    }
  }
  return out;
}

/** The same before any row exists: the column's name and type decide. */
export function dimFromSchema(name: string, colType: string | null | undefined, distinct: number | null = null, datePart = false): ShapeDim {
  let role: ShapeDim["role"] = "category";
  if (datePart || DATE_TYPE_RE.test(String(colType || "")) || NUMERIC_TYPE_RE.test(String(colType || "")) || ORDINAL_NAME_RE.test(name || "")) role = "ordinal";
  else if (looksLikeCountryName(name)) role = "country";
  return { name, role, distinct };
}

function unitOf(format: unknown): ShapeMeasure["unit"] {
  return format === "percent" || format === "currency" ? format : "number";
}

export type ShapeOptions = { target?: boolean; formats?: Record<string, string | null | undefined> };

/** A shape from a BlockSpec alone (`columns`: the table's schema). */
export function shapeFromSpec(spec: BlockSpec | null | undefined, columns?: { name: string; type?: string | null }[] | null, opts: ShapeOptions = {}): ChartShape {
  const types = new Map((columns || []).map((c) => [c.name, c.type ?? null]));
  const s = spec || ({ table: "", measures: [] } as BlockSpec);
  const dims: ShapeDim[] = (s.group_by || []).map((g) => dimFromSchema(g, types.get(g), null));
  for (const p of s.date_parts || []) dims.push(dimFromSchema(p.alias || `${p.column}_${p.part}`, null, null, true));
  return {
    time: s.time && s.time.column ? { grain: s.time.grain || "month", periods: null } : null,
    dims,
    measures: (s.measures || []).map((m) => ({ name: m.alias, additive: ADDITIVE.has(String(m.agg || "").toLowerCase()), unit: unitOf(opts.formats?.[m.alias]) })),
    bins: Boolean(s.bins),
    target: Boolean(opts.target),
    negative: false,
    max_ratio: null,
  };
}

/** A shape from a run's result: the values themselves decide. */
export function shapeFromResult(result: BlockResult | null | undefined, spec?: BlockSpec | null, opts: ShapeOptions = {}): ChartShape {
  const r = result || ({ rows: [], columns: [] } as unknown as BlockResult);
  const s = spec || r.spec || null;
  const rows = r.rows || [];
  const timeCol = r.time_column || null;
  const parts = new Set((s?.date_parts || []).map((p) => p.alias));
  const aggs = new Map((s?.measures || []).map((m) => [m.alias, String(m.agg || "").toLowerCase()]));
  // The first measure weighs the rows when it adds up (see dimFromValues).
  const first = (r.measures || [])[0];
  const weights = first && ADDITIVE.has(aggs.get(first) ?? "sum") ? rows.map((row) => row[first]) : null;
  const dims: ShapeDim[] = (r.dimensions || []).map((name) =>
    parts.has(name) || (r.date_parts && name in r.date_parts)
      ? { name, role: "ordinal" as const, distinct: distinctCount(rows.map((row) => row[name])) }
      : dimFromValues(name, rows.map((row) => row[name]), weights)
  );
  let negative = false;
  const sizes: number[] = [];
  const measures: ShapeMeasure[] = (r.measures || []).map((alias) => {
    const values = rows.map((row) => row[alias]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (values.some((v) => v < 0)) negative = true;
    if (values.length) sizes.push(Math.max(...values.map((v) => Math.abs(v))));
    return { name: alias, additive: ADDITIVE.has(aggs.get(alias) ?? "sum"), unit: unitOf(opts.formats?.[alias]) };
  });
  const positive = sizes.filter((v) => v > 0);
  let time: ChartShape["time"] = null;
  if (timeCol) {
    const periods = new Set<string>();
    for (const row of rows) if (row[timeCol] !== null && row[timeCol] !== undefined) periods.add(String(row[timeCol]));
    time = { grain: r.period || s?.time?.grain || "month", periods: periods.size };
  }
  return {
    time, dims, measures, bins: Boolean(s?.bins) || Boolean(r.bins), target: Boolean(opts.target), negative,
    max_ratio: positive.length > 1 ? Math.max(...positive) / Math.min(...positive) : null,
  };
}

// ---- can this shape draw that chart? -------------------------------------------

function needsOf(type: string): string {
  return BY_TYPE.get(type)?.needs ?? "";
}

export type Fit = { ok: true; why: null } | { ok: false; why: string };
const YES: Fit = { ok: true, why: null };

/** Whether the shape can be drawn as `chartType`; `why` is the one line a
 *  disabled tile shows. */
export function fits(shape: ChartShape, chartType: string): Fit {
  let ct = normalizeChartTypeKey(chartType);
  if (ct === null) return { ok: false, why: "not a chart type GD360 draws" };
  if (ct === "grouped_bar") ct = "bar";
  if (ct === "step_line") ct = "line";
  const t = shape.time;
  const dims = shape.dims || [];
  const nd = dims.length, nm = (shape.measures || []).length;
  const axes = nd + (t ? 1 : 0);
  const no: Fit = { ok: false, why: needsOf(ct) };
  const when = (cond: boolean): Fit => (cond ? YES : no);
  if (shape.bins) return ct === "histogram" || ct === "table" ? YES : { ok: false, why: "a binned column is drawn as a histogram" };
  if (ct === "histogram") return no;
  if (ct === "table") return YES;
  if (nm < 1) return { ok: false, why: "needs a measure" };
  if (ct === "kpi") return when(axes === 0);
  if (ct === "bullet") return when((axes === 0 && nm >= 1) || (axes === 1 && !t && nm === 1));
  // A form made of several marks needs several: one category is a number,
  // not a funnel / treemap / waterfall (known only once the values are).
  const lone = nd === 1 && !t && dims[0].distinct !== null && dims[0].distinct !== undefined && dims[0].distinct < 2;
  if (lone && (ct === "funnel" || ct === "treemap" || ct === "waterfall")) return { ok: false, why: "needs at least two categories" };
  if (ct === "funnel") return when((axes === 0 && nm >= 2) || (nd === 1 && !t && nm === 1));
  if (axes === 0) return { ok: false, why: "needs a category or a date to draw across" };
  if (ct === "bar" || ct === "line" || ct === "area") return axes <= 2 ? YES : { ok: false, why: "three dimensions read best as a table" };
  if (ct === "horizontal_bar") return when(axes <= 2 && !(t && nd === 0));
  if (ct === "stacked_bar" || ct === "stacked_bar_100") return when((axes === 2 && nm >= 1) || (axes === 1 && nm >= 2));
  if (ct === "stacked_area" || ct === "stacked_area_100") {
    const ordered = Boolean(t) || (nd >= 1 && dims[0].role === "ordinal");
    return when(ordered && ((axes === 2 && nm >= 1) || (axes === 1 && nm >= 2)));
  }
  if (ct === "combo") return when(axes === 1 && nm >= 2);
  if (ct === "donut" || ct === "pie") return when(nd === 1 && !t && nm === 1);
  if (ct === "treemap") return when((nd === 1 || nd === 2) && !t && nm >= 1);
  if (ct === "map") {
    if (nd === 1 && !t && dims[0].role === "country") return YES;
    if (nd === 1 && !t && dims[0].few_countries !== undefined) return { ok: false, why: `only ${dims[0].few_countries} countries - bars read better` };
    return no;
  }
  if (ct === "heatmap" || ct === "pivot") return when(axes === 2);
  if (ct === "scatter") return when(axes === 1 && nm >= 2);
  if (ct === "bubble") return when(axes === 1 && nm >= 3);
  if (ct === "waterfall") {
    if (axes === 2 && nm === 1) {
      // A bridge: one of the two dimensions has exactly two values (two
      // years, plan and actual) - checked once the values are known.
      const sizes: (number | null | undefined)[] = [...dims.map((d) => d.distinct), ...(t ? [t.periods] : [])];
      if (sizes.every((s) => typeof s === "number") && !sizes.includes(2)) return no;
      return YES;
    }
    return when(axes === 1 && nm === 1);
  }
  return no;
}

/** fits() for a spec that has not run: a map is accepted for any single
 *  category (whether its values are countries is only known from the data). */
export function fitsBeforeRun(shape: ChartShape, chartType: string): Fit {
  const f = fits(shape, chartType);
  if (!f.ok && normalizeChartTypeKey(chartType) === "map" && shape.dims.length === 1 && !shape.time && shape.measures.length > 0) return YES;
  return f;
}

// ---- the recommendation -----------------------------------------------------------

export type Recommendation = { chart_type: string; block_type: "chart" | "kpi" | "table" | "donut"; reason: string; strength: "strong" | "weak" };
export type Resolved = Recommendation & { suggested: string | null; overrode: boolean; override_reason: string | null };

const GRAIN_PLURAL: Record<string, string> = { day: "days", week: "weeks", month: "months", quarter: "quarters", year: "years" };

function n(value: number): string {
  return Math.trunc(value).toLocaleString("en-US");
}

function periodsText(time: NonNullable<ChartShape["time"]>): string {
  const grain = time.grain || "month";
  const plural = GRAIN_PLURAL[grain] ?? `${grain}s`;
  if (typeof time.periods === "number" && Number.isInteger(time.periods)) return `${n(time.periods)} ${time.periods !== 1 ? plural : grain}`;
  return `time (by ${grain})`;
}

function rec(chart_type: string, reason: string, strength: "strong" | "weak" = "weak"): Recommendation {
  return { chart_type, block_type: blockTypeFor(chart_type), reason, strength };
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** The recommended chart for a shape, with the line shown to the person. */
export function recommend(shape: ChartShape): Recommendation {
  const t = shape.time;
  const dims = shape.dims || [];
  const measures = shape.measures || [];
  const nd = dims.length, nm = measures.length;

  if (shape.bins) return rec("histogram", "Distribution of one numeric column → histogram", "strong");
  if (nm === 0) return rec("table", "No measure to draw → table", "strong");

  if (nd === 0 && !t) {
    if (shape.target && nm === 1) return rec("bullet", "One number against a target → bullet");
    return rec("kpi", "One headline number → KPI tile", "strong");
  }

  if (t && nd === 0) {
    if (isInt(t.periods) && t.periods <= 3) return rec("bar", `Only ${periodsText(t)} → bars`);
    if (nm === 1) return rec("line", `One measure over ${periodsText(t)} → line`);
    const units = new Set(measures.map((m) => m.unit || "number"));
    if (units.size > 1 || (typeof shape.max_ratio === "number" && shape.max_ratio > SCALE_RATIO)) {
      return rec("line", `${n(nm)} measures of different scale over ${periodsText(t)} → aligned panels, never two y-axes`);
    }
    return rec("line", `${n(nm)} measures over ${periodsText(t)} → lines`);
  }

  if (t && nd === 1) {
    if (nm >= 2) return rec("table", "Several measures by period and category → table", "strong");
    const distinct = dims[0].distinct;
    if (isInt(distinct) && distinct > SERIES_MAX) return rec("heatmap", `${n(distinct)} series over ${periodsText(t)} → heatmap`, "strong");
    return rec("line", `One measure over ${periodsText(t)}, one line per category → lines`);
  }

  if (t && nd >= 2) return rec("table", "Three dimensions → table", "strong");

  if (nd === 1) {
    const d = dims[0];
    const distinct = d.distinct;
    const known = isInt(distinct);
    if (nm === 1) {
      const m = measures[0];
      if (d.role === "country") {
        const count = isInt(d.countries) ? d.countries : distinct;
        if (isInt(count)) return rec("map", `Country column with ${n(count)} values → map`, "strong");
        return rec("map", "Country column → map", "strong");
      }
      if (d.few_countries !== undefined) return rec("bar", `Only ${n(d.few_countries)} countries → bars`);
      if (known && (distinct as number) <= 1) return rec("bar", "A single value → one bar");
      if (d.role === "ordinal") {
        if (known && (distinct as number) > RANKING_MAX) return rec("line", `Ordered scale with ${n(distinct as number)} values → line`);
        return rec("bar", known ? `${n(distinct as number)} ordered values → bars` : "Ordered values → bars");
      }
      if (!known) return rec("bar", "One measure across a category → bars");
      const k = distinct as number;
      if (k > TABLE_MIN_CATEGORIES) return rec("table", `${n(k)} categories → table`, "strong");
      if (k > RANKING_MAX) return rec("horizontal_bar", `${n(k)} categories → horizontal bars of the largest`);
      if (k > DONUT_MAX) return rec("horizontal_bar", `Ranking of ${n(k)} → horizontal bars`);
      if (k >= DONUT_MIN && m.additive && !shape.negative) return rec("donut", `Share across ${n(k)} categories → donut`);
      return rec("bar", `Comparison across ${n(k)} categories → bars`);
    }
    if (nm === 2) {
      if (known && (distinct as number) >= SCATTER_MIN_POINTS) return rec("scatter", "Two measures per item → scatter");
      return rec("bar", "Two measures across a few categories → side-by-side bars");
    }
    if (known && (distinct as number) <= 12 && nm <= 4) return rec("bar", `${n(nm)} measures across ${n(distinct as number)} categories → one panel each`);
    return rec("table", `${n(nm)} measures per item → table`, "strong");
  }

  if (nd === 2) {
    if (nm >= 2) return rec("pivot", `Two dimensions and ${n(nm)} measures → pivot table`, "strong");
    const a = dims[0].distinct, b = dims[1].distinct;
    if (isInt(a) && isInt(b)) {
      if (a * b > HEATMAP_MAX_CELLS) return rec("table", `Too many combinations (${n(a * b)}) → table`, "strong");
      return rec("heatmap", `Two dimensions (${n(a)} × ${n(b)}) → heatmap`, "strong");
    }
    return rec("heatmap", "Two dimensions → heatmap", "strong");
  }

  return rec("table", "Three dimensions → table", "strong");
}

/** recommend(), after weighing a suggested chart type (see the Python
 *  docstring: `explicit` = the person asked for that form). */
export function resolve(shape: ChartShape, hint?: string | null, explicit = false): Resolved {
  const out: Resolved = { ...recommend(shape), suggested: null, overrode: false, override_reason: null };
  const raw = hint;
  const key = hint ? normalizeChartTypeKey(hint) : null;
  if (raw && !key) return { ...out, suggested: String(raw).slice(0, 40), overrode: true, override_reason: "not a chart type GD360 draws" };
  if (!key) return out;
  out.suggested = key;
  const plain = key === "grouped_bar" ? "bar" : key === "step_line" ? "line" : key;
  if (plain === out.chart_type) return { ...out, chart_type: key };
  const f = fits(shape, key);
  if (!f.ok) return { ...out, overrode: true, override_reason: f.why };
  if (explicit || out.strength === "weak") {
    const label = BY_TYPE.get(plain)?.label ?? plain;
    return {
      chart_type: key, block_type: blockTypeFor(plain), strength: "weak",
      reason: explicit ? `${label}, as asked` : `${label}, as suggested for this block`,
      suggested: key, overrode: false, override_reason: null,
    };
  }
  return { ...out, overrode: true, override_reason: out.reason };
}

/** The chart type a block is DRAWN as. A type GD360 chose before the
 *  block had run (config.chart_auto without chart_checked) was chosen
 *  from column names; the first result has the values, so the same rule
 *  is asked again - exactly what the server does on that run
 *  (_confirm_auto_charts), so the page and the stored block agree. */
export function effectiveChartType(config: any, result: BlockResult | null | undefined, blockType: string): { chartType: string | null; blockType: string; reason: string | null } {
  const current: string | null = blockType === "donut" ? "donut" : typeof config?.chart_type === "string" ? config.chart_type : null;
  const stored = { chartType: current, blockType, reason: typeof config?.chart_reason === "string" ? config.chart_reason : null };
  if (blockType !== "chart" && blockType !== "donut") return stored;
  if (!config?.chart_auto || config?.chart_checked || !result || result.status !== "ok" || !result.rows?.length) return stored;
  const target = typeof config?.target === "number";
  const shape = shapeFromResult(result, config?.spec, { target });
  const r = recommend(shape);
  const fit = current ? fits(shape, current) : ({ ok: false, why: "" } as Fit);
  if ((!fit.ok || (r.strength === "strong" && r.chart_type !== current)) && (r.block_type === "chart" || r.block_type === "donut")) {
    return { chartType: r.chart_type, blockType: r.block_type, reason: r.reason };
  }
  if (fit.ok && r.chart_type === current) return { ...stored, reason: r.reason };
  return stored;
}
