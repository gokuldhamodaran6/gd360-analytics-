import type {
  BlockSpec, ColumnFilterSpec, DashboardDateRange, DashboardParameter, DashboardPeriod, DashboardSavedView, FilterCriterion,
} from "../api/client";
import { formatValue, PLAIN_FORMAT } from "./format";

// 2026-10-07 (Option A dashboard view): the pure, framework-free half of
// the run engine (useDashboardRun.ts is the stateful half). Everything a
// rail control picks is kept as a per-parameter VALUE here and translated
// into the backend's FilterCriterion vocabulary (routers/datasources.py
// _apply_column_filter / query_builder.page_filters_to_block_filters -
// "values", "number", "date", ...) only at the boundary, so the same
// state drives the warehouse run endpoint, the file-source
// preview-filtered path, the "Show SQL" query string and the URL.

export const PERIODS: DashboardPeriod[] = ["day", "week", "month", "quarter", "year"];
export const PERIOD_LABEL: Record<DashboardPeriod, string> = { day: "Day", week: "Week", month: "Month", quarter: "Quarter", year: "Year" };

export function normalizePeriod(p: string | null | undefined, fallback: DashboardPeriod = "month"): DashboardPeriod {
  return (PERIODS as string[]).includes(p || "") ? (p as DashboardPeriod) : fallback;
}

// What one rail control holds:
//   chips / multi / search / checkboxes -> the picked values (string[])
//   segmented                            -> one value or null ("All")
//   range                                -> [low, high] or null
//   date_range                           -> {from, to}
export type ParamValue = string[] | string | [number, number] | DashboardDateRange | null;

export type CrossFilter = { column: string; value: string | number | boolean | null; blockId?: string };

export type RunState = {
  paramValues: Record<string, ParamValue>;
  crossFilters: Record<string, CrossFilter>; // keyed by column
  // File-source dashboards: the page's own "filter" blocks (keyed by block id).
  filterBlockValues: Record<string, ColumnFilterSpec | null>;
  blockFilters: Record<string, FilterCriterion[]>;
  period: DashboardPeriod;
  dateRange: DashboardDateRange;
  viewId: string | null;
};

export const EMPTY_RANGE: DashboardDateRange = { from: null, to: null };

export function emptyRunState(defaultPeriod: string | null | undefined): RunState {
  return {
    paramValues: {},
    crossFilters: {},
    filterBlockValues: {},
    blockFilters: {},
    period: normalizePeriod(defaultPeriod),
    dateRange: EMPTY_RANGE,
    viewId: null,
  };
}

const MULTI_CONTROLS = new Set(["chips", "multi", "search", "checkboxes"]);

export function isMultiControl(control: string): boolean {
  return MULTI_CONTROLS.has(control);
}

export function isParamValueSet(param: DashboardParameter, value: ParamValue | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (isMultiControl(param.control)) return Array.isArray(value) && value.length > 0;
  if (param.control === "segmented") return typeof value === "string" && value !== "";
  if (param.control === "range") return Array.isArray(value) && value.length === 2;
  if (param.control === "date_range") return typeof value === "object" && !Array.isArray(value) && Boolean(value.from || value.to);
  return false;
}

// Rail value -> FilterCriterion (null when the control is at rest).
export function paramToCriterion(param: DashboardParameter, value: ParamValue | undefined): FilterCriterion | null {
  if (!isParamValueSet(param, value)) return null;
  if (isMultiControl(param.control)) {
    return { column: param.column, spec: { type: "values", include: (value as string[]).map(decodeValueToken) } };
  }
  if (param.control === "segmented") {
    return { column: param.column, spec: { type: "values", include: [decodeValueToken(value as string)] } };
  }
  if (param.control === "range") {
    const [lo, hi] = value as [number, number];
    return { column: param.column, spec: { type: "number", op: "between", value: String(lo), value2: String(hi) } };
  }
  if (param.control === "date_range") {
    const r = value as DashboardDateRange;
    return { column: param.column, spec: { type: "date", from: r.from || null, to: r.to || null } };
  }
  return null;
}

