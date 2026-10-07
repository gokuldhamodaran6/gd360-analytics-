// The chart contract (2026-10-07, chart-integrity round) - the frontend half.
//
// A chart is a deterministic function of the result table. deriveChartModel
// decides, from (result_columns, result_rows, chart_type) and nothing else,
// what a standard chart shows:
//
//   x        the category / time dimension (one tick per distinct value)
//   series   one per measure column (a WIDE result: dimension + N numbers)
//            or one per value of a series dimension (a LONG result:
//            dimension, series dimension, one number)
//   values   each series' numbers, aligned to x - copied, never recomputed
//
// It is a line-for-line port of backend/app/services/chart_model.py and the
// two are held to each other by a shared fixture file
// (gd360-wh-test/chart_model_fixtures.json, written by the backend test and
// read by workspacechart.test.tsx): the same table must give the same model
// on both sides.
//
// Why the browser has it too: a message stored before figures were audited
// can hold a Plotly figure that contradicts its own rows (a pivoted result
// drawn as one hotel's revenue against the other's). The workspace never
// draws the stored figure when the rows are there - it draws THIS model -
// so an old conversation opens with the right chart without re-asking.
// auditFigure() says exactly how a stored figure disagrees with its rows.

export type ModelColumn = { name: string; dtype?: string | null; role?: string | null };
export type ModelRow = Record<string, any>;

export type AxisKind = "time" | "ordinal" | "category";

export type ChartModelX = { name: string; axis: AxisKind; ordered: boolean; labels: string[]; values: any[] };
export type ChartModelSeries = { name: string; values: (number | null)[] };

export type ChartModelKind = "cartesian" | "pie" | "kpi" | "table" | "passthrough";

export type ResultChartModel = {
  kind: ChartModelKind;
  chart_type: string;
  x: ChartModelX | null;
  series_by: string | null;
  measure: string | null;
  measures: string[];
  series: ChartModelSeries[];
  stacked: boolean;
  horizontal: boolean;
  note: string | null;
  reason: string | null;
  transposed?: boolean;
};

export const LINE_TYPES = new Set(["line", "area", "stacked_area", "step_line"]);
export const BAR_TYPES = new Set(["bar", "horizontal_bar", "grouped_bar", "stacked_bar"]);
export const PIE_TYPES = new Set(["pie", "donut"]);
export const STANDARD_TYPES = new Set([...LINE_TYPES, ...BAR_TYPES, ...PIE_TYPES, "table", "kpi"]);
export const MAX_SERIES = 12;
export const MAX_CATEGORIES = 500;
export const MAX_KPIS = 4;
export const BLANK_LABEL = "(Blanks)";

const TYPE_ALIASES: Record<string, string> = { column: "bar", single_value: "kpi", number: "kpi", big_number: "kpi", indicator: "kpi" };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_INDEX: Record<string, number> = {};
MONTHS.forEach((m, i) => { MONTH_INDEX[m] = i; MONTH_INDEX[m.slice(0, 3)] = i; });
MONTH_INDEX.sept = 8;
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const WEEKDAY_INDEX: Record<string, number> = {};
WEEKDAYS.forEach((d, i) => { WEEKDAY_INDEX[d] = i; WEEKDAY_INDEX[d.slice(0, 3)] = i; });

const TIME_TOKENS = new Set(["year", "yr", "fy", "month", "mon", "quarter", "qtr", "week", "wk", "day", "dow", "weekday", "hour", "hr", "date", "period"]);
const TIME_SUFFIX_OK = new Set([...TIME_TOKENS, "number", "num", "no", "of", "index", "name", "start", "end", "id", "key"]);
const ID_TOKENS = new Set(["id", "code", "zip", "zipcode", "postcode", "postal", "sku", "key", "uuid", "no", "num", "number"]);
const MEASURE_TOKENS = new Set([
  "total", "sum", "avg", "average", "mean", "median", "count", "cnt", "rate", "pct", "percent", "percentage", "share", "ratio",
  "amount", "revenue", "sales", "price", "cost", "profit", "margin", "qty", "quantity", "per", "min", "max", "std", "stddev",
  "var", "variance", "score", "value", "nights", "stays", "bookings", "orders", "customers", "users", "rows",
]);

const ISO_DATE_RE = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const MIDNIGHT_RE = /[T ]00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?$/;
const QUARTER_RE = /^(\d{4})[-\s]?Q([1-4])$|^Q([1-4])[-\s]?(\d{4})$/i;
const NUMERIC_TEXT_RE = /^-?\d+(?:\.\d+)?$/;

// ---- values ---------------------------------------------------------------

export function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "number" && !Number.isFinite(v)) return true;
  return typeof v === "string" && v.trim() === "";
}

/** A number used as a LABEL (a year, an id): "2015", never "2,015". */
export function numberLabel(v: number): string {
  return String(v);
}

/** How one dimension value is written on an axis, in a legend, in a
 *  sentence. The same function labels the model's categories and reads a
 *  figure's ticks, so the audit compares like with like. */
export function valueLabel(v: unknown): string {
  if (isBlank(v)) return BLANK_LABEL;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (isNumber(v)) return numberLabel(v);
  const s = String(v).trim();
  if (ISO_DATE_RE.test(s)) return s.replace(MIDNIGHT_RE, "");
  return s;
}

