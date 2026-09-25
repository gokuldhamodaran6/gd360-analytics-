import axios from "axios";

export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

export const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("gd360_token");
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    // A 401 on the login call itself just means wrong email/password -
    // that should show an error on the login form, not bounce the page
    // away before the person can read it. Only treat a 401 on some other,
    // already-authenticated call as an expired session.
    const requestUrl: string = err?.config?.url || "";
    const isLoginAttempt = requestUrl.includes("/auth/login") || requestUrl.includes("/auth/register");
    if (err?.response?.status === 401 && !isLoginAttempt) {
      localStorage.removeItem("gd360_token");
      localStorage.removeItem("gd360_user");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export type AdminStats = {
  total_users: number;
  new_users_today: number;
  new_users_7d: number;
  total_prompts: number;
  prompts_today: number;
  prompts_7d: number;
  total_datasources: number;
  total_dashboards: number;
  active_users_today: number;
  active_users_7d: number;
  active_users_30d: number;
  total_verify_checks: number;
  funnel: {
    signed_up: number;
    connected_data: number;
    ran_a_prompt: number;
    saved_a_dashboard: number;
  };
};

export type AdminUserRow = {
  id: string;
  email: string;
  full_name: string | null;
  company: string | null;
  created_at: string;
  prompt_count: number;
  last_prompt_at: string | null;
  datasource_count: number;
  dashboard_count: number;
  verified_count: number;
};

export type AdminUsagePoint = {
  day: string;
  count: number;
  active_users: number;
  analyze_count: number;
  transform_count: number;
};

export type AdminGrowthPoint = { day: string; new_users: number; cumulative_users: number };

export type AdminBreakdowns = {
  datasource_kinds: { kind: string; count: number }[];
  action_mix: { action: string; count: number }[];
  chart_types: { chart_type: string; count: number }[];
  goku: { total_questions: number; users: number };
  verification: { total_checks: number; messages_ever_verified: number; verifiable_messages: number };
};

export type AdminActivityEvent = {
  type: "signup" | "connected_data" | "saved_dashboard";
  at: string | null;
  text: string;
};

export const adminApi = {
  getStats: () => api.get<AdminStats>("/admin/stats").then((r) => r.data),
  getUsers: () => api.get<AdminUserRow[]>("/admin/users").then((r) => r.data),
  getUsageTimeseries: (days = 14) =>
    api.get<AdminUsagePoint[]>(`/admin/usage-timeseries?days=${days}`).then((r) => r.data),
  getGrowthTimeseries: (days = 30) =>
    api.get<AdminGrowthPoint[]>(`/admin/growth-timeseries?days=${days}`).then((r) => r.data),
  getBreakdowns: () => api.get<AdminBreakdowns>("/admin/breakdowns").then((r) => r.data),
  getActivityFeed: (limit = 30) =>
    api.get<AdminActivityEvent[]>(`/admin/activity-feed?limit=${limit}`).then((r) => r.data),
};

export type CleaningLogEntry = {
  prompt: string;
  summary: string | null;
  rows_before: number | null;
  rows_after: number | null;
  nulls_before: number | null;
  nulls_after: number | null;
  created_at: string;
};

// A named, saved table created by a cleaning/prep prompt. "Original data"
// is not one of these - it is always available and is represented on the
// client as versionId === null.
export type DatasetVersion = {
  id: string;
  name: string;
  parent_version_id: string | null;
  step_count: number;
  created_at: string;
  // Which conversation's chat prompt actually built this table - null for
  // one predating this attribution, or the legacy-migration's own first
  // version (see backend ensure_legacy_migrated), in which case it is not
  // tied to any one chat and always shows regardless of scope. Used to
  // scope the Data tab's table strip (and the WORKING ON picker, which
  // reads this same list) to just the currently open conversation by
  // default - see Workspace.tsx's versionScope.
  conversation_id: string | null;
};

// One table this datasource's data flow through - exactly what
// Message.sources holds server-side (see backend models.py), returned
// verbatim as part of each FlowNode below. "kind" is what the box on the
// Flow map should look like: "original"/"sheet" are the raw incoming
// data (this datasource's own, or - when datasource_id differs from the
// datasource the map was opened for - another, separately-connected one
// pulled in via "+ Add more data"); "version" is a saved/prepared table,
// identified by version_id.
export type FlowSource = {
  kind: "original" | "sheet" | "version";
  label: string;
  datasource_id: string;
  version_id: string | null;
  sheet: string | null;
};

// A saved table, with its full lineage - which table(s) it was built
// from within THIS datasource (parent_version_ids can be several, e.g. a
// prompt that merged two saved tables together). A version predating this
// column may have parent_version_ids: null even though it does have a
// single parent_version_id - DataFlowMap treats that the same as [id].
export type FlowVersion = {
  id: string;
  name: string;
  parent_version_id: string | null;
  parent_version_ids: string[] | null;
  step_count: number;
  created_at: string;
};

// One chart-producing or table-producing chat turn, anywhere in this data
// source's history (every past conversation, not just the one currently
// open) - the other half of the Flow map, alongside FlowVersion above.
// `sources` is null for a turn saved before this feature existed; the map
// falls back to treating those as sourced from "Original data".
export type FlowNode = {
  message_id: string;
  conversation_id: string;
  conversation_title: string;
  prompt: string;
  action: "analyze" | "transform" | string;
  chart_type: string | null;
  has_chart: boolean;
  created_at: string;
  sources: FlowSource[] | null;
  new_version_id: string | null;
};

export type DataFlow = {
  datasource_id: string;
  datasource_name: string;
  versions: FlowVersion[];
  nodes: FlowNode[];
};

// One column's aggregate, computed server-side over the full
// filtered/sorted table (not just the current page) - see backend
// routers/datasources.py _column_stats. sum/mean/min/max are only ever
// set for a numeric column; a text/date/boolean column gets `distinct`
// instead (min/max are also set for a comparable non-numeric column, as
// its raw string form). The Data tab's Totals row lets a person pick
// whichever of these is actually present for a given column.
export type ColumnStat = {
  count: number;
  non_null: number;
  sum: number | null;
  mean: number | null;
  min: number | string | null;
  max: number | string | null;
  distinct: number | null;
};

export type DataPreview = {
  columns: string[];
  dtypes: Record<string, string>;
  rows: Record<string, any>[];
  total_rows: number;
  offset: number;
  limit: number;
  version_id: string | null;
  version_name: string;
  cleaning_log: CleaningLogEntry[];
  column_stats: Record<string, ColumnStat>;
  // True only for a live-connector datasource whose true row count may be
  // bigger than what PREVIEW_ROW_LIMIT let this preview load - the Totals
  // row shows a small caveat instead of silently understating a sum.
  stats_capped: boolean;
};

// Each column's filter is now a small structured object - a values
// checklist, or a type-aware condition (text/number/date/boolean) - built
// by DataTable.tsx's Excel-style filter panel (see its ColumnFilterSpec)
// and read on the backend by routers/datasources.py's _apply_column_filter.
// Kept loosely typed here (rather than importing DataTable's own union)
// since the API client is just a pass-through: it JSON-serializes whatever
// shape the caller built and never inspects it itself.
export type PreviewOptions = {
  sortBy?: string | null;
  sortDir?: "asc" | "desc";
  filters?: Record<string, any>;
};

// One distinct value (with its row count) for a single column - the
// checkbox list in the Data tab's Excel-style filter panel is built from
// these. Computed on demand, only for the one column a person opens the
// filter for - see backend routers/datasources.py get_column_distinct_values
// for why this is its own lazy endpoint rather than part of every preview.
export type ColumnDistinctValue = { value: string | number | boolean | null; count: number };

export type ColumnDistinctValues = {
  column: string;
  values: ColumnDistinctValue[];
  null_count: number;
  distinct_total: number;
  // True when distinct_total is bigger than how many values were actually
  // returned (capped by `limit`) - the filter panel shows "+N more, type to
  // search" instead of silently looking like a complete list.
  truncated: boolean;
};

// What the natural-language filter bar gets back - `filters` is keyed by
// real column name, each value already the same structured shape the
// manual Values/Condition filter panel builds (DataTable.tsx's
// ColumnFilterSpec), ready to merge straight into that same filter state.
// `note` is one short, friendly sentence to show back ("Showing orders
// over $500 in California."), or a brief explanation when nothing in the
// request matched a real column.
export type ParseFilterResult = {
  filters: Record<string, any>;
  note: string;
};

// A named snapshot of the whole Data tab display for one table - see
// backend models.SavedView. `config` is intentionally untyped here (a
// plain object) - it is whatever DataTable.tsx's own view-state serializer
// produces, and only that same code ever reads it back apart.
export type SavedView = {
  id: string;
  name: string;
  table: string | null;
  version_id: string | null;
  config: Record<string, any>;
  created_at: string;
  updated_at: string;
  // Who saved this view - shared team-wide once its data source is (see
  // backend routers/datasources.py list_saved_views), so a shared list
  // doesn't look like it all came from whoever's looking at it right now.
  created_by_id: string | null;
  created_by_name: string | null;
  created_by_email: string | null;
};

// The same shape the backend's DataSourceOut returns - kept here (rather
// than only as DataSourceForm.tsx's CreatedDataSource, which this mirrors)
// so the API client itself can be typed without importing a component
// file. schema_cache is what a multi-sheet Excel upload's per-sheet
// columns, or a database's per-table columns, actually live in - see
// getTableEntries in DataSourceForm.tsx for how it gets turned into a
// uniform list of pickable tables regardless of kind.
export type DataSourceSummary = {
  id: string;
  name: string;
  kind: string;
  connection_info: Record<string, unknown>;
  read_only: boolean;
  schema_cache?: Record<string, unknown> | null;
  created_at: string;
};

export const datasourceApi = {
  // Every data source this person has connected - used by the chat
  // panel's "+ Add more data" picker to offer every OTHER already-
  // connected data source (not just the one the current Workspace page is
  // open on) as something to pull into the current analysis.
  // workspaceId narrows this to one workspace (see workspaceApi below) -
  // omitted, this still returns everything, exactly as before workspaces
  // existed, so every existing caller keeps working unchanged.
  list: (workspaceId?: string) =>
    api.get<DataSourceSummary[]>("/datasources", { params: { workspace_id: workspaceId || undefined } }).then((r) => r.data),

  // Moves a data source into a different one of the caller's own
  // workspaces - called right after a new data source is created so it's
  // tagged with whichever workspace was active at the time (see
  // Dashboard.tsx's "+ New Project" flow).
  assignWorkspace: (id: string, workspaceId: string) =>
    api.patch(`/datasources/${id}/workspace`, { workspace_id: workspaceId }).then((r) => r.data),

  // `table` (new) picks one specific original table/sheet by name - the
  // Data tab's own per-table tab strip for a multi-table datasource (see
  // DataTable.tsx). Ignored server-side whenever `versionId` is set (a
  // saved/AI-built table is not addressed by table name), and left
  // undefined otherwise falls back to the backend's own sensible default
  // (the first table, for a multi-table source - see
  // data_loader.default_table_for_preview).
  preview: (id: string, versionId: string | null, limit = 50, offset = 0, opts: PreviewOptions = {}, table?: string | null) =>
    api
      .get<DataPreview>(`/datasources/${id}/preview`, {
        params: {
          version_id: versionId || undefined,
          table: versionId ? undefined : table || undefined,
          limit,
          offset,
          sort_by: opts.sortBy || undefined,
          sort_dir: opts.sortDir || undefined,
          filters:
            opts.filters && Object.keys(opts.filters).some((k) => opts.filters![k])
              ? JSON.stringify(opts.filters)
              : undefined,
        },
      })
      .then((r) => r.data),

  listVersions: (id: string) => api.get<DatasetVersion[]>(`/datasources/${id}/versions`).then((r) => r.data),

  // Distinct values (with counts) for one column, for the Excel-style
  // checkbox filter panel - see get_column_distinct_values on the backend.
  // `search` narrows the search-within-values box in that panel before
  // the backend counts/truncates, so it stays fast even on a
  // high-cardinality column.
  getColumnDistinctValues: (
    id: string,
    column: string,
    versionId: string | null,
    opts: { table?: string | null; search?: string; limit?: number } = {}
  ) =>
    api
      .get<ColumnDistinctValues>(`/datasources/${id}/columns/${encodeURIComponent(column)}/distinct-values`, {
        params: {
          version_id: versionId || undefined,
          table: versionId ? undefined : opts.table || undefined,
          search: opts.search || undefined,
          limit: opts.limit || undefined,
        },
      })
      .then((r) => r.data),

  // Every saved table and every chart/analysis ever built for this data
  // source, across every past conversation - the raw material for the
  // Flow tab's data-lineage map (components/DataFlowMap.tsx). See
  // backend routers/datasources.py get_data_flow for exactly what this
  // reads back (nothing is computed fresh server-side either).
  getFlow: (id: string) => api.get<DataFlow>(`/datasources/${id}/flow`).then((r) => r.data),

  // The natural-language filter bar: turns a plain-English request into
  // the same structured filters the manual filter panel produces - see
  // backend routers/datasources.py parse_filter and
  // services/ai_engine.py parse_filter_prompt.
  parseFilter: (id: string, prompt: string, versionId: string | null, table?: string | null) =>
    api
      .post<ParseFilterResult>(`/datasources/${id}/parse-filter`, {
        prompt,
        version_id: versionId || undefined,
        table: versionId ? undefined : table || undefined,
      })
      .then((r) => r.data),

  // Saved Views - a named snapshot of the whole Data tab display for one
  // table (see models.SavedView). Scoped to exactly one of versionId/table,
  // mirroring how every other per-table call here already addresses "which
  // table" (preview, distinct-values, parse-filter, export).
  listViews: (id: string, versionId: string | null, table?: string | null) =>
    api
      .get<SavedView[]>(`/datasources/${id}/views`, {
        params: { version_id: versionId || undefined, table: versionId ? undefined : table || undefined },
      })
      .then((r) => r.data),

  createView: (id: string, name: string, versionId: string | null, table: string | null | undefined, config: Record<string, any>) =>
    api
      .post<SavedView>(`/datasources/${id}/views`, {
        name,
        version_id: versionId || undefined,
        table: versionId ? undefined : table || undefined,
        config,
      })
      .then((r) => r.data),

  deleteView: (id: string, viewId: string) => api.delete(`/datasources/${id}/views/${viewId}`),

  rename: (id: string, name: string) =>
    api.patch<{ id: string; name: string }>(`/datasources/${id}`, { name }).then((r) => r.data),

  renameVersion: (id: string, versionId: string, name: string) =>
    api.patch<{ id: string; name: string }>(`/datasources/${id}/versions/${versionId}`, { name }).then((r) => r.data),

  deleteVersion: (id: string, versionId: string) => api.delete(`/datasources/${id}/versions/${versionId}`),

  // Removes a connected data source entirely - used by the "New data" flow
  // to clean up an abandoned Google Sheets/Excel OAuth connect (see
  // connectionsApi below), and available anywhere else a "delete this data
  // source" action is added later.
  delete: (id: string) => api.delete(`/datasources/${id}`),

  downloadExport: async (id: string, versionId: string | null, format: "csv" | "xlsx", table?: string | null) => {
    const res = await api.get(`/datasources/${id}/export`, {
      params: {
        version_id: versionId || undefined,
        table: versionId ? undefined : table || undefined,
        export_format: format,
      },
      responseType: "blob",
    });
    const disposition: string = res.headers["content-disposition"] || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : `data.${format}`;
    const blob = new Blob([res.data]);
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  },
};

// ---- Live OAuth connectors: Google Sheets and Microsoft Excel (OneDrive/
// SharePoint) - see backend routers/connections.py for the full authorize
// -> provider consent -> callback -> pick a resource -> finish flow. The
// SPA is left entirely during steps 1-2 (a real browser redirect to
// Google's/Microsoft's own sign-in page), which is why this is a handful
// of plain endpoint calls rather than anything resembling the rest of this
// client's request/response round trips - see pages/ConnectResourcePicker.tsx
// for where the redirect lands back in the app. ----

export type OAuthProvider = "google_sheets" | "microsoft_excel";

export type OAuthResource = {
  id: string;
  name: string;
  modified_at: string | null;
  drive_id?: string | null;
};

export type OAuthResourcesResult = {
  provider: OAuthProvider;
  resources: OAuthResource[];
};

export const connectionsApi = {
  authorize: (provider: OAuthProvider) =>
    api
      .get<{ authorize_url: string }>(`/connections/${provider === "google_sheets" ? "google" : "microsoft"}/authorize`)
      .then((r) => r.data.authorize_url),

  // Microsoft Excel only - see backend routers/connections.py's
  // list_resources docstring for why Google Sheets doesn't use this.
  listResources: (connectionId: string, search?: string) =>
    api
      .get<OAuthResourcesResult>(`/connections/${connectionId}/resources`, { params: { search: search || undefined } })
      .then((r) => r.data),

  // Google Sheets only - a short-lived token to open Google's own
  // file-picker widget with (see GooglePicker in ConnectResourcePicker.tsx).
  pickerToken: (connectionId: string) =>
    api.get<{ access_token: string }>(`/connections/${connectionId}/picker-token`).then((r) => r.data.access_token),

  finish: (connectionId: string, payload: { name: string; resource_id: string; resource_name: string; drive_id?: string | null }) =>
    api.post<DataSourceSummary>(`/connections/${connectionId}/finish`, payload).then((r) => r.data),
};

export type ConversationSummary = {
  id: string;
  title: string;
  datasource_id: string | null;
  datasource_name: string | null;
  message_count: number;
  last_message: string;
  last_chart_type: string | null;
  pinned: boolean;
  // 2026-09-23 (folders round): which Folder this Project is filed into,
  // if any - null means "unfiled" (the Projects page's default view).
  folder_id: string | null;
  created_at: string;
  updated_at: string;
  // Who started this Project, and what the CURRENT signed-in person can do
  // with it (2026-09-23, roles & attribution round) - server-computed so
  // the UI never has to re-derive the owner/member/viewer role logic
  // itself. created_by_name falls back to created_by_email when someone
  // hasn't set a display name.
  created_by_id: string;
  created_by_name: string | null;
  created_by_email: string;
  is_own: boolean;
  can_edit: boolean;
  can_delete: boolean;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  chart_spec: any;
  // The chart type actually rendered, plus the tidy row-level numbers it
  // was built from (see backend chart_builder.result_to_tidy) - what lets
  // the Explore panel keep working (instant client-side axis/type/filter
  // changes) after reopening a saved conversation. Loosely typed here
  // (matching chart_spec above); Workspace.tsx narrows to the real
  // ResultColumn[]/rows shape from lib/exploreEngine when building a
  // ChartEntry from these.
  chart_type: string | null;
  result_columns: any;
  result_rows: any;
  result_truncated: boolean;
  insight: string | null;
  suggestions: { charts?: any[]; stats?: any[]; follow_up?: { label: string; prompt: string }[] } | null;
  needs_clarification: boolean;
  action: "analyze" | "transform" | "clarify" | "explain" | null;
  created_at: string;
};

export type ConversationDetail = {
  id: string;
  title: string;
  datasource_id: string | null;
  created_by_id: string;
  created_by_name: string | null;
  created_by_email: string;
  is_own: boolean;
  can_edit: boolean;
  can_delete: boolean;
  messages: ConversationMessage[];
};

export const conversationApi = {
  // workspaceId narrows this to one workspace's Projects (see workspaceApi
  // below) - omitted, this still returns everything, exactly as before
  // workspaces existed.
  list: (workspaceId?: string) =>
    api.get<ConversationSummary[]>("/conversations", { params: { workspace_id: workspaceId || undefined } }).then((r) => r.data),
  getMessages: (id: string) => api.get<ConversationDetail>(`/conversations/${id}/messages`).then((r) => r.data),
  rename: (id: string, title: string) =>
    api.patch<{ id: string; title: string; pinned: boolean }>(`/conversations/${id}`, { title }).then((r) => r.data),
  pin: (id: string, pinned: boolean) =>
    api.patch<{ id: string; title: string; pinned: boolean }>(`/conversations/${id}`, { pinned }).then((r) => r.data),
  remove: (id: string) => api.delete<{ id: string; deleted: boolean }>(`/conversations/${id}`).then((r) => r.data),
  // Files (folderId set) or unfiles (folderId null) several Projects into
  // a folder at once - the Projects page's select-all bulk-move action
  // (2026-09-23, folders round). Anything the caller can't actually edit
  // is silently skipped server-side rather than failing the whole batch -
  // see routers/conversations.py bulk_move_conversations for exactly what
  // "moved" vs "skipped" means.
  bulkMove: (conversationIds: string[], folderId: string | null) =>
    api
      .patch<{ moved: string[]; skipped: string[]; folder_id: string | null }>("/conversations/bulk-move", {
        conversation_ids: conversationIds,
        folder_id: folderId,
      })
      .then((r) => r.data),
};

// ---- Folders: purely an organizing label for Projects, scoped to one
// workspace - see backend models.Folder / routers/folders.py. Deleting a
// folder never deletes the Projects in it, only unfiles them back to
// folder_id: null. ----
export type FolderSummary = {
  id: string;
  name: string;
  workspace_id: string;
  created_at: string;
  project_count: number;
  can_edit: boolean;
};

export const folderApi = {
  list: (workspaceId: string) =>
    api.get<FolderSummary[]>("/folders", { params: { workspace_id: workspaceId } }).then((r) => r.data),
  create: (workspaceId: string, name: string) =>
    api.post<FolderSummary>("/folders", { workspace_id: workspaceId, name }).then((r) => r.data),
  rename: (id: string, name: string) => api.patch<FolderSummary>(`/folders/${id}`, { name }).then((r) => r.data),
  remove: (id: string) => api.delete<{ id: string; deleted: boolean }>(`/folders/${id}`).then((r) => r.data),
};

// ---- Workspaces: real, persisted workspaces with real members - see
// backend routers/workspaces.py for the full model. No transactional email
// sending exists in this app yet, so inviting someone works by sharing a
// link (POST .../invite/regenerate issues it, GET/POST /invites/:token
// previews and accepts it), not by an emailed invite. ----

// "viewer" added 2026-09-23 (roles & attribution round): full read access,
// no create/edit/delete - see backend services/workspace_access.py for
// exactly what that does and doesn't allow.
export type WorkspaceRole = "owner" | "member" | "viewer";

export type WorkspaceSummary = {
  id: string;
  name: string;
  is_personal: boolean;
  role: WorkspaceRole; // the CURRENT signed-in person's role in this workspace
  member_count: number;
  datasource_count: number;
  invite_token: string;
  created_at: string;
};

export type WorkspaceMember = {
  user_id: string;
  email: string;
  full_name: string | null;
  role: WorkspaceRole;
  created_at: string;
};

export type WorkspaceDetail = WorkspaceSummary & { members: WorkspaceMember[] };

export type InvitePreview = {
  workspace_id: string;
  workspace_name: string;
  member_count: number;
  already_member: boolean;
};

export const workspaceApi = {
  list: () => api.get<WorkspaceSummary[]>("/workspaces").then((r) => r.data),
  create: (name: string) => api.post<WorkspaceSummary>("/workspaces", { name }).then((r) => r.data),
  get: (id: string) => api.get<WorkspaceDetail>(`/workspaces/${id}`).then((r) => r.data),
  rename: (id: string, name: string) => api.patch<WorkspaceSummary>(`/workspaces/${id}`, { name }).then((r) => r.data),
  remove: (id: string) => api.delete<{ id: string; deleted: boolean }>(`/workspaces/${id}`).then((r) => r.data),
  regenerateInvite: (id: string) =>
    api.post<WorkspaceSummary>(`/workspaces/${id}/invite/regenerate`).then((r) => r.data),
  removeMember: (id: string, userId: string) =>
    api.delete<{ user_id: string; removed: boolean }>(`/workspaces/${id}/members/${userId}`).then((r) => r.data),
  // Promotes/demotes an existing member between full access ("member") and
  // read-only ("viewer") - owner-only server-side, and the owner's own row
  // is never a valid target (see backend update_member_role).
  updateMemberRole: (id: string, userId: string, role: "member" | "viewer") =>
    api.patch<WorkspaceMember>(`/workspaces/${id}/members/${userId}/role`, { role }).then((r) => r.data),
  previewInvite: (token: string) => api.get<InvitePreview>(`/invites/${token}`).then((r) => r.data),
  joinInvite: (token: string) => api.post<WorkspaceSummary>(`/invites/${token}/join`).then((r) => r.data),
};

// The "Double-check this" action: re-checks a previously computed answer
// for correctness on demand, instead of the person having to just trust
// the first pass indefinitely - see backend routers/chat.py verify_message
// and services/ai_engine.py verify_answer for what actually happens.
export type VerifyResult = {
  status: "confirmed" | "corrected" | "unavailable";
  message: string;
  message_id: string;
  reply_text?: string | null;
  chart_spec?: any;
  chart_type?: string | null;
  result_columns?: any;
  result_rows?: any;
  result_truncated?: boolean;
  insight?: string | null;
  new_version_id?: string | null;
  new_version_name?: string | null;
};

export const chatApi = {
  verify: (messageId: string, sourceVersionIds: string[] | null) =>
    api
      .post<VerifyResult>("/chat/verify", { message_id: messageId, source_version_ids: sourceVersionIds })
      .then((r) => r.data),
};

// Goku: the guided, beginner-friendly assistant that lives only in the
// Workspace page - see backend routers/goku.py and services/ai_engine.py
// goku_chat for what it actually does. One conversation per data source.
export type GokuActionPrompt = { label: string; prompt: string };

export type GokuMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  action_prompts: GokuActionPrompt[] | null;
  created_at: string;
};

