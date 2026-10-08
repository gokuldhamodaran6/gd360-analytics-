// 2026-10-08 (round 13): ML Studio - a model from a goal in words. Client
// for backend routers/ml_studio.py (scoring/versions/delete stay on /ml-models).
import { api } from "./client";

export type ProblemType = {
  id: string;
  family: "Predict" | "Forecast" | "Discover" | "Decide" | "Language";
  title: string;
  sub: string;
  ready: boolean;
};

export type StudioTable = { source_id: string; source: string; kind: string; mode: string; table: string; columns: { name: string; type?: string }[] };

export type Spec = {
  problem_type: string;
  source_id: string;
  table: string;
  target?: string | null;
  positive_value?: string | null;
  time_column?: string | null;
  value_column?: string | null;
  group_column?: string | null;
  horizon?: number | null;
  grain?: string | null;
  exclude?: string[];
  share?: number | null;
  goal?: string;
  summary?: string | null;
};

export type PlanRow = { k: string; v: string; m?: string };

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
};

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

export const mlStudioApi = {
  types: () =>
    api.get<{ types: ProblemType[]; tables: StudioTable[]; limits: { max_rows: number; trials: number; tune_seconds: number; workers: number } }>("/ml-studio/types").then((r) => r.data),
  understand: (goal: string, problem_type?: string | null, source_id?: string | null) =>
    api.post<Spec>("/ml-studio/understand", { goal, problem_type: problem_type || null, source_id: source_id || null }).then((r) => r.data),
  plan: (spec: Spec) => api.post<Plan>("/ml-studio/plan", { spec }).then((r) => r.data),
  start: (spec: Spec, name: string, goal: string) => api.post<{ id: string }>("/ml-studio/projects", { spec, name, goal }).then((r) => r.data),
  list: () => api.get<{ projects: StudioProject[] }>("/ml-studio/projects").then((r) => r.data.projects),
  get: (id: string) => api.get<StudioProject>(`/ml-studio/projects/${id}`).then((r) => r.data),
  stop: (id: string) => api.post(`/ml-studio/projects/${id}/stop`).then((r) => r.data),
  retrain: (id: string) => api.post(`/ml-studio/projects/${id}/retrain`).then((r) => r.data),
  score: (id: string) => api.post<{ new_version_id: string; new_version_name: string; row_count: number }>(`/ml-models/${id}/score`, {}).then((r) => r.data),
  remove: (id: string) => api.delete(`/ml-models/${id}`),
};

export const FAMILY_COLOR: Record<string, string> = {
  Predict: "rgb(var(--auto-do))",
  Forecast: "rgb(var(--auto-tell))",
  Discover: "rgb(var(--auto-when))",
  Decide: "rgb(var(--color-warning))",
  Language: "rgb(var(--color-danger))",
};

export const TYPE_LABEL: Record<string, string> = {
  yes_no: "Yes / no",
  number: "Number",
  drivers: "Drivers",
  segments: "Segments",
  anomalies: "Anomalies",
  forecast_one: "Forecast",
  forecast_many: "Forecast · many",
};

export function metricLine(p: StudioProject): string {
  const m = p.metrics || {};
  if (p.status === "training") return "Training…";
  if (p.status === "failed") return p.error || "Couldn't train";
  if (m.roc_auc != null) return `ROC AUC ${Number(m.roc_auc).toFixed(3)}`;
  if (m.accuracy != null) return `${(Number(m.accuracy) * 100).toFixed(1)}% accurate`;
  if (m.r2 != null) return `R² ${Number(m.r2).toFixed(3)}`;
  if (m.silhouette != null) return `${m.groups} groups · silhouette ${Number(m.silhouette).toFixed(2)}`;
  if (m.flagged != null) return `${Number(m.flagged).toLocaleString()} unusual rows`;
  if (m.series != null) return `${m.series} series${m.median_mase != null ? ` · MASE ${Number(m.median_mase).toFixed(2)}` : ""}`;
  return "Ready";
}
