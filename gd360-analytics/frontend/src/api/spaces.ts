// 2026-10-09 (round 15): Spaces (groups of sources one team works from),
// the connector catalog, app sign-in and the Space overview (channel hub).
// Backend: routers/spaces.py, routers/apps.py.
import { api } from "./client";

export type SpaceAccess = "private" | "workspace" | "members";

export type SpaceSource = {
  id: string;
  name: string;
  kind: string;
  label: string;
  last_synced_at: string | null;
  sync_error: string | null;
  mode: "synced" | "live" | "file";
};

export type Space = {
  id: string;
  name: string;
  color: string;
  description: string | null;
  icon: string | null;
  access: SpaceAccess;
  member_ids: string[];
  workspace_id: string | null;
  owner_id: string;
  can_edit: boolean;
  source_ids: string[];
  sources: SpaceSource[];
  stats: { sources: number; dashboards: number; projects: number };
  fresh: { status: "ok" | "warning" | "syncing"; text: string; last_synced_at?: string | null };
  created_at: string;
  updated_at?: string;
};

export type SpaceInput = {
  name?: string;
  color?: string;
  description?: string | null;
  icon?: string | null;
  access?: SpaceAccess;
  member_ids?: string[];
  source_ids?: string[];
  workspace_id?: string | null;
};

export type OverviewKpi = {
  key: "audience" | "reach" | "engagement_rate" | "sessions" | "ad_spend" | "roas" | "search_clicks" | "store_revenue";
  label: string;
  value: number | null;
  display: string;
  previous: number | null;
  previous_display?: string | null;
  delta_pct: number | null;
  delta_points?: number | null;
  source_note: string | null;
  available: boolean;
};

export type OverviewChannel = {
  source_id: string;
  name: string;
  kind: string;
  label: string;
  group: "Organic" | "Paid" | "Web" | "Search" | "Store" | "Email";
  audience: number | null;
  audience_growth: number | null;
  audience_growth_pct: number | null;
  reach: number | null;
  reach_previous: number | null;
  reach_delta_pct: number | null;
  impressions: number | null;
  engagements: number | null;
  engagement_rate: number | null;
  clicks: number | null;
  spend: number | null;
  revenue: number | null;
  roas: number | null;
  sessions: number | null;
  orders: number | null;
  video_views: number | null;
};

export type SpaceOverview = {
  space: { id: string; name: string; color: string };
  period: { days: number; start: string; end: string; previous_start: string; previous_end: string };
  kpis: OverviewKpi[];
  channels: OverviewChannel[];
  weekly: { week_start: string; organic_reach: number | null; paid_reach: number | null }[];
  top_posts: { source_id: string; kind: string; account: string | null; text: string | null; url: string | null; type: string | null; posted_at: string | null; reach: number | null; engagements: number | null; engagement_rate: number | null; video_views: number | null }[];
  queries: { query: string; clicks: number; impressions: number; ctr: number | null; position: number | null }[];
  missing: string[];
  sources_used: string[];
  tables: { source_id: string; source: string; kind: string; table: string; rows: number | null; synced_at: string | null }[];
  fresh: { status: string; text: string };
};

export type CatalogCategory = { id: string; label: string; description: string };

export type CatalogConnector = {
  id: string;
  slug: string;
  label: string;
  category: string;
  summary: string;
  status: "connected" | "live" | "next";
  // "app:<kind>" | "database:<kind>" | "warehouse:<kind>" | "file" | "sheets" | "api" | "streaming" | "request"
  flow: string;
  kind: string | null;
  auth: "oauth" | "token" | "form";
  oauth_provider: string | null;
  oauth_ready: boolean;
  is_new: boolean;
  monogram: string;
  color: string;
  ink: string;
  ring: string | null;
  suggested_space: string | null;
};

export type AppField = { key: string; label: string; placeholder?: string; secret?: boolean; optional?: boolean; multiline?: boolean };

export type AppMeta = {
  kind: string;
  label: string;
  summary: string;
  fields: AppField[];
  steps: string[];
  default_interval: string;
  intervals: string[];
  category?: string;
  oauth_provider: string | null;
  oauth_ready: boolean;
  discover: boolean;
  suggested_space: string | null;
};

export type DiscoveredAccount = { id: string; name: string; detail: string | null };

export type ConnectAppPayload = {
  kind: string;
  name: string;
  credentials?: Record<string, string>;
  pending_id?: string;
  account_ids?: string[];
  space_ids?: string[];
  new_space?: { name: string; color?: string };
  sync_interval?: string;
  history_days?: number;
  workspace_id?: string;
};

export type ConnectedApp = {
  id: string;
  name: string;
  kind: string;
  label: string;
  sync_interval: string;
  last_synced_at: string | null;
  next_sync_at: string | null;
  sync_error: string | null;
  syncing: boolean;
  tables: { name: string; rows: number; synced_at: string }[];
  space_ids?: string[];
};

