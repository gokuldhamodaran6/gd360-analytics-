// 2026-10-10: Initiatives + Accounts (account-based marketing). Client for
// backend routers/initiatives.py, routers/gtm.py and routers/gtm_public.py.
import axios from "axios";
import { api, API_URL } from "./client";

export type Kind = "event" | "webinar" | "campaign" | "abm" | "hiring" | "product" | "custom";
export type Health = { state: "ok" | "watch" | "risk" | "done"; label: string };
export type Target = { key: string; label: string; target: number | null; unit: string; actual: number | null; auto: boolean; why?: string | null; pct?: number | null };

export type InitiativeSummary = {
  id: string; title: string; kind: Kind; kind_label: string; department: string | null; status: string;
  key_date: string | null; starts_on: string | null; location: string | null; days_to_go: number | null;
  targets: Target[]; tasks_total: number; tasks_done: number; overdue: number; blocked: number; health: Health;
  next_task: { id: string; title: string; due_on: string | null } | null; updated_at: string; created_at: string;
};

export type NeedsYou = {
  type: "task" | "reminder" | "surge"; id: string; title: string; initiative_id?: string | null; initiative?: string;
  due_on?: string; overdue?: boolean; remind_at?: string; account_id?: string | null; account?: string | null;
  detail?: string; tier?: string | null;
};

export type Hub = { workspace_id: string; initiatives: InitiativeSummary[]; needs_you: NeedsYou[];
  counts: { active: number; done: number; at_risk: number; accounts: number } };

export type Approval = {
  state: "none" | "submitted" | "approved" | "changes"; approver?: string; approver_email?: string | null; note?: string | null;
  requested_by?: string; requested_at?: string; decided_by?: string; decided_at?: string; decision_note?: string | null;
  version?: string | null; history?: { at: string; by: string; action: string; note?: string | null; version?: string | null }[];
};
export type Evidence = { label: string; url: string | null; version: string | null; kind: string; added_at: string };

export type Task = {
  id: string; phase_id: string | null; title: string; detail: string | null; owner_name: string | null; due_on: string | null;
  status: "todo" | "doing" | "review" | "done" | "blocked"; tool_key: string | null; position: number; origin: string;
  done_at: string | null; evidence: Evidence[]; approval: Approval | null; approval_link: string | null;
};

export type Item = {
  id: string; group: string | null; title: string; subtitle: string | null; stage: string; email: string | null;
  link: string | null; account_id: string | null; owner_name: string | null; notes: string | null; data: Record<string, any>;
  position: number; stage_changed_at: string | null;
};

export type Phase = { id: string; title: string; from: number; to: number; starts?: string; ends?: string };
export type Tool = { key: string; name: string; mode: string; category: string; does: string; why: string | null;
  status: "ready" | "connected" | "connect" | "error" | "import" | "link" | "needs_setup" };

export type TrackedLink = {
  id: string; kind: string; label: string; url: string; channel: string | null; variant: string | null; paid: boolean;
  region: string | null; logged: Record<string, number>; code: string; clicks: number; last_click_at: string | null;
  visits: number; visitors: number; accounts: number; conversions: number; conversion_rate: number | null;
  tracking: { state: "live" | "stale" | "missing"; last_seen: string | null } | null; tracked_url: string; created_at: string;
};

export type PlanRow = { key: string; label: string; state: "live" | "setup" | "manual" | "waiting" | "connected"; how: string;
  action: string | null; question?: string };
export type Connected = { id: string; name: string; kind: string; covers: string; metrics: string[]; questions: string[]; last_synced_at: string | null };
export type Breakdown = { channel: string; mode: string; region: string | null; items: number; clicks: number; visits: number;
  conversions: number; reach: number; impressions: number; engagements: number; spend: number; cost_per_conversion: number | null };
export type AB = { a: string; b: string; state: "collecting" | "winner" | "close"; winner?: string; text: string } | null;

export type CampaignRow = {
  id: string; name: string; subject: string; status: string; initiative_id?: string | null; audience?: Audience; audience_text?: string;
  scheduled_at: string | null; sent_at: string | null; error?: string | null; created_at?: string; body?: string;
  queued: number; sent: number; failed: number; skipped: number; opened: number; clicked: number; unsubscribed: number;
  open_rate: number | null; click_rate: number | null;
};

