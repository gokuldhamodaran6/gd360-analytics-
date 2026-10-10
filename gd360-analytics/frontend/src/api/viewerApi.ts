// 2026-10-10 (round 19): the client the company-domain viewer uses (the app
// opened at data.acmeretail.com). Its own axios instance: the viewer's
// GD360 token lives in this origin's localStorage, and a 401 here means
// "show the sign-in card", never "go to /login" like the app's instance.
import axios from "axios";
import {
  API_URL, normalizeErrorDetail, publicRunBody,
  type ColumnDistinctValue, type FilterCriterion, type FilteredBlock, type ParameterOptions, type PublicDashboard, type RunPageRequest, type RunPageResponse,
} from "./client";
import type { ColorRegistry } from "../dashboard/theme/appearance";

const TOKEN_KEY = "gd360_token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}
export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the session lasts for this tab only */
  }
}

const http = axios.create({ baseURL: API_URL });
http.interceptors.request.use((config) => {
  const t = getToken();
  if (t) config.headers = { ...(config.headers || {}), Authorization: `Bearer ${t}` } as any;
  return config;
});
http.interceptors.response.use(
  (r) => r,
  (err) => {
    normalizeErrorDetail(err);
    return Promise.reject(err);
  }
);

export type Site = {
  hostname: string;
  title: string;
  workspace_name: string;
  has_logo: boolean;
  show_powered_by: boolean;
  audience: "company" | "invited" | "public";
  email_domains: string[];
  sign_in: { password: boolean; email_code: boolean };
};

export type Me = { id: string; email: string; name: string; email_verified: boolean; member_role: string | null };

export type Reason = "" | "sign_in" | "verify_email" | "not_allowed" | "members_only" | "gone";

export type HomeOut = {
  site: Site;
  me: Me | null;
  can_open_site: boolean;
  reason: Reason;
  dashboards: { path: string; title: string; updated_at: string | null; published_at: string | null; pages: number; subscribed: boolean; personal_view: boolean; audience: string }[];
  pending_requests: { path: string; title: string; asked_at: string | null }[];
};

export type DashOut = {
  site: Site;
  me: Me | null;
  path: string;
  title: string;
  access: { ok: boolean; reason: Reason; message: string; request: { status: string; at: string | null } | null; can_request: boolean };
  subscribed: boolean;
  view: { personal: boolean; column?: string; values?: (string | number)[]; hidden_blocks?: number };
  published_at: string | null;
  updated_at: string | null;
  dashboard: PublicDashboard | null;
};

export type TokenOut = { access_token: string; mfa_required?: boolean; mfa_token?: string | null; user: { email: string } };

const enc = encodeURIComponent;

export const viewerApi = {
  site: (host: string) => http.get<{ kind: "org" | "legacy" | "none"; site?: Site }>("/viewer/site", { params: { host } }).then((r) => r.data),
  logoUrl: (host: string) => `${API_URL}/viewer/${enc(host)}/logo`,
  brandingUrl: (host: string, path: string, kind: "logo" | "background") => `${API_URL}/viewer/${enc(host)}/d/${enc(path)}/branding/${kind}`,
  home: (host: string) => http.get<HomeOut>(`/viewer/${enc(host)}/home`).then((r) => r.data),
  dashboard: (host: string, path: string) => http.get<DashOut>(`/viewer/${enc(host)}/d/${enc(path)}`).then((r) => r.data),
  run: (host: string, path: string, pageId: string, req: RunPageRequest, signal?: AbortSignal) =>
    http.post<RunPageResponse>(`/viewer/${enc(host)}/d/${enc(path)}/pages/${pageId}/run`, publicRunBody(req), { signal }).then((r) => r.data),
  options: (host: string, path: string, paramId: string, opts: { search?: string; limit?: number }, signal?: AbortSignal) =>
    http.get<ParameterOptions>(`/viewer/${enc(host)}/d/${enc(path)}/parameters/${paramId}/options`, { params: { search: opts.search || undefined, limit: opts.limit || undefined }, signal }).then((r) => r.data),
  preview: (host: string, path: string, pageId: string, filters: FilterCriterion[], blockFilters: Record<string, FilterCriterion[]> | undefined) =>
    http
      .post<{ blocks: FilteredBlock[]; matched_rows: number | null; colors?: ColorRegistry | null }>(`/viewer/${enc(host)}/d/${enc(path)}/pages/${pageId}/preview-filtered`, { filters, block_filters: blockFilters || {} })
      .then((r) => ({ blocks: r.data.blocks, matchedRows: r.data.matched_rows, colors: r.data.colors || null })),
  filterOptions: (host: string, path: string, pageId: string, column: string) =>
    http.get<{ values: ColumnDistinctValue[]; dtype: string }>(`/viewer/${enc(host)}/d/${enc(path)}/pages/${pageId}/filter-options`, { params: { column } }).then((r) => r.data),
  askAccess: (host: string, path: string, note: string) => http.post<{ status: string; at?: string }>(`/viewer/${enc(host)}/d/${enc(path)}/access-request`, { note: note || null }).then((r) => r.data),
  subscribe: (host: string, path: string) =>
    http.post<{ subscribed: boolean; next_send_at: string; timezone: string }>(`/viewer/${enc(host)}/d/${enc(path)}/subscribe`, {
      timezone: (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch {
          return "UTC";
        }
      })(),
    }).then((r) => r.data),
  unsubscribe: (host: string, path: string) => http.delete(`/viewer/${enc(host)}/d/${enc(path)}/subscribe`).then((r) => r.data),

  // sign-in - the same GD360 accounts as the app
  captcha: () => http.get<{ captcha_id: string; question: string }>("/auth/captcha").then((r) => r.data),
  login: (email: string, password: string) => http.post<TokenOut>("/auth/login", { email, password }).then((r) => r.data),
  loginMfa: (mfaToken: string, code: string) => http.post<TokenOut>("/auth/login/mfa", { mfa_token: mfaToken, code }).then((r) => r.data),
  register: (b: { email: string; password: string; full_name: string; captcha_id: string; captcha_answer: string }) => http.post<TokenOut>("/auth/register", b).then((r) => r.data),
  codeRequest: (email: string, host: string) => http.post("/auth/code/request", { email, host }).then((r) => r.data),
  codeVerify: (email: string, code: string, host: string, full_name?: string) => http.post<TokenOut>("/auth/code/verify", { email, code, host, full_name: full_name || null }).then((r) => r.data),
  verifyEmailRequest: (host: string) => http.post("/auth/verify-email/request", {}, { headers: { "X-GD360-Host": host } }).then((r) => r.data),
  verifyEmailConfirm: (code: string) => http.post("/auth/verify-email/confirm", { code }).then((r) => r.data),
};