export const gokuApi = {
  getMessages: (datasourceId: string) =>
    api.get<{ messages: GokuMessage[] }>(`/goku/${datasourceId}/messages`).then((r) => r.data),
  chat: (datasourceId: string, message: string, sourceVersionIds: string[] | null) =>
    api
      .post<GokuMessage>("/goku/chat", {
        datasource_id: datasourceId,
        message,
        source_version_ids: sourceVersionIds,
      })
      .then((r) => r.data),
};

// Dashboards: named boards of pinned charts. A dashboard can stay personal
// (workspace_id null, visible only to whoever created it - the original
// behavior) or be shared into a team workspace (2026-09-23, shared
// dashboards round), where every member can see it and anyone but a
// "viewer" can add to/rename it - see backend routers/dashboards.py for
// the exact view/editable/delete split can_edit/can_delete are computed
// from server-side.
export type DashboardSummary = {
  id: string;
  name: string;
  workspace_id: string | null;
  workspace_name: string | null;
  created_at: string;
  chart_count: number;
  is_own: boolean;
  created_by_name: string | null;
  created_by_email: string | null;
  can_edit: boolean;
  can_delete: boolean;
  // 2026-09-24 (Dashboard Builder Phase 1): 1 = this original flat saved-
  // chart-list kind, 2 = the new pages+blocks kind (dashboardBuilderApi
  // further down). Dashboards.tsx branches a row's link on this so it
  // opens the right viewer. Optional so a response from before this round
  // still types cleanly - "not exactly 2" always means "open the old
  // viewer".
  layout_version?: number;
};