export function nameTokensList(name: unknown): string[] {
  const spaced = String(name ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function timeNamed(name: string): boolean {
  const toks = nameTokensList(name);
  if (!toks.length || toks.some((t) => MEASURE_TOKENS.has(t))) return false;
  for (let i = 0; i < toks.length; i++) {
    if (TIME_TOKENS.has(toks[i]) && toks.slice(i + 1).every((x) => TIME_SUFFIX_OK.has(x))) return true;
  }
  return false;
}

function idNamed(name: string): boolean {
  const toks = nameTokensList(name);
  if (!toks.length || toks.some((t) => MEASURE_TOKENS.has(t))) return false;
  return ID_TOKENS.has(toks[toks.length - 1]) && !(toks.length > 1 && ["num", "number", "no"].includes(toks[0]));
}

function flagNamed(name: string): boolean {
  const n = String(name).toLowerCase();
  return n.startsWith("is_") || n.startsWith("has_") || n.endsWith("_flag");
}

function yearLike(values: unknown[]): boolean {
  return values.length > 0 && values.every((v) => isNumber(v) && Number.isInteger(v) && v >= 1900 && v <= 2100);
}

/** A sort key for a value that has a natural order; null for free text. */
function orderKey(v: unknown): number[] | null {
  if (typeof v === "boolean" || isBlank(v)) return null;
  if (isNumber(v)) return [0, v];
  const s = String(v).trim();
  if (NUMERIC_TEXT_RE.test(s)) return [0, Number(s)];
  const m = ISO_DATE_RE.exec(s);
  if (m) return [1, Number(m[1]), Number(m[2]), Number(m[3] || 1), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)];
  const q = QUARTER_RE.exec(s);
  if (q) return [2, Number(q[1] || q[4]), Number(q[2] || q[3])];
  const low = s.toLowerCase();
  if (low in MONTH_INDEX) return [3, MONTH_INDEX[low]];
  if (low in WEEKDAY_INDEX) return [4, WEEKDAY_INDEX[low]];
  return null;
}

function compareKeys(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -Infinity, y = b[i] ?? -Infinity;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---- columns --------------------------------------------------------------

export type ClassifiedColumn = { name: string; role: "dimension" | "measure"; axis: AxisKind | null; why: string; time_like: boolean };

/** Every column of a tidy result as a dimension or a measure. A measure is
 *  a column of numbers that are quantities; a dimension is everything else
 *  AND a column of whole numbers that identify something (a year, a month
 *  number, an id, a zip code, a 0/1 flag) - those are labels on a category
 *  axis, written "2015", never "2,015", never a tick at 2,015.5. */
export function classifyColumns(columns: ModelColumn[], rows: ModelRow[]): ClassifiedColumn[] {
  const names = columns.map((c) => String(c.name));
  return columns.map((c) => {
    const name = String(c.name);
    const present = rows.map((r) => r[name]).filter((v) => !isBlank(v));
    const dtype = String(c.dtype || "").toLowerCase();
    const declaredDimension = String(c.role || "").toLowerCase() === "dimension";
    const numeric = present.length > 0 && present.every(isNumber);
    const info: ClassifiedColumn = { name, role: "dimension", axis: "category", why: "text", time_like: false };
    if (!present.length) {
      const isMeasure = dtype === "number" && !declaredDimension;
      info.role = isMeasure ? "measure" : "dimension";
      info.axis = isMeasure ? null : "category";
      info.why = "empty";
    } else if (numeric) {
      const whole = present.every((v) => Number.isInteger(v));
      if (declaredDimension) {
        info.axis = "ordinal"; info.why = "declared"; info.time_like = timeNamed(name) || yearLike(present);
      } else if (names.length === 2 && names[0] === "label" && names[1] === "value" && name === "label") {
        info.axis = "ordinal"; info.why = "series index"; info.time_like = yearLike(present);
      } else if (whole && timeNamed(name)) {
        info.axis = "ordinal"; info.why = "period name"; info.time_like = true;
      } else if (whole && idNamed(name)) {
        info.axis = "ordinal"; info.why = "identifier name";
      } else if (whole && flagNamed(name) && present.every((v) => v === 0 || v === 1)) {
        info.axis = "ordinal"; info.why = "flag";
      } else {
        info.role = "measure"; info.axis = null; info.why = "number";
      }
    } else if (dtype === "boolean" || present.every((v) => typeof v === "boolean")) {
      info.axis = "category"; info.why = "boolean";
    } else {
      const keys = present.map(orderKey);
      if (keys.every((k) => k !== null && k[0] === 1)) {
        info.axis = "time"; info.why = "dates"; info.time_like = true;
      } else if (keys.every((k) => k !== null) && new Set(keys.map((k) => k![0])).size === 1) {
        const kind = keys[0]![0];
        const period = kind === 2 || kind === 3 || kind === 4 || (kind === 0 && (timeNamed(name) || yearLike(keys.map((k) => k![1]))));
        info.axis = "ordinal"; info.why = "ordered text"; info.time_like = period;
      } else if (dtype === "date") {
        info.axis = "category"; info.why = "date-typed text";
      }
    }
    return info;
  });
}

/** No column is a dimension by type or by name, yet a chart needs one: the
 *  first column whose values are whole and distinct (preferring one that
 *  reads as years), else the first column if its values are distinct. */
function promotePositionalDimension(cols: ClassifiedColumn[], rows: ModelRow[]): void {
  const measures = cols.filter((c) => c.role === "measure");
  if (measures.length < 2) return;
  const valuesOf = (c: ClassifiedColumn) => rows.map((r) => r[c.name]).filter((v) => !isBlank(v));
  const distinct = (vals: unknown[]) => vals.length === rows.length && new Set(vals).size === vals.length;
  let pick: ClassifiedColumn | null = null;
  for (const c of measures) {
    const vals = valuesOf(c);
    if (distinct(vals) && yearLike(vals)) { pick = c; break; }
  }
  if (!pick) {
    // Whole numbers under a name that is not a quantity's (an integer
    // bucket) - never a fractional column or "avg_lead_time" / "bookings":
    // one measure's values on the axis under another measure is the
    // original wrong chart with category labels. (chart_model.py, same rule.)
    const first = measures[0];
    const vals = valuesOf(first);
    const whole = vals.length > 0 && vals.every((v) => isNumber(v) && Number.isInteger(v));
    if (distinct(vals) && whole && !nameTokensList(first.name).some((t) => MEASURE_TOKENS.has(t))) pick = first;
  }
  if (pick) {
    pick.role = "dimension"; pick.axis = "ordinal"; pick.why = "position"; pick.time_like = yearLike(valuesOf(pick));
  }
}

// ---- the model ------------------------------------------------------------

export function normalizeModelChartType(chartType: string | null | undefined): string {
  const ct = String(chartType || "bar").toLowerCase().trim();
  return TYPE_ALIASES[ct] || ct;
}

function table(chartType: string, reason: string | null, measures: string[] = []): ResultChartModel {
  return { kind: "table", chart_type: chartType, x: null, series_by: null, measure: null, measures, series: [], stacked: false, horizontal: false, note: null, reason };
}

function cleanNumber(v: unknown): number | null {
  return isNumber(v) ? v : null;
}

function friendlyType(chartType: string): string {
  return chartType.replace(/_/g, " ");
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** Explicit field roles, for a table the person has mapped themselves in
 *  "Edit chart" (x / series / measures chosen there are not inferred again).
 *  `keepOrder`: the rows are already in the order the person asked for (a
 *  sort or a top-N in Edit chart) - x is not re-sorted. */
export type ModelRoles = { x: string; seriesBy?: string | null; measures: string[]; keepOrder?: boolean };

/** (result_columns, result_rows, chart_type) -> the chart model. */
export function deriveChartModel(columnsIn: ModelColumn[] | null | undefined, rowsIn: ModelRow[] | null | undefined, chartType: string | null | undefined, roles?: ModelRoles | null): ResultChartModel {
  const ct = normalizeModelChartType(chartType);
  const columns = (columnsIn || []).filter((c) => c && typeof c === "object" && c.name !== null && c.name !== undefined);
  const rows = (rowsIn || []).filter((r) => r && typeof r === "object");
  if (!STANDARD_TYPES.has(ct)) {
    return { kind: "passthrough", chart_type: ct, x: null, series_by: null, measure: null, measures: [], series: [], stacked: false, horizontal: false, note: null, reason: null };
  }
  if (!columns.length || !rows.length) return table(ct, "There are no rows to draw.");

  let cols = classifyColumns(columns, rows);
  if (roles) {
    // The person's own mapping: nothing is inferred.
    const dims = new Set([roles.x, ...(roles.seriesBy ? [roles.seriesBy] : [])]);
    cols = cols
      .filter((c) => dims.has(c.name) || roles.measures.includes(c.name))
      .map((c) => (dims.has(c.name)
        ? { ...c, role: "dimension" as const, axis: c.role === "dimension" && c.axis ? c.axis : ("ordinal" as AxisKind), why: c.role === "dimension" ? c.why : "chosen" }
        : { ...c, role: "measure" as const, axis: null, why: c.why === "empty" ? "empty" : "number" }));
    cols.sort((a, b) => (a.name === roles.x ? -1 : b.name === roles.x ? 1 : 0));
  } else if (!cols.some((c) => c.role === "dimension") && rows.length > 1) {
    promotePositionalDimension(cols, rows);
  }
  const dims = cols.filter((c) => c.role === "dimension");
  const measures = cols.filter((c) => c.role === "measure" && c.why !== "empty").map((c) => c.name);

  if (ct === "table") return table(ct, null, measures);
  if (!measures.length) {
    const empty = cols.filter((c) => c.why === "empty").map((c) => c.name);
    if (empty.length) return table(ct, `Every value of ${empty.join(", ")} is empty, so there is nothing to draw; the result is shown as a table.`);
    return table(ct, "This result has no numeric column to plot, so it is shown as a table.");
  }

  // ---- one row, no dimension ----
  if (!dims.length) {
    if (rows.length === 1) {
      const values = measures.map((m) => cleanNumber(rows[0][m]));
      if (measures.length >= 2 && (BAR_TYPES.has(ct) || PIE_TYPES.has(ct))) {
        if (PIE_TYPES.has(ct) && (values.some((v) => v !== null && v < 0) || !values.some((v) => v))) {
          return table(ct, `A ${friendlyType(ct)} chart needs positive values to divide a whole; this result is shown as a table.`, measures);
        }
        return {
          kind: PIE_TYPES.has(ct) ? "pie" : "cartesian", chart_type: ct,
          x: { name: "measure", axis: "category", ordered: false, labels: measures.map(String), values: measures.map(String) },
          series_by: null, measure: "value", measures: ["value"], transposed: true,
          series: [{ name: "value", values }],
          stacked: false, horizontal: ct === "horizontal_bar", note: null, reason: null,
        };
      }
      if (measures.length > MAX_KPIS) return table(ct, `This result is one row of ${measures.length} numbers, which reads best as a table.`, measures);
      return {
        kind: "kpi", chart_type: "kpi", x: null, series_by: null, measure: measures[0], measures,
        series: measures.map((m, i) => ({ name: m, values: [values[i]] })),
        stacked: false, horizontal: false, note: null, reason: null,
      };
    }
    return table(ct, `This result has ${count(rows.length)} rows of numbers and no category or date column to put on the axis, so it is shown as a table.`, measures);
  }
  if (ct === "kpi") return table(ct, "A single-value tile needs one row with one number; this result has a breakdown, so it is shown as a table.", measures);

  // ---- which dimension is the axis ----
  const x = roles ? dims[0] : dims.find((d) => d.axis === "time") || dims.find((d) => d.time_like) || dims[0];
  const others = dims.filter((d) => d !== x);
  if (others.length > 1) {
    return table(ct, `This result is broken down by ${dims.length} columns (${dims.map((d) => d.name).join(", ")}); a ${friendlyType(ct)} chart can show one axis and one series split, so it is shown as a table.`, measures);
  }
  const seriesDim = others[0] || null;
  const xname = x.name;

  // ---- the categories, in order ----
  const sortable = !roles?.keepOrder && (x.axis === "time" || (x.axis === "ordinal" && (x.time_like || LINE_TYPES.has(ct))));
  let work = rows;
  if (sortable) {
    work = rows.filter((r) => !isBlank(r[xname]));
    if (!work.length) return table(ct, `Every ${xname} value is empty, so there is nothing to put on the axis.`, measures);
  }
  let labels: string[] = [];
  let rawValues: any[] = [];
  let index = new Map<string, number>();
  for (const r of work) {
    const lab = valueLabel(r[xname]);
    if (!index.has(lab)) {
      index.set(lab, labels.length);
      labels.push(lab);
      rawValues.push(isBlank(r[xname]) ? null : r[xname]);
    }
  }
  if (sortable) {
    const keyed = rawValues.map((v, i) => ({ k: orderKey(v), i }));
    if (keyed.every((t) => t.k !== null)) {
      keyed.sort((a, b) => compareKeys(a.k!, b.k!) || a.i - b.i);
      labels = keyed.map((t) => labels[t.i]);
      rawValues = keyed.map((t) => rawValues[t.i]);
      index = new Map(labels.map((lab, i) => [lab, i]));
    }
  }
  if (labels.length > MAX_CATEGORIES) return table(ct, `${count(labels.length)} distinct ${xname} values are too many for one axis, so this is shown as a table.`, measures);

  const stacked = ct === "stacked_bar" || ct === "stacked_area";
  const horizontal = ct === "horizontal_bar";
  const ordered = x.axis === "time" || Boolean(x.time_like);
  const base = { chart_type: ct, x: { name: xname, axis: (x.axis || "category") as AxisKind, ordered, labels, values: rawValues }, measures, stacked, horizontal, reason: null };

  // ---- long: one series per value of the series dimension ----
  if (seriesDim) {
    const sname = seriesDim.name;
    const measure = measures[0];
    let note: string | null = null;
    if (measures.length > 1) note = `Showing ${measure}. ${measures.slice(1).join(", ")} ${measures.length === 2 ? "is" : "are"} in the table.`;
    const order: string[] = [];
    const cells = new Map<string, (number | null)[]>();
    const seen = new Set<string>();
    for (const r of work) {
      const xl = valueLabel(r[xname]);
      const sl = valueLabel(r[sname]);
      const key = `${xl}\u0000${sl}`;
      if (seen.has(key)) return table(ct, `Several rows share the same ${xname} and ${sname}, so one mark per pair would hide rows; this is shown as a table.`, measures);
      seen.add(key);
      if (!cells.has(sl)) {
        cells.set(sl, new Array(labels.length).fill(null));
        order.push(sl);
      }
      cells.get(sl)![index.get(xl)!] = cleanNumber(r[measure]);
    }
    if (order.length > MAX_SERIES) return table(ct, `${order.length} ${sname} values are too many series to tell apart on one chart, so this is shown as a table.`, measures);
    if (PIE_TYPES.has(ct)) return table(ct, `A ${friendlyType(ct)} chart shows one breakdown; this result is split by both ${xname} and ${sname}, so it is shown as a table.`, measures);
    return { ...base, kind: "cartesian", series_by: sname, measure, note, series: order.map((s) => ({ name: s, values: cells.get(s)! })) };
  }

  // ---- wide: one series per measure ----
  if (labels.length !== work.length) return table(ct, `Several rows share the same ${xname}, so one mark per ${xname} would hide rows; this is shown as a table.`, measures);
  const byLabel = new Map<string, ModelRow>();
  for (const r of work) byLabel.set(valueLabel(r[xname]), r);
  const column = (m: string) => labels.map((lab) => cleanNumber(byLabel.get(lab)![m]));

  if (PIE_TYPES.has(ct)) {
    const measure = measures[0];
    const values = column(measure);
    if (values.some((v) => v !== null && v < 0)) return table(ct, `A ${friendlyType(ct)} chart cannot show negative values (${measure} has some), so this is shown as a table.`, measures);
    if (!values.some((v) => v)) return table(ct, `Every ${measure} value is zero or empty, so there is no whole to divide; this is shown as a table.`, measures);
    let note: string | null = null;
    if (measures.length > 1) note = `Showing ${measure}. ${measures.slice(1).join(", ")} ${measures.length === 2 ? "is" : "are"} in the table.`;
    return { ...base, kind: "pie", series_by: null, measure, note, stacked: false, horizontal: false, series: [{ name: measure, values }] };
  }
  return { ...base, kind: "cartesian", series_by: null, measure: measures.length === 1 ? measures[0] : null, note: null, series: measures.map((m) => ({ name: m, values: column(m) })) };
}

// ---- the audit ------------------------------------------------------------

export const OVERLAY_ROLES = new Set(["forecast_line", "forecast_band", "trend_line", "trend_band", "anomaly_markers"]);
const REL_TOL = 1e-6;

export function numbersEqual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a === null || a === undefined) && (b === null || b === undefined);
  const fa = Number(a), fb = Number(b);
  if (Number.isNaN(fa) || Number.isNaN(fb)) return Number.isNaN(fa) && Number.isNaN(fb);
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) return !Number.isFinite(fa) && !Number.isFinite(fb);
  return Math.abs(fa - fb) <= REL_TOL * Math.max(1, Math.abs(fa), Math.abs(fb));
}

