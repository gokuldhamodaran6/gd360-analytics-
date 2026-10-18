// 2026-10-17 (R53): Initiatives Autopilot - backend/app/routers/autopilot.py, services/autopilot.
import { api } from "./client";

export type Truth = "counted" | "matched" | "typed" | "none" | "modelled";
export type Fact = { key: string; label: string; value: number | null; unit: string; source: string; as_of?: string };
export type Benchmark = { key: string; low: number; typical: number; high: number; source: string };
export type Brain = {
  workspace_id: string; website: string | null; about: string | null; products: string[]; voice: string | null; industry: string | null;
  industry_label: string | null; audiences: Record<string, any>; sources: { id: string; kind: string; name: string; numbers: { key: string; label: string; value: number | null; unit: string }[] }[];
  facts: Fact[]; edited: Record<string, boolean>; brand: any; site: any; benchmarks: Benchmark[]; refreshed_at: string | null;
};
export type Pack = { key: string; label: string; audiences: string[]; channels: string[]; initiatives: { kind: string; brief: string }[]; focus: string[]; benchmarks: Benchmark[] };
export type Agent = { key: string; does: string; alone: string[]; asks: string[]; last_30_days: { done_alone: number; asked: number; undone: number } };
export type Action = {
  id: string; initiative_id: string | null; initiative?: string; agent: string; kind: string; kind_label: string; title: string; detail: string | null;
  impact: string | null; cost: number | null; state: "proposed" | "done" | "undone" | "dismissed" | "failed"; auto: boolean; reversible: boolean;
  result: string | null; decided_by: string | null; decided_at: string | null; created_at: string | null; payload: any;
};
export type Ev = {
  id: string; kind: string; source: string; external_id: string; title: string | null; text: string; url: string | null; media_url: string | null;
  numbers: Record<string, number | null>; matched_by: string | null; confidence: number | null; why: string | null;
  state: "auto" | "review" | "confirmed" | "rejected"; occurred_at: string | null; decided_by: string | null; initiative_id?: string; initiative?: string;
};
export type Decisions = { actions: Action[]; review: Ev[]; approvals: { task_id: string; title: string; initiative_id: string; initiative: string; approver: string | null }[]; total: number };
export type Contract = { code: string; ad_rule: string; hashtag: string | null; utm_campaign: string; utm_example: string; keywords: string[]; mapped: Record<string, string[]>;
  bindings: Record<string, { truth: Truth; source: string }> };
export type Policy = { paused: boolean; auto_attach_at: number; budget_cap: number; alone: Record<string, boolean>; ask: Record<string, boolean> };
export type ApOne = { contract: Contract; policy: Policy; counts: Record<string, { accepted: number; review: number; rejected: number }>; decisions: Decisions;
  last_scan: string | null; sources: { kind: string; platform?: string; name: string }[]; rules: Record<string, { rule: any; closes_on: string; completed_by: string | null }> };
export type Forecast = { key: string; label: string; target: number; actual: number | null; unit: string; truth?: Truth; state: string; median?: number; p10?: number; p90?: number;
  prob?: number | null; basis?: string | null; expected_now?: number | null; note?: string; direction?: "up" | "down" };
export type Move = { key: string; agent: string; kind: string; title: string; detail: string; helps: string; lift: number | null; cost: number | null; rank: number; alone: boolean };
export type Pace = { forecast: Forecast[]; moves: Move[]; snapshots: Record<string, { day: string; value: number }[]>; share_of_time: number | null };
export type MixChannel = { platform: string; days: number; spend: number; results: number; cost_per_result: number | null; daily_spend: number; marginal: number; fit: "curve" | "line";
  r2: number | null; curve: { spend: number; results: number }[]; observed: { spend: number; results: number }[] };
export type Mix = { available: boolean; why?: string; channels?: MixChannel[]; plan_b?: { from: string; to: string; per_day: number; days: number; amount: number; extra: number; title: string; detail: string } | null; note?: string };
export type Lift = { state: string; why?: string; actual?: number; expected?: number; lift?: number; lo?: number; hi?: number; pct?: number | null; clears_zero?: boolean;
  series?: { date: string; actual: number; expected: number }[]; verdict?: string | null; source?: string; metric?: string; treated?: string[]; control?: string };
export type Proof = { targets: any[]; evidence: Record<string, number>; lift: Lift; geo: Lift; pipeline: { sourced: number; sourced_n: number; influenced: number; influenced_n: number; won: number; won_n: number;
  deals: any[]; sources: any[] }; calibration: any; learnings: string[]; published: string | null; period: string; verdict: string };
export type Integrations = { digest: { on: boolean; hour: number; timezone: string; email: string | null; slack: boolean; teams: boolean; whatsapp: boolean };
  meta_capi: boolean; linkedin_capi: boolean; google_ads: boolean; teams_graph: boolean; linkedin_mentions: boolean; luma_hook: string | null; plain: Record<string, any>; last: Record<string, any> };
export type Webinar360 = { ready: boolean; ready_at: string | null; registered: number; joined: number; attendance_rate: number | null; avg_minutes: number | null; minutes_planned: number;
  viewers: { curve: { minute: number; viewers: number }[]; peak: number; avg: number; drops: { minute: number; from: number; to: number }[] };
  heat: { hot: number; warm: number; cold: number }; people: { name: string; company: string | null; minutes: number; questions: number; score: number; heat: "hot" | "warm" | "cold" }[];
  cta_clicks: number; replay_views: number; questions: string[]; pipeline: Record<string, number | null>; truth: string };