export type SavedChart = {
  id: string;
  title: string;
  chart_spec: any;
  insight: string | null;
  position: number;
};

export type DashboardDetail = DashboardSummary & { charts: SavedChart[] };

export const dashboardApi = {
  list: () => api.get<DashboardSummary[]>("/dashboards").then((r) => r.data),
  get: (id: string) => api.get<DashboardDetail>(`/dashboards/${id}`).then((r) => r.data),
  create: (name: string, workspaceId?: string | null) =>
    api.post<DashboardSummary>("/dashboards", { name, workspace_id: workspaceId || null }).then((r) => r.data),
  rename: (id: string, name: string) =>
    api.patch<DashboardSummary>(`/dashboards/${id}`, { name }).then((r) => r.data),
  // Sharing/un-sharing (creator-only server-side) - pass null to move a
  // dashboard back to personal.
  setWorkspace: (id: string, workspaceId: string | null) =>
    api.patch<DashboardSummary>(`/dashboards/${id}/workspace`, { workspace_id: workspaceId }).then((r) => r.data),
  remove: (id: string) => api.delete(`/dashboards/${id}`).then(() => undefined),
  saveChart: (payload: {
    title: string;
    chart_spec: any;
    insight?: string | null;
    dashboard_id?: string | null;
    dashboard_name?: string | null;
    workspace_id?: string | null;
  }) =>
    api
      .post<{ dashboard_id: string; dashboard_name: string; chart_id: string }>("/dashboards/save-chart", payload)
      .then((r) => r.data),
  removeChart: (dashboardId: string, chartId: string) =>
    api.delete(`/dashboards/${dashboardId}/charts/${chartId}`).then(() => undefined),
};

