// 2026-10-08 (round 13): ML Studio - a model from a goal in words. Client
// for backend routers/ml_studio.py (scoring/versions/delete stay on /ml-models).
// 2026-10-09 (round 15): all 21 kinds, learning inside a Space or from several
// tables joined (join/suggest, join/preview), the per-kind input fields the
// Adjust panel renders, and the generic results (headline, kpis, sections).
import { api } from "./client";

export type Family = "Predict" | "Forecast" | "Discover" | "Decide" | "Language";

export type FieldType = "column" | "columns" | "value" | "number" | "text" | "list" | "scenario";

export type TypeField = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  hint?: string;
  /** for type "value": the spec key of the column whose values are picked */
  of?: string;
};

export type ProblemType = {
  id: string;
  family: Family;
  title: string;
  sub: string;
  ready: boolean;
  needs?: string;
  fields?: TypeField[];
};

export type StudioTable = { source_id: string; source: string; kind: string; mode: string; table: string; columns: { name: string; type?: string }[] };

export type JoinRef = { source_id: string; table: string; key: string; base_key: string };

export type Spec = {
  problem_type: string;
  source_id: string;
  table: string;
  joins?: JoinRef[] | null;
  space_id?: string | null;
  /** round 15: a table outside the Space that fits the goal better */
  scope_hint?: { source_id: string; table: string; source: string; text: string } | null;
  target?: string | null;
  positive_value?: string | null;
  time_column?: string | null;
  value_column?: string | null;
  group_column?: string | null;
  horizon?: number | null;
  grain?: string | null;
  exclude?: string[] | null;
  share?: number | null;
  goal?: string;
  summary?: string | null;
  // round 15 kinds - every key the backend's SPEC_KEYS accepts
  start_column?: string | null;
  end_column?: string | null;
  duration_column?: string | null;
  event_column?: string | null;
  drivers?: string[] | null;
  scenario?: Record<string, number> | null;
  spend_columns?: string[] | null;
  order_column?: string | null;
  item_column?: string | null;
  entity_column?: string | null;
  treatment_column?: string | null;
  treated_value?: string | null;
  price_column?: string | null;
  units_column?: string | null;
  channel_column?: string | null;
  conversion_column?: string | null;
  conversion_value?: string | null;
  text_column?: string | null;
  label_column?: string | null;
  tags?: string[] | null;
  fields?: string[] | null;
  k?: number | null;
  [key: string]: unknown;
};

export type PlanRow = { k: string; v: string; m?: string };

export type PlanJoin = {
  source: string;
  table: string;
  key: string;
  base_key: string;
  matched: number;
  base_rows: number;
  match_rate: number;
  many_per_key: boolean;
  aggregated: string[];
  how: string;
};

export type Plan = {
  problem_type: string;
  title: string;
  source: string;
  table: string;
  rows: number;
  capped: boolean;
  columns: string[];
  warnings: string[];
  rows_text: PlanRow[];
  spec: Spec;
  features?: string[];
  excluded?: { column: string; reason: string }[];
  leak_suspects?: { column: string; reason: string }[];
  grain?: string;
  horizon?: number;
  joins?: PlanJoin[];
  target?: string;
  label?: { classes?: string[]; positive?: string; [k: string]: unknown };
};

export type JoinCandidate = {
  source_id: string;
  source: string;
  table: string;
  key: string;
  base_key: string;
  overlap: number;
  many_per_key: boolean;
  why: string;
};

export type JoinInfo = {
  source_id: string;
  source: string;
  table: string;
  key: string;
  base_key: string;
  alias: string;
  matched: number;
  base_rows: number;
  match_rate: number;
  many_per_key: boolean;
  aggregated: string[];
  added: string[];
  how: string;
  join_rows: number;
  capped: boolean;
};

export type JoinPreview = {
  rows: number;
  columns: { name: string; from: string }[];
  preview: Record<string, unknown>[];
  joins: JoinInfo[];
  warnings: string[];
  text: string;
};

export type Stage = { id: string; title: string; status: "pending" | "running" | "done"; note: string };

export type BoardRow = {
  algorithm: string;
  key: string;
  score: number | null;
  second?: number | null;
  test_score?: number | null;
  test_second?: number | null;
  trials: number | null;
  state: string;
  best?: boolean;
  baseline?: boolean;
  method?: string;
};

export type Progress = {
  stages: Stage[];
  leaderboard: BoardRow[];
  curve: { trial: number; best: number | null; score: number | null; algorithm: string }[];
  trials_done: number;
  trials_total: number | null;
  leaks: { column: string; reason: string }[];
  resources: { rows_used?: number; rows_total?: number; capped?: boolean; memory_mb?: number; workers?: number; memory_limited?: boolean; model_mb?: number };
  memory_note?: string;
  message?: string;
  elapsed?: number;
  current?: string | null;
  split?: string;
  joins?: (Partial<JoinInfo> & { table: string; match_rate: number })[];
};

// ---- generic results (round 15) ----

export type ValueFormat = "number" | "integer" | "percent" | "currency" | "text" | "date";

