// 2026-10-08 (round 11): multi-source Projects and synced apps - the client
// for backend routers/projects.py and routers/apps.py.
import { api } from "./client";
import { localToday } from "./assistant";

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
  // "stale" (Guided Analysis): an earlier step it builds on changed
  status: "pending" | "running" | "done" | "failed" | "skipped" | "stale";
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
  // 2026-10-10 (Guided Analysis)
  approved?: boolean;
  tweaks?: string[];
  edits?: string[];
  added?: boolean;
  // 2026-10-11 (Ask Journey): the result came from an earlier question in
  // the thread (same query on the same source) - no new query ran
  reused?: { question: number; step: number; title?: string | null; run_id?: string } | null;
};

export type Fact = { id: string; label: string; value: number | null; kind: string; display: string };

type VisualBase = { sources?: string[] };
export type Visual = VisualBase &
  (
    | { type: "waterfall"; title: string; items: { label: string; value: number; kind: "total" | "up" | "down" }[]; format: string; currency?: string | null;
        details?: { columns: ResultColumn[]; rows: Record<string, unknown>[] } | null }
    | { type: "diverging"; title: string; items: { label: string; value: number; share: number | null }[]; format: string; currency?: string | null }
    | { type: "chart"; title: string; chart_type?: string | null; columns: ResultColumn[]; rows: Record<string, unknown>[]; truncated?: boolean;
        // round 14: "table" = a formatted detail table; a note under the chart
        display?: "table" | null; note?: string | null; time_column?: string | null;
        // round 33: every column the result returned, when the chart draws one of them
        details?: { columns: ResultColumn[]; rows: Record<string, unknown>[] } | null }
    | { type: "kpis"; items: { label: string; display: string; fact_id: string }[] }
    | ForecastVisual
  );

// 2026-10-12 (round 32): a forecast inside an answer - the history, the
// forecast for exactly the period asked, and its 80% / 95% ranges
// (backend project_engine/forecasting.py).
export type ForecastPoint = {
  period: string; value: number; kind: "actual" | "partial" | "forecast";
  lo80?: number; hi80?: number; lo95?: number; hi95?: number; source?: "model" | "long";
};
export type ForecastYear = {
  period: string; value: number; kind: "actual" | "forecast" | "mixed";
  lo80?: number; hi80?: number; lo95?: number; hi95?: number; actual_part?: number | null; long_range?: boolean;
};
export type ForecastVisual = {
  type: "forecast"; title: string; metric: string; format: string; currency?: string | null;
  grain: "day" | "week" | "month" | "quarter" | "year";
  target: { label: string; start: string; end: string; multi_year: boolean; headline_label: string };
  headline: {
    label: string; value: number; lo80: number; hi80: number; lo95: number; hi95: number;
    display: string; range_display: string; wide_display: string;
    vs?: { label: string; display: string; pct_display?: string | null; pct: number } | null;
    total_display?: string | null; cagr_display?: string | null;
  };
  years: ForecastYear[];
  points: ForecastPoint[];
  method: {
    label: string; history: string; certainty: "tested" | "long-range" | "rough" | "untested";
    mape?: number | null; baseline_mape?: number | null; baseline?: string | null; long_range_from?: number | null; notes: string[];
  };
  columns: ResultColumn[]; rows: Record<string, unknown>[];
  // round 33: open on the months when asked "by month"; the grain the test error is measured at
  view?: "months" | null; error_grain?: string | null;
};

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
  // round 32: when the data can't answer it - the closest things it can, one tap each
  options?: WayForward[];
};

export type WayForward = { id: string; label: string; kind: "ask" | "connect"; question?: string; href?: string };

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
  // 2026-10-10 (Guided Analysis): a step changed after the answer was written
  answer_stale?: boolean;
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
  // 2026-10-10 (Guided Analysis): a step or the answer is being worked on
  busy?: boolean;
  duration_seconds: number | null;
  // 2026-10-11 (Ask Journey): what the conversation column shows without
  // the full run
  answer_text?: string | null;
  next_questions?: string[];
  steps_total?: number;
  steps_done?: number;
  steps_approved?: number;
  steps_reused?: number;
  plan?: Plan | null;
  steps?: RunStep[];
  result?: RunResult | null;
};