// The reverse: a FilterCriterion on this parameter's column -> rail value
// (null when the spec is not one this control can hold).
export function criterionToParamValue(param: DashboardParameter, spec: ColumnFilterSpec): ParamValue | null {
  if (isMultiControl(param.control)) {
    if (spec.type !== "values") return null;
    return spec.include.map(encodeValueToken);
  }
  if (param.control === "segmented") {
    if (spec.type !== "values" || spec.include.length !== 1) return null;
    return encodeValueToken(spec.include[0]);
  }
  if (param.control === "range") {
    if (spec.type !== "number" || spec.op !== "between") return null;
    const lo = Number(spec.value), hi = Number(spec.value2);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    return [lo, hi];
  }
  if (param.control === "date_range") {
    if (spec.type !== "date") return null;
    return { from: spec.from, to: spec.to };
  }
  return null;
}

// Option values arrive from the warehouse as string | number | boolean |
// null; the rail controls (MultiSelect/CheckboxList/...) work on strings.
// A null is kept distinguishable ("(Blanks)") through a sentinel token.
export const NULL_TOKEN = "\u0000null";
export function encodeValueToken(v: string | number | boolean | null): string {
  return v === null || v === undefined ? NULL_TOKEN : String(v);
}
export function decodeValueToken(token: string): string | null {
  return token === NULL_TOKEN ? null : token;
}
export function valueLabel(v: string | number | boolean | null | undefined): string {
  return v === null || v === undefined || v === NULL_TOKEN ? "(Blanks)" : String(v);
}

// Everything the engine sends as `filters` for a run.
export function buildPageFilters(
  parameters: DashboardParameter[], state: Pick<RunState, "paramValues" | "crossFilters" | "filterBlockValues">,
  filterBlocks: { id: string; column: string | null }[] = []
): FilterCriterion[] {
  const out: FilterCriterion[] = [];
  const seen = new Set<string>();
  for (const p of parameters) {
    const c = paramToCriterion(p, state.paramValues[p.id]);
    if (c) {
      out.push(c);
      seen.add(p.column);
    }
  }
  for (const b of filterBlocks) {
    const spec = state.filterBlockValues[b.id];
    if (b.column && spec) {
      out.push({ column: b.column, spec });
      seen.add(b.column);
    }
  }
  for (const cf of Object.values(state.crossFilters)) {
    // A clicked bar narrows a column the rail already narrows: the click
    // wins for that column (it is the more specific intent).
    const idx = out.findIndex((f) => f.column === cf.column);
    const crit: FilterCriterion = { column: cf.column, spec: { type: "values", include: [cf.value] } };
    if (idx >= 0) out[idx] = crit;
    else out.push(crit);
  }
  return out;
}

// The {name: value} map SQL cells bind ({{name}} / @name).
export function buildParameterValues(parameters: DashboardParameter[], paramValues: Record<string, ParamValue>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const p of parameters) {
    const v = paramValues[p.id];
    if (!isParamValueSet(p, v)) continue;
    const key = p.name || p.id;
    if (isMultiControl(p.control)) out[key] = (v as string[]).map(decodeValueToken);
    else if (p.control === "segmented") out[key] = decodeValueToken(v as string);
    else out[key] = v;
  }
  return out;
}

// Filters -> rail state. Any criterion no parameter can hold becomes a
// cross-filter (when it is a single-value "values" spec) or is dropped.
export function filtersToState(
  parameters: DashboardParameter[], filters: FilterCriterion[]
): { paramValues: Record<string, ParamValue>; crossFilters: Record<string, CrossFilter> } {
  const paramValues: Record<string, ParamValue> = {};
  const crossFilters: Record<string, CrossFilter> = {};
  for (const f of filters || []) {
    if (!f || !f.column || !f.spec) continue;
    const param = parameters.find((p) => p.column === f.column && criterionToParamValue(p, f.spec) !== null);
    if (param) {
      paramValues[param.id] = criterionToParamValue(param, f.spec);
      continue;
    }
    if (f.spec.type === "values" && f.spec.include.length === 1) {
      crossFilters[f.column] = { column: f.column, value: f.spec.include[0] };
    }
  }
  return { paramValues, crossFilters };
}

// ---- URL (de)serialisation: ?f=<json filters>&period=&from=&to=&view=&bf=<json> ----

export const URL_KEYS = ["f", "period", "from", "to", "view", "bf"] as const;

