// 2026-10-11 (Explain & Alerts): the GD360 bell (backend routers/notifications.py)
// and Ask AI + alerts on dashboards (backend routers/dashboard_ai.py).
import { api } from "./client";

export type AppNotification = {
  id: string;
  kind: "alert" | "reminder" | "info" | "failed";
  title: string;
  body: string | null;
  link: string | null;
  data: {
    automation_id?: string | null; link?: string | null; why?: string | null; value?: string | null; line?: string | null;
    dashboard_id?: string | null; page_id?: string | null; block_id?: string | null; reminder?: boolean; source?: string | null;
  };
  automation_id: string | null;
  read: boolean;
  created_at: string;
};

export type WhyOut = {
  why: string | null;
  current: { label: string; display: string; window_text: string; as_of: string | null; prior_display: string | null; formula: string | null } | null;
  link: string | null;
  error?: string;
};

export const notificationsApi = {
  list: () => api.get<{ items: AppNotification[]; unread: number }>("/notifications").then((r) => r.data),
  unread: (since?: string | null) =>
    api.get<{ unread: number; latest: AppNotification[]; now: string }>("/notifications/unread", { params: { since: since || undefined } }).then((r) => r.data),
  read: (ids?: string[]) => api.post<{ marked: number; unread: number }>("/notifications/read", ids ? { ids } : {}).then((r) => r.data),
  snooze: (id: string, days = 7) => api.post<{ automation_id: string; until: string; name: string }>(`/notifications/${id}/snooze`, { days }).then((r) => r.data),
  unsnooze: (id: string) => api.post<{ automation_id: string }>(`/notifications/${id}/unsnooze`).then((r) => r.data),
  why: (id: string) => api.post<WhyOut>(`/notifications/${id}/why`, undefined, { timeout: 60000 }).then((r) => r.data),
};

// ---- dashboards ----------------------------------------------------------------

export type BlockSnapshot = {
  id: string;
  title: string;
  type: string;
  chart_type?: string | null;
  columns: { name: string; type?: string }[] | string[];
  rows: Record<string, unknown>[];
  dimensions?: string[];
  kpi?: { value: unknown; display: string; delta?: string | null; delta_caption?: string | null; sparkline?: number[] } | null;
  currency?: string | null;
  filters_text?: string | null;
};

export type BlockExplanation = {
  headline: string;
  points: { text: string; ref: string | null; block_id?: string | null }[];
  takeaway: string | null;
  followups: string[];
  needs_new_data?: boolean;
  new_question?: string | null;
  written_by: "model" | "numbers";
  question: string | null;
  block_id?: string | null;
  title?: string;
  seconds?: number;
};

export type AlertOp = "below" | "above" | "drops_by" | "rises_by";

export type AlertTarget = {
  kind: "board"; dashboard_id: string; page_id?: string; block_id: string; den_block_id?: string | null;
  ratio_as?: "percent" | "per" | null; window?: string; label?: string | null;
};

export type AlertDraft = {
  name: string;
  target: AlertTarget;
  kpi: "value";
  op: AlertOp;
  value: number;
  unit: string;
  line_display: string;
  label: string;
  formula: string | null;
  ratio: boolean;
  window: "last_30_days" | "last_7_days" | "total";
  window_text: string;
  as_of: string | null;
  current: { display: string; value: number | null; window_text: string; as_of: string | null };
  why: string | null;
  met_now: boolean | null;
  history: { period: string; label: string; value: number }[];
  backtest: {
    points: number; months_crossed?: number; fires?: number; text: string;
    lowest?: { label: string; value: number; display: string }; highest?: { label: string; value: number; display: string };
  };
  dashboard: { id: string; name: string };
  link: string;
  kind: string;
  check: { every: string; minute?: number; time?: string };
  when_text: string;
};

export type MetricChoice = { block_id: string; label: string; page_id: string; agg: string | null; format: string | null };

