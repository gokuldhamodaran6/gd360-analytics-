// 2026-10-08 (round 12): Automations - WHEN -> DO -> TELL. Client for
// backend routers/automations.py.
import { api } from "./client";

export type Every = "hour" | "day" | "week" | "month";

export type Schedule = { every: Every; time?: string; minute?: number; days?: number[]; day_of_month?: number };

export type Trigger =
  | ({ type: "schedule" } & Schedule)
  | { type: "new_data"; datasource_id: string }
  | {
      type: "threshold";
      target: { kind: "project_run"; run_id: string } | { kind: "dashboard"; dashboard_id: string };
      kpi: string;
      kpi_label?: string;
      op: "below" | "above" | "drops_by" | "rises_by";
      value: number;
      unit?: string;
      check: Schedule;
    };

export type StepType =
  | "refresh_project_dashboard"
  | "rerun_question"
  | "refresh_dashboard"
  | "sync_source"
  | "quality_check"
  | "rescore_model"
  | "summarise";

export type Step = { type: StepType; dashboard_id?: string; run_id?: string; datasource_id?: string; model_id?: string };

export type Mode = "always" | "on_change" | "on_failure";

export type TellOut = {
  email: string[];
  mode: Mode;
  slack: { masked: string; label: string } | null;
  teams: { masked: string; label: string } | null;
};

export type TellIn = {
  email: string[];
  mode: Mode;
  slack_url?: string;
  slack_label?: string;
  slack_remove?: boolean;
  slack_keep?: boolean;
  teams_url?: string;
  teams_label?: string;
  teams_remove?: boolean;
  teams_keep?: boolean;
};

export type Sentence = { when: string; do: string; tell: string; tell_sentence?: string };

export type RunMessage = {
  subject: string;
  title: string;
  headline: string;
  lines: string[];
  kpis: { label: string; display: string; delta?: string | null; delta_dir?: string | null; note?: string | null }[];
  link: string | null;
  link_label: string;
  failed: boolean;
};

export type AutomationRun = {
  id: string;
  automation_id: string | null;
  name: string;
  reason: "schedule" | "manual" | "test" | "new_data" | "threshold";
  status: "running" | "success" | "failed";
  steps: { index: number; type: string; label: string; status: "done" | "failed" | "skipped"; detail?: any; error?: string; seconds?: number }[];
  message: RunMessage | null;
  deliveries: { channel: "email" | "slack" | "teams"; to: string; status: "sent" | "failed" | "not_configured" | "skipped"; detail?: string }[];
  notified: boolean;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  seconds: number | null;
};

export type Automation = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  timezone: string;
  steps: Step[];
  stop_on_quality_fail: boolean;
  tell: TellOut;
  sentence: Sentence;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_run: AutomationRun | null;
  running: boolean;
  last_value: string | null;
  last_checked_at: string | null;
  last_condition: boolean | null;
  triggered: { count: number; since: string | null } | null;
  created_at: string;
};

export type KpiOption = { key: string; label: string; display: string; kind?: string | null; delta?: string | null };

export type AutomationOptions = {
  project_dashboards: { id: string; name: string; kpis: KpiOption[]; queries: number }[];
  dashboards: { id: string; name: string }[];
  questions: { id: string; question: string; project_id: string; project: string; kpis: KpiOption[] }[];
  sources: { id: string; name: string; kind: string; label: string; mode: string; can_sync: boolean; new_data: boolean; quality_rules: number }[];
  models: { id: string; name: string }[];
  email_ready: boolean;
  me: string;
};

export type FreshnessRow = { id: string; name: string; type: string; arrives: string; updated_at: string | null; freshness: string; error: string | null };

export type Draft = {
  id?: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  timezone: string;
  steps: Step[];
  stop_on_quality_fail: boolean;
  tell: TellIn;
};

export type Preview = {
  sentence: Sentence;
  next_runs: string[];
  estimate: { queries: number; bytes_scanned: number | null; seconds: number | null; runs_per_month: number | null; exact: boolean };
  message: RunMessage | null;
  email_ready: boolean;
};

export const automationsApi = {
  list: () => api.get<{ automations: Automation[]; email_ready: boolean }>("/automations").then((r) => r.data),
  get: (id: string) => api.get<Automation>(`/automations/${id}`).then((r) => r.data),
  create: (d: Draft) => api.post<Automation>("/automations", d).then((r) => r.data),
  update: (id: string, d: Draft) => api.put<Automation>(`/automations/${id}`, d).then((r) => r.data),
  toggle: (id: string, enabled: boolean) => api.patch<Automation>(`/automations/${id}`, { enabled }).then((r) => r.data),
  remove: (id: string) => api.delete(`/automations/${id}`),
  runNow: (id: string) => api.post<{ run_id: string }>(`/automations/${id}/run`).then((r) => r.data),
  test: (d: Draft) => api.post<{ run_id: string }>("/automations/test", d).then((r) => r.data),
  run: (runId: string) => api.get<AutomationRun>(`/automations/runs/${runId}`).then((r) => r.data),
  runs: (id: string) => api.get<{ runs: AutomationRun[] }>(`/automations/${id}/runs`).then((r) => r.data.runs),
  options: () => api.get<AutomationOptions>("/automations/options").then((r) => r.data),
  freshness: () => api.get<{ sources: FreshnessRow[] }>("/automations/freshness").then((r) => r.data.sources),
  preview: (d: Draft) => api.post<Preview>("/automations/preview", d).then((r) => r.data),
};

/** The person's own time zone, as the browser knows it. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function timeZones(): string[] {
  try {
    const list = (Intl as any).supportedValuesOf?.("timeZone") as string[] | undefined;
    if (list && list.length) return list;
  } catch {
    /* older browsers */
  }
  return ["UTC", "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Europe/London", "Europe/Berlin", "Europe/Paris",
    "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo"];
}

/** "Fri 9 Oct" + "6:00 AM" for a UTC instant, in a time zone. */
export function whenParts(iso: string, tz: string): { day: string; time: string } {
  const d = new Date(iso);
  try {
    const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d).replace(",", "");
    const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
    return { day, time };
  } catch {
    return { day: d.toDateString(), time: d.toLocaleTimeString() };
  }
}

export function tzAbbrev(tz: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
    return part?.value || "";
  } catch {
    return "";
  }
}