// ---- Dashboard Builder (2026-09-24, Phase 1): the new real-time,
// publishable "pages of blocks" kind of dashboard - what replaces the flat
// saved-chart-list above as this app's actual PowerBI/Tableau/Hex-style
// dashboard feature. A dashboard here is layout_version===2 on the exact
// same Dashboard row the API above also manages; this client just talks to
// a completely separate router (see backend routers/dashboard_builder.py)
// that only ever creates/reads/publishes that kind. Phase 1 covers
// AI-generation from a finished chat analysis and a public share link -
// no canvas editing yet (that's Phase 2), so there's no "create blank" or
// "move/resize a block" call here yet either. ----

// 2026-09-25 (Round 3): added "gauge" | "donut" | "sparkline" |
// "avatar_list" - four native widget types (radial meter, curved-legend
// donut, half-tone trend sparkline, ranked avatar leaderboard), built and
// rendered entirely in components/DashboardBlocks.tsx, not a chart_spec.
// See routers/dashboard_builder.py's own module docstring, Round 3
// section, for each one's config shape.
export type DashboardBlockType = "chart" | "table" | "kpi" | "text" | "filter" | "gauge" | "donut" | "sparkline" | "avatar_list";

// `config`'s shape depends on `type` - deliberately left loosely typed
// here (this client is a pass-through, same convention as PreviewOptions.
// filters above) rather than a discriminated union, since every renderer
// (components/DashboardBlocks.tsx) narrows it itself right where it's
// used. The shapes the backend actually sends, verbatim from
// routers/dashboard_builder.py's _block_config/_ai_result_to_block/
// _run_manual_recipe:
//   chart: { chart_spec: any; result_columns?: any; result_rows?: any; recipe?: ManualRecipe }
//     (result_columns/result_rows are only present when this chart has
//     tidy data attached - that's what makes restyle_block possible; a
//     chart block from before this existed may omit them. `recipe` is
//     only present on a block built with "Build manually" - that's what
//     makes it respond to a cross-filter at all, see dashboardBuilderApi.
//     previewFiltered below)
//   table: { columns: string[]; rows: Record<string, any>[]; truncated: boolean; recipe?: ManualRecipe }
//   kpi:   { value: number | string | null; label: string; recipe?: ManualRecipe }
//   text:  { text: string }
//     (2026-09-24, Phase 2: a freeform note block - its body is written
//     straight through dashboardBuilderApi.updateBlock's `config` field,
//     there is no dedicated endpoint for it)
//   filter: { column: string | null }
//     (2026-09-24, Phase 2b: which column this filter block targets - a
//     structural, shared setting written through updateBlock's `config`
//     field, same as text. Deliberately the ONLY thing stored here - the
//     filter's currently-SELECTED VALUE is never persisted anywhere; see
//     dashboardBuilderApi.previewFiltered below for why)
export type DashboardBlock = {
  id: string;
  type: DashboardBlockType;
  title: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  config: any;
  position: number;
};

