// 2026-10-14 (R46, GD360 2.0): the conversation API (backend/app/routers/v2.py).
import { api } from "./client";
import type { ProjectRun } from "./projects";
import type { Space } from "./spaces";

export type Chip = { key: string; ok: boolean; label: string; detail?: string | null };
export type TurnKind = "knowledge" | "data" | "guided" | "dashboard" | "document" | "automation" | "chat" | "check" | "explain";
export type TurnStatus = "working" | "steps" | "done" | "failed" | "needs_input" | "confirm";
export type Artifact = {
  type: "dashboard" | "document" | "automation";
  id: string; name?: string; title?: string; url?: string; page_id?: string | null; words?: number;
  sentence?: { when?: string; do?: string; tell?: string; tell_sentence?: string }; next_run_at?: string | null;
  live?: { kind: string; label: string; url: string; views: number } | null;
};
export type TrailItem = { label: string; status?: string | null; sql?: string | null; ms?: number | null };
export type Turn = {
  id: string; kind: TurnKind; status: TurnStatus; question: string; created_at: string; finished_at?: string | null;
  text?: string | null; sources?: { title: string; url: string }[]; grounded?: boolean | null;
  chips: Chip[]; verdict?: "ok" | "warn" | "fail" | "pending"; artifacts: Artifact[]; trail: TrailItem[];
  elapsed_s?: number | null; error?: string | null; intent_by?: string | null; mode?: "analyst" | "engine";
  run_id?: string | null; run?: ProjectRun | null; guided_project_id?: string | null;
  confirm?: AutomationConfirm | null; check?: any; explain?: any; issues?: string[];
  document?: { title: string; markdown: string; flagged: string[] } | null;
  placements?: { dashboard_id: string; dashboard_name: string; page_id?: string | null }[];
};
export type AutomationConfirm = {
  kind: "automation"; ok: boolean; body: any; issues: string[]; needs: string[]; note?: string | null;
  sentence: { when: string; do: string; tell: string; tell_sentence?: string };
  watch?: { question: string; run_id: string } | null;
};
export type SourceSummary = { id: string; name: string; kind: string; label?: string; mode?: string; freshness?: any; tables?: any[]; workspace_id?: string | null };
export type Conversation = {
  id: string; title: string; created_at: string; source_ids: string[]; sources: SourceSummary[]; workspace_id: string | null;
  can_edit: boolean; turns: Turn[]; dashboards: { id: string; name: string; layout_version: number; pages: { id: string; name: string }[]; live?: any }[];
  v2: boolean; space_id: string | null; space_name: string | null; space_color: string | null;
};
export type ConversationRow = {
  id: string; title: string; created_at: string; space_id: string | null; pinned: boolean; last_at: string; headline?: string | null;
  v2: boolean; kind: string; mine: boolean;
};
export type PlanMeter = { key: string; label: string; used: number; limit: number | null; near: boolean; over: boolean };
export type PlanSummary = {
  plan: string; label: string; who: string; price: Record<string, any>; model_tier: string; support: string; enforced: boolean;
  limits: Record<string, number | null>; meters: PlanMeter[]; all_features: boolean;
  plans: Record<string, { label: string; price: Record<string, any>; limits: Record<string, number | null>; who: string }>;
};
export type Home = {
  user: { id: string; first_name: string; email: string }; spaces: Space[]; sources: SourceSummary[];
  conversations: ConversationRow[]; plan: PlanSummary; web: boolean; web_provider: string;
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
  dashboard: (id: string, body: { run_ids?: string[]; name?: string }) => api.post<Turn>(`/v2/conversations/${id}/dashboard`, body).then((r) => r.data),
  documentUrl: (id: string, turnId: string) => `${api.defaults.baseURL}/v2/conversations/${id}/documents/${turnId}.md`,
};
