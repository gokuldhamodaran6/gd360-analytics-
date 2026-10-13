// 2026-10-13 (round 42): Event OS - one event tracked before, during and
// after. Client for backend routers/eventos.py and eventos_public.py.
import axios from "axios";
import { api, API_URL } from "./client";

export type Truth = "counted" | "matched" | "reported" | "modelled" | "tested";
export type Phase = "before" | "during" | "after" | "done";
export type Kpi = { key: string; label: string; value: number | null; unit: string; truth: Truth; sub?: string | null };

export type Windows = { open: string | null; start: string | null; end: string | null; close: string | null;
  start_local: string | null; end_local: string | null; timezone: string; post_days: number };
export type EventHead = { id: string; title: string; kind: string; format: string; format_label: string; mode: string;
  location: string | null; capacity: number | null; fire_limit: number | null; code: string | null; windows: Windows;
  phase_now: Phase; days_to_go: number | null; sample: boolean; currency: string; online: boolean; physical: boolean; status: string };
export type Links = { registration: string; staff: string; share: string | null; share_enabled: boolean; survey: string; walk_in: string };

export type Goal = { id: string; owner_name: string; owner_role: string | null; owner_email: string | null; label: string; metric: string;
  metric_label: string; unit: string; target: number; low: number; high: number; weight: number; lower_is_better: boolean; safety: boolean;
  actual: number | null; actual_typed: number | null; truth: Truth; score: number | null; meets: boolean | null; final: boolean; so_far: boolean;
  signed: boolean; signed_at: string | null; signed_by: string | null; version: number; history: { at: string; by: string; change: string }[];
  sign_token: string; likelihood?: number | null };
export type Sim = { median: number | null; p10: number | null; p90: number | null; hist: number[]; below40?: number; odds70: number | null;
  goals: Record<string, number>; runs?: number } | null;
export type ScoreBlock = { goals: Goal[]; now: { score: number | null; confidence: number | null; coverage: number; capped: boolean };
  predicted: Sim; history: { date: string; score: number; phase: string }[]; truth_mix: Record<string, number>; signed: number; total: number };
export type Action = { id: string; key: string; agent: string; phase: string | null; title: string; detail: string | null; impact: string | null;
  state: "proposed" | "done" | "dismissed"; can_do: boolean; result: string | null; decided_by: string | null; decided_at: string | null; created_at: string };
export type Daily = { date: string; registrations: number; checkins: number; mentions: number; spend: number; phase: Phase | null };
export type Channel = { channel: string; registrations: number; icp: number; icp_known: number; came: number; spend: number; icp_share: number | null;
  cost_per_icp: number | null; cost_per_reg: number | null; show_rate: number | null };
export type Check = { key: string; label: string; ok: boolean; fix: string };
type Base = { links: Links; can_edit: boolean };

export type Overview = Base & { event: EventHead; score: ScoreBlock; kpis: Record<"before" | "during" | "after", Kpi[]>; daily: Daily[];
  funnel: { stage: string; value: number; truth: Truth }[]; channels: Channel[]; currency: string; setup: { checks: Check[]; ready: number };
  actions: Action[]; values: Record<string, number | null> };
export type Forecast = { done: boolean; final: number | null; median: number | null; p10: number | null; p90: number | null; k: number | null;
  basis: string; note?: string; curve: { date: string; median: number; lo: number; hi: number }[] } | null;
export type Growth = Base & { event: EventHead; cumulative: { date: string; actual: number; phase: Phase | null }[]; forecast: Forecast;
  target: number | null; odds: number | null; funnel: { stage: string; value: number }[]; channels: Channel[];
  ads: { campaigns: { platform: string; campaign: string; how: string; spend: number; clicks: number; impressions: number }[]; unmatched: any[]; sources: any[]; total: number };
  kpis: Kpi[]; spark: number[]; actions: Action[]; currency: string };
export type Mention = { id: string; platform: string; author: string | null; author_kind: string | null; url: string | null; text: string;
  media_url: string | null; posted_at: string | null; reach: number | null; engagements: number | null; matched_by: string | null;
  confidence: number | null; why: string | null; state: "auto" | "review" | "confirmed" | "rejected"; sentiment: string | null; phase: Phase | null };