export type DashboardBuilderPage = {
  id: string;
  name: string;
  position: number;
  blocks: DashboardBlock[];
};

// 2026-09-24 (Phase 3): one named person allowed to open a "private" share
// - see dashboardBuilderApi.addShareEmail/removeShareEmail below.
export type DashboardShareEmail = { id: string; email: string };

export type DashboardBuilderDetail = {
  id: string;
  name: string;
  layout_version: number;
  created_at: string;
  // Which chat Project this was generated from - null for a dashboard
  // started blank (not possible yet in Phase 1, but the field already
  // exists on the model for when Phase 2 adds it).
  source_conversation_id: string | null;
  // 2026-09-24 (Phase 2): the data source this dashboard's blocks are (or
  // can be) built against, resolved server-side from source_conversation_id
  // - both null for a dashboard with no source conversation, or whose
  // original conversation/data source was since deleted. The canvas uses
  // this to know whether Ask AI / manual-build are even offered, and
  // datasourceApi.preview(datasource_id, null) to populate the manual-build
  // column picker (deliberately reusing that existing endpoint rather than
  // adding a new "list columns" one).
  datasource_id: string | null;
  datasource_name: string | null;
  pages: DashboardBuilderPage[];
  can_edit: boolean;
  is_published: boolean;
  public_slug: string | null;
  // 2026-09-24 (Phase 3): the share row's own settings - all present once
  // this dashboard has ever been published at least once (null/false/empty
  // before that). share_emails only matters when share_mode is "private";
  // never includes the password itself, just whether one is set.
  share_mode: "public" | "private" | null;
  share_has_password: boolean;
  share_emails: DashboardShareEmail[];
  // 2026-09-24 (Phase 4, white-label): this dashboard's own custom domain,
  // if any - null/null/null until setCustomDomain is ever called.
  // custom_domain_status is Render's own DNS-verification/SSL-issuance
  // progress, collapsed to one of three values by the backend (see
  // services/render_domains.py): "pending_dns" (the CNAME record hasn't
  // been seen yet), "pending_ssl" (DNS verified, certificate still being
  // issued), or "live" (actually serving HTTPS traffic on this domain
  // now) - PublishPanel below shows a different message/icon for each.
  // custom_domain_error is set only when the last recheck hit a real
  // problem (e.g. the domain was removed by hand on Render) - shown
  // inline next to the "Check again" button rather than failing silently.
  custom_domain: string | null;
  custom_domain_status: "pending_dns" | "pending_ssl" | "live" | null;
  custom_domain_error: string | null;
};