const ws = (w?: string | null) => (w ? { params: { workspace_id: w } } : {});
export const autopilotApi = {
  brain: (w?: string | null) => api.get<Brain>("/autopilot/brain", ws(w)).then((r) => r.data),
  refreshBrain: (w: string | null, website?: string) => api.post<Brain>("/autopilot/brain/refresh", { workspace_id: w, website }).then((r) => r.data),
  editBrain: (w: string | null, body: Partial<Brain>) => api.patch<Brain>("/autopilot/brain", { workspace_id: w, ...body }).then((r) => r.data),
  packs: () => api.get<{ packs: Pack[] }>("/autopilot/packs").then((r) => r.data.packs),
  crew: (w?: string | null) => api.get<{ crew: Agent[]; mcp: { url: string; tools: string[] } }>("/autopilot/crew", ws(w)).then((r) => r.data),
  decisions: (w?: string | null) => api.get<Decisions>("/autopilot/decisions", ws(w)).then((r) => r.data),
  backtest: (w?: string | null) => api.get<{ tested: number; held: number; coverage: number | null; verdict: string | null; rows: any[] }>("/autopilot/backtest", ws(w)).then((r) => r.data),
  integrations: (w?: string | null) => api.get<Integrations>("/autopilot/integrations", ws(w)).then((r) => r.data),
  saveIntegrations: (w: string | null, values: Record<string, any>) => api.put<Integrations>("/autopilot/integrations", { workspace_id: w, values }).then((r) => r.data),
  digest: (w: string | null, send = false) => api.post<{ lines: string[]; sent?: any[] }>("/autopilot/digest/preview", { workspace_id: w, send }).then((r) => r.data),
  one: (id: string) => api.get<ApOne>(`/autopilot/initiatives/${id}`).then((r) => r.data),
  run: (id: string) => api.post<{ evidence: any; closed: string[]; proposed: string[] }>(`/autopilot/initiatives/${id}/run`, {}).then((r) => r.data),
  evidence: (id: string, state?: string, kind?: string) => api.get<{ evidence: Ev[]; values: Record<string, number> }>(`/autopilot/initiatives/${id}/evidence`, { params: { state, kind } }).then((r) => r.data),
  decide: (id: string, eid: string, decision: "confirm" | "reject") => api.post(`/autopilot/initiatives/${id}/evidence/${eid}/decide`, { decision }).then((r) => r.data),
  map: (id: string, kind: "ad" | "post", value: string) => api.post(`/autopilot/initiatives/${id}/evidence/map`, { kind, value }).then((r) => r.data),
  contract: (id: string, body: Record<string, any>) => api.patch<Contract>(`/autopilot/initiatives/${id}/contract`, body).then((r) => r.data),
  setPolicy: (id: string, body: Partial<Policy>) => api.put<Policy>(`/autopilot/initiatives/${id}/policy`, body).then((r) => r.data),
  actions: (id: string) => api.get<{ actions: Action[] }>(`/autopilot/initiatives/${id}/actions`).then((r) => r.data.actions),
  act: (aid: string, verb: "approve" | "dismiss" | "undo") => api.post<Action>(`/autopilot/actions/${aid}/${verb}`, {}).then((r) => r.data),
  pace: (id: string) => api.get<Pace>(`/autopilot/initiatives/${id}/pace`).then((r) => r.data),
  move: (id: string, key: string) => api.post<Action>(`/autopilot/initiatives/${id}/moves/${key}`, {}).then((r) => r.data),
  mix: (id: string) => api.get<Mix>(`/autopilot/initiatives/${id}/mix`).then((r) => r.data),
  proof: (id: string) => api.get<Proof>(`/autopilot/initiatives/${id}/proof`).then((r) => r.data),
  publish: (id: string, text: string) => api.post(`/autopilot/initiatives/${id}/learnings`, { text }).then((r) => r.data),
  banner: (id: string, file: File) => { const f = new FormData(); f.append("file", file); return api.post(`/autopilot/initiatives/${id}/banner`, f).then((r) => r.data); },
  teamsImport: (id: string, file: File) => { const f = new FormData(); f.append("file", file); return api.post(`/autopilot/initiatives/${id}/teams/import`, f).then((r) => r.data); },
  teamsPull: (id: string, organizer: string, meeting_id: string) => api.post(`/autopilot/initiatives/${id}/teams/pull`, { organizer, meeting_id }).then((r) => r.data),
  mentions: (id: string) => api.post(`/autopilot/initiatives/${id}/linkedin/mentions`, {}).then((r) => r.data),
  webinar360: (id: string) => api.get<Webinar360>(`/autopilot/initiatives/${id}/webinar360`).then((r) => r.data),
  online: (id: string) => api.get<{ tracks: { track: string; curve: { minute: number; viewers: number }[]; peak: number; avg: number; drops: any[] }[]; note: string }>(`/autopilot/initiatives/${id}/online`).then((r) => r.data),
  solo: (id: string) => api.get<{ came: number; expected: number | null; walk_ins: number; registered: number; score: number | null; lines: string[]; ready_at: string | null }>(`/autopilot/initiatives/${id}/solo-card`).then((r) => r.data),
  reportUrl: (id: string) => `/autopilot/initiatives/${id}/report.pdf`,
  report: async (id: string, name: string) => {
    const res = await api.get(`/autopilot/initiatives/${id}/report.pdf`, { responseType: "blob" });
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${(name || "initiative").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60)}-proof.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};