export type Buzz = Base & { event: EventHead; counts: Record<"before" | "during" | "after", number>; total: number; review: number;
  reach: number | null; engagements: number | null; positive_share: number | null; sentiment: Record<string, number>; kinds: Record<string, number>;
  platforms: Record<string, number>; matched_by: Record<string, number>;
  days: { date: string; phase: Phase | null; attendee: number; speaker: number; own: number; press: number }[];
  voices: { kind: string; posts: number; reach: number }[]; items: Mention[]; items_total: number; complaints: Mention[];
  scan: any; last_scan_at: string | null; attendee_posters: number; attendees: number; matched_to_ticket: number };
export type Demand = Base & { event: EventHead; showup: { bins: number[]; groups: { group: string; people: number; will_come: number; came: number }[];
  expected: number; registered: number; rate: number | null; likely_no: number; undecided: number; coming: number; walkins_expected: number; model: string };
  forecast: Forecast; predicted_attendance: number; icp_predicted: number | null; capacity: number | null; fire_limit: number | null;
  accounts: { target: number; covered: number; missing: number } | null; seniority: { label: string; n: number }[]; cities: { label: string; n: number }[];
  meetings_booked: number; actions: Action[] };
export type Zone = { id: string; name: string; capacity: number | null; outside?: boolean; now: number | null; pct: number | null; at: string | null };
export type SessionRow = { id: string; title: string; speaker: string | null; room: string | null; track: string | null; starts_at: string | null;
  ends_at: string | null; capacity: number | null; online: boolean; in_room: number; fill: number | null; online_peak: number | null; rating: number | null; ratings: number };
export type Live = Base & { event: EventHead; kpis: Kpi[]; arrivals: { t: string; actual: number | null; plan: number }[]; zones: Zone[];
  sessions: SessionRow[]; queue: { at: string; zone: string; minutes: number }[]; stream: { at: string; viewers: number; minute: number | null; session_id: string | null }[];
  feed: { at: string; kind: string; who: string; company: string | null; tier: string; gate: string | null; icp: boolean | null }[]; actions: Action[] };
export type SponsorRow = { id: string; name: string; tier: string | null; booth: string | null; goal: number | null; leads: number; hot: number;
  pct: number | null; visits: number; dwell_min: number | null; renewal: string; amount: number | null; contact_email: string | null; report_link: string; scan_link: string };
export type Sponsors = Base & { event: EventHead; sponsors: SponsorRow[]; total_leads: number; avg: number | null; renewing: number; seniority: { label: string; n: number }[] };
export type Report = Base & { event: EventHead; score: ScoreBlock; values: Record<string, number | null>; costs: { label: string; amount: number; channel?: string | null; kind?: string }[];
  income: { label: string; amount: number }[]; deals: { deals: any[]; sourced: number; influenced: number; won: number; sourced_n: number; influenced_n: number; won_n: number; sources: any[] };
  channels: Channel[]; drivers: { label: string; owner: string; delta: number; score: number; actual: number; target: number; unit: string }[];
  learnings: { kind: string; title: string; proof: string }[]; sessions: SessionRow[]; sponsors: SponsorRow[]; currency: string;
  buzz: { before: number | null; during: number | null; after: number | null; reach: number | null; positive_share: number | null } };
export type Config = { format: string; mode: string; starts_at: string | null; ends_at: string | null; timezone: string | null; capacity: number | null;
  fire_limit: number | null; post_window_days: number; code: string | null; hashtags: string[]; keywords: string[]; promo_codes: string[];
  handles: Record<string, string[]>; ad_campaigns: string[]; zones: { id: string; name: string; capacity: number | null; outside?: boolean }[];
  share_enabled: boolean; costs: { label: string; amount: number; channel?: string | null }[]; income: { label: string; amount: number }[];
  prices: Record<string, number>; currency: string; win_rate: number; city: string | null; join_url: string | null; zoom_secret_set: boolean;
  sample: boolean; naming_rule: string };
export type ConfigData = Base & { config: Config; event: EventHead; checks: Check[]; ads: { campaigns: any[]; unmatched: any[]; sources: any[]; total: number };
  assets: { id: string; kind: string; label: string | null; url: string }[]; scan: any; last_scan_at: string | null;
  social_rules: { tags: string[]; codes: string[]; title: string; keywords: string[] } };