export type Project = {
  id: string;
  title: string;
  // "project" = an Instant Answer, "guided" = a Guided Analysis
  kind?: "project" | "guided" | null;
  source_ids: string[];
  sources: ProjectSource[];
  workspace_id: string | null;
  created_at: string;
  pinned: boolean;
  can_edit: boolean;
  runs: ProjectRun[];
  dashboards: ThreadDashboard[];
  // 2026-10-11 (Ask Journey): which answers went onto which dashboard, and
  // the answers GD360 was told "Not now" about
  placements?: Placement[];
  dismissed?: string[];
  // 2026-10-11 (Explain & Alerts): explanations asked in this thread
  explains?: Explanation[];
  // 2026-10-09 (round 15): the Space a project was asked in, if any.
  space_id?: string | null;
  space_name?: string | null;
  space_color?: string | null;
};

// 2026-10-11 (Explain & Alerts): an explanation of what is already on
// screen - the answer, one chart or one cause - written from the run's own
// numbers (no new run). written_by "numbers" = composed without a model.
export type ExplainTarget = { kind: "answer" | "visual" | "cause"; index: number };

export type Explanation = {
  id: string | null;
  run_id: string;
  created_at: string;
  target: ExplainTarget;
  title: string;
  question: string | null;
  headline: string;
  points: { text: string; ref: string | null }[];
  takeaway: string | null;
  followups: string[];
  needs_new_data?: boolean;
  new_question?: string | null;
  written_by: "model" | "numbers";
  seconds?: number;
};

export type AskResult =
  | { kind?: "run"; project_id: string; run_id: string; source_ids?: string[] }
  // round 32: a follow-up whose date can't be right comes back as a "did you mean?" first
  | { kind: "check"; project_id: string; check: QuestionCheck; run_id?: undefined; source_ids?: string[] }
  | { kind: "explain"; project_id: string; explain: Explanation; route?: string; run_id?: undefined; source_ids?: string[] };

export type LiveInfo = { kind: "domain" | "link"; label: string; url: string; views: number };

export type ThreadDashboard = {
  id: string;
  name: string;
  layout_version?: number;
  datasource_id?: string | null;
  created_at?: string;
  can_edit?: boolean;
  pages?: { id: string; name: string }[];
  live?: LiveInfo | null;
};

export type Placement = {
  action_id: string;
  dashboard_id: string;
  dashboard_name?: string;
  mode: "new" | "page" | "merge" | "replace";
  run_ids: string[];
  page_ids?: string[];
  block_ids?: string[];
  page_id?: string | null;
  at?: string;
};

// round 36: "Create a dashboard from this thread" - a checked plan, arranged by GD360 or by the person
export type ThreadPlanMode = "auto" | "arrange" | "answers";
export type ThreadPlanBlock = {
  id: string;
  title: string;
  type: string;
  chart_type: string | null;
  visual: "kpi" | "trend" | "bars" | "map" | "donut" | "split" | "table";
  how: string;
  origin: string; // "Q1".. | "suggested" | "you"
  why?: string | null;
  table?: string | null;
};
export type ThreadPlan = {
  plan_id: string;
  title: string;
  datasource_id: string;
  datasource_name: string;
  mode: ThreadPlanMode;
  pages: { title: string; blocks: ThreadPlanBlock[] }[];
  skipped: { title: string; reason: string }[];
  answers: { label: string; question: string; run_id: string }[];
  total: number;
};
export type ThreadBuildResult = MakeDashboardResult & { blocks: number };

