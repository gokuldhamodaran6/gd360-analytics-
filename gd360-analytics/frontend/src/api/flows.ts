// R54: Automate data - backend/app/routers/flows.py, services/flows.
import { api } from "./client";

export type FlowStatus = "draft" | "tested" | "live" | "paused";
export type RunStatus = "running" | "success" | "held" | "failed";

export type Source = { alias: string; datasource_id: string; table: string | null; label: string };
export type CleanOp = { op: "tidy_key" | "to_number" | "set_aside_missing" | "trim_text" | "dedupe"; column?: string };
export type Step =
  | { id: string; kind: "clean"; source: string; ops: CleanOp[]; enabled?: boolean }
  | { id: string; kind: "combine"; left: string; right: string; left_on: string; right_on: string; right_columns: string[]; aggregate: "sum" | "first" | "count"; fill: number | null; enabled?: boolean }
  | { id: string; kind: "compute"; column: string; left: string; op: "+" | "-" | "*" | "/"; right: string | number; fill: number | null; enabled?: boolean }
  | { id: string; kind: "keep"; columns: string[]; enabled?: boolean }
  | { id: string; kind: "rename"; columns: Record<string, string>; source?: string; enabled?: boolean };
export type Check = { id: string; kind: "unique" | "not_empty" | "min" | "max" | "ready_by"; column?: string; value?: number; time?: string; enabled?: boolean };
export type Spec = {
  sources: Source[]; steps: Step[]; checks: Check[]; output: { name: string };
  schedule: { time: string; days: number[]; timezone: string; on_change: boolean };
  policy: { hold_above: number; flag_to: string[]; alert_to: string[]; daily_summary: boolean };
};
export type ProfileColumn = { name: string; kind: string; filled: number; examples: any[] };
export type Issue = {
  id: string; alias: string; kind: "key_format" | "text_number" | "missing_key" | "duplicates"; column: string; count: number; title: string; detail: string;
  examples?: { before: string; after: any }[]; rows?: Record<string, any>[];
};
export type Profile = {
  sources: { alias: string; label: string; rows: number; columns: ProfileColumn[]; sample: Record<string, any>[] }[];
  link: { left: string; right: string; left_on: string; right_on: string; overlap: number; matched: number; of: number } | null;
  issues: Issue[];
};
export type Msg = { id: string; role: "user" | "gd360"; kind: string; text: string; data: any; at: string };
export type CheckResult = { id: string; kind: string; label: string; status: "passed" | "flagged" | "failed" | "later" | "late"; count: number; column?: string; detail?: string; note?: string };
export type RunEvent = { at: string; text: string; status: "ok" | "warn" | "bad"; detail?: string };
export type RunLite = {
  id: string; reason: string; status: RunStatus; published: boolean; version: number; started_at: string | null; finished_at: string | null;
  seconds: number | null; rows_out: number | null; flagged: number | null; error: string | null;
};
export type Run = RunLite & {
  stats: Record<string, any>; checks: CheckResult[]; events: RunEvent[];
  flagged_rows: { reasons: string[]; row: Record<string, any> }[]; set_aside: { source: string; reason: string; row: Record<string, any> }[];
  examples: { source: string; column: string; before: string; after: any }[]; preview: { columns: string[]; rows: Record<string, any>[] }; deliveries: any[];
};
export type Fix = {
  id: string; run_id: string; alias: string; cause: string; summary: string; evidence: string;
  changes: { alias: string; from: string; to: string; as: string }[]; diff: [string, string][]; created_at: string;
};
export type Flow = {
  id: string; name: string; request: string | null; status: FlowStatus; enabled: boolean; version: number; workspace_id: string | null; can_edit: boolean;
  spec: Spec; steps: { id: string; kind: string; enabled: boolean; title: string; detail: string }[];
  checks: { id: string; kind: string; enabled: boolean; label: string; column?: string; value?: number; time?: string }[];
  schedule_text: string; code: string; profile: Profile | null; thread: Msg[]; pending_fix: Fix | null;
  output: { datasource_id: string | null; name: string; exists: boolean };
  next_run_at: string | null; next_run_text: string | null; last_run_at: string | null; last_status: RunStatus | null;
  last_test: Run | null; last_live: Run | null; running: RunLite | null; runs: RunLite[];
  used_by: { kind: "dashboard" | "doc" | "automation"; id: string; name: string; link: string }[];
  people: Record<string, string>; created_at: string; updated_at: string;
};
export type FlowItem = {
  id: string; name: string; status: FlowStatus; enabled: boolean; sources: string[]; output: string; schedule: string;
  next_run_at: string | null; last_run_at: string | null; last_status: RunStatus | null; last_rows: number | null; last_flagged: number | null;
  needs_fix: boolean; updated_at: string;
};
export type SourceOption = { id: string; name: string; kind: string; tables: string[]; managed?: boolean };
export type Person = { id: string; name: string; email: string };
export type DraftResult = Flow | { needs_sources: true; message: string; options: SourceOption[] };

