// 2026-10-10 (round 19): clients for the Automations home (/ops), the Trust
// Center (/trust), company domains (/domains) and 2-step sign-in (/auth/mfa).
// The company-domain VIEWER (the app on data.acmeretail.com) has its own
// client in src/viewer/viewerApi.ts.
import { api, API_URL } from "./client";

// ------------------------------------------------------------ Automations --

export type OpsKind = "automation" | "alert" | "refresh" | "chain" | "sync";
export type RunStatus = "success" | "failed" | "running";

export type OpsItem = {
  key: string;
  kind: OpsKind;
  id: string;
  name: string;
  detail: string;
  sentence?: { when: string; do: string; tell: string };
  schedule: { text: string; interval: string | null; editable: boolean; options?: string[] };
  enabled: boolean;
  owner: { id: string; name: string };
  runs: { status: RunStatus; at: string | null }[];
  last_run: { status: RunStatus; at: string | null; seconds: number | null; error: string | null; value?: string | null; checked?: boolean } | null;
  next_run_at: string | null;
  running: boolean;
  can_edit: boolean;
  can_run: boolean;
  can_toggle: boolean;
  can_delete?: boolean;
  who_can_edit: string;
  link: string | null;
  approval: null | {
    status: "pending" | "approved" | "rejected";
    requested_at: string | null;
    requested_by?: string;
    note: string | null;
    external: string[];
  };
  scheduled: boolean;
  shared?: boolean;
  stale?: boolean;
  live_source?: boolean;
  last_refreshed_at?: string | null;
  sync_error?: string | null;
  steps?: any[];
  description?: string | null;
  source_ids: string[];
};

export type OpsAttention = {
  id: string;
  tone: "approval" | "failed" | "stale" | "quality" | "info";
  key?: string | null;
  keys?: string[];
  title: string;
  detail: string;
  actions: string[];
  datasource_id?: string;
};

export type OpsOverview = {
  workspace: { id: string; name: string; personal: boolean; role: string; admin: boolean; can_edit: boolean };
  space: { id: string; name: string } | null;
  tiles: {
    active: number;
    active_by_kind: Record<OpsKind, number>;
    running_now: number;
    running_names: string[];
    next_24h: number;
    next: { at: string; key: string; kind: OpsKind; name: string } | null;
    failed_24h: number;
    stale: number;
    waiting: number;
    total: number;
  };
  attention: OpsAttention[];
  timeline: { at: string; key: string; kind: OpsKind; name: string }[];
  items: OpsItem[];
  email_ready: boolean;
  generated_at: string;
};

export type OpsRun = {
  id: string;
  kind: OpsKind;
  item_id: string;
  name: string;
  reason: string;
  status: RunStatus;
  started_at: string | null;
  seconds: number | null;
  error: string | null;
  detail?: string | null;
  rows?: number | null;
  headline?: string | null;
  steps?: { index?: number; label?: string; status?: string; error?: string | null; seconds?: number | null }[];
  deliveries?: { channel: string; to: string; status: string; detail?: string | null }[];
};

const ws = (workspaceId?: string | null, extra: Record<string, unknown> = {}) => ({
  params: { ...(workspaceId ? { workspace_id: workspaceId } : {}), ...extra },
});

export const opsApi = {
  overview: (workspaceId?: string | null, spaceId?: string | null) =>
    api.get<OpsOverview>("/ops/overview", ws(workspaceId, spaceId ? { space_id: spaceId } : {})).then((r) => r.data),
  runs: (workspaceId: string | null | undefined, page = 1, kind?: string, status?: string) =>
    api
      .get<{ runs: OpsRun[]; total: number; page: number; page_size: number }>(
        "/ops/runs",
        ws(workspaceId, { page, page_size: 25, kind: kind || undefined, status: status || undefined })
      )
      .then((r) => r.data),
  itemRuns: (workspaceId: string | null | undefined, key: string) => {
    const [kind, id] = key.split(":");
    return api.get<{ item: OpsItem; runs: OpsRun[] }>(`/ops/items/${kind}/${id}/runs`, ws(workspaceId)).then((r) => r.data);
  },
  run: (workspaceId: string | null | undefined, key: string) => {
    const [kind, id] = key.split(":");
    return api.post(`/ops/items/${kind}/${id}/run`, {}, ws(workspaceId)).then((r) => r.data);
  },
  schedule: (workspaceId: string | null | undefined, items: string[], interval: string) =>
    api.post<{ changed: { key: string; name: string }[] }>("/ops/schedule", { items, interval }, ws(workspaceId)).then((r) => r.data),
  refreshAll: (workspaceId: string | null | undefined, items: string[]) =>
    api.post<{ started: string[] }>("/ops/refresh-all", { items }, ws(workspaceId)).then((r) => r.data),
  approve: (automationId: string, note?: string) => api.post(`/ops/automations/${automationId}/approve`, { note: note || null }),
  reject: (automationId: string, note?: string) => api.post(`/ops/automations/${automationId}/reject`, { note: note || null }),
};