export type MakeDashboardResult = {
  dashboard_id: string;
  name: string;
  layout_version: number;
  page_id: string | null;
  page_ids?: string[];
  block_ids?: string[];
  datasource_id: string;
  datasource_name: string;
  action_id?: string;
  mode?: Placement["mode"];
  run_ids?: string[];
  live?: LiveInfo | null;
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

// 2026-10-11 (round 24, Understand before answering): the read-back of a
// question before it runs (backend services/question_check.py).
export type CheckPeriod = { start: string; end: string; label: string; text: string; assumed?: boolean; key?: string; future?: boolean; parts?: CheckPeriod[]; forecast?: boolean };
export type CheckOption = {
  id: string; label: string; value: string; detail?: string; recommended?: boolean;
  fit?: string; why?: string; action?: "connect" | "upload" | "more"; period?: CheckPeriod;
  // round 32: an option that asks a different question ("Show 2021–2025 instead")
  question?: string;
};
export type CheckIssue = {
  id: string;
  kind: "year_typo" | "month_typo" | "future_year" | "forecast_year" | "choose" | "swap" | "confirm_pick" | "cant_answer";
  title: string; text: string; options: CheckOption[]; multi?: boolean; said?: string; fix?: { from: string }; suggested?: string;
};
export type CheckCandidate = {
  id: string; name: string; kind: string; label: string; freshness?: string; fit: string; why: string; says?: string;
  coverage?: { start: string; end: string; text: string } | null; date_column?: string | null; measures?: string[];
  table?: string | null; named?: boolean; score: number;
};
export type QuestionCheck = {
  question: string; ready: boolean; what?: string; topic?: string | null; period: CheckPeriod | null;
  period_options?: CheckPeriod[]; needs_time?: boolean; issues: CheckIssue[]; candidates: CheckCandidate[];
  picked: string[]; picked_sources?: { id: string; name: string; label: string }[]; restated: string | null;
  connect?: { kind: string; label: string; url: string }[]; sources_considered?: number; skipped?: boolean;
  forecast?: boolean;
};
export type RunBrief = { period?: CheckPeriod | null; restated?: string | null; notes?: string[]; forecast?: boolean };

export const projectsApi = {
  check: (payload: { question: string; source_ids?: string[]; space_id?: string; workspace_id?: string; accepted?: string[] }) =>
    api.post<QuestionCheck>("/projects/check", { ...payload, today: localToday() }, { timeout: 20000 }).then((r) => r.data),
  sources: (workspaceId?: string) =>
    api.get<ProjectSource[]>("/projects/sources", { params: { workspace_id: workspaceId || undefined } }).then((r) => r.data),
  // 2026-10-09 (round 15): space_id asks one Space (its sources you can use);
  // send space_id or source_ids, never both.
  // mode "guided" starts a Guided Analysis (the same engine, one step at a time).
  create: (payload: { question: string; source_ids?: string[]; space_id?: string; workspace_id?: string; auto_run?: boolean; mode?: "answer" | "guided"; brief?: RunBrief }) =>
    api.post<{ project_id: string; run_id: string; space_id?: string | null; kind?: string }>("/projects", payload).then((r) => r.data),
  get: (id: string) => api.get<Project>(`/projects/${id}`).then((r) => r.data),
  update: (id: string, payload: { title?: string; source_ids?: string[] }) =>
    api.patch<{ id: string; title: string; source_ids: string[] }>(`/projects/${id}`, payload).then((r) => r.data),
  // 2026-10-11 (Ask Journey): a Guided Analysis follow-up picks its mode
  // ("guided" step by step, "answer" straight through); any thread can
  // change its sources with the question (space_id or source_ids).
  ask: (
    id: string,
    question: string,
    autoRun = true,
    extra?: {
      mode?: "answer" | "guided"; source_ids?: string[]; space_id?: string;
      // 2026-10-11 (Explain & Alerts): read the follow-up first - "explain
      // this" is answered from the answer on screen without a new run
      route?: boolean; context_run_id?: string; explain_target?: ExplainTarget;
      // round 32: read the follow-up's dates first (a "did you mean?" comes back as kind "check");
      // `accepted`: years the person chose to keep as written
      understand?: boolean; accepted?: string[];
    },
  ) =>
    api.post<AskResult>(`/projects/${id}/ask`, { question, auto_run: autoRun, ...(extra || {}), ...(extra?.understand ? { today: localToday() } : {}) }, { timeout: 90000 }).then((r) => r.data),
  explain: (runId: string, target: ExplainTarget, question?: string) =>
    api.post<Explanation>(`/projects/runs/${runId}/explain`, { target, question: question || undefined }, { timeout: 60000 }).then((r) => r.data),
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
    payload: {
      run_id?: string; name?: string; datasource_id?: string; add_to_dashboard_id?: string; replace_dashboard_id?: string;
      // 2026-10-11 (Ask Journey)
      run_ids?: string[]; pages?: 1 | 2; page_name?: string; merge_into_page_id?: string;
    },
  ) => api.post<MakeDashboardResult>(`/projects/${id}/dashboard`, payload, { timeout: 240000 }).then((r) => r.data),
  planThreadDashboard: (id: string, payload: { run_ids: string[]; purpose?: string; mode: ThreadPlanMode; datasource_id?: string }) =>
    api.post<ThreadPlan>(`/projects/${id}/dashboard/plan`, payload, { timeout: 240000 }).then((r) => r.data),
  addToThreadPlan: (id: string, planId: string, payload: { text: string; page_index: number }) =>
    api.post<{ blocks: ThreadPlanBlock[]; plan: ThreadPlan }>(`/projects/${id}/dashboard/plan/${planId}/add`, payload, { timeout: 180000 }).then((r) => r.data),
  buildThreadDashboard: (id: string, payload: { plan_id: string; pages?: { title: string; block_ids: string[] }[]; name?: string }) =>
    api.post<ThreadBuildResult>(`/projects/${id}/dashboard/build`, payload, { timeout: 240000 }).then((r) => r.data),
  undoPlacement: (id: string, actionId: string) =>
    api.post<{ ok: boolean; dashboard_id: string }>(`/projects/${id}/dashboard/undo`, { action_id: actionId }).then((r) => r.data),
  dismissDashboardPrompt: (id: string, runIds: string[]) =>
    api.post<{ dismissed: string[] }>(`/projects/${id}/dashboard/dismiss`, { run_ids: runIds }).then((r) => r.data),
  dashboard: (id: string) => api.get<ProjectDashboard>(`/projects/dashboards/${id}`).then((r) => r.data),
  refreshDashboard: (id: string) =>
    api.post<ProjectDashboard>(`/projects/dashboards/${id}/refresh`, undefined, { timeout: 180000 }).then((r) => r.data),
  updateDashboard: (id: string, payload: { name?: string; tiles?: DashTile[] }) =>
    api.patch<ProjectDashboard>(`/projects/dashboards/${id}`, payload).then((r) => r.data),
};