// What the anonymous, no-login public link actually gets back - no
// can_edit/is_published/ids beyond what's needed to render the pages, so
// nothing about the owner's account leaks into a page a stranger can open.
export type PublicDashboard = {
  name: string;
  pages: DashboardBuilderPage[];
};

// 2026-09-24 (Phase 2): the manual-build form's five whitelisted
// aggregations, verbatim from backend _MANUAL_AGG_FUNCS - kept here as a
// typed union (rather than a bare string) so the form component can't
// accidentally send one the backend doesn't recognize.
export type ManualAgg = "sum" | "avg" | "count" | "min" | "max";

// The style panel's chart-type choices - verbatim from backend
// _RESTYLE_CHART_TYPES, the subset of chart_builder.build_figure's types
// that always work from a plain two-column (dimension, measure) result.
export type RestyleChartType = "bar" | "line" | "area" | "pie" | "horizontal_bar" | "scatter";

// 2026-09-24 (Phase 2b): what makes a chart/table/kpi block able to
// respond to a cross-filter at all - stored on the block's own config
// under `recipe` by build_manual_block, verbatim from backend
// _run_manual_recipe's `recipe` dict. A block with no `recipe` (anything
// AI-built) simply can't be cross-filtered - see previewFiltered below.
export type ManualBlockType = "kpi" | "table" | "chart" | "gauge" | "donut" | "sparkline" | "avatar_list";

export type ManualRecipe = {
  metric_column: string;
  agg: ManualAgg;
  group_by_column: string | null;
  block_type: ManualBlockType;
  chart_type: RestyleChartType | null;
  // 2026-09-25 (Round 3): only meaningful when block_type === "gauge" -
  // see backend _run_manual_recipe for the defaults filled in when either
  // is left unset.
  target_value?: number | null;
  max_value?: number | null;
};

// One active cross-filter selection - (which column, which value). Lives
// ONLY in the frontend's own component state per viewer, per page - see
// previewFiltered's own docs for why this is never persisted anywhere.
export type FilterCriterion = { column: string; value: string | number | boolean };

// What previewFiltered returns for one block it successfully recomputed -
// same (type, config) shape as everywhere else, keyed by the block's id
// so the caller can merge it into whatever it's currently rendering.
export type FilteredBlock = { id: string; type: DashboardBlockType; config: any };