// ----------------------------------------------------------- Trust Center --

export type TrustRisk = {
  id: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  actions: { type: string; label: string; dashboard_id?: string; datasource_id?: string; columns?: string[]; tab?: string; policy?: string; value?: unknown }[];
};

export type TrustPerson = { user_id: string; name: string; email: string; role: string; mfa: boolean; last_active: string | null; joined_at: string | null; is_me: boolean };

export type TrustSource = {
  id: string;
  name: string;
  kind: string;
  mode: string;
  owner: string;
  shared: boolean;
  who: { user_id: string; name: string; email: string; role: string }[];
  reviewed_at: string | null;
  reviewed_by: string | null;
  due_at: string | null;
  status: "never" | "overdue" | "ok";
  sensitive: { column: string; category_label: string; protected: boolean }[];
  rules: { id: string; role: string; kind: string; column: string | null; values: unknown }[];
};

export type TrustSensitive = {
  id: string;
  datasource_id: string;
  datasource: string;
  table: string | null;
  column: string;
  category: string;
  category_label: string;
  reason: string | null;
  status: "flagged" | "confirmed" | "dismissed";
  state: "dismissed" | "private" | "hidden" | "hidden_viewers" | "visible";
  protected: boolean;
  decided_by: string | null;
  decided_at: string | null;
};

export type TrustShare = {
  kind: "link" | "domain";
  dashboard_id: string;
  dashboard: string;
  level: string;
  address: string;
  custom_domain: string | null;
  custom_domain_status: string | null;
  password: boolean;
  emails: number;
  views: number;
  last_viewed_at: string | null;
  published_at: string | null;
  sensitive_source: boolean;
  owner: string;
  row_rule?: boolean;
};

export type TrustOverview = {
  workspace: { id: string; name: string; personal: boolean; role: string; owner: boolean };
  posture: { score: number; grade: string; dimensions: { key: string; label: string; score: number; detail: string }[] };
  risks: TrustRisk[];
  access: TrustSource[];
  sensitive: TrustSensitive[];
  sharing: TrustShare[];
  people: TrustPerson[];
  quality: {
    sources: { id: string; name: string; rules: number; failing: number; errors: number; passing: number; last_run_at: string | null; details: { id: string; column: string | null; type: string; status: string | null; message: string | null; failing_rows: number | null }[] }[];
    total_rules: number;
    failing: number;
  };
  policies: Policies;
  policy_labels: Record<string, string>;
  review_choices: number[];
  domain: { hostname: string; status: string; audience: string } | null;
  counts: { sources: number; audit_events: number; high: number; medium: number; low: number };
  generated_at: string;
};

export type Policies = {
  require_mfa: boolean;
  block_public_links: boolean;
  external_email_needs_approval: boolean;
  domain_publish_needs_approval: boolean;
  review_every_days: number;
};

export type AuditEvent = {
  id: string;
  at: string;
  action: string;
  label: string;
  category: string;
  actor: string;
  actor_email: string | null;
  target_type: string | null;
  target_id: string | null;
  what: string;
};