export type Audience = { tiers?: string[]; segments?: string[]; lists?: string[]; countries?: string[]; titles?: string[];
  subscribers?: boolean; initiative_id?: string; people?: "registered" | "attended" | "no_shows" | "walk_ins"; account_ids?: string[] };

export type Initiative = InitiativeSummary & {
  workspace_id: string; brief: string | null; summary: string | null; budget: number | null; details: Record<string, any>;
  scope: { regions?: string[]; channels?: string[]; note?: string | null }; phases: Phase[];
  plan_meta: { strategy?: string[]; assumptions?: string[]; learned?: string[]; roles?: Role[]; outcome?: string | null; ai?: boolean; compressed?: boolean };
  audience: Audience | null; audience_text: string | null; registration_open: boolean;
  links_public: { registration: string; walk_in: string };
  board: { label: string; stages: string[] }; tasks: Task[]; items: Item[]; tools: Tool[]; values: Record<string, number | null>;
  tracked: TrackedLink[]; ab: AB; breakdown: Breakdown[]; tracking_plan: PlanRow[]; connected_data: Connected[];
  campaigns: CampaignRow[]; email_ready: boolean; can_edit: boolean; owner: string | null;
};

export type Role = { role: string; does: string; targets: Record<string, number> };

export type PlanDraft = {
  title: string; kind: Kind; department: string | null; summary: string; strategy: string[]; key_date: string | null;
  location: string | null; budget: number | null; questions: { key: string; question: string; options: string[] }[];
  details: Record<string, string>; audience: Audience | null; targets: Target[]; phases: Phase[];
  tasks: { title: string; phase: string; offset: number; tool: string | null; detail: string | null; due_on: string; owner?: string }[];
  tools: { key: string; why: string }[]; board_items: { title: string; group: string | null; stage: string }[];
  roles: Role[]; assumptions: string[]; learned: string[]; history_count: number; ai: boolean; compressed?: boolean; starts_on?: string;
  scope?: { regions?: string[]; channels?: string[] };
};

export type Catalog = {
  kinds: Record<Kind, { label: string; department: string | null; dated: boolean; board: string; stages: string[] }>;
  tools: Record<string, { name: string; mode: string; category: string; does: string }>;
  metrics: Record<string, { label: string; unit: string; auto: boolean }>;
};

export type Update = { id: string; kind: string; text: string; channel: string | null; link: string | null; numbers: Record<string, number>;
  link_id: string | null; paid: boolean | null; region: string | null; task_id: string | null; author: string | null; occurred_at: string };

export type Today = { date: string; tiles: { label: string; value: number; source: "tracked" | "logged" }[]; updates: Update[];
  completed: { id: string; title: string; owner: string | null }[]; due: { id: string; title: string; owner: string | null }[];
  approvals: { task: string; action: string; by: string; version: string | null; at: string }[] };

export type Person = { contact_id: string | null; account_id: string | null; name: string | null; email: string | null; title: string | null;
  company: string | null; tier: string | null; registered_at: string | null; attended: boolean; walk_in: boolean; interests: string[];
  wants_meeting: boolean; note: string | null; source: string | null; subscribed: boolean };

export type Results = { targets: Target[]; values: Record<string, number | null>; series: Record<string, any>[];
  accounts: (AccountRow & { signals: number })[]; breakdown: Breakdown[]; ab: AB; update_totals: Record<string, number>; outcome: string | null };

export type MemberStats = { assigned: number; invited: number; replied: number; registered: number; attended: number; meetings: number;
  declined: number; overdue: number; untouched: number; touches: number; reply_rate: number | null; registration_rate: number | null };
export type Member = { id: string; name: string; email: string | null; role: string | null; team: string | null; targets: Record<string, number>;
  token: string; ref: string; last_update_at: string | null; stale: boolean; stats: MemberStats; links: { page: string; invite: string } };