export type Kpi = { label: string; value: unknown; display: string; note?: string | null };

export type TableSection = {
  type: "table";
  title: string;
  note?: string;
  columns: { name: string; label: string; format: ValueFormat }[];
  rows: Record<string, unknown>[];
};
export type BarsSection = {
  type: "bars";
  title: string;
  note?: string;
  format: ValueFormat;
  items: { label: string; value: number | null; display: string; note?: string; tone?: "up" | "down" | "neutral" }[];
};
export type LineSection = {
  type: "line";
  title: string;
  note?: string;
  format: ValueFormat;
  x: string[];
  series: { name: string; values: (number | null)[]; dashed?: boolean }[];
  band?: { lo: (number | null)[]; hi: (number | null)[] } | null;
};
export type MatrixSection = {
  type: "matrix";
  title: string;
  note?: string;
  row_labels: string[];
  col_labels: string[];
  values: (number | null)[][];
  format: ValueFormat;
};
export type TextSection = { type: "text"; title: string; body: string };
export type Section = TableSection | BarsSection | LineSection | MatrixSection | TextSection;

export type StudioProject = {
  id: string;
  name: string;
  goal: string | null;
  problem_type: string | null;
  status: "training" | "ready" | "failed";
  error: string | null;
  source: string | null;
  source_id: string;
  table: string | null;
  target: string;
  task_type: string | null;
  metrics: Record<string, any> | null;
  rows: number | null;
  created_at: string;
  started_at: string | null;
  trained_at: string | null;
  elapsed: number | null;
  can_edit: boolean;
  can_delete: boolean;
  version: number;
  predictions: number;
  plan?: { spec: Spec } | null;
  progress?: Progress | null;
  results?: any;
  features?: string[] | null;
  excluded?: { column: string; reason: string }[] | null;
};

export type Limits = { max_rows: number; trials: number; tune_seconds: number; workers: number };

export const mlStudioApi = {
  types: (spaceId?: string | null) =>
    api
      .get<{ types: ProblemType[]; tables: StudioTable[]; limits: Limits }>("/ml-studio/types", { params: spaceId ? { space_id: spaceId } : {} })
      .then((r) => r.data),
  understand: (
    goal: string,
    problem_type?: string | null,
    source_id?: string | null,
    table?: string | null,
    space_id?: string | null,
    joins?: JoinRef[] | null,
  ) =>
    api
      .post<Spec>(
        "/ml-studio/understand",
        {
          goal,
          problem_type: problem_type || null,
          source_id: source_id || null,
          table: table || null,
          space_id: space_id || null,
          joins: joins && joins.length ? joins : null,
        },
        { timeout: 90000 },
      )
      .then((r) => r.data),
  plan: (spec: Spec) => api.post<Plan>("/ml-studio/plan", { spec }, { timeout: 120000 }).then((r) => r.data),
  joinSuggest: (source_id: string, table: string | null, space_id?: string | null) =>
    api
      .post<{ candidates: JoinCandidate[] }>("/ml-studio/join/suggest", { source_id, table, space_id: space_id || null }, { timeout: 120000 })
      .then((r) => r.data.candidates),
  joinPreview: (spec: Partial<Spec> & { source_id: string; table: string }) =>
    api.post<JoinPreview>("/ml-studio/join/preview", { spec }, { timeout: 120000 }).then((r) => r.data),
  start: (spec: Spec, name: string, goal: string) => api.post<{ id: string }>("/ml-studio/projects", { spec, name, goal }, { timeout: 120000 }).then((r) => r.data),
  list: () => api.get<{ projects: StudioProject[] }>("/ml-studio/projects").then((r) => r.data.projects),
  get: (id: string) => api.get<StudioProject>(`/ml-studio/projects/${id}`).then((r) => r.data),
  stop: (id: string) => api.post(`/ml-studio/projects/${id}/stop`).then((r) => r.data),
  retrain: (id: string) => api.post(`/ml-studio/projects/${id}/retrain`).then((r) => r.data),
  score: (id: string) => api.post<{ new_version_id: string; new_version_name: string; row_count: number }>(`/ml-models/${id}/score`, {}).then((r) => r.data),
  remove: (id: string) => api.delete(`/ml-models/${id}`),
};

export const FAMILIES: Family[] = ["Predict", "Forecast", "Discover", "Decide", "Language"];

export const FAMILY_COLOR: Record<string, string> = {
  Predict: "rgb(var(--auto-do))",
  Forecast: "rgb(var(--auto-tell))",
  Discover: "rgb(var(--auto-when))",
  Decide: "rgb(var(--color-warning))",
  Language: "rgb(var(--color-danger))",
};

/** Which family each kind belongs to (the gallery carries it too; this
 *  covers the model list, which doesn't load the gallery). */
export const FAMILY_OF: Record<string, Family> = {
  yes_no: "Predict",
  which_category: "Predict",
  number: "Predict",
  time_to_event: "Predict",
  forecast_one: "Forecast",
  forecast_many: "Forecast",
  what_if: "Forecast",
  marketing_mix: "Forecast",
  segments: "Discover",
  anomalies: "Discover",
  drivers: "Discover",
  bought_together: "Discover",
  cohorts: "Discover",
  recommendations: "Decide",
  uplift: "Decide",
  price: "Decide",
  attribution: "Decide",
  text_tag: "Language",
  sentiment: "Language",
  themes: "Language",
  doc_facts: "Language",
};