function titleText(t: unknown): string {
  if (typeof t === "string") return t;
  if (t && typeof t === "object" && typeof (t as any).text === "string") return (t as any).text;
  return "";
}

export function nameTokens(s: unknown): Set<string> {
  return new Set(nameTokensList(s).filter((t) => t.length > 1).map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t)));
}

const PLACEHOLDER_NAMES = new Set(["label", "value", "index", "x", "y", "0", "1", "count", "level", "unnamed"]);

export function isPlaceholderName(name: unknown): boolean {
  const s = String(name ?? "").trim().toLowerCase();
  return !s || PLACEHOLDER_NAMES.has(s) || s.startsWith("level_");
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function union(names: string[]): Set<string> {
  const out = new Set<string>();
  for (const n of names) for (const t of nameTokens(n)) out.add(t);
  return out;
}

/** Does an axis title name the column(s) actually on that axis? */
export function axisLabelOk(label: string | null | undefined, ownNames: string[], otherNames: string[]): boolean {
  const text = (label || "").trim();
  if (!text) return true;
  const want = nameTokens(text);
  if (!want.size) return true;
  if (intersects(want, union(ownNames))) return true;
  if (intersects(want, union(otherNames))) return false;
  return ownNames.every(isPlaceholderName);
}

export function yAxisNames(model: ResultChartModel): string[] {
  const names = [...(model.measures || [])];
  if (model.measure && !names.includes(model.measure)) names.push(model.measure);
  return names;
}

/** A value-axis title is accepted when it names a measure, or names no
 *  column at all on a chart whose series are columns of one pivoted
 *  quantity; rejected when it names the dimension, or - with one measure -
 *  something that is not that measure. */
export function valueAxisLabelOk(label: string | null | undefined, model: ResultChartModel): boolean {
  const text = (label || "").trim();
  if (!text || !model.x) return true;
  const want = nameTokens(text);
  if (!want.size) return true;
  const names = yAxisNames(model);
  const dimNames = [model.x.name, ...(model.series_by ? [model.series_by] : [])];
  if (intersects(want, union(names))) return true;
  if (intersects(want, union(dimNames))) return false;
  if ((model.series || []).length > 1 && !model.series_by) return true;
  return names.every(isPlaceholderName);
}

/** Every way `figure` (a Plotly {data, layout}) disagrees with `model`.
 *  [] means the figure draws exactly the model. */
export function auditFigure(figure: any, model: ResultChartModel): string[] {
  const kind = model.kind;
  if (kind !== "cartesian" && kind !== "pie" && kind !== "kpi") return [];
  if (!figure || typeof figure !== "object") return ["the figure is not a Plotly figure"];
  const problems: string[] = [];
  const layout: Record<string, any> = figure.layout && typeof figure.layout === "object" ? figure.layout : {};
  const traces: any[] = (Array.isArray(figure.data) ? figure.data : []).filter((t: any) => t && typeof t === "object" && !(t.meta && typeof t.meta === "object" && OVERLAY_ROLES.has(t.meta.role)));
  const series = model.series || [];

  if (kind === "kpi") {
    const shown = series.filter((s) => s.values.length && s.values[0] !== null);
    if (traces.length !== shown.length || traces.some((t) => t.type !== "indicator")) {
      return [`${shown.length} single value(s) should be ${shown.length} indicator(s); the figure has ${traces.length} trace(s) of type ${traces[0]?.type ?? null}`];
    }
    traces.forEach((t, i) => {
      if (!numbersEqual(t.value, shown[i].values[0])) problems.push(`the indicator for ${shown[i].name} shows ${JSON.stringify(t.value)}, the table says ${JSON.stringify(shown[i].values[0])}`);
    });
    return problems;
  }

  const x = model.x!;
  const labels = x.labels;
  const labelSet = new Set(labels);

  if (kind === "pie") {
    if (traces.length !== 1 || traces[0].type !== "pie") return [`a pie should be one pie trace, the figure has ${traces.length} trace(s)`];
    const t = traces[0];
    if (!Array.isArray(t.labels) || !Array.isArray(t.values) || t.labels.length !== t.values.length) return ["the pie's labels and values are not readable lists of the same length"];
    const want = new Map<string, number | null>(labels.map((lab, i) => [lab, series[0].values[i]]));
    const used = new Set<string>();
    let otherTotal: any = undefined;
    t.labels.forEach((lab: any, i: number) => {
      const v = t.values[i];
      const key = valueLabel(lab);
      if (want.has(key) && !used.has(key)) {
        used.add(key);
        const w = want.get(key);
        if (!numbersEqual(v, w ?? 0) && !(w === null && (v === null || v === undefined))) problems.push(`slice ${JSON.stringify(key)} is ${JSON.stringify(v)}, the table says ${JSON.stringify(w)}`);
      } else if (/^Other( \(\d+\))?$/.test(String(lab)) && otherTotal === undefined) {
        otherTotal = v;
      } else {
        problems.push(`slice ${JSON.stringify(String(lab))} is not a ${x.name} value`);
      }
    });
    const rest = labels.filter((k) => !used.has(k)).map((k) => want.get(k) || 0);
    const restSum = rest.reduce((s, v) => s + v, 0);
    if (otherTotal !== undefined) {
      if (!numbersEqual(otherTotal, restSum)) problems.push(`the 'Other' slice is ${JSON.stringify(otherTotal)}, the remaining rows add up to ${restSum}`);
    } else if (rest.some((v) => v)) {
      problems.push(`${rest.length} ${x.name} value(s) are missing from the pie`);
    }
    return problems;
  }

  // ---- cartesian ----
  if (traces.length !== series.length) problems.push(`${traces.length} trace(s) drawn, the table has ${series.length} series`);
  const unmatched = series.map((_, i) => i);
  traces.forEach((t, ti) => {
    const ttype = t.type || "scatter";
    if (ttype !== "scatter" && ttype !== "bar" && ttype !== "scattergl") {
      problems.push(`trace ${ti + 1} is a ${ttype} trace`);
      return;
    }
    const horizontal = t.orientation === "h";
    const cats = horizontal ? t.y : t.x;
    const vals = horizontal ? t.x : t.y;
    if (!Array.isArray(cats) || !Array.isArray(vals) || cats.length !== vals.length) {
      problems.push(`trace ${ti + 1} has no readable category / value lists`);
      return;
    }
    const catLabels = cats.map(valueLabel);
    const stray = catLabels.filter((c) => !labelSet.has(c));
    if (stray.length) {
      problems.push(`trace ${ti + 1} (${t.name || "unnamed"}) plots ${JSON.stringify(stray[0])} on the ${x.name} axis, which is not a ${x.name} value`);
      return;
    }
    if (new Set(catLabels).size !== catLabels.length) {
      problems.push(`trace ${ti + 1} repeats a ${x.name} value`);
      return;
    }
    const got = new Map<string, any>(catLabels.map((c, i) => [c, vals[i]]));
    const same = (si: number) => labels.every((lab, i) => {
      let g = got.get(lab);
      if (typeof g === "number" && !Number.isFinite(g)) g = null;
      return numbersEqual(g ?? null, series[si].values[i]);
    });
    const named = unmatched.find((si) => String(series[si].name) === String(t.name));
    const match = named !== undefined && same(named) ? named : unmatched.find((si) => same(si));
    if (match === undefined) problems.push(`trace ${ti + 1} (${t.name || "unnamed"}) does not equal any series of the table`);
    else unmatched.splice(unmatched.indexOf(match), 1);
    if (ttype !== "bar" && t.line && typeof t.line === "object" && t.line.shape === "spline") {
      problems.push(`trace ${ti + 1} is drawn as a smoothed curve, which invents values between points`);
    }
  });

  const horizontalFig = traces.some((t) => t.orientation === "h");
  const catKey = horizontalFig ? "yaxis" : "xaxis";
  const valKey = horizontalFig ? "xaxis" : "yaxis";
  const wantType = x.axis === "time" ? "date" : "category";
  for (const [key, axis] of Object.entries(layout)) {
    if (!axis || typeof axis !== "object" || !new RegExp(`^${catKey}\\d*$`).test(key)) continue;
    if (axis.type !== wantType && axis.type !== "category") {
      problems.push(`the ${x.name} axis is not a category axis (type ${JSON.stringify(axis.type ?? null)}), so its ticks may fall between values`);
    }
  }
  const catTitle = titleText(layout[catKey]?.title);
  const valTitle = titleText(layout[valKey]?.title);
  if (!axisLabelOk(catTitle, [x.name], yAxisNames(model))) problems.push(`the axis titled ${JSON.stringify(catTitle)} does not name the column on it (${x.name})`);
  if (!valueAxisLabelOk(valTitle, model)) problems.push(`the axis titled ${JSON.stringify(valTitle)} does not name the values on it`);
  return problems;
}

// ---- the Plotly figure of a model -----------------------------------------

const ACRONYMS = [
  "ADR", "ID", "USD", "EUR", "GBP", "YoY", "MoM", "QoQ", "WoW", "YTD", "MTD", "KPI", "URL", "SKU", "CAC", "LTV", "ARPU", "MRR", "ARR", "ROI", "ROAS", "AOV", "GMV",
  "CTR", "CPC", "CPA", "CPM", "API", "SQL", "UTC", "VAT", "NPS", "CSAT", "DAU", "WAU", "MAU", "B2B", "B2C", "IP", "SLA", "UUID", "RevPAR", "OTA", "COGS", "EBITDA", "PII",
];
const ACRONYM_BY_LOWER = new Map(ACRONYMS.map((a) => [a.toLowerCase(), a]));

/** "total_revenue" -> "Total revenue" (the same rules as dashboard/format
 *  humanize and backend chart_model.humanize; kept here so this file has
 *  no import of its own and the two sides stay a plain port of each other). */
export function humanizeName(name: unknown): string {
  const s = String(name ?? "").trim();
  if (!s) return "";
  const acronym = ACRONYM_BY_LOWER.get(s.toLowerCase());
  if (acronym) return acronym;
  const shouting = s === s.toUpperCase() && /[A-Za-z]/.test(s);
  if (!s.includes("_") && /[A-Z]/.test(s) && !shouting) return s;
  return s.replace(/[_\s]+/g, " ").trim().split(" ").map((w, i) => {
    const known = ACRONYM_BY_LOWER.get(w.toLowerCase());
    if (known) return known;
    const low = w.toLowerCase();
    return i === 0 ? low.charAt(0).toUpperCase() + low.slice(1) : low;
  }).join(" ");
}

export const MODEL_PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const MAX_PIE_SLICES = 6;

function foldSmallSlices(labels: string[], values: number[]): { labels: string[]; values: number[] } {
  if (labels.length <= MAX_PIE_SLICES) return { labels, values };
  const pairs = labels.map((l, i) => ({ l, v: values[i] })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const kept = pairs.slice(0, MAX_PIE_SLICES - 1);
  const folded = pairs.slice(MAX_PIE_SLICES - 1);
  kept.push({ l: `Other (${folded.length})`, v: folded.reduce((s, p) => s + p.v, 0) });
  return { labels: kept.map((p) => p.l), values: kept.map((p) => p.v) };
}

/** The axis titles a figure may carry: the supplied wording when it names
 *  the column(s) on that axis, else the column's own name (or nothing). */
export function modelAxisTitles(model: ResultChartModel, xLabel?: string | null, yLabel?: string | null): { x: string; y: string } {
  if (!model.x) return { x: "", y: "" };
  const xname = model.x.name;
  let xl = (xLabel || "").trim();
  if (xl && !axisLabelOk(xl, [xname], yAxisNames(model))) xl = isPlaceholderName(xname) ? "" : humanizeName(xname);
  let yl = (yLabel || "").trim();
  if (yl && !valueAxisLabelOk(yl, model)) {
    const single = model.measure || (model.series.length === 1 && !model.series_by ? model.series[0].name : null);
    yl = single && !isPlaceholderName(single) ? humanizeName(single) : "";
  }
  return { x: xl, y: yl };
}

/** The plain Plotly figure of a chart model - x is the dimension on a
 *  CATEGORY axis (a real date axis for a line over dates), one trace per
 *  series, straight segments. The unstyled counterpart of the backend's
 *  figure_from_model: it goes through lib/chartStyle or dashboard/plotlyKit
 *  before it is drawn, exactly like a backend figure. */
export function figureFromModel(model: ResultChartModel, opts: { title?: string | null; xLabel?: string | null; yLabel?: string | null } = {}): any | null {
  const baseLayout = () => ({ title: { text: opts.title || "" }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", margin: { l: 56, r: 28, t: 68, b: 64 } });
  if (model.kind === "kpi") {
    const shown = model.series.filter((s) => s.values.length && s.values[0] !== null);
    if (!shown.length) return null;
    return {
      data: shown.map((s, i) => ({ type: "indicator", mode: "number", value: s.values[0], title: { text: isPlaceholderName(s.name) ? "" : humanizeName(s.name) }, domain: { x: [i / shown.length, (i + 1) / shown.length], y: [0, 1] } })),
      layout: baseLayout(),
    };
  }
  if (!model.x) return null;
  const labels = model.x.labels;
  if (model.kind === "pie") {
    const pairs = labels.map((l, i) => ({ l, v: model.series[0].values[i] })).filter((p) => p.v !== null) as { l: string; v: number }[];
    const folded = foldSmallSlices(pairs.map((p) => p.l), pairs.map((p) => p.v));
    return { data: [{ type: "pie", labels: folded.labels, values: folded.values, hole: model.chart_type === "donut" ? 0.65 : 0.45, marker: { colors: MODEL_PALETTE } }], layout: baseLayout() };
  }
  if (model.kind !== "cartesian") return null;
  const ct = model.chart_type;
  const n = model.series.length;
  const bar = BAR_TYPES.has(ct);
  const data = model.series.map((s, i) => {
    const name = String(s.name);
    const color = n > 1 ? MODEL_PALETTE[i % MODEL_PALETTE.length] : bar ? MODEL_PALETTE[0] : ct === "line" || ct === "step_line" ? MODEL_PALETTE[3] : MODEL_PALETTE[1];
    if (bar) {
      return model.horizontal
        ? { type: "bar", name, x: s.values, y: labels, orientation: "h", marker: { color } }
        : { type: "bar", name, x: labels, y: s.values, marker: { color } };
    }
    const shape = ct === "step_line" ? "hv" : "linear";
    if (ct === "line" || ct === "step_line") return { type: "scatter", name, x: labels, y: s.values, mode: "lines+markers", line: { color, width: 3, shape }, connectgaps: false };
    if (ct === "stacked_area") return { type: "scatter", name, x: labels, y: s.values, mode: "lines", stackgroup: "one", line: { color, shape } };
    return { type: "scatter", name, x: labels, y: s.values, mode: "lines", fill: "tozeroy", line: { color, shape }, connectgaps: false };
  });
  const titles = modelAxisTitles(model, opts.xLabel, opts.yLabel);
  const axisType = model.x.axis === "time" && LINE_TYPES.has(ct) ? "date" : "category";
  const categoryAxis: Record<string, any> = { type: axisType, automargin: true, title: { text: titles.x, standoff: 10 } };
  if (axisType === "category") Object.assign(categoryAxis, { categoryorder: "array", categoryarray: [...labels] });
  const valueAxis = { automargin: true, title: { text: titles.y, standoff: 12 } };
  const layout: Record<string, any> = { ...baseLayout(), showlegend: n > 1 };
  if (ct === "stacked_bar") layout.barmode = "stack";
  else if (bar && n > 1) layout.barmode = "group";
  if (model.horizontal) {
    layout.yaxis = { ...categoryAxis, autorange: "reversed" };
    layout.xaxis = valueAxis;
  } else {
    layout.xaxis = categoryAxis;
    layout.yaxis = valueAxis;
  }
  return { data, layout };
}

function figureTitle(figure: any, key?: string): string {
  const layout = figure?.layout && typeof figure.layout === "object" ? figure.layout : {};
  return titleText(key ? layout[key]?.title : layout.title);
}

export type CheckedFigure = {
  // The figure to use: the stored one when it draws exactly the model (or
  // when there is nothing to check it against), the one rebuilt from the
  // rows when it does not, null when the rows cannot be drawn as that chart.
  figure: any | null;
  model: ResultChartModel | null;
  problems: string[];
  rebuilt: boolean;
  tableReason: string | null;
};

/** THE AUDIT on the load path: a stored figure checked against the rows
 *  stored beside it. Mirrors backend chart_builder.checked_chart_spec. */
export function checkedFigure(figure: any, columns: ModelColumn[] | null | undefined, rows: ModelRow[] | null | undefined, chartType: string | null | undefined, opts: { context?: string; truncated?: boolean; quiet?: boolean } = {}): CheckedFigure {
  if (!columns?.length || !Array.isArray(rows) || !rows.length) return { figure: figure ?? null, model: null, problems: [], rebuilt: false, tableReason: null };
  const model = deriveChartModel(columns, rows, chartType);
  if (model.kind === "passthrough") return { figure: figure ?? null, model, problems: [], rebuilt: false, tableReason: null };
  const tag = `[chart_audit] ${opts.context || "figure"} chart_type=${model.chart_type}`;
  const log = (text: string) => { if (!opts.quiet && typeof console !== "undefined") console.warn(`${tag} ${text}`); };
  if (opts.truncated) {
    return { figure: null, model, problems: ["the stored rows are truncated"], rebuilt: false, tableReason: `This result has more than ${count(rows.length)} rows; a chart of only the first ${count(rows.length)} would be misleading, so it is shown as a table.` };
  }
  if (model.kind === "table") return { figure: null, model, problems: model.reason ? [model.reason] : [], rebuilt: false, tableReason: model.reason };
  const problems = figure ? auditFigure(figure, model) : ["no figure was stored"];
  if (!problems.length) return { figure, model, problems: [], rebuilt: false, tableReason: null };
  if (figure) log(`MISMATCH (${problems.length}): ${problems.slice(0, 6).join(" | ")} -> drawn from the result table`);
  const horizontal = model.horizontal;
  const rebuilt = figureFromModel(model, {
    title: figureTitle(figure),
    xLabel: figureTitle(figure, horizontal ? "yaxis" : "xaxis"),
    yLabel: figureTitle(figure, horizontal ? "xaxis" : "yaxis"),
  });
  if (!rebuilt || auditFigure(rebuilt, model).length) {
    return { figure: null, model, problems, rebuilt: false, tableReason: "This result could not be drawn as a chart without misrepresenting it, so it is shown as a table." };
  }
  return { figure: rebuilt, model, problems, rebuilt: true, tableReason: null };
}