export type TeamData = { members: Member[]; teams: ({ team: string; people: number; reply_rate: number | null } & Partial<MemberStats>)[];
  total: Partial<MemberStats>; channels: { channel: string; label: string; invited: number; replied: number; registered: number;
  reply_rate: number | null; registration_rate: number | null }[]; segments: Record<string, Record<string, number>>; roles: Role[];
  statuses: { key: string; label: string }[]; channel_options: { key: string; label: string }[] };
export type Outreach = { id: string; status: string; status_label: string; channel: string | null; touches: number; last_touch_at: string | null;
  next_step: string | null; next_step_on: string | null; overdue: boolean; notes: string | null; segment: string; member_id: string | null;
  member: string | null; account_id: string | null; account: string | null; tier: string | null; domain: string | null;
  contact_id: string | null; person: string | null; title: string | null; email: string | null; linkedin_url: string | null;
  history?: { at: string; by: string; from: string; to: string; channel: string | null; note: string | null; auto: boolean }[] };

export type AccountRow = { id: string; name: string; domain: string | null; industry: string | null; employees: number | null; revenue: number | null;
  country: string | null; city: string | null; segment: string | null; list_name: string | null; icp_score: number | null; icp_tier: string | null;
  engagement_score: number; engagement_7d: number; heat: "hot" | "warm" | "cold"; last_engaged_at: string | null; source: string | null;
  owner_name: string | null; people?: number };

export type TimelineRow = { id: string; kind: string; label: string; channel: string | null; detail: Record<string, any> | null; occurred_at: string;
  initiative_id: string | null; initiative?: string | null; account_id: string | null; account: string | null; tier: string | null;
  contact_id: string | null; contact: string | null };

export type AccountDetail = AccountRow & { linkedin_url: string | null; notes: string | null; icp_reasons: string[]; region: string | null;
  people: { id: string; name: string | null; email: string | null; title: string | null; seniority: string | null; linkedin_url: string | null;
    phone: string | null; source: string | null; subscribed: boolean; unsubscribed: boolean; persona_match: boolean; signals: number }[];
  personas: { title: string; covered: boolean; search: string }[]; timeline: TimelineRow[]; counts: Record<string, number>;
  initiatives: { id: string; title: string }[]; boards: { initiative_id: string; initiative: string; stage: string; item_id: string }[];
  reminders: { id: string; note: string; remind_at: string }[]; apollo: boolean };

export type Icp = { industries?: string[]; countries?: string[]; titles?: string[]; keywords?: string[]; exclude?: string[];
  min_employees?: number | null; max_employees?: number | null; min_revenue?: number | null; company_name?: string; sender_name?: string;
  postal_address?: string; booking_link?: string };

export type Profile = { workspace_id: string; icp: Icp; icp_set: boolean; snippet: string; site_key: string;
  tracking: { last_visit_at: string | null; live: boolean };
  connections: { provider: string; status: string; masked: string | null; last_sync_at: string | null; last_error: string | null; last_result: Record<string, number> | null }[];
  email: { configured: boolean; daily_cap: number; sent_today: number } };

export type Overview = { accounts: number; people: number; subscribers: number; tiers: Record<string, number>; engaged_30d: number;
  engaged_by_tier: Record<string, number>; visits_30d: number; meetings_30d: number;
  emails_30d: { sent: number; open_rate: number | null; click_rate: number | null }; funnel: { stage: string; n: number }[];
  weeks: Record<string, any>[]; surging: AccountRow[]; new_visitors: AccountRow[]; feed: TimelineRow[] };

export type ImportPreview = { headers: string[]; rows: number; sample: Record<string, string>[]; mapping: Record<string, string>;
  kind: "accounts" | "contacts"; capped: boolean };

const q = (o: Record<string, any>) => {
  const p = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") p.set(k, String(v)); });
  const s = p.toString();
  return s ? `?${s}` : "";
};

function form(file: File, fields: Record<string, any>): FormData {
  const f = new FormData();
  f.append("file", file);
  Object.entries(fields).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") f.append(k, typeof v === "string" ? v : String(v)); });
  return f;
}