export const TYPE_LABEL: Record<string, string> = {
  yes_no: "Yes / no",
  which_category: "Which category",
  number: "Number",
  time_to_event: "When it will happen",
  forecast_one: "Forecast",
  forecast_many: "Forecast · many",
  what_if: "What-if",
  marketing_mix: "Marketing mix",
  segments: "Segments",
  anomalies: "Anomalies",
  drivers: "Drivers",
  bought_together: "Bought together",
  cohorts: "Cohort retention",
  recommendations: "Recommendations",
  uplift: "Who responds",
  price: "Price sensitivity",
  attribution: "Attribution",
  text_tag: "Sort and tag text",
  sentiment: "Sentiment",
  themes: "Themes",
  doc_facts: "Facts from documents",
};

/** Kinds whose result is a report, not a model that scores rows. */
export const NOT_SCORABLE = new Set(["what_if", "marketing_mix", "attribution", "forecast_one", "forecast_many"]);

/** Kinds whose results keep their round-13 renderers. */
export const LEGACY_RESULTS = new Set(["yes_no", "number", "drivers", "segments", "anomalies", "forecast_one", "forecast_many"]);

function pct(v: unknown, digits = 0): string {
  return `${(Number(v) * 100).toFixed(digits)}%`;
}

export function metricLine(p: StudioProject): string {
  const m = p.metrics || {};
  if (p.status === "training") return "Training…";
  if (p.status === "failed") return p.error || "Couldn't train";
  // round 15: the presented first KPI, when the project carries results
  const k0 = p.results?.kpis?.[0];
  if (k0 && k0.display) return `${k0.label} ${k0.display}`;
  switch (p.problem_type) {
    case "what_if":
      return m.r2 != null ? `R² ${Number(m.r2).toFixed(2)}${m.scenario_change_pct != null ? ` · scenario ${Number(m.scenario_change_pct) >= 0 ? "+" : ""}${Number(m.scenario_change_pct).toFixed(1)}%` : ""}` : "Ready";
    case "marketing_mix":
      return m.r2 != null ? `R² ${Number(m.r2).toFixed(2)} · ${m.weeks ?? "?"} weeks` : "Ready";
    case "bought_together":
      return m.pairs != null ? `${Number(m.pairs).toLocaleString()} pairs in ${Number(m.orders || 0).toLocaleString()} orders` : "Ready";
    case "cohorts":
      return m.month1_retention != null ? `${pct(m.month1_retention)} buy again in month 2` : `${Number(m.customers || 0).toLocaleString()} customers`;
    case "recommendations":
      return m.hit_rate_at_5 != null ? `${pct(m.hit_rate_at_5)} found in top 5` : "Ready";
    case "uplift":
      return m.effect != null ? `Effect ${Number(m.effect) >= 0 ? "+" : ""}${Math.abs(Number(m.effect)) < 1 ? Number(m.effect).toFixed(3) : Number(m.effect).toFixed(1)}` : "Ready";
    case "price":
      return m.median_elasticity != null ? `Elasticity ${Number(m.median_elasticity).toFixed(2)} · ${m.products} products` : "Ready";
    case "attribution":
      return m.conversions != null ? `${Number(m.conversions).toLocaleString()} conversions credited` : "Ready";
    case "themes":
      return m.themes != null ? `${m.themes} themes` : "Ready";
    case "sentiment":
      return m.share_complaint != null ? `${pct(m.share_praise ?? 0)} praise · ${pct(m.share_complaint)} complaints` : "Ready";
    case "text_tag":
      return m.accuracy != null ? `${(Number(m.accuracy) * 100).toFixed(1)}% right` : m.tags != null ? `${m.tags} tags` : "Ready";
    case "doc_facts":
      return m.completeness != null ? `${pct(m.completeness)} of fields found` : "Ready";
    default:
      break;
  }
  if (m.roc_auc != null) return `ROC AUC ${Number(m.roc_auc).toFixed(3)}`;
  if (m.accuracy != null) return `${(Number(m.accuracy) * 100).toFixed(1)}% accurate`;
  if (m.r2 != null) return `R² ${Number(m.r2).toFixed(3)}`;
  if (m.silhouette != null) return `${m.groups} groups · silhouette ${Number(m.silhouette).toFixed(2)}`;
  if (m.flagged != null) return `${Number(m.flagged).toLocaleString()} unusual rows`;
  if (m.series != null) return `${m.series} series${m.median_mase != null ? ` · MASE ${Number(m.median_mase).toFixed(2)}` : ""}`;
  return "Ready";
}

export function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  if (typeof d === "string" && d.trim()) return d;
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg);
  if (e?.code === "ECONNABORTED") return "That took too long - the table may be very large. Try again, or pick a smaller table.";
  return fallback;
}