// 2026-10-10: Guided Analysis - backend routers/guided.py. Each call returns
// the run as GET /projects/runs/{id} does; work continues in the background.
export const guidedApi = {
  runStep: (runId: string, stepId: string) => api.post<ProjectRun>(`/guided/runs/${runId}/steps/${stepId}/run`).then((r) => r.data),
  approve: (runId: string, stepId: string, runNext = true) =>
    api.post<ProjectRun>(`/guided/runs/${runId}/steps/${stepId}/approve`, { run_next: runNext }).then((r) => r.data),
  revise: (runId: string, stepId: string, instruction: string) =>
    api.post<ProjectRun>(`/guided/runs/${runId}/steps/${stepId}/revise`, { instruction }, { timeout: 120000 }).then((r) => r.data),
  setSql: (runId: string, stepId: string, sql: string) =>
    api.put<ProjectRun>(`/guided/runs/${runId}/steps/${stepId}/sql`, { sql }).then((r) => r.data),
  remove: (runId: string, stepId: string) => api.delete<ProjectRun>(`/guided/runs/${runId}/steps/${stepId}`).then((r) => r.data),
  add: (runId: string, instruction: string, afterId?: string | null) =>
    api
      .post<ProjectRun & { added_step_id: string }>(`/guided/runs/${runId}/steps`, { instruction, after_id: afterId || undefined }, { timeout: 120000 })
      .then((r) => r.data),
  runRest: (runId: string) => api.post<ProjectRun>(`/guided/runs/${runId}/run-rest`).then((r) => r.data),
  finish: (runId: string) => api.post<ProjectRun>(`/guided/runs/${runId}/finish`).then((r) => r.data),
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
