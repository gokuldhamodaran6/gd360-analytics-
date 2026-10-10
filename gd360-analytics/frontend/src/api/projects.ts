// 2026-10-08 (round 11): multi-source Projects and synced apps - the client
// for backend routers/projects.py and routers/apps.py.
import { api } from "./client";

export type SourceMode = "live" | "synced" | "file";

export type ProjectSource = {
  id: string;
  name: string;
  kind: string;
  label: string;
  mode: SourceMode;
  freshness: string;
  tables: number;
  workspace_id?: string | null;
  sync_error?: string | null;
};

export type ResultColumn = { name: string; dtype: string; role: string; label?: string; format?: "currency" | "percent" | "ratio" | "integer" | "number"; currency?: string };

export type RunStep = {
  id: string;
  kind: "step" | "combine";
  title: string;
  purpose?: string | null;
  source_id: string | null;
  source_name: string | null;
  source_kind: string | null;
  mode: SourceMode | "combine" | null;
  dialect: string | null;
  sql: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  rows_returned: number | null;
  rows_read?: number | null;
  bytes_scanned?: number | null;
  duration_ms: number | null;
  error: string | null;
  repaired: boolean;
  truncated: boolean;
  columns: ResultColumn[] | null;
  preview: Record<string, unknown>[] | null;
  note?: string | null;
  freshness?: string | null;
};

export type Fact = { id: string; label: string; value: number | null; kind: string; display: string };

type VisualBase = { sources?: string[] };
export type Visual = VisualBase &
  (
    | { type: "waterfall"; title: string; items: { label: string; value: number; kind: "total" | "up" | "down" }[]; format: string; currency?: string | null }
    | { type: "diverging"; title: string; items: { label: string; value: number; share: number | null }[]; format: string; currency?: string | null }
    | { type: "chart"; title: string; chart_type?: string | null; columns: ResultColumn[]; rows: Record<string, unknown>[]; truncated?: boolean;
        // round 14: "table" = a formatted detail table; a note under the chart
        display?: "table" | null; note?: string | null; time_column?: string | null }
    | { type: "kpis"; items: { label: string; display: string; fact_id: string }[] }
  );

export type Cause = {
  title: string;
  detail: string;
  fact_ids: string[];
  confidence: "high" | "medium" | "low";
  direction: "up" | "down" | null;
  // read off the computed facts by the backend (executor.enrich_causes)
  amount?: string | null;
  amount_value?: number | null;
  share?: string | null;
  sources?: string[];
};

export type Answer = {
  headline: string;
  answer: string;
  causes: Cause[];
  ruled_out: { title: string; detail: string }[];
  next_questions: string[];
  written_by?: "model" | "template";
};

export type EvidenceTable = {
  id: string;
  title: string;
  source: string;
  columns: ResultColumn[];
  rows: Record<string, unknown>[];
  truncated?: boolean;
};

export type RunResult = {
  answer: Answer;
  analysis_type?: string;
  facts?: Fact[];
  summary?: Record<string, any>;
  visuals?: Visual[];
  warnings?: string[];
  evidence?: EvidenceTable[];
  sources_used?: string[];
  queries?: number;
};

export type PlanStep = {
  id: string;
  title: string;
  purpose: string;
  source_id: string;
  source_name: string;
  source_kind: string;
  mode: SourceMode;
  dialect: string;
  sql: string;
};

export type Plan = {
  title: string;
  can_answer: boolean;
  missing?: string;
  understanding: { metric?: string; window?: string; method?: string; scope?: string };
  assumptions: string[];
  steps: PlanStep[];
  combine: { id: string; title: string; purpose: string; sql: string }[];
  analysis: Record<string, any>;
  issues?: string[];
  catalog?: { id: string; name: string; kind: string; label: string; mode: SourceMode; freshness: string; restricted: boolean; tables: number }[];
};

export type RunStatus = "planning" | "planned" | "running" | "done" | "failed" | "stopped" | "needs_input" | "replaced";

export type ProjectRun = {
  id: string;
  project_id: string;
  question: string;
  status: RunStatus;
  error: string | null;
  note: string | null;
  auto_run: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  headline: string | null;
  duration_seconds: number | null;
  plan?: Plan | null;
  steps?: RunStep[];
  result?: RunResult | null;
};

export type Project = {
  id: string;
  title: string;
  source_ids: string[];
  sources: ProjectSource[];
  workspace_id: string | null;
  created_at: string;
  pinned: boolean;
  can_edit: boolean;
  runs: ProjectRun[];
  dashboards: { id: string; name: string; layout_version?: number }[];
  // 2026-10-09 (round 15): the Space a project was asked in, if any.
  space_id?: string | null;
  space_name?: string | null;
  space_color?: string | null;
};

export type DashTile = {
  id: string;
  kind: "kpi" | "visual" | "context";
  ref: string | number;
  title: string;
  hidden: boolean;
  span: 1 | 2;
  chart_type?: string | null;
};

export type DashKpi = { key: string; label: string; display: string; delta?: string | null; delta_dir?: string | null; note?: string; sources?: string[] };