export const initiativesApi = {
  hub: (workspace_id?: string) => api.get<Hub>(`/initiatives${q({ workspace_id })}`).then((r) => r.data),
  catalog: () => api.get<Catalog>("/initiatives/catalog").then((r) => r.data),
  draft: (body: { workspace_id?: string; brief: string; kind?: string; answers?: Record<string, string>; key_date?: string | null; previous?: PlanDraft; instruction?: string }) =>
    api.post<PlanDraft>("/initiatives/draft", body).then((r) => r.data),
  create: (body: { workspace_id?: string; brief?: string; plan: PlanDraft }) => api.post<{ id: string }>("/initiatives", body).then((r) => r.data),
  get: (id: string) => api.get<Initiative>(`/initiatives/${id}`).then((r) => r.data),
  patch: (id: string, body: Record<string, any>) => api.patch(`/initiatives/${id}`, body).then((r) => r.data),
  remove: (id: string) => api.delete(`/initiatives/${id}`).then((r) => r.data),
  addTask: (id: string, body: Partial<Task>) => api.post<Task>(`/initiatives/${id}/tasks`, body).then((r) => r.data),
  patchTask: (id: string, tid: string, body: Partial<Task>) => api.patch<Task>(`/initiatives/${id}/tasks/${tid}`, body).then((r) => r.data),
  deleteTask: (id: string, tid: string) => api.delete(`/initiatives/${id}/tasks/${tid}`).then((r) => r.data),
  addEvidence: (id: string, tid: string, body: { label?: string; url?: string; version?: string; remove_index?: number }) =>
    api.post<Task>(`/initiatives/${id}/tasks/${tid}/evidence`, body).then((r) => r.data),
  requestApproval: (id: string, tid: string, body: { approver: string; approver_email?: string; note?: string }) =>
    api.post<Task & { emailed: boolean }>(`/initiatives/${id}/tasks/${tid}/approval`, body).then((r) => r.data),
  decide: (id: string, tid: string, body: { decision: "approve" | "changes"; note?: string }) =>
    api.post<Task>(`/initiatives/${id}/tasks/${tid}/decision`, body).then((r) => r.data),
  addItem: (id: string, body: Record<string, any>) => api.post<Item>(`/initiatives/${id}/items`, body).then((r) => r.data),
  patchItem: (id: string, iid: string, body: Record<string, any>) => api.patch<Item>(`/initiatives/${id}/items/${iid}`, body).then((r) => r.data),
  deleteItem: (id: string, iid: string) => api.delete(`/initiatives/${id}/items/${iid}`).then((r) => r.data),
  importItems: (id: string, file: File, source: string, commit: boolean) =>
    api.post(`/initiatives/${id}/items/import`, form(file, { source, commit })).then((r) => r.data),
  updates: (id: string) => api.get<Update[]>(`/initiatives/${id}/updates`).then((r) => r.data),
  addUpdate: (id: string, body: Record<string, any>) => api.post<Update>(`/initiatives/${id}/updates`, body).then((r) => r.data),
  deleteUpdate: (id: string, uid: string) => api.delete(`/initiatives/${id}/updates/${uid}`).then((r) => r.data),
  today: (id: string, day?: string) => api.get<Today>(`/initiatives/${id}/today${q({ day })}`).then((r) => r.data),
  addLink: (id: string, body: Record<string, any>) => api.post<{ id: string; code: string; tracked_url: string }>(`/initiatives/${id}/links`, body).then((r) => r.data),
  patchLink: (id: string, lid: string, body: Record<string, any>) => api.patch(`/initiatives/${id}/links/${lid}`, body).then((r) => r.data),
  deleteLink: (id: string, lid: string) => api.delete(`/initiatives/${id}/links/${lid}`).then((r) => r.data),
  people: (id: string) => api.get<Person[]>(`/initiatives/${id}/people`).then((r) => r.data),
  addPerson: (id: string, body: Record<string, any>) => api.post(`/initiatives/${id}/people`, body).then((r) => r.data),
  setAttended: (id: string, cid: string, attended: boolean) => api.post(`/initiatives/${id}/people/${cid}/attended`, { attended }).then((r) => r.data),
  peopleCsv: (id: string) => api.get(`/initiatives/${id}/people.csv`, { responseType: "blob" }).then((r) => r.data as Blob),
  importPeople: (id: string, file: File, signal: string, source: string, commit: boolean) =>
    api.post(`/initiatives/${id}/import-people`, form(file, { signal, source, commit })).then((r) => r.data),
  results: (id: string) => api.get<Results>(`/initiatives/${id}/results`).then((r) => r.data),
  assistantHistory: (id: string) => api.get<{ id: string; role: string; content: string; actions: any[]; created_at: string }[]>(`/initiatives/${id}/assistant`).then((r) => r.data),
  ask: (id: string, message: string) => api.post<{ reply: string; actions: { type: string; text: string; source_id?: string; question?: string }[] }>(`/initiatives/${id}/assistant`, { message }).then((r) => r.data),
  team: (id: string) => api.get<TeamData>(`/initiatives/${id}/team`).then((r) => r.data),
  addMember: (id: string, body: Record<string, any>) => api.post<Member>(`/initiatives/${id}/team`, body).then((r) => r.data),
  patchMember: (id: string, mid: string, body: Record<string, any>) => api.patch(`/initiatives/${id}/team/${mid}`, body).then((r) => r.data),
  deleteMember: (id: string, mid: string) => api.delete(`/initiatives/${id}/team/${mid}`).then((r) => r.data),
  nudge: (id: string, mid: string) => api.post<{ emailed: boolean; message: string }>(`/initiatives/${id}/team/${mid}/nudge`).then((r) => r.data),
  newMemberLink: (id: string, mid: string) => api.post<{ page: string; invite: string }>(`/initiatives/${id}/team/${mid}/new-link`).then((r) => r.data),
  assign: (id: string, body: Record<string, any>) => api.post<{ assigned: number; skipped: number }>(`/initiatives/${id}/team/assign`, body).then((r) => r.data),
  outreach: (id: string, member_id?: string) => api.get<Outreach[]>(`/initiatives/${id}/outreach${q({ member_id })}`).then((r) => r.data),
  addOutreach: (id: string, body: Record<string, any>) => api.post(`/initiatives/${id}/outreach`, body).then((r) => r.data),
  patchOutreach: (id: string, oid: string, body: Record<string, any>) => api.patch(`/initiatives/${id}/outreach/${oid}`, body).then((r) => r.data),
  deleteOutreach: (id: string, oid: string) => api.delete(`/initiatives/${id}/outreach/${oid}`).then((r) => r.data),
  addReminder: (body: Record<string, any>) => api.post("/initiatives/reminders/new", body).then((r) => r.data),
  patchReminder: (rid: string, body: Record<string, any>) => api.patch(`/initiatives/reminders/${rid}`, body).then((r) => r.data),
};