export const spacesApi = {
  list: (workspaceId?: string | null) =>
    api.get<{ spaces: Space[] }>("/spaces", { params: workspaceId ? { workspace_id: workspaceId } : {} }).then((r) => r.data.spaces),
  get: (id: string) => api.get<Space>(`/spaces/${id}`).then((r) => r.data),
  create: (body: SpaceInput) => api.post<Space>("/spaces", body).then((r) => r.data),
  update: (id: string, body: SpaceInput) => api.patch<Space>(`/spaces/${id}`, body).then((r) => r.data),
  remove: (id: string) => api.delete(`/spaces/${id}`),
  sources: (id: string, add: string[], remove: string[] = []) => api.post<Space>(`/spaces/${id}/sources`, { add, remove }).then((r) => r.data),
  assign: (spaceId: string, sourceIds: string[]) => api.post<Space>("/spaces/assign", { space_id: spaceId, source_ids: sourceIds }).then((r) => r.data),
  suggest: (kind: string, workspaceId?: string | null) =>
    api.get<{ name: string | null; space_id: string | null; color: string | null; description: string | null }>("/spaces/suggest", { params: { kind, ...(workspaceId ? { workspace_id: workspaceId } : {}) } }).then((r) => r.data),
  overview: (id: string, days = 28) => api.get<SpaceOverview>(`/spaces/${id}/overview`, { params: { days }, timeout: 60000 }).then((r) => r.data),
};

export const catalogApi = {
  catalog: () => api.get<{ categories: CatalogCategory[]; connectors: CatalogConnector[] }>("/apps/catalog").then((r) => r.data),
  apps: () => api.get<AppMeta[]>("/apps").then((r) => r.data),
  oauthStart: (kind: string) => api.get<{ authorize_url: string; provider: string; redirect_uri: string }>(`/apps/oauth/${kind}/start`).then((r) => r.data),
  discover: (kind: string, body: { credentials?: Record<string, string>; pending_id?: string }) =>
    api.post<{ accounts: DiscoveredAccount[] }>("/apps/discover", { kind, ...body }, { timeout: 60000 }).then((r) => r.data.accounts),
  connect: (payload: ConnectAppPayload) => api.post<ConnectedApp>("/apps", payload, { timeout: 90000 }).then((r) => r.data),
  status: (id: string) => api.get<ConnectedApp>(`/apps/${id}`).then((r) => r.data),
};

export const SPACE_COLORS = ["#C9A7FF", "#43E5A0", "#F2B84B", "#FF8FA3", "#7AA7FF", "#5CF2E6"];

/** The monogram tile colours for a source kind already connected (the
 *  catalog carries the full list; this covers the ones lists show). */
export const KIND_TILE: Record<string, { m: string; c: string; t: string }> = {
  instagram: { m: "Ig", c: "#C1356F", t: "#FFFFFF" },
  facebook_pages: { m: "Fb", c: "#1668E3", t: "#FFFFFF" },
  linkedin_pages: { m: "in", c: "#0A63BC", t: "#FFFFFF" },
  youtube: { m: "Yt", c: "#E5242B", t: "#FFFFFF" },
  search_console: { m: "SC", c: "#2B7DE9", t: "#FFFFFF" },
  woocommerce: { m: "Wc", c: "#7F54B3", t: "#FFFFFF" },
  stripe: { m: "St", c: "#635BFF", t: "#FFFFFF" },
  hubspot: { m: "Hs", c: "#FF5C35", t: "#FFFFFF" },
  klaviyo: { m: "Kl", c: "#1F1F1F", t: "#FFFFFF" },
  shopify: { m: "Sh", c: "#5E8E3E", t: "#FFFFFF" },
  ga4: { m: "G4", c: "#E8710A", t: "#FFFFFF" },
  meta_ads: { m: "Ma", c: "#1668E3", t: "#FFFFFF" },
  google_ads: { m: "GA", c: "#1A73E8", t: "#FFFFFF" },
  postgres: { m: "Pg", c: "#2F5D8C", t: "#FFFFFF" },
  mysql: { m: "My", c: "#00758F", t: "#FFFFFF" },
  sqlserver: { m: "SQ", c: "#B52E31", t: "#FFFFFF" },
  mongodb: { m: "Mg", c: "#0F8B4C", t: "#FFFFFF" },
  supabase: { m: "Sb", c: "#2FBF7E", t: "#0B0F10" },
  bigquery: { m: "BQ", c: "#3B78E7", t: "#FFFFFF" },
  snowflake: { m: "Sf", c: "#1EA7D9", t: "#FFFFFF" },
  csv: { m: "Fi", c: "#1C2A25", t: "#43E5A0" },
  excel: { m: "Xl", c: "#1D6F42", t: "#FFFFFF" },
  google_sheets: { m: "GS", c: "#1E8E3E", t: "#FFFFFF" },
  microsoft_excel: { m: "Xl", c: "#1D6F42", t: "#FFFFFF" },
  api: { m: "{}", c: "#151C1D", t: "#43E5A0" },
  streaming: { m: "Wh", c: "#151C1D", t: "#9DB4FF" },
};

export function kindTile(kind: string, name?: string): { m: string; c: string; t: string } {
  return KIND_TILE[kind] || { m: (name || kind || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "?", c: "#1A2224", t: "#C9D3D0" };
}