export type GoalsData = Base & ScoreBlock & { event: EventHead; suggested: any[]; metrics: Record<string, { label: string; unit: string; truth: Truth; phase: string; higher: boolean }>; sign_base: string };
export type Ticket = { id: string; code: string; name: string | null; email: string | null; company: string | null; title: string | null; tier: string;
  icp: boolean | null; source: string | null; status: string; walk_in: boolean; registered_at: string | null; checked_in_at: string | null;
  show_prob: number | null; gate: string | null; confirmed: boolean; online_minutes: number | null; engagement: number | null };

const p = (id: string, rest: string) => `/initiatives/${id}/eventos/${rest}`;

export const eventApi = {
  sample: (stage: "before" | "live" | "done", workspace_id?: string | null) =>
    api.post<{ id: string }>("/initiatives/eventos/sample", { stage, workspace_id }).then((r) => r.data),
  overview: (id: string) => api.get<Overview>(p(id, "overview")).then((r) => r.data),
  growth: (id: string) => api.get<Growth>(p(id, "growth")).then((r) => r.data),
  buzz: (id: string, q: { phase?: string; state?: string; platform?: string; limit?: number; offset?: number } = {}) =>
    api.get<Buzz>(p(id, "buzz"), { params: q }).then((r) => r.data),
  scan: (id: string) => api.post(p(id, "buzz/scan")).then((r) => r.data),
  addPost: (id: string, url: string, author_kind?: string, author?: string) =>
    api.post<Mention>(p(id, "buzz/link"), { url, author_kind, author }).then((r) => r.data),
  patchMention: (id: string, mid: string, body: { state?: string; author_kind?: string; sentiment?: string }) =>
    api.patch(p(id, `mentions/${mid}`), body).then((r) => r.data),
  demand: (id: string) => api.get<Demand>(p(id, "demand")).then((r) => r.data),
  live: (id: string) => api.get<Live>(p(id, "live")).then((r) => r.data),
  sponsors: (id: string) => api.get<Sponsors>(p(id, "sponsors")).then((r) => r.data),
  addSponsor: (id: string, body: any) => api.post(p(id, "sponsors"), body).then((r) => r.data),
  patchSponsor: (id: string, sid: string, body: any) => api.patch(p(id, `sponsors/${sid}`), body).then((r) => r.data),
  deleteSponsor: (id: string, sid: string) => api.delete(p(id, `sponsors/${sid}`)).then((r) => r.data),
  sponsorReport: (id: string, sid: string) => api.get(p(id, `sponsors/${sid}/report`)).then((r) => r.data),
  report: (id: string) => api.get<Report>(p(id, "report")).then((r) => r.data),
  exportXlsx: async (id: string, sections: string[], mask: boolean, title: string) => {
    const r = await api.get(p(id, "export.xlsx"), { params: { sections: sections.join(","), mask }, responseType: "blob" });
    const url = URL.createObjectURL(r.data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event"}-A-to-Z.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  },
  config: (id: string) => api.get<ConfigData>(p(id, "config")).then((r) => r.data),
  patchConfig: (id: string, body: Partial<Config> & { zoom_secret?: string }) => api.patch(p(id, "config"), body).then((r) => r.data),
  newLinks: (id: string, which: "staff" | "share") => api.post(p(id, "config/new-links"), null, { params: { which } }).then((r) => r.data),
  goals: (id: string) => api.get<GoalsData>(p(id, "goals")).then((r) => r.data),
  addGoal: (id: string, body: any) => api.post(p(id, "goals"), body).then((r) => r.data),
  addSuggested: (id: string) => api.post(p(id, "goals/suggested")).then((r) => r.data),
  patchGoal: (id: string, gid: string, body: any) => api.patch(p(id, `goals/${gid}`), body).then((r) => r.data),
  deleteGoal: (id: string, gid: string) => api.delete(p(id, `goals/${gid}`)).then((r) => r.data),
  signGoal: (id: string, gid: string) => api.post(p(id, `goals/${gid}/sign`)).then((r) => r.data),
  sessions: (id: string) => api.get<{ sessions: SessionRow[] }>(p(id, "sessions")).then((r) => r.data),
  addSession: (id: string, body: any) => api.post(p(id, "sessions"), body).then((r) => r.data),
  patchSession: (id: string, sid: string, body: any) => api.patch(p(id, `sessions/${sid}`), body).then((r) => r.data),
  deleteSession: (id: string, sid: string) => api.delete(p(id, `sessions/${sid}`)).then((r) => r.data),
  addAsset: (id: string, file: File, kind: string) => {
    const f = new FormData();
    f.append("file", file);
    f.append("kind", kind);
    f.append("label", file.name);
    return api.post(p(id, "assets"), f).then((r) => r.data);
  },
  deleteAsset: (id: string, aid: string) => api.delete(p(id, `assets/${aid}`)).then((r) => r.data),
  actions: (id: string) => api.get<{ actions: Action[] }>(p(id, "actions")).then((r) => r.data),
  decide: (id: string, aid: string, decision: "approve" | "dismiss") => api.post<Action>(p(id, `actions/${aid}/${decision}`)).then((r) => r.data),
  tickets: (id: string, q: { q?: string; status?: string; limit?: number; offset?: number } = {}) =>
    api.get<{ total: number; tickets: Ticket[] }>(p(id, "tickets"), { params: q }).then((r) => r.data),
  addTicket: (id: string, body: any) => api.post<Ticket>(p(id, "tickets"), body).then((r) => r.data),
  ticketOp: (id: string, tid: string, op: "checkin" | "undo" | "cancel" | "confirm") => api.post<Ticket>(p(id, `tickets/${tid}/${op}`)).then((r) => r.data),
  importAttendance: (id: string, file: File, session_id?: string) => {
    const f = new FormData();
    f.append("file", file);
    if (session_id) f.append("session_id", session_id);
    return api.post(p(id, "import/attendance"), f).then((r) => r.data);
  },
  addTouch: (id: string, body: any) => api.post(p(id, "touches"), body).then((r) => r.data),
  putLearnings: (id: string, learnings: any[]) => api.put(p(id, "learnings"), { learnings }).then((r) => r.data),
  clone: (id: string, title: string, key_date?: string) => api.post<{ id: string }>(p(id, "clone"), { title, key_date }).then((r) => r.data),
};

// ------------------------------------------------------------- public ---
export const pub = axios.create({ baseURL: API_URL });
const pp = (rest: string) => `/public/eventos/${rest}`;

export const publicEvent = {
  staff: (token: string, k: string) => pub.get(pp(`staff/${token}`), { params: { k } }).then((r) => r.data),
  search: (token: string, k: string, q: string) => pub.get(pp(`staff/${token}/search`), { params: { k, q } }).then((r) => r.data),
  checkin: (token: string, body: any) => pub.post(pp(`staff/${token}/checkin`), body).then((r) => r.data),
  walkin: (token: string, body: any) => pub.post(pp(`staff/${token}/walkin`), body).then((r) => r.data),
  lead: (token: string, body: any) => pub.post(pp(`staff/${token}/lead`), body).then((r) => r.data),
  session: (token: string, body: any) => pub.post(pp(`staff/${token}/session`), body).then((r) => r.data),
  count: (token: string, body: any) => pub.post(pp(`staff/${token}/count`), body).then((r) => r.data),
  sync: (token: string, k: string, items: any[]) => pub.post(pp(`staff/${token}/sync`), { k, items }).then((r) => r.data),
  ocr: (token: string, k: string, file: Blob) => {
    const f = new FormData();
    f.append("k", k);
    f.append("file", file, "card.jpg");
    return pub.post(pp(`staff/${token}/ocr`), f).then((r) => r.data);
  },
  ticket: (code: string) => pub.get(pp(`ticket/${code}`)).then((r) => r.data),
  sponsor: (token: string) => pub.get(pp(`sp/${token}`)).then((r) => r.data),
  renew: (token: string, decision: string, name?: string) => pub.post(pp(`sp/${token}/renew`), { decision, name }).then((r) => r.data),
  survey: (token: string, t?: string | null) => pub.get(pp(`f/${token}`), { params: { t } }).then((r) => r.data),
  answer: (token: string, body: any) => pub.post(pp(`f/${token}`), body).then((r) => r.data),
  shared: (token: string) => pub.get<Overview>(pp(`x/${token}`)).then((r) => r.data),
  goal: (token: string) => pub.get(pp(`goal/${token}`)).then((r) => r.data),
  sign: (token: string, name: string) => pub.post(pp(`goal/${token}/sign`), { name }).then((r) => r.data),
};

export const assetUrl = (path: string) => (path.startsWith("/public/") ? `${API_URL}${path}` : path);

export function errText(e: any, fallback = "Something went wrong - try again."): string {
  const d = e?.response?.data?.detail;
  if (typeof d === "string") return d;
  if (e?.message === "Network Error") return "No connection - it will be saved and sent when you're back online.";
  return fallback;
}