export const dashboardBuilderApi = {
  // Builds a brand-new pages+blocks dashboard out of everything scoreable
  // in one chat Project (its chart/table-producing turns) - this is the
  // "Build with AI" action behind the chat's "Build Dashboard" button. See
  // backend generate_dashboard for exactly how blocks are chosen, typed,
  // and laid out (always deterministic layout, AI only picks content).
  //
  // 2026-09-25 (Round 2, the "AI Build" wizard): `goal` is the answer to
  // BuildDashboardModal's one clarifying question ("what should this
  // dashboard show?"). When given, the backend plans and runs a FRESH set
  // of analyses against the real data for exactly that description,
  // rather than just laying out whatever's already in this chat - see
  // generate_dashboard's own docstring. Omitted/blank keeps the original
  // one-shot recap behavior exactly as it always worked.
  generate: (conversationId: string, goal?: string) =>
    api
      .post<DashboardBuilderDetail>("/dashboard-builder/generate", {
        conversation_id: conversationId,
        goal: goal?.trim() || undefined,
      })
      .then((r) => r.data),
  // 2026-09-25 (Round 2, "build own"): a blank v2 dashboard - one page,
  // zero blocks, linked to this conversation's data source so the
  // canvas's Ask AI / build-manually pickers work immediately. This is
  // "Create your own" in BuildDashboardModal.tsx, real for the first time
  // this round (it was shown-but-disabled since Phase 1).
  createBlank: (conversationId: string) =>
    api
      .post<DashboardBuilderDetail>("/dashboard-builder/create-blank", { conversation_id: conversationId })
      .then((r) => r.data),
  get: (id: string) => api.get<DashboardBuilderDetail>(`/dashboard-builder/${id}`).then((r) => r.data),
  // 2026-09-25 (Round 2): there was previously no way to rename a v2
  // dashboard's own name at all - see backend update_dashboard.
  rename: (id: string, name: string) =>
    api.patch<DashboardBuilderDetail>(`/dashboard-builder/${id}`, { name }).then((r) => r.data),
  // 2026-09-24 (Phase 3): mode is "public" (anyone with the link) or
  // "private" (named emails + optional password - see addShareEmail/
  // removeShareEmail below for managing that list). `password` is only
  // read by the backend when mode is "private"; omit/undefined it there
  // to mean "no password, email alone is the gate" - there's no separate
  // "leave the existing password as-is" option, every publish call fully
  // states the password this dashboard should use going forward.
  publish: (id: string, mode: "public" | "private" = "public", password?: string) =>
    api
      .post<DashboardBuilderDetail>(`/dashboard-builder/${id}/publish`, { mode, password: password || undefined })
      .then((r) => r.data),
  unpublish: (id: string) =>
    api.post<DashboardBuilderDetail>(`/dashboard-builder/${id}/unpublish`).then((r) => r.data),
  // 2026-09-24 (Phase 3): who's currently allowed to open this dashboard's
  // PRIVATE link. Adding/removing is edit-gated (same as everything else
  // in this object) - only the dashboard's owner/editor manages the list;
  // the people ON it never sign in as GD360 users at all (see
  // publicDashboardApi below for how they actually get in).
  addShareEmail: (id: string, email: string) =>
    api.post<DashboardBuilderDetail>(`/dashboard-builder/${id}/shares/emails`, { email }).then((r) => r.data),
  removeShareEmail: (id: string, emailId: string) =>
    api.delete<DashboardBuilderDetail>(`/dashboard-builder/${id}/shares/emails/${emailId}`).then((r) => r.data),

  // ---- Phase 4 (2026-09-24): white-label custom domains - see backend
  // routers/dashboard_builder.py's own module docstring and
  // services/render_domains.py. The dashboard must already be published
  // (any mode) before a domain can be set - setCustomDomain 400s
  // otherwise, same as this client's other share-management calls. A 503
  // here means this GD360 installation hasn't had RENDER_API_KEY/
  // RENDER_FRONTEND_SERVICE_ID configured yet (see config.py) - show that
  // message as-is, it's already written for a non-technical reader. ----
  setCustomDomain: (id: string, domain: string) =>
    api.post<DashboardBuilderDetail>(`/dashboard-builder/${id}/shares/domain`, { domain }).then((r) => r.data),
  // The "Check again" button - re-polls Render for this domain's current
  // DNS/SSL status. Never throws for an ordinary Render-side problem (a
  // stale/removed registration) - that comes back as a normal 200 with
  // custom_domain_error set, so the caller just re-renders from the
  // response like any other update.
  recheckCustomDomain: (id: string) =>
    api.post<DashboardBuilderDetail>(`/dashboard-builder/${id}/shares/domain/recheck`).then((r) => r.data),
  removeCustomDomain: (id: string) =>
    api.delete<DashboardBuilderDetail>(`/dashboard-builder/${id}/shares/domain`).then((r) => r.data),

  // ---- Phase 3 (2026-09-24): page management - add/rename/reorder/
  // duplicate/delete a page (tab). Every one of these returns the whole
  // updated DashboardBuilderDetail, same convention as the block calls
  // below. ----
  createPage: (dashboardId: string, name?: string) =>
    api.post<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/pages`, { name: name || "" }).then((r) => r.data),
  renamePage: (dashboardId: string, pageId: string, name: string) =>
    api.patch<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/pages/${pageId}`, { name }).then((r) => r.data),
  reorderPage: (dashboardId: string, pageId: string, position: number) =>
    api.patch<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/pages/${pageId}`, { position }).then((r) => r.data),
  deletePage: (dashboardId: string, pageId: string) =>
    api.delete<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/pages/${pageId}`).then((r) => r.data),
  duplicatePage: (dashboardId: string, pageId: string) =>
    api.post<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/pages/${pageId}/duplicate`).then((r) => r.data),

  // ---- Phase 2 (2026-09-24): the canvas editor's own calls - every one of
  // these returns the WHOLE updated DashboardBuilderDetail (not just the
  // one block), same convention as generate/publish/unpublish above, so
  // the canvas can just replace its local state wholesale after each edit
  // instead of hand-patching one block in place. ----

  // Adds one empty block to a page - the "+ Add block" toolbar's
  // Chart/Table/KPI/Text choice. Filled in right after with askAiBlock or
  // buildManualBlock (or, for a text block, a plain updateBlock config
  // write).
  createBlock: (dashboardId: string, pageId: string, type: DashboardBlockType, title?: string) =>
    api
      .post<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/blocks`, {
        page_id: pageId,
        type,
        title: title || undefined,
      })
      .then((r) => r.data),

  // Partial update - the canvas calls this once per completed drag (x/y)
  // or resize (w/h) gesture (never on intermediate drag frames), a title
  // inline-edit calls it with just `title`, and a text block's body is
  // written through `config`.
  updateBlock: (
    dashboardId: string,
    blockId: string,
    payload: { x?: number; y?: number; w?: number; h?: number; title?: string; config?: Record<string, any> }
  ) => api.patch<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/blocks/${blockId}`, payload).then((r) => r.data),

  deleteBlock: (dashboardId: string, blockId: string) =>
    api.delete<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/blocks/${blockId}`).then((r) => r.data),

  // Fills a block in by asking a plain-English question against this
  // dashboard's own data source - reuses the exact same AI pipeline the
  // main chat uses. Two error shapes the caller should show inline rather
  // than as a generic failure toast: a 422, whose `detail` string IS the
  // clarifying question to show back (the block is left untouched so the
  // person can just try again with a clearer prompt); and a 502, whose
  // `detail` string is already a short, friendly message safe to show
  // as-is (see backend ai_engine.friendly_ai_error).
  askAiBlock: (dashboardId: string, blockId: string, prompt: string) =>
    api
      .post<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/blocks/${blockId}/ask-ai`, { prompt })
      .then((r) => r.data),

  // The non-AI "create by own" path - a plain column + aggregation form,
  // computed directly with pandas server-side (no AI call, no sandboxed
  // code execution). group_by_column is required for block_type
  // "table"/"chart" and ignored for "kpi"; chart_type is only used when
  // block_type is "chart" (defaults to "bar" server-side if omitted).
  // `filters` (2026-09-24, Phase 2b) are whichever cross-filters the
  // person currently has active on the page - pass the same array
  // previewFiltered below was last called with, so a brand-new block
  // starts out correctly filtered instead of jumping on the next change.
  // The server also stores this block's recipe, which is what makes IT
  // respond to a future filter change via previewFiltered.
  buildManualBlock: (
    dashboardId: string,
    blockId: string,
    payload: {
      metric_column: string;
      agg: ManualAgg;
      group_by_column?: string | null;
      block_type: ManualBlockType;
      chart_type?: RestyleChartType | null;
      filters?: FilterCriterion[];
      // 2026-09-25 (Round 3): only read server-side when block_type is
      // "gauge" - see ManualRecipe above.
      target_value?: number;
      max_value?: number;
    }
  ) =>
    api
      .post<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/blocks/${blockId}/build-manual`, payload)
      .then((r) => r.data),

  // Cross-filtering (2026-09-24, Phase 2b) - READ-ONLY, changes nothing on
  // the server. Call this every time the viewer's active filter selection
  // changes on a page; it returns only the blocks that could actually be
  // recomputed (anything built with "Build manually" - see ManualRecipe
  // above), and the caller merges those into local render state rather
  // than writing them into the persisted dashboard - a filter selection
  // is per-viewer and never saved. A block not present in the response
  // (an AI-built block, a filter block itself, or one that failed to
  // recompute) should be rendered exactly as it already is; the caller
  // never treats "missing from this response" as "clear this block."
  // Requires only VIEW access to the dashboard, not edit - and
  // deliberately has no public/no-login equivalent (see backend
  // routers/dashboard_builder.py's module docstring for why).
  previewFiltered: (dashboardId: string, pageId: string, filters: FilterCriterion[]) =>
    api
      .post<{ blocks: FilteredBlock[] }>(`/dashboard-builder/${dashboardId}/pages/${pageId}/preview-filtered`, { filters })
      .then((r) => r.data.blocks),

  // Switches an existing chart block to a different chart type - no AI
  // call, rebuilt deterministically from the tidy data already stored on
  // the block. Only works on a "chart" block that has result_columns/
  // result_rows attached (see DashboardBlock's config docs above) - a 400
  // here with a friendly message means that data isn't there yet.
  restyleBlock: (dashboardId: string, blockId: string, chartType: RestyleChartType, title?: string) =>
    api
      .patch<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/blocks/${blockId}/style`, {
        chart_type: chartType,
        title: title || undefined,
      })
      .then((r) => r.data),
};

// 2026-09-24 (Phase 3): a deliberately SEPARATE axios instance with NO
// interceptors, used only by the anonymous public/private dashboard
// viewer (PublicDashboardView.tsx). Two concrete reasons this can't just
// reuse the shared `api` instance above:
//   1. `api`'s request interceptor auto-attaches a real, logged-in GD360
//      user's own Authorization bearer token from localStorage to every
//      request, if one happens to exist in this browser - e.g. Gokul
//      testing his own private dashboard link while logged into his own
//      GD360 account in the same browser. That would silently clobber a
//      private-dashboard viewer token passed the normal way.
//   2. `api`'s response interceptor treats ANY 401 (other than a login/
//      register attempt) as "your GD360 session expired," clears the
//      real gd360_token/gd360_user from localStorage, and redirects to
//      /login. A private dashboard's own 401 ("enter your email") is a
//      completely different, expected, everyday state - it must never
//      log a real signed-in user out of their own account or bounce them
//      off the page they were looking at.
// So the viewer's own access token (from verify below) is sent as a
// custom X-Dashboard-Access-Token header, never the standard
// Authorization header, and a 401/403 here is just handled inline by the
// caller - see backend routers/dashboard_builder.py's own module
// docstring for the matching server-side reasoning.
const publicApi = axios.create({ baseURL: API_URL });

export const publicDashboardApi = {
  // A 404 here means "not currently published" (or the slug doesn't
  // exist at all - same message either way, no info leak). A 401 means
  // "this is a private dashboard - show the email/password gate." A 403
  // (only possible once a token IS supplied) means "that email's access
  // was revoked, or a stale/foreign token was passed."
  get: (slug: string, viewerToken?: string) =>
    publicApi
      .get<PublicDashboard>(`/public/dashboards/${slug}`, {
        headers: viewerToken ? { "X-Dashboard-Access-Token": viewerToken } : undefined,
      })
      .then((r) => r.data),
  // Submits the email/password gate. On success, returns a short-lived
  // access_token scoped to exactly this dashboard's share - pass it to
  // `get` above on every subsequent fetch. password is only checked by
  // the backend when this share actually has one set; send it whenever
  // the gate form has a password field showing.
  verify: (slug: string, email: string, password?: string) =>
    publicApi
      .post<{ access_token: string }>(`/public/dashboards/${slug}/verify`, { email, password: password || undefined })
      .then((r) => r.data.access_token),

  // 2026-09-24 (Phase 4, white-label): the hostname-keyed counterpart of
  // get/verify above, for when this SPA is being viewed through a
  // customer's own custom domain rather than GD360's own onrender.com URL
  // with a /d/:slug path in it - see PublicDashboardView.tsx for how it
  // decides which pair to call, and backend routers/dashboard_builder.py's
  // public_domains_router for the matching server side. Same error-shape
  // contract as get/verify above (404/401/403 mean the same things).
  getByHostname: (hostname: string, viewerToken?: string) =>
    publicApi
      .get<PublicDashboard>(`/public/domains/${encodeURIComponent(hostname)}`, {
        headers: viewerToken ? { "X-Dashboard-Access-Token": viewerToken } : undefined,
      })
      .then((r) => r.data),
  verifyByHostname: (hostname: string, email: string, password?: string) =>
    publicApi
      .post<{ access_token: string }>(`/public/domains/${encodeURIComponent(hostname)}/verify`, {
        email,
        password: password || undefined,
      })
      .then((r) => r.data.access_token),
};
