// 2026-10-14 (R46, GD360 2.0): the conversation API (backend/app/routers/v2.py).
import { api } from "./client";
import type { ProjectRun } from "./projects";
import type { Space } from "./spaces";

export type Chip = { key: string; ok: boolean; label: string; detail?: string | null };
export type TurnKind = "knowledge" | "data" | "guided" | "dashboard" | "document" | "automation" | "chat" | "check" | "explain" | "dashboard_edit" | "model" | "team" | "analysis" | "document_edit" | "list" | "whatif";
export type TurnStatus = "working" | "steps" | "done" | "failed" | "needs_input" | "confirm";
export type Artifact = {
  type: "dashboard" | "document" | "automation" | "model" | "space" | "analysis" | "list";
  id: string; name?: string; title?: string; url?: string; page_id?: string | null; words?: number; refresh?: boolean; score?: string | null;
  doc_id?: string;
  recipe?: string; figures?: number; scored?: number | null; board?: boolean; pages?: number;
  rules?: string[]; invite_link?: string | null;
  sentence?: { when?: string; do?: string; tell?: string; tell_sentence?: string }; next_run_at?: string | null;
  live?: { kind: string; label: string; url: string; views: number } | null;
};
export type TrailItem = { label: string; status?: string | null; sql?: string | null; ms?: number | null };
export type Source = { n?: number; title: string; url: string; domain?: string };
// 2026-10-15 (R48): the analysis runner's typed result (backend/app/services/agent/analysis.py)
export type Signal = {
  column: string; label: string; kind: "numeric" | "categorical" | "flat"; direction?: string; group: string; group_n: number; group_rate: number;
  compare: string; compare_n: number; compare_rate: number; lift?: number | null; diff_pp: number; importance?: number | null; rank?: number | null;
  values?: { value: string; n: number; rate: number }[];
};
export type Tier = { key: "high" | "medium" | "low"; label: string; count: number; rule: string; hist_rate: number; band_n: number; action: string };
export type Analysis = {
  recipe: "outcome" | "segment" | "signal"; question: string; title?: string;
  table: { source_id: string; source: string; table: string; rows_used: number; sampled: boolean; columns: number; entities: string };
  target: { column: string; positive: string; verb: string; noun: string; label: string };
  baseline: { n: number; positives: number; rate: number; existing: number };
  has_dates: boolean; id_column?: string | null; signals: Signal[]; signals_total: number;
  importance: { column: string; label: string; value: number }[];
  segments: { label: string; rate: number; n: number; highlight: boolean }[];
  model?: { algorithm: string; test_n: number; train_n: number; ap: number; auc: number; baseline_ap: number; pr_curve: [number, number][]; point: { recall: number; precision: number }; features: number; folds: number; leaks: { column: string; reason: string }[]; excluded: number } | null;
  tiers?: Tier[] | null;
  risk_list?: { columns: string[]; rows: Record<string, any>[]; total_high: number } | null;
  by_dimension?: { column: string; label: string; values: { value: string; n: number; positives: number; rate: number; vs_all_pp: number }[] } | null;
  focus?: Signal | null;
  recommendations: { n: string; title: string; body: string; reach: number; reach_note: string }[];
  method: { steps: { label: string; detail?: string; ms?: number }[]; formulas: string[]; code: string };
  prose?: { headline: string; summary: string[]; limitation: string; signals_note?: string; tiers_note?: string; written_by: string; replaced: { field: string; numbers: string[] }[] };
  elapsed_s?: number;
};
export type Turn = {
  id: string; kind: TurnKind; status: TurnStatus; question: string; created_at: string; finished_at?: string | null;
  text?: string | null; sources?: Source[]; grounded?: boolean | null; normalized?: string | null; analysis?: Analysis | null;
  chips: Chip[]; verdict?: "ok" | "warn" | "fail" | "pending"; artifacts: Artifact[]; trail: TrailItem[];
  elapsed_s?: number | null; error?: string | null; intent_by?: string | null; mode?: "analyst" | "engine";
  run_id?: string | null; run?: ProjectRun | null; guided_project_id?: string | null;
  confirm?: AutomationConfirm | TeamConfirm | null; check?: any; explain?: any; issues?: string[];
  model_summary?: { label: string; metric: string; test_score?: number | null; baseline?: { name?: string; score?: number }; drivers: string[]; leaks: string[]; rows?: number; target?: string; table?: string } | null;
  document?: { title: string; markdown: string; flagged: string[] } | null;
  placements?: { dashboard_id: string; dashboard_name: string; page_id?: string | null }[];
  // 2026-10-15 (R50): the action cards - a dashboard edit (was / now) and a dashboard build (its pages)
  edit?: { before: BoardCardState | { name: string; theme: string; accent?: string | null }; after: BoardCardState; changes: string[]; undo: boolean; dashboard_id: string } | null;
  built?: { pages: string[]; name: string; theme: string; typo?: string | null; dashboard_id: string } | null;
  // 2026-10-17 (R52): the risk list and the what-if, answered from the analysis; time budgets
  list?: RiskList | null; whatif?: WhatIf | null; budget_s?: number | null; timed_out?: boolean | null;
};
export type RiskList = {
  title: string; tier: string; rule: string; id_label: string; columns: string[]; rows: Record<string, any>[]; total: number; shown: number;
  asked?: number | null; note?: string | null; entities: string; restricted?: string | null;
};
export type WhatIfSide = { group_rate: number; group_count: number; overall_rate: number; overall_count: number };
export type WhatIf = {
  group: string; group_n: number; column?: string | null; before: WhatIfSide; after: WhatIfSide; saved: number; noun: string; entities: string;
  change: { kind: "relative" | "points"; amount: number; label: string }; assumptions: string[];
};
export const downloadTurnList = async (conversationId: string, turnId: string, kind: "xlsx" | "csv", name: string) => {
  const res = await api.get(`/v2/conversations/${conversationId}/turns/${turnId}/export.${kind}`, { responseType: "blob" });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${(name || "list").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "list"}.${kind}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};