export type DraftResult =
  | { status: "ok"; draft: AlertDraft; choices: MetricChoice[] }
  | { status: "need_metric"; message: string; choices: MetricChoice[]; op?: AlertOp | null; value?: number | null }
  | { status: "need_line"; message: string; current: AlertDraft["current"]; target: AlertTarget; choices: MetricChoice[] };

export type AskOut = ({ kind: "alert" } & DraftResult) | { kind: "explain"; explain: BlockExplanation };

export type WatchSuggestion = { block_id: string; page_id: string; label: string; op: AlertOp; value: number; line_display: string; text: string; reason: string };

export type BoardAlert = {
  id: string; name: string; enabled: boolean; mine: boolean; block_id: string; den_block_id?: string | null; page_id?: string | null;
  label: string; op: AlertOp; value: number; unit: string; line: string; last_value: string | null; last_condition: boolean | null;
  last_checked_at: string | null; remind: "once" | "daily"; snoozed: boolean; people: number; waiting_for_ok: boolean; tell: string;
};

export type WatchOut = {
  suggestions: WatchSuggestion[];
  noticed: (WatchSuggestion & { pct: number }) | null;
  alerts: BoardAlert[];
  email_ready: boolean;
};

export type Recipient = { id: string; name: string; email: string; role: string | null; access: "app" | "link" | "none"; me: boolean };

export type RecipientsOut = {
  people: Recipient[];
  can_edit: boolean;
  workspace_id: string | null;
  share: { mode: string; published: boolean; slug: string } | null;
  email_ready: boolean;
};

export type CreateAlertBody = {
  target: AlertTarget; op: AlertOp; value: number; name?: string; check?: AlertDraft["check"];
  user_ids: string[]; emails: string[]; in_app: boolean; email: boolean; remind: "once" | "daily"; timezone: string;
  workspace_id?: string | null;
  slack_url?: string; slack_label?: string; teams_url?: string; teams_label?: string; webhook_url?: string; webhook_label?: string;
};

export const dashboardAiApi = {
  ask: (dashboardId: string, body: { question: string; page_id?: string | null; blocks: BlockSnapshot[]; focus_block_id?: string | null }) =>
    api.post<AskOut>(`/dashboard-ai/${dashboardId}/ask`, body, { timeout: 90000 }).then((r) => r.data),
  explain: (dashboardId: string, block: BlockSnapshot, question?: string) =>
    api.post<BlockExplanation>(`/dashboard-ai/${dashboardId}/explain`, { block, question }, { timeout: 90000 }).then((r) => r.data),
  draft: (dashboardId: string, body: { text?: string; page_id?: string | null; block_id?: string; den_block_id?: string | null; ratio_as?: string | null; op?: AlertOp; value?: number; window?: string; label?: string | null }) =>
    api.post<DraftResult>(`/dashboard-ai/${dashboardId}/alert-draft`, body, { timeout: 90000 }).then((r) => r.data),
  watch: (dashboardId: string, pageId?: string | null) =>
    api.get<WatchOut>(`/dashboard-ai/${dashboardId}/watch`, { params: { page_id: pageId || undefined }, timeout: 90000 }).then((r) => r.data),
  recipients: (dashboardId: string) => api.get<RecipientsOut>(`/dashboard-ai/${dashboardId}/recipients`).then((r) => r.data),
  giveAccess: (dashboardId: string, email: string) =>
    api.post<{ access: "link"; link: string; note: string }>(`/dashboard-ai/${dashboardId}/give-access`, { email }).then((r) => r.data),
  createAlert: (dashboardId: string, body: CreateAlertBody) =>
    api.post<{ id: string; name: string; enabled: boolean; people: number; approval: { status: string } | null; sentence: { tell: string; tell_sentence?: string } }>(
      `/dashboard-ai/${dashboardId}/alerts`, body, { timeout: 90000 },
    ).then((r) => r.data),
};