export const gtmApi = {
  profile: (workspace_id?: string) => api.get<Profile>(`/gtm/profile${q({ workspace_id })}`).then((r) => r.data),
  saveIcp: (workspace_id: string | undefined, icp: Icp) => api.put<{ rescored: number; icp: Icp }>("/gtm/profile", { workspace_id, icp }).then((r) => r.data),
  suggestIcp: (workspace_id?: string) => api.post<{ icp: Icp; basis: string | null }>(`/gtm/profile/suggest${q({ workspace_id })}`).then((r) => r.data),
  overview: (workspace_id?: string) => api.get<Overview>(`/gtm/overview${q({ workspace_id })}`).then((r) => r.data),
  accounts: (params: Record<string, any>) => api.get<{ total: number; page: number; size: number; rows: AccountRow[];
    facets: Record<string, { value: string; n: number }[]> }>(`/gtm/accounts${q(params)}`).then((r) => r.data),
  accountsCsv: (params: Record<string, any>) => api.get(`/gtm/accounts.csv${q(params)}`, { responseType: "blob" }).then((r) => r.data as Blob),
  account: (id: string) => api.get<AccountDetail>(`/gtm/accounts/${id}`).then((r) => r.data),
  addAccount: (body: Record<string, any>) => api.post(`/gtm/accounts`, body).then((r) => r.data),
  patchAccount: (id: string, body: Record<string, any>) => api.patch(`/gtm/accounts/${id}`, body).then((r) => r.data),
  bulk: (body: Record<string, any>) => api.post(`/gtm/accounts/bulk`, body).then((r) => r.data),
  activity: (id: string, body: Record<string, any>) => api.post(`/gtm/accounts/${id}/activity`, body).then((r) => r.data),
  findPeople: (id: string) => api.post<{ found: number; added: number }>(`/gtm/accounts/${id}/find-people`).then((r) => r.data),
  contacts: (params: Record<string, any>) => api.get<{ total: number; rows: any[] }>(`/gtm/contacts${q(params)}`).then((r) => r.data),
  addContact: (body: Record<string, any>) => api.post(`/gtm/contacts`, body).then((r) => r.data),
  exportContact: (id: string) => api.get(`/gtm/contacts/${id}/export`).then((r) => r.data),
  eraseContact: (id: string) => api.delete(`/gtm/contacts/${id}`).then((r) => r.data),
  importCsv: (file: File, fields: Record<string, any>) => api.post(`/gtm/import`, form(file, fields)).then((r) => r.data),
  connect: (provider: string, workspace_id: string | undefined, key: string) => api.put<{ message: string }>(`/gtm/connections/${provider}`, { workspace_id, key }).then((r) => r.data),
  disconnect: (provider: string, workspace_id?: string) => api.delete(`/gtm/connections/${provider}${q({ workspace_id })}`).then((r) => r.data),
  sync: (provider: string, body: Record<string, any>) => api.post<{ started: boolean }>(`/gtm/connections/${provider}/sync`, body).then((r) => r.data),
  campaigns: (workspace_id?: string, initiative_id?: string) => api.get<CampaignRow[]>(`/gtm/campaigns${q({ workspace_id, initiative_id })}`).then((r) => r.data),
  createCampaign: (body: Record<string, any>) => api.post<CampaignRow>(`/gtm/campaigns`, body).then((r) => r.data),
  campaign: (id: string) => api.get<CampaignRow & { body: string; preview: { subject: string; text: string; to: string | null };
    count: { people: number; accounts: number; sample: { name: string | null; email: string; title: string | null }[] } }>(`/gtm/campaigns/${id}`).then((r) => r.data),
  patchCampaign: (id: string, body: Record<string, any>) => api.patch<CampaignRow>(`/gtm/campaigns/${id}`, body).then((r) => r.data),
  deleteCampaign: (id: string) => api.delete(`/gtm/campaigns/${id}`).then((r) => r.data),
  count: (workspace_id: string | undefined, audience: Audience) => api.post<{ people: number; accounts: number; sample: any[] }>(`/gtm/audience/count`, { workspace_id, audience }).then((r) => r.data),
  test: (id: string, to?: string) => api.post<{ to: string }>(`/gtm/campaigns/${id}/test`, { to }).then((r) => r.data),
  send: (id: string, body: { scheduled_at?: string; confirm_count?: number }) => api.post<CampaignRow>(`/gtm/campaigns/${id}/send`, body).then((r) => r.data),
  exportCampaign: (id: string) => api.get(`/gtm/campaigns/${id}/export`, { responseType: "blob" }).then((r) => r.data as Blob),
};

// public pages - no login
const pub = axios.create({ baseURL: API_URL });
export const publicGtm = {
  event: (token: string) => pub.get(`/public/gtm/e/${token}`).then((r) => r.data),
  register: (token: string, body: Record<string, any>) => pub.post(`/public/gtm/e/${token}`, body).then((r) => r.data),
  walkin: (token: string, k: string) => pub.get(`/public/gtm/w/${token}${q({ k })}`).then((r) => r.data),
  captureWalkin: (token: string, body: Record<string, any>) => pub.post(`/public/gtm/w/${token}`, body).then((r) => r.data),
  approval: (token: string) => pub.get(`/public/gtm/a/${token}`).then((r) => r.data),
  decide: (token: string, body: Record<string, any>) => pub.post(`/public/gtm/a/${token}`, body).then((r) => r.data),
  rep: (token: string) => pub.get(`/public/gtm/r/${token}`).then((r) => r.data),
  repLog: (token: string, body: Record<string, any>) => pub.post(`/public/gtm/r/${token}`, body).then((r) => r.data),
};

export function errorText(e: any, fallback = "Something went wrong. Please try again."): string {
  const d = e?.response?.data?.detail;
  if (typeof d === "string" && d.trim()) return d;
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg);
  return fallback;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