export type BoardCardState = {
  name: string; theme: string; theme_label: string; accent?: string | null; pages: string[];
  palette: { bg: string; card: string; ink: string; accent: string; warn: string; mode: string };
};
export type FirstCheck = { text: string; over?: { dim_label: string; value: string; rate: number; n: number }[]; groups?: number; columns?: number; overall?: number };
export type AutomationConfirm = {
  kind: "automation"; ok: boolean; body: any; issues: string[]; needs: string[]; note?: string | null;
  sentence: { when: string; do: string; tell: string; tell_sentence?: string };
  watch?: { question: string; run_id: string } | null;
  // R50: the alert card - what it watches, what it would say right now, where it sends
  watches?: string | null; first_check?: FirstCheck | null; sends?: string | null;
  threshold?: { value: number | null; unit: string; op: string } | null;
};
export type TeamConfirm = {
  kind: "team"; ok: boolean; body: { name: string; access: string; member_ids: string[]; source_ids: string[]; workspace_id: string | null; hidden: any[]; rows: any[] };
  members: { user_id: string; name: string; role: string }[]; to_invite: string[]; invite_link?: string | null;
  sources: { id: string; name: string; kind: string }[]; hidden: { source_id: string; source: string; column: string }[];
  rows: { source_id: string; source: string; column: string; values: string[]; who: string; role: string }[]; issues: string[]; note?: string | null; limits: string[];
  shares_conversation?: boolean;
};
export type BlockData = { id: string; title: string; type: string; columns: string[]; rows: Record<string, unknown>[]; row_count: number; kpi: { label: string; value: number | null; display: string } | null; definition?: string | null };
export type DashboardData = { dashboard: { id: string; name: string }; page: { id: string; name: string }; source: { id: string; name: string; kind: string } | null; blocks: BlockData[] };
export type SourceSummary = { id: string; name: string; kind: string; label?: string; mode?: string; freshness?: any; tables?: any[]; workspace_id?: string | null };
export type Conversation = {
  id: string; title: string; created_at: string; source_ids: string[]; sources: SourceSummary[]; workspace_id: string | null;
  can_edit: boolean; turns: Turn[]; dashboards: { id: string; name: string; layout_version: number; pages: { id: string; name: string }[]; live?: any }[];
  v2: boolean; space_id: string | null; space_name: string | null; space_color: string | null;
};
export type ConversationRow = {
  id: string; title: string; created_at: string; space_id: string | null; pinned: boolean; last_at: string; headline?: string | null;
  v2: boolean; kind: string; mine: boolean;
  space_name?: string | null; space_color?: string | null; work?: string;
};
export type PlanMeter = { key: string; label: string; used: number; limit: number | null; near: boolean; over: boolean };
export type PlanSummary = {
  plan: string; label: string; who: string; price: Record<string, any>; model_tier: string; support: string; enforced: boolean;
  limits: Record<string, number | null>; meters: PlanMeter[]; all_features: boolean;
  plans: Record<string, { label: string; price: Record<string, any>; limits: Record<string, number | null>; who: string }>;
};
export type Home = {
  user: { id: string; first_name: string; email: string }; spaces: Space[]; sources: SourceSummary[];
  conversations: ConversationRow[]; plan: PlanSummary; web: boolean; web_provider: string; examples?: string[];
};
export type Mode = "auto" | "quick" | "guided";