const ws = (w?: string | null) => (w ? { params: { workspace_id: w } } : {});
export const flowsApi = {
  list: (w?: string | null) => api.get<{ items: FlowItem[] }>("/flows", ws(w)).then((r) => r.data.items),
  sources: (w?: string | null) => api.get<{ items: SourceOption[] }>("/flows/sources", ws(w)).then((r) => r.data.items),
  people: (w?: string | null) => api.get<{ items: Person[] }>("/flows/people", ws(w)).then((r) => r.data.items),
  draft: (body: { text: string; workspace_id?: string | null; source_ids?: string[]; timezone?: string }) =>
    api.post<DraftResult>("/flows/draft", body).then((r) => r.data),
  get: (id: string) => api.get<Flow>(`/flows/${id}`).then((r) => r.data),
  patch: (id: string, body: { name?: string; enabled?: boolean }) => api.patch<Flow>(`/flows/${id}`, body).then((r) => r.data),
  saveSpec: (id: string, spec: Spec, note: string) => api.put<Flow>(`/flows/${id}/spec`, { spec, note }).then((r) => r.data),
  replan: (id: string, source_ids?: string[]) => api.post<Flow>(`/flows/${id}/replan`, { source_ids }).then((r) => r.data),
  message: (id: string, text: string) => api.post<{ reply: string; run_id: string | null; flow: Flow }>(`/flows/${id}/messages`, { text }).then((r) => r.data),
  test: (id: string) => api.post<{ run_id: string }>(`/flows/${id}/test`).then((r) => r.data),
  run: (id: string) => api.post<{ run_id: string }>(`/flows/${id}/run`).then((r) => r.data),
  getRun: (runId: string) => api.get<Run>(`/flows/runs/${runId}`).then((r) => r.data),
  applyFix: (id: string) => api.post<{ run_id: string }>(`/flows/${id}/fix/apply`).then((r) => r.data),
  dismissFix: (id: string) => api.post<Flow>(`/flows/${id}/fix/dismiss`).then((r) => r.data),
  versions: (id: string) => api.get<{ items: { version: number; note: string; by: string; at: string; current: boolean }[] }>(`/flows/${id}/versions`).then((r) => r.data.items),
  restore: (id: string, v: number) => api.post<Flow>(`/flows/${id}/versions/${v}/restore`).then((r) => r.data),
  remove: (id: string) => api.delete(`/flows/${id}`),
  replaceFile: (datasourceId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return api.post<{ id: string; rows: number; columns: string[] }>(`/datasources/${datasourceId}/replace-file`, fd).then((r) => r.data);
  },
};

export const STATUS_WORD: Record<FlowStatus, string> = { draft: "Draft", tested: "Tested", live: "On", paused: "Paused" };
export const RUN_WORD: Record<RunStatus, string> = { running: "Running", success: "Saved", held: "Held", failed: "Stopped" };
export const REASON_WORD: Record<string, string> = { test: "Test", manual: "Run now", schedule: "Scheduled", change: "Source changed", fix: "After fix" };
export const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function fmtNum(v: any): string {
  if (v === null || v === undefined || v === "") return "–";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return String(v);
}

const ID_COL = /(^|[_\s#])(id|no|nr|num|number|code|ref|order|invoice|sku|pin|zip|phone)$|^#|#$/i;

/** One table cell: ids without thousands separators, midnight dates as plain dates. */
export function fmtCell(col: string, v: any): string {
  if (v === null || v === undefined || v === "") return "–";
  if (typeof v === "number" && ID_COL.test(col.trim())) return String(v);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?Z?$/.test(v)) return v.slice(0, 10);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v.slice(0, 16).replace("T", " ");
  return fmtNum(v);
}

export function fmtSecs(s: number | null | undefined): string {
  if (s === null || s === undefined) return "";
  if (s < 1) return "<1 s";
  return s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`;
}

export function runWord(reason: string, status: RunStatus): string {
  if (reason === "test" && status === "success") return "Passed";
  if (reason === "test" && status === "held") return "Would be held";
  return RUN_WORD[status];
}

export function timeOf(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function whenOf(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  const y = new Date(now.getTime() - 86400000);
  if (same) return `Today ${timeOf(iso)}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday ${timeOf(iso)}`;
  return d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + timeOf(iso);
}