export const trustApi = {
  overview: (workspaceId?: string | null) => api.get<TrustOverview>("/trust/overview", ws(workspaceId)).then((r) => r.data),
  fix: (workspaceId: string | null | undefined, body: Record<string, unknown>) => api.post("/trust/fix", body, ws(workspaceId)).then((r) => r.data),
  setPolicies: (workspaceId: string | null | undefined, rules: Partial<Policies>) =>
    api.patch<{ rules: Policies }>("/trust/policies", { rules }, ws(workspaceId)).then((r) => r.data),
  audit: (workspaceId: string | null | undefined, opts: { page?: number; category?: string; actor_id?: string; q?: string; days?: number }) =>
    api
      .get<{ events: AuditEvent[]; total: number; page: number; page_size: number; categories: string[] }>(
        "/trust/audit",
        ws(workspaceId, { page: opts.page || 1, page_size: 30, category: opts.category || undefined, actor_id: opts.actor_id || undefined, q: opts.q || undefined, days: opts.days || undefined })
      )
      .then((r) => r.data),
  download: async (workspaceId: string | null | undefined, what: "audit.csv" | "evidence.zip", extra: Record<string, unknown> = {}) => {
    const res = await api.get(`/trust/${what}`, { ...ws(workspaceId, extra), responseType: "blob" });
    const cd = String(res.headers["content-disposition"] || "");
    const name = /filename="([^"]+)"/.exec(cd)?.[1] || `gd360-${what}`;
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },
  privacyLookup: (workspaceId: string | null | undefined, email: string) =>
    api
      .get<{ email: string; contacts: { id: string; name: string | null; email: string; title: string | null; phone: boolean; subscribed: boolean; unsubscribed: boolean; engagements: number; consent_records: number; created_at: string | null }[]; is_member: boolean; domain_views: number }>(
        "/trust/privacy/lookup",
        ws(workspaceId, { email })
      )
      .then((r) => r.data),
  privacyHistory: (workspaceId?: string | null) =>
    api.get<{ requests: AuditEvent[]; consent_records: number }>("/trust/privacy/history", ws(workspaceId)).then((r) => r.data),
  exportContact: (id: string) => api.get(`/gtm/contacts/${id}/export`).then((r) => r.data),
  eraseContact: (id: string) => api.delete(`/gtm/contacts/${id}`).then((r) => r.data),
  setRole: (workspaceId: string | null | undefined, userId: string, role: string) =>
    api.patch(`/trust/people/${userId}`, { role }, ws(workspaceId)).then((r) => r.data),
};

// ------------------------------------------------------- Company domains --

export type DomainRecord = { type: "CNAME" | "TXT"; name: string; host: string; value: string; ok: boolean; purpose: string };

export type CompanyDomain = {
  id: string;
  hostname: string;
  status: "pending_dns" | "pending_ssl" | "live" | "error";
  url: string;
  records: DomainRecord[];
  cname_target: string;
  last_error: string | null;
  last_checked_at: string | null;
  verified_at: string | null;
  live_at: string | null;
  created_at: string | null;
  audience: "company" | "invited" | "public";
  allowed_email_domains: string[];
  invited_emails: string[];
  site_title: string;
  default_title: string;
  show_powered_by: boolean;
  has_logo: boolean;
  publish_needs_approval: boolean;
  dns_seen?: { cname: string[]; txt: string[] };
};

export type RowRule = {
  column: string;
  by_email: Record<string, (string | number)[]>;
  by_domain: Record<string, (string | number)[]>;
  default: "none" | "all" | (string | number)[];
};

export type Publication = {
  id: string;
  dashboard_id: string;
  dashboard: string;
  title: string;
  path: string;
  url: string;
  audience: "domain" | "invited" | "members";
  invited_emails: string[];
  row_rule: RowRule | null;
  row_rule_text: string | null;
  status: "live" | "pending" | "rejected" | "removed";
  requested_by: string | null;
  requested_at: string | null;
  request_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  published_at: string | null;
  views: number;
  viewers_30d: number;
  last_viewed_at: string | null;
  subscribers: number;
};

export type AccessRequest = { id: string; publication_id: string; title: string; path: string; email: string; name: string; note: string | null; status: string; created_at: string | null };

export type DomainPage = {
  workspace: { id: string; name: string; personal: boolean };
  role: string;
  can_manage: boolean;
  cname_target: string;
  suggested_email_domains: string[];
  publish_needs_approval: boolean;
  domain: CompanyDomain | null;
  publications: Publication[];
  requests: Publication[];
  access_requests: AccessRequest[];
};