export function serializeRunState(
  parameters: DashboardParameter[], state: RunState, existing?: string
): string {
  const params = new URLSearchParams(existing || "");
  for (const k of URL_KEYS) params.delete(k);
  const filters = buildPageFilters(parameters, state);
  if (filters.length) params.set("f", JSON.stringify(filters));
  if (state.period) params.set("period", state.period);
  if (state.dateRange.from) params.set("from", state.dateRange.from);
  if (state.dateRange.to) params.set("to", state.dateRange.to);
  if (state.viewId) params.set("view", state.viewId);
  const bf = Object.fromEntries(Object.entries(state.blockFilters).filter(([, v]) => v.length > 0));
  if (Object.keys(bf).length) params.set("bf", JSON.stringify(bf));
  return params.toString();
}

export function parseRunState(
  search: string, parameters: DashboardParameter[], defaultPeriod: string | null | undefined
): Partial<RunState> {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: Partial<RunState> = {};
  const f = params.get("f");
  if (f) {
    try {
      const parsed = JSON.parse(f);
      if (Array.isArray(parsed)) {
        const { paramValues, crossFilters } = filtersToState(parameters, parsed as FilterCriterion[]);
        out.paramValues = paramValues;
        out.crossFilters = crossFilters;
      }
    } catch {
      // A hand-edited URL: ignore the filters, keep the rest.
    }
  }
  const period = params.get("period");
  if (period && (PERIODS as string[]).includes(period)) out.period = period as DashboardPeriod;
  else if (period === null && defaultPeriod) out.period = normalizePeriod(defaultPeriod);
  const from = params.get("from"), to = params.get("to");
  if (from || to) out.dateRange = { from: from || null, to: to || null };
  const view = params.get("view");
  if (view) out.viewId = view;
  const bf = params.get("bf");
  if (bf) {
    try {
      const parsed = JSON.parse(bf);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.blockFilters = parsed;
    } catch {
      // ignore
    }
  }
  return out;
}

export function stateFromSavedView(parameters: DashboardParameter[], view: DashboardSavedView, base: RunState): RunState {
  const { paramValues, crossFilters } = filtersToState(parameters, view.filters || []);
  return {
    ...base,
    paramValues,
    crossFilters,
    period: view.period ? normalizePeriod(view.period, base.period) : base.period,
    dateRange: view.date_range ? { from: view.date_range.from || null, to: view.date_range.to || null } : EMPTY_RANGE,
    viewId: view.id,
  };
}

export function sameFilters(a: FilterCriterion[], b: FilterCriterion[]): boolean {
  if (a.length !== b.length) return false;
  const key = (f: FilterCriterion) => `${f.column}:${JSON.stringify(f.spec)}`;
  const sa = a.map(key).sort(), sb = b.map(key).sort();
  return sa.every((k, i) => k === sb[i]);
}

export function countActiveFilters(parameters: DashboardParameter[], state: RunState): number {
  return buildPageFilters(parameters, state).length;
}

// ---- Block subtitles (query_builder.describe_block_spec, ported) ----

export function describeSpec(spec: BlockSpec | null | undefined): string {
  if (!spec) return "";
  const parts: string[] = [];
  for (const m of spec.measures || []) {
    const agg = String(m.agg || "").replace(/_/g, " ");
    if (m.expr) parts.push(`${agg} of ${m.expr}`);
    else if (m.column) parts.push(`${agg} of ${m.column}`);
    else parts.push("count of rows");
  }
  let text = `${parts.join(", ")} from ${spec.table}`;
  const dims = [...(spec.group_by || [])];
  if (spec.time) dims.unshift(`${spec.time.column} by ${spec.time.grain}`);
  if (dims.length) text += ` by ${dims.join(", ")}`;
  if (spec.filters && spec.filters.length) {
    text += " where " + spec.filters.map((f) => `${f.column} ${String(f.op).replace(/_/g, " ")}${f.value === null || f.value === undefined ? "" : ` ${Array.isArray(f.value) ? f.value.join(", ") : f.value}`}`).join(" and ");
  }
  return text;
}

// Both of these are format.ts's formatValue (the one formatter every
// dashboard number goes through) with no block format: a KPI-sized number
// ("auto": 119,386 / 42.7M) and a table cell (every digit).
export function formatNumber(v: unknown): string {
  return formatValue(v, PLAIN_FORMAT, "auto");
}

export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return formatValue(v, PLAIN_FORMAT, "full");
}

export function relativeTime(iso: string | null | undefined, nowMs = Date.now()): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