export type ProjectDashboard = {
  id: string;
  name: string;
  project_id: string | null;
  run_id?: string | null;
  question: string | null;
  headline: string | null;
  tiles: DashTile[];
  snapshot: {
    kpis?: DashKpi[];
    visuals?: Visual[];
    context?: (EvidenceTable & { source?: string })[];
    warnings?: string[];
    steps?: { id: string; kind: string; title: string; source_name: string; mode: string; status: string; error: string | null; freshness?: string }[];
  };
  snapshot_at: string | null;
  sources: ProjectSource[];
  can_edit: boolean;
  workspace_id: string | null;
  assumptions: string[];
};

export const projectsApi = {
  sources: (workspaceId?: string) =>
    api.get<ProjectSource[]>("/projects/sources", { params: { workspace_id: workspaceId || undefined } }).then((r) => r.data),
  // 2026-10-09 (round 15): space_id asks one Space (its sources you can use);
  // send space_id or source_ids, never both.
  create: (payload: { question: string; source_ids?: string[]; space_id?: string; workspace_id?: string; auto_run?: boolean }) =>
    api.post<{ project_id: string; run_id: string; space_id?: string | null }>("/projects", payload).then((r) => r.data),
  get: (id: string) => api.get<Project>(`/projects/${id}`).then((r) => r.data),
  update: (id: string, payload: { title?: string; source_ids?: string[] }) =>
    api.patch<{ id: string; title: string; source_ids: string[] }>(`/projects/${id}`, payload).then((r) => r.data),
  ask: (id: string, question: string, autoRun = true) =>
    api.post<{ project_id: string; run_id: string }>(`/projects/${id}/ask`, { question, auto_run: autoRun }).then((r) => r.data),
  run: (runId: string) => api.get<ProjectRun>(`/projects/runs/${runId}`).then((r) => r.data),
  execute: (runId: string) => api.post(`/projects/runs/${runId}/execute`).then((r) => r.data),
  replan: (runId: string, note: string) =>
    api.post<{ run_id: string }>(`/projects/runs/${runId}/replan`, { note }).then((r) => r.data),
  stop: (runId: string) => api.post(`/projects/runs/${runId}/stop`).then((r) => r.data),
  // 2026-10-10 (one kind of dashboard): builds the full dashboard (filters,
  // cross-filter, canvas, publish) from an answer - new, added to an
  // existing one, or upgrading this answer's classic dashboard in place.
  makeDashboard: (
    id: string,
    payload: { run_id?: string; name?: string; datasource_id?: string; add_to_dashboard_id?: string; replace_dashboard_id?: string },
  ) =>
    api
      .post<{ dashboard_id: string; name: string; layout_version: number; page_id: string | null; datasource_id: string; datasource_name: string }>(
        `/projects/${id}/dashboard`, payload, { timeout: 240000 },
      )
      .then((r) => r.data),
  dashboard: (id: string) => api.get<ProjectDashboard>(`/projects/dashboards/${id}`).then((r) => r.data),
  refreshDashboard: (id: string) =>
    api.post<ProjectDashboard>(`/projects/dashboards/${id}/refresh`, undefined, { timeout: 180000 }).then((r) => r.data),
  updateDashboard: (id: string, payload: { name?: string; tiles?: DashTile[] }) =>
    api.patch<ProjectDashboard>(`/projects/dashboards/${id}`, payload).then((r) => r.data),
};

export type AppField = { key: string; label: string; placeholder: string; secret: boolean; multiline?: boolean; optional?: boolean };
export type AppInfo = {
  kind: string;
  label: string;
  summary: string;
  fields: AppField[];
  steps: string[];
  default_interval: string;
  intervals: string[];
};
export type AppStatus = {
  id: string;
  name: string;
  kind: string;
  label: string;
  sync_interval: string;
  history_days?: number | null;
  account?: string | null;
  last_synced_at: string | null;
  next_sync_at: string | null;
  sync_error: string | null;
  syncing: boolean;
  tables: { name: string; rows: number; synced_at: string }[];
};

export const appsApi = {
  list: () => api.get<AppInfo[]>("/apps").then((r) => r.data),
  connect: (payload: { kind: string; name: string; credentials: Record<string, string>; sync_interval?: string; history_days?: number; workspace_id?: string }) =>
    api.post<AppStatus>("/apps", payload, { timeout: 60000 }).then((r) => r.data),
  status: (id: string) => api.get<AppStatus>(`/apps/${id}`).then((r) => r.data),
  syncNow: (id: string) => api.post<AppStatus>(`/apps/${id}/sync`).then((r) => r.data),
  update: (id: string, syncInterval: string) => api.patch<AppStatus>(`/apps/${id}`, { sync_interval: syncInterval }).then((r) => r.data),
};

export const SYNCED_KINDS = ["shopify", "ga4", "meta_ads", "google_ads"];

export const INTERVAL_LABELS: Record<string, string> = {
  "15m": "Every 15 minutes",
  "1h": "Every hour",
  "6h": "Every 6 hours",
  daily: "Once a day",
};