const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const today = () => new Date().toISOString().slice(0, 10);

export const v2Api = {
  home: (workspaceId?: string | null) => api.get<Home>("/v2/home", { params: workspaceId ? { workspace_id: workspaceId } : {} }).then((r) => r.data),
  plan: () => api.get<PlanSummary>("/v2/plan").then((r) => r.data),
  start: (body: { message: string; space_id?: string | null; source_ids?: string[] | null; workspace_id?: string | null; mode?: Mode; intent?: string | null }) =>
    api.post<{ conversation: Conversation; turn: Turn }>("/v2/conversations", { ...body, today: today(), timezone: tz() }).then((r) => r.data),
  list: (workspaceId?: string | null) => api.get<{ conversations: ConversationRow[] }>("/v2/conversations", { params: workspaceId ? { workspace_id: workspaceId } : {} }).then((r) => r.data.conversations),
  get: (id: string) => api.get<Conversation>(`/v2/conversations/${id}`).then((r) => r.data),
  update: (id: string, body: { title?: string; pinned?: boolean }) => api.patch(`/v2/conversations/${id}`, body).then((r) => r.data),
  send: (id: string, body: { message: string; mode?: Mode; accepted?: string[]; context_run_id?: string | null; intent?: string | null }) =>
    api.post<Turn>(`/v2/conversations/${id}/messages`, { ...body, today: today(), timezone: tz() }).then((r) => r.data),
  turn: (id: string, turnId: string) => api.get<Turn>(`/v2/conversations/${id}/turns/${turnId}`).then((r) => r.data),
  confirm: (id: string, turnId: string, approve: boolean, edits?: any) =>
    api.post<Turn>(`/v2/conversations/${id}/turns/${turnId}/confirm`, { approve, edits }).then((r) => r.data),
  revise: (id: string, turnId: string, edits: Record<string, unknown>) =>
    api.post<Turn>(`/v2/conversations/${id}/turns/${turnId}/revise`, { approve: true, edits }).then((r) => r.data),
  dashboard: (id: string, body: { run_ids?: string[]; name?: string }) => api.post<Turn>(`/v2/conversations/${id}/dashboard`, body).then((r) => r.data),
  documentUrl: (id: string, turnId: string) => `${api.defaults.baseURL}/v2/conversations/${id}/documents/${turnId}.md`,
  dashboardData: (dashboardId: string, pageId?: string | null) => api.get<DashboardData>(`/v2/dashboards/${dashboardId}/data`, { params: pageId ? { page_id: pageId } : {} }).then((r) => r.data),
  publicPlans: () => api.get<{ plans: PlanSummary["plans"]; all_features: boolean; enforced: boolean }>("/v2/plans").then((r) => r.data),
};