export type PublishState = {
  dashboard: { id: string; name: string; warehouse_native: boolean };
  workspace: { id: string; name: string; personal: boolean } | null;
  in_workspace: boolean;
  role: string | null;
  can_manage: boolean;
  mode: "direct" | "request" | "none";
  domain: CompanyDomain | null;
  publication: Publication | null;
  suggested_path: string | null;
  columns: Record<string, string[]>;
  sensitive_columns: { column: string; category: string }[];
  member_count: number;
};

export type PublishInput = {
  dashboard_id: string;
  path: string;
  title?: string | null;
  audience: "domain" | "invited" | "members";
  invited_emails?: string[];
  row_rule?: RowRule | null;
  note?: string | null;
};

export const domainsApi = {
  get: (workspaceId: string) => api.get<DomainPage>("/domains", ws(workspaceId)).then((r) => r.data),
  add: (workspaceId: string, hostname: string) => api.post<CompanyDomain>("/domains", { workspace_id: workspaceId, hostname }).then((r) => r.data),
  check: (id: string) => api.post<CompanyDomain>(`/domains/${id}/check`).then((r) => r.data),
  remove: (id: string) => api.delete(`/domains/${id}`).then((r) => r.data),
  update: (id: string, patch: Partial<{ audience: string; allowed_email_domains: string[]; invited_emails: string[]; site_title: string; show_powered_by: boolean; publish_needs_approval: boolean }>) =>
    api.patch<CompanyDomain>(`/domains/${id}`, patch).then((r) => r.data),
  uploadLogo: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return api.post<CompanyDomain>(`/domains/${id}/logo`, fd).then((r) => r.data);
  },
  removeLogo: (id: string) => api.delete<CompanyDomain>(`/domains/${id}/logo`).then((r) => r.data),
  logoBlobUrl: async (id: string) => {
    const r = await api.get(`/domains/${id}/logo`, { responseType: "blob" });
    return URL.createObjectURL(r.data as Blob);
  },
  pathAvailable: (id: string, path: string, publicationId?: string) =>
    api.get<{ path: string; available: boolean; reason: string | null }>(`/domains/${id}/path-available`, { params: { path, publication_id: publicationId } }).then((r) => r.data),
  forDashboard: (dashboardId: string) => api.get<PublishState>(`/domains/for-dashboard/${dashboardId}`).then((r) => r.data),
  publish: (domainId: string, body: PublishInput) => api.post<Publication>(`/domains/${domainId}/publications`, body).then((r) => r.data),
  updatePublication: (pubId: string, body: PublishInput) => api.patch<Publication>(`/domains/publications/${pubId}`, body).then((r) => r.data),
  approve: (pubId: string, note?: string) => api.post<Publication>(`/domains/publications/${pubId}/approve`, { note: note || null }).then((r) => r.data),
  decline: (pubId: string, note?: string) => api.post<Publication>(`/domains/publications/${pubId}/decline`, { note: note || null }).then((r) => r.data),
  unpublish: (pubId: string) => api.delete(`/domains/publications/${pubId}`).then((r) => r.data),
  viewers: (pubId: string) =>
    api.get<{ days: number; viewers: { email: string | null; views: number; last_viewed_at: string | null }[] }>(`/domains/publications/${pubId}/viewers`).then((r) => r.data),
  decideAccess: (reqId: string, decision: "approve" | "decline") => api.post<AccessRequest>(`/domains/access-requests/${reqId}/${decision}`).then((r) => r.data),
};

// ------------------------------------------------------------- 2-step ----

export const mfaApi = {
  status: () => api.get<{ enabled: boolean; enabled_at: string | null; recovery_codes_left: number }>("/auth/mfa").then((r) => r.data),
  setup: () => api.post<{ secret: string; uri: string; qr_svg: string | null }>("/auth/mfa/setup").then((r) => r.data),
  enable: (code: string) => api.post<{ enabled: boolean; recovery_codes: string[] }>("/auth/mfa/enable", { code }).then((r) => r.data),
  disable: (password: string) => api.post("/auth/mfa/disable", { password }).then((r) => r.data),
  newCodes: (password: string) => api.post<{ recovery_codes: string[] }>("/auth/mfa/recovery-codes", { password }).then((r) => r.data),
  me: () => api.get<{ mfa_enabled?: boolean; mfa_setup_required?: boolean; email_verified?: boolean }>("/auth/me").then((r) => r.data),
};

export function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

export { API_URL };
