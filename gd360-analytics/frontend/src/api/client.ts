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

// 2026-10-07 (real end-to-end run): FastAPI answers a request-validation
// failure (HTTP 422) with `detail` as a LIST of {loc, msg, type} objects,
// not the plain string every HTTPException this backend raises carries.
// Dozens of call sites do `setError(err?.response?.data?.detail || "...")`
// and then render that value - with a list there, React throws "Objects
// are not valid as a React child" and the whole page goes blank (first
// seen on Register: an address the backend's email validator rejects but
// the browser's own type="email" check accepts, e.g. "name@company").
// Turning it into one readable sentence here, once, keeps every one of
// those call sites correct without each having to know about 422s.
export function errorDetailText(detail: unknown): string | undefined {
  if (detail == null) return undefined;
  if (typeof detail === "string") return detail;
  const one = (d: any): string => {
    if (typeof d === "string") return d;
    if (d && typeof d.msg === "string") {
      const loc = Array.isArray(d.loc) ? d.loc.filter((p: unknown) => typeof p === "string" && p !== "body" && p !== "query" && p !== "path") : [];
      const field = loc.length ? String(loc[loc.length - 1]).replace(/_/g, " ") : "";
      const msg = d.msg.replace(/^Value error,\s*/i, "");
      return field ? `${field.charAt(0).toUpperCase()}${field.slice(1)}: ${msg}` : msg;
    }
    if (d && typeof d.message === "string") return d.message;
    try { return JSON.stringify(d); } catch { return String(d); }
  };
  const text = (Array.isArray(detail) ? detail.map(one) : [one(detail)]).filter(Boolean).join(" ");
  return text || undefined;
}

function normalizeErrorDetail(err: any): void {
  const body = err?.response?.data;
  if (body && typeof body === "object" && !(typeof Blob !== "undefined" && body instanceof Blob) && body.detail != null && typeof body.detail !== "string") {
    body.detail = errorDetailText(body.detail);
  }
}

api.interceptors.response.use(
  (res) => res,
  (err) => {
    normalizeErrorDetail(err);
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
  // 2026-10-06 ("generated data is a saved query" layer) - see backend
  // schemas.DatasetVersionOut. For a warehouse/database source a table
  // built from a prompt is a SAVED QUERY (source_kind "warehouse_query"):
  // GD360 stores only its SQL definition, never a copy of the rows. The
  // fields below ride along so the Data tab can render such a table
  // without ever loading it; a file-backed version reports "file" (treat
  // a missing source_kind as "file" - an older backend never sends it)
  // and nulls everywhere else.
  source_kind?: "file" | "warehouse_query";
  // The standalone SQL definition (the `pushdown_sql` of the chat turn
  // that built it).
  query_sql?: string | null;
  // The short alias the definition is wrapped under as a CTE when a later
  // question chains on this table (`WITH <sql_alias> AS (...)`).
  sql_alias?: string | null;
  // The real warehouse table the definition reads from.
  source_table?: string | null;
  // Exact COUNT(*) of the definition, taken inside the warehouse at
  // creation (null if that count failed; /profile fills it in later).
  row_count?: number | null;
  // The definition's result schema captured at creation: [{name, type}].
  columns_json?: { name: string; type?: string | null }[] | null;
  parent_version_ids?: string[] | null;
  // 2026-10-06 (pro local-file Data tab): a file-backed version's own
  // cleaning log (inherited steps plus its own, same shape the preview
  // returns) so the versions rail can caption "reservation_status_date
  // -> date" without a preview call per version. For a file version
  // `row_count` above is its exact row count (not null).
  cleaning_log?: CleaningLogEntry[];
};

export function isWarehouseQueryVersion(v: Pick<DatasetVersion, "source_kind"> | null | undefined): boolean {
  return !!v && v.source_kind === "warehouse_query";
}

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

// Phase 2, feature 2 (persistent, editable semantic layer): a Flow-tab
// card's own saved overrides - see backend models.FlowAnnotation. Every
// field defaults to null when the card has never been annotated, meaning
// "use the computed default (its real name, the dagre auto-layout
// position)" exactly as the Flow tab always behaved before this feature
// existed. Spread directly onto a FlowVersion/FlowNode below rather than a
// separate parallel list, matching how the backend already embeds them.
export type FlowAnnotationFields = {
  display_label: string | null;
  description: string | null;
  position_x: number | null;
  position_y: number | null;
};

// A saved table, with its full lineage - which table(s) it was built
// from within THIS datasource (parent_version_ids can be several, e.g. a
// prompt that merged two saved tables together). A version predating this
// column may have parent_version_ids: null even though it does have a
// single parent_version_id - DataFlowMap treats that the same as [id].
export type FlowVersion = FlowAnnotationFields & {
  id: string;
  name: string;
  parent_version_id: string | null;
  parent_version_ids: string[] | null;
  step_count: number;
  created_at: string;
  // Flow tab transparency round: a real wall-clock measurement of how
  // long this table took to build, and a short, honest description of
  // what operation actually ran - both null for a version saved before
  // this existed. Never fabricated - see backend models.DatasetVersion.
  duration_ms: number | null;
  method_summary: string | null;
  // 2026-10-06 ("generated data is a saved query" layer): "warehouse_query"
  // for a saved-query table of a warehouse source (see DatasetVersion.
  // source_kind), with its exact row count and the real table it reads
  // from - so the Flow tab can label it honestly. Absent/"file" otherwise.
  source_kind?: "file" | "warehouse_query";
  row_count?: number | null;
  source_table?: string | null;
};

// One chart-producing or table-producing chat turn, anywhere in this data
// source's history (every past conversation, not just the one currently
// open) - the other half of the Flow map, alongside FlowVersion above.
// `sources` is null for a turn saved before this feature existed; the map
// falls back to treating those as sourced from "Original data".
export type FlowNode = FlowAnnotationFields & {
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
  // Flow tab transparency round - see FlowVersion's own comment above;
  // the same real measurement/classification, for a chart-producing turn.
  duration_ms: number | null;
  method_summary: string | null;
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
  // bigger than what this kind's effective preview cap (backend
  // config.py's effective_preview_cap - PREVIEW_ROW_LIMIT, or BigQuery's
  // own lower BIGQUERY_MAX_ROWS_LOADED) let this preview load - the
  // Totals row shows a small caveat instead of silently understating a
  // sum.
  stats_capped: boolean;
  // 2026-10-06 (NoSQL hybrid round 2): how many rows the connector
  // actually handed back before any column filter was applied (the raw
  // load size) - distinct from total_rows above, which is AFTER any
  // filter. Paging can never reach past this number, no matter what
  // total_rows or profile.exact_total_rows say - see DataTable.tsx's
  // stats_capped messaging, which shows this alongside the exact/
  // estimated total so a person can never mistake "rows loaded into this
  // preview" for "rows that really exist at the source."
  loaded_row_count: number;
  // 2026-10-06 (Mongo raw-document drawer round): the real MongoDB `_id`
  // string for each row in `rows` above, positionally aligned with it -
  // present ONLY when this preview is for a MongoDB datasource (see
  // backend preview_datasource, which omits this key entirely - never an
  // empty array - for every other datasource kind). DataTable.tsx uses
  // this to know which rows can open the raw-document drawer, and what
  // doc_id to send getMongoRawDocument below.
  doc_ids?: string[];
  // 2026-10-06 (profile-first Data tab): present ONLY when the preview was
  // requested with `sample_rows` (datasourceApi.previewSample below) for an
  // original warehouse/database table - see backend preview_datasource's
  // sample mode. `rows` is then the whole tiny example set (unfiltered,
  // unsorted, unpaged), total_rows/loaded_row_count equal its size (never
  // the real table count - that comes from DataProfile.exact_total_rows),
  // and `sample_sql` is the real statement shape the connector ran, shown
  // verbatim as the example-rows caption.
  sample_mode?: boolean;
  sample_rows?: number;
  sample_sql?: string;
  // 2026-10-06 ("generated data is a saved query" layer): present ONLY
  // when the sample was requested for a warehouse saved-query version
  // (datasourceApi.previewVersionSample) - the version's own definition
  // and lineage, copied from the version row so this one response is
  // self-contained. See DatasetVersion's identical fields.
  version_source_kind?: "warehouse_query";
  query_sql?: string | null;
  sql_alias?: string | null;
  source_table?: string | null;
  row_count?: number | null;
  columns_json?: { name: string; type?: string | null }[] | null;
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

// 2026-10-05 (Data-tab scale round): one column's real, full-table stats -
// see backend services/profiling.py's build_profile_query/parse_profile_row.
// Deliberately narrower than ColumnStat above (no sum/mean - see
// profiling.py's own comment on why AVG was left out across 5 SQL
// dialects): this is an honest, exact COUNT/MIN/MAX over EVERY row at the
// source, not a sample-derived estimate.
export type ProfileColumnStat = {
  non_null: number;
  null_pct: number;
  distinct: number | null;
  min: number | string | null;
  max: number | string | null;
  // 2026-10-06 (profile-first Data tab): the column's declared type from
  // the schema introspected at connect time (ds.schema_cache) - e.g.
  // "STRING"/"INT64" for BigQuery, "VARCHAR"/"INTEGER" for a SQL source.
  // Null when the schema has no entry for this column.
  type?: string | null;
  // The three most common values, most common first, ONLY for a column
  // whose exact distinct count is 1..50 - from ONE extra query per
  // profile run (BigQuery APPROX_TOP_COUNT / Snowflake APPROX_TOP_K / a
  // GROUP BY UNION ALL on the SQL kinds - see backend services/profiling.py
  // build_top_values_query). `pct` is the share of ALL rows
  // (exact_total_rows), so it lines up with the empty-cell percentages.
  // Absent when that second query failed or the column didn't qualify -
  // see DataProfile.top_values_computed.
  top_values?: ProfileTopValue[];
};

export type ProfileTopValue = { value: string | number | boolean | null; count: number; pct: number | null };

// What GET /datasources/{id}/profile returns - see backend
// routers/datasources.py profile_datasource. Every field after `supported`
// is optional because the four outcomes (unsupported kind, cached hit,
// too-expensive, real result) each fill in a different subset - DataTable.tsx
// must check `supported`/`too_expensive`/`error` before trusting any stat.
export type DataProfile = {
  // False for a kind this never runs against (Mongo, file uploads) - the
  // Data tab silently keeps its existing sample-based heuristic for those,
  // this is not a failure state.
  supported: boolean;
  // True only when this profile's cost would have exceeded the same shared
  // per-user daily pushdown budget chat.ts's BigQuery/Snowflake queries are
  // governed by (see services/pushdown_budget.py) - a real governance
  // outcome, not an error.
  too_expensive?: boolean;
  message?: string;
  // True when the real query failed for some other reason - the Data tab
  // must fall back to its existing preview-based stats, never show a blank
  // or broken profile strip.
  error?: boolean;
  exact_total_rows?: number;
  columns?: Record<string, ProfileColumnStat>;
  profiled_columns?: string[];
  // True when the table has more columns than MAX_PROFILE_COLUMNS - only
  // the first N were profiled, so the strip should say so rather than
  // silently look complete.
  truncated_columns?: boolean;
  // True when this came back from the 5-minute in-process TTL cache rather
  // than a fresh query - lets the UI skip a loading flicker on repeat opens
  // without claiming the number was just re-measured.
  cached?: boolean;
  // 2026-10-06 (NoSQL hybrid round): real, previously-discarded numbers
  // from backend routers/datasources.py's profile_datasource -
  // `bytes_scanned` is the connector's own run_pushdown_query result
  // (already metered for the shared daily cost budget - see
  // services/pushdown_budget.py), only ever present for bigquery/
  // snowflake (the only two kinds that run a real metered pushdown query
  // here); every other supported kind omits this key entirely, never
  // sends a fabricated 0. `cached_at` is the real epoch-seconds timestamp
  // this result was computed/stored, present whenever `supported` is
  // true - DataTable.tsx uses it to show a genuine "cached Xm ago"
  // instead of guessing from the TTL alone.
  bytes_scanned?: number;
  cached_at?: number;
  // 2026-10-06 (profile-first Data tab): real wall-clock milliseconds the
  // profile's queries took at the source (the main aggregate plus the
  // optional top-values query) - the "Profile cost" tile's duration.
  // Rides along unchanged through a cache hit (it describes the cached
  // computation, not this request).
  duration_ms?: number;
  // True when the second, top-values query ran and succeeded this time -
  // False means low-cardinality columns simply carry no top_values (none
  // qualified, or that query failed), never that they have no values.
  top_values_computed?: boolean;
  // 2026-10-06 (NoSQL hybrid round 2): a cheap, APPROXIMATE document-count
  // signal - present ONLY when ds.kind === "mongodb" (MongoConnector.
  // estimate_row_count, via pymongo's estimated_document_count - a fast
  // metadata read, never a full collection scan). Every other unsupported
  // kind (csv/excel/api/googlesheets/microsoft_excel) has no equivalent
  // cheap estimate and never gets this key. Deliberately named
  // differently from exact_total_rows above - this is always an estimate,
  // never exact, and DataTable.tsx must show it with a "~"/"estimated"
  // label, never the exact pill's checkmark.
  estimated_total_rows?: number;
  // 2026-10-06 (pro local-file Data tab): "gd360" when the profile was
  // computed with pandas inside GD360 over a COMPLETE uploaded CSV/Excel
  // file (backend services/file_import.py profile_dataframe) - such a
  // profile never carries bytes_scanned. Absent for a warehouse profile.
  computed_in?: "gd360";
};

// 2026-10-06 (pro local-file Data tab) - the import pipeline for an
// uploaded CSV/Excel file. See backend routers/datasources.py
// get_file_import / rerun_file_import and services/file_import.py.
export type FileImportSettings = {
  sheet: string | null;
  header_row: number;
  delimiter: "auto" | "," | "\t" | ";" | "|";
  decimal: "." | ",";
  thousands: "auto" | "," | "." | " " | "none";
  date_format: "auto" | "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY/MM/DD" | "DD-MM-YYYY" | "MM-DD-YYYY";
  trim_whitespace: boolean;
  skip_empty_rows: boolean;
};

export type FileTypeFix = {
  column: string;
  kind: "to_date" | "to_number" | "to_bool";
  from: string;
  to: string;
  matched: number;
  total: number;
  lost: number;
};

// The summary of the last import run for one sheet - every number is a
// count over the whole sheet.
export type FileImportSummary = {
  sheet: string | null;
  header_row: number;
  delimiter: string;
  date_format: string;
  rows: number;
  columns: number;
  type_fixes: FileTypeFix[];
  fixed_count: number;
  errors: number;
  mixed_type_columns: Record<string, number>;
  imported_at: string;
};

export type FileImportState = {
  kind: "csv" | "excel";
  filename: string | null;
  size_bytes: number;
  sheets: { name: string; rows: number | null; cols: number | null }[];
  // The sheet this state describes (null for a CSV / single-sheet file).
  sheet: string | null;
  sheet_key: string;
  detected: { header_row: number; delimiter: string | null; encoding: string | null; date_format: string | null };
  settings: FileImportSettings;
  // null until an import has run for this sheet (an upload that predates
  // this layer) - the Data tab then offers "Run import".
  summary: FileImportSummary | null;
  imported: boolean;
  uploaded_at: string | null;
  uploaded_by: string | null;
  uploaded_by_initials: string | null;
};

// One cleaning suggestion computed over the whole file - see backend
// services/file_import.py suggest_cleaning. `affected_rows` is exact.
export type CleaningSuggestion = {
  id: string;
  kind: "to_date" | "to_number" | "to_bool" | "drop_duplicates" | "fill_empty" | "trim_whitespace" | "standardise";
  column: string | null;
  title: string;
  reason: string;
  affected_rows: number;
  params: Record<string, any>;
};

export type CleaningSuggestions = {
  suggestions: CleaningSuggestion[];
  total_rows: number;
  version_id: string | null;
  computed_in: "gd360";
  duration_ms: number;
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
  // The workspace this source lives in (backend DataSourceOut) - whose
  // brand kit its dashboards and chat charts start from.
  workspace_id?: string | null;
  connection_info: Record<string, unknown>;
  read_only: boolean;
  schema_cache?: Record<string, unknown> | null;
  created_at: string;
  // 2026-09-28 (streaming/webhook ingestion round): only ever set for
  // kind === "streaming" - the last time this source actually received a
  // real webhook event. Drives the "live" pulsing-dot badge (see
  // pages/DataSources.tsx) - null/undefined means "never received one".
  last_event_at?: string | null;
  // Phase 2, feature 4 (generic API/webhook PULL connector): only ever set
  // for kind === "api" - the last time this source's URL was successfully
  // fetched (at connect time, or a later manual refresh). Drives the "last
  // refreshed X ago" / "never refreshed" text on its card (see
  // pages/DataSources.tsx) - never a fabricated value.
  api_last_refreshed_at?: string | null;
  // 2026-10-08 (round 11): synced app sources only (shopify, ga4, meta_ads,
  // google_ads) - see api/projects.ts appsApi.
  last_synced_at?: string | null;
  next_sync_at?: string | null;
  sync_error?: string | null;
  // 2026-09-30 (data catalog v1): a short, optional, human-written blurb of
  // what this data source is - see backend models.DataSource.description's
  // own comment. Never computed or inferred, unlike schema_cache above.
  description?: string | null;
};

// 2026-09-28 (streaming/webhook ingestion round): what connect_streaming/
// regenerate_webhook_secret return - a normal DataSourceSummary PLUS the
// webhook URL and secret, shown to the person exactly ONCE right after
// creation (or a deliberate regenerate) and never fetchable again after
// that, same as every other credential in this app (see DataSourceForm's
// own module note).
export type StreamingDataSourceCreated = DataSourceSummary & {
  webhook_url: string;
  webhook_secret: string;
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

  // 2026-10-06 (profile-first Data tab): a tiny set of EXAMPLE rows for an
  // original warehouse/database table - the connector is asked for exactly
  // `sampleRows` rows at the query level (LIMIT n / TOP n), never the
  // usual preview cap. No version id, no filters/sort/paging: the rows are
  // read-only examples under the full-table profile, and every real
  // number on that tab comes from `profile` above. See backend
  // preview_datasource's `sample_rows` param; for any non-warehouse kind
  // the backend ignores sample_rows and answers like a plain preview.
  previewSample: (id: string, table?: string | null, sampleRows = 20) =>
    api
      .get<DataPreview>(`/datasources/${id}/preview`, {
        params: { table: table || undefined, sample_rows: sampleRows },
      })
      .then((r) => r.data),

  // 2026-10-06 ("generated data is a saved query" layer): the example rows
  // of a warehouse SAVED-QUERY version - `SELECT * FROM (<definition>)
  // LIMIT n` run inside the warehouse (see backend preview_datasource's
  // version branch). This is the ONLY way to read rows of such a version:
  // the same call without `sample_rows` is a 400 there, never a grid.
  previewVersionSample: (id: string, versionId: string, sampleRows = 20) =>
    api
      .get<DataPreview>(`/datasources/${id}/preview`, {
        params: { version_id: versionId, sample_rows: sampleRows },
      })
      .then((r) => r.data),

  // 2026-10-06 (Mongo raw-document drawer round): the real, unflattened
  // MongoDB document behind one Data-tab row - `docId` is one of the
  // `_id` strings DataPreview.doc_ids returned alongside that row, and
  // `table` is the collection name (same as `preview`'s own `table`
  // param - left undefined for a single-collection datasource exactly
  // the way `preview` already leaves its own `table` param undefined
  // then, and resolved server-side the same way). See backend
  // get_mongo_raw_document for why this is cheap to call on every
  // drawer-open (a single indexed find_one).
  getMongoRawDocument: (id: string, docId: string, table?: string | null) =>
    api
      .get<{ document: unknown }>(`/datasources/${id}/mongo-document`, { params: { doc_id: docId, table: table || undefined } })
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

  // 2026-10-05 (Data-tab scale round): real, exact full-table stats - see
  // backend routers/datasources.py profile_datasource. `table` only (no
  // versionId) since this profiles a real connected table at its source,
  // never a saved/AI-built table (those have no live source to query).
  // Called lazily by DataTable.tsx once per table open, not on every
  // preview page - the backend's own 5-minute TTL cache keeps repeat opens
  // cheap and fast without this client needing its own cache.
  profile: (id: string, table?: string | null) =>
    api
      .get<DataProfile>(`/datasources/${id}/profile`, {
        params: { table: table || undefined },
      })
      .then((r) => r.data),

  // 2026-10-06 ("generated data is a saved query" layer): the same full
  // profile for a warehouse SAVED-QUERY version - the aggregate query runs
  // over `(<definition>) AS gd360_v` inside the warehouse (see backend
  // profile_datasource's version_id branch). Same response shape as
  // `profile` above; a file-backed version answers `supported: false`.
  profileVersion: (id: string, versionId: string) =>
    api
      .get<DataProfile>(`/datasources/${id}/profile`, {
        params: { version_id: versionId },
      })
      .then((r) => r.data),

  // Every saved table and every chart/analysis ever built for this data
  // source, across every past conversation - the raw material for the
  // Flow tab's data-lineage map (components/DataFlowMap.tsx). See
  // backend routers/datasources.py get_data_flow for exactly what this
  // reads back (nothing is computed fresh server-side either).
  getFlow: (id: string) => api.get<DataFlow>(`/datasources/${id}/flow`).then((r) => r.data),

  // Phase 2, feature 2: upserts one Flow-tab card's persistent annotation -
  // any subset of the four fields, see backend upsert_flow_annotation.
  updateFlowAnnotation: (
    id: string,
    nodeKey: string,
    patch: { display_label?: string | null; description?: string | null; position_x?: number; position_y?: number }
  ) =>
    api
      .patch<FlowAnnotationFields & { node_key: string; updated_at: string }>(
        `/datasources/${id}/flow/annotations/${encodeURIComponent(nodeKey)}`,
        patch
      )
      .then((r) => r.data),

  // Phase 2, feature 4: connects a generic read-only REST API source, and
  // manually re-fetches it later - see backend connect_api/refresh_api.
  createApi: (payload: { name: string; url: string; auth_header_name?: string; auth_header_value?: string; json_path?: string }) =>
    api.post<DataSourceSummary>("/datasources/api", payload).then((r) => r.data),

  refreshApi: (id: string) => api.post<DataSourceSummary>(`/datasources/${id}/api/refresh`).then((r) => r.data),

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

  // 2026-09-30 (data catalog v1): a short, plain-English blurb of what this
  // data source actually is - editable tier (not owner-only, unlike rename
  // above) - see backend models.DataSource.description's own comment.
  // Passing an empty/whitespace-only string clears it back to null.
  updateDescription: (id: string, description: string) =>
    api.patch<DataSourceSummary>(`/datasources/${id}/description`, { description }).then((r) => r.data),

  renameVersion: (id: string, versionId: string, name: string) =>
    api.patch<{ id: string; name: string }>(`/datasources/${id}/versions/${versionId}`, { name }).then((r) => r.data),

  deleteVersion: (id: string, versionId: string) => api.delete(`/datasources/${id}/versions/${versionId}`),

  // 2026-10-06 (pro local-file Data tab) - see FileImportState. `table` is
  // the sheet name of a multi-sheet workbook (undefined = first/only).
  getFileImport: (id: string, table?: string | null) =>
    api.get<FileImportState>(`/datasources/${id}/import`, { params: { table: table || undefined } }).then((r) => r.data),

  // Re-runs the import for one sheet with these settings (any subset; the
  // rest keep their current value) and returns the refreshed state. The
  // backend reloads the frame from the stored bytes, re-infers and
  // applies type fixes, refreshes the schema and drops its caches.
  rerunFileImport: (id: string, settings: Partial<FileImportSettings>) =>
    api.post<FileImportState>(`/datasources/${id}/import`, settings).then((r) => r.data),

  // Up to 8 cleaning suggestions over the whole sheet / saved version.
  getCleaningSuggestions: (id: string, versionId: string | null, table?: string | null) =>
    api
      .get<CleaningSuggestions>(`/datasources/${id}/cleaning-suggestions`, {
        params: { version_id: versionId || undefined, table: versionId ? undefined : table || undefined },
      })
      .then((r) => r.data),

  // Applies the chosen suggestions in order and saves a NEW version (the
  // original is never changed); returns that version's list entry plus
  // `applied` (one cleaning-log entry per step).
  applyCleaningSuggestions: (id: string, ids: string[], versionId: string | null, table?: string | null) =>
    api
      .post<DatasetVersion & { applied: CleaningLogEntry[] }>(`/datasources/${id}/cleaning-suggestions/apply`, {
        ids,
        version_id: versionId || undefined,
        table: versionId ? undefined : table || undefined,
      })
      .then((r) => r.data),

  // Removes a connected data source entirely - used by the "New data" flow
  // to clean up an abandoned Google Sheets/Excel OAuth connect (see
  // connectionsApi below), and available anywhere else a "delete this data
  // source" action is added later.
  delete: (id: string) => api.delete(`/datasources/${id}`),

  // 2026-09-28 (streaming/webhook ingestion round): creates the
  // kind==="streaming" connector - see StreamingDataSourceCreated's own
  // comment for why the webhook URL/secret only ever come back from this
  // call and regenerateWebhookSecret below, never from a plain list/get.
  createStreaming: (name: string) =>
    api.post<StreamingDataSourceCreated>("/datasources/streaming", { name }).then((r) => r.data),

  // Mints a brand-new webhook secret, immediately invalidating the old
  // one - owner-only, same tier as delete() above. Used from the Data
  // Sources page when a person has lost their original secret or wants to
  // revoke a leaked one.
  regenerateWebhookSecret: (id: string) =>
    api.post<StreamingDataSourceCreated>(`/datasources/${id}/webhook/regenerate`).then((r) => r.data),

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

  // 2026-10-06 ("generated data is a saved query" layer): the "Download N
  // rows" exit for a warehouse saved-query table - GET /datasources/{id}/
  // versions/{vid}/download streams the definition's rows straight from
  // the warehouse's own row iterator to the browser as CSV (see backend
  // download_warehouse_version: never to_dataframe(), capped at
  // WAREHOUSE_DOWNLOAD_MAX_ROWS with a trailing comment row when hit).
  // Fetched through the same authenticated axios instance and saved via a
  // blob exactly the way downloadExport above does, so the bearer token
  // never ends up in a URL. A file-backed version is a 400 here - those
  // keep using downloadExport.
  downloadVersionCsv: async (id: string, versionId: string) => {
    const res = await api.get(`/datasources/${id}/versions/${versionId}/download`, { responseType: "blob" });
    const disposition: string = res.headers["content-disposition"] || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : "saved-query.csv";
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
  // 2026-10-08 (round 11): "project" = a multi-source Project (opens
  // /p/:id), "analysis" = the one-source analysis chat (/workspace/:id).
  kind?: "project" | "analysis";
  source_ids?: string[];
  // 2026-10-10 (Library): how many dashboards were made from this item.
  dashboard_count?: number;
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
  // "needs_query_help" (2026-10-06, warehouse-honesty round): a warehouse
  // question that could NOT be run inside the warehouse - nothing was
  // computed, and the pushdown_* / builder_* fields below say what was
  // tried and how to finish it. See backend schemas.ChatResponse.
  action: "analyze" | "transform" | "clarify" | "explain" | "needs_query_help" | null;
  // 2026-09-28: the real WORKING ON selection this turn actually ran
  // against (see backend routers/chat.py _load_selected_tables' own
  // "sources manifest" docstring for the exact shape) plus which new
  // saved table it produced, if any - both already stored on Message
  // server-side, exposed here so Workspace.tsx's restore-on-refresh
  // effect can rebuild the real selection instead of guessing at it.
  sources: { kind: "original" | "sheet" | "version"; label: string; datasource_id: string | null; version_id: string | null; sheet: string | null }[] | null;
  new_version_id: string | null;
  // See backend models.Message.steps' own docstring - the real "what I
  // did" trace, restored here so it still shows under a past turn too.
  steps: { label: string; detail?: string | null }[] | null;
  // 2026-09-28 (multi-result round): the extra chart/table cards beyond
  // the first, and the honest trustworthiness caveat - see backend
  // models.Message.results/self_critique and ai_engine._build_result_entry
  // for the exact shape of one entry.
  results: ResultEntry[] | null;
  self_critique: string | null;
  // 2026-09-29 (plain-language findings round): the real method label, the
  // real code that ran, and how long this whole turn actually took - see
  // backend schemas.ChatResponse's identical fields. Restored here too so
  // reopening a saved conversation still shows a "Show calculation" toggle
  // under a past turn, not only a freshly-sent live one.
  method_summary: string | null;
  code: string | null;
  duration_ms: number | null;
  // 2026-10-06 (pushdown-honesty round): whether this turn ran a real
  // query directly against the warehouse/database, or fell back to
  // analyzing a loaded, row-capped in-memory sample - see backend
  // models.Message.used_pushdown/sample_row_count's own docstring for the
  // full reasoning. used_pushdown is null for a kind pushdown is never
  // attempted for (a file upload). sample_row_count is set only when
  // used_pushdown is false AND this kind is pushdown-eligible.
  used_pushdown: boolean | null;
  sample_row_count: number | null;
  // 2026-10-06 (warehouse-honesty round): what actually ran inside the
  // warehouse for this turn, or why it could not - see WarehouseTurnFields
  // below and backend routers/conversations.py get_conversation_messages.
  // builder_columns is deliberately NOT restored per message (it is
  // derived from the data source's own schema_cache, which Workspace.tsx
  // already holds as dsInfo.schema_cache - see builderColumnsFromSchema in
  // components/WarehouseTurn.tsx). exact_total_rows is not persisted on
  // the message row either, so a restored turn falls back to the "every
  // row" wording.
  pushdown_sql?: string | null;
  pushdown_provider?: string | null;
  pushdown_bytes_scanned?: number | null;
  pushdown_duration_ms?: number | null;
  pushdown_result_rows?: number | null;
  pushdown_attempts?: PushdownAttempt[] | null;
  pushdown_skipped_reason?: PushdownSkippedReason | null;
  builder_suggestion?: QueryBuilderSpec | null;
  exact_total_rows?: number | null;
  // 2026-10-07 ("say what was filtered"): see QueryFilters below.
  query_filters?: QueryFilters | null;
  created_at: string;
};

// ---- 2026-10-06 (warehouse-honesty round) ---------------------------
// For a warehouse/database data source (BigQuery/Snowflake/Postgres/MySQL/
// SQL Server/Supabase/MongoDB) a chat question is answered ONLY by a real
// query run inside the warehouse over every row - never by analyzing a
// row-capped sample. These mirror backend schemas.ChatResponse's new
// fields and schemas_extra.QueryBuilderSpec exactly; see those files'
// own comments for the full contract.

export type QueryBuilderAgg = "count" | "sum" | "avg" | "min" | "max" | "count_distinct";
export type QueryBuilderOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "is_null" | "is_not_null" | "in";
export type QueryBuilderOrderBy = "measure_desc" | "measure_asc" | "group";

export type QueryBuilderFilter = {
  column: string;
  op: QueryBuilderOp;
  // A single number/string for the comparison ops, a list for "in",
  // omitted/null for is_null / is_not_null.
  value?: string | number | (string | number)[] | null;
};

// The deterministic "finish it yourself" spec: turned into SQL server-side
// with zero language-model involvement (backend services/query_builder.py).
// Every table/column must exist in the data source's own schema or the
// request is rejected with HTTP 400.
export type QueryBuilderSpec = {
  table: string;
  group_by: string[];
  measure: string | null;
  agg: QueryBuilderAgg;
  filters: QueryBuilderFilter[];
  order_by?: QueryBuilderOrderBy | null;
  limit?: number;
};

export type PushdownAttemptStatus =
  | "ok"
  | "rejected_unsafe"
  | "rejected_too_expensive"
  | "error"
  | "not_possible"
  | "needs_table"
  | "generation_failed"
  // 2026-10-06 ("generated data is a saved query" layer): a table
  // definition that passed validation (read-only check, dry run, schema
  // probe) and became the saved query - the "ran" of a table turn.
  | "validated";

export type PushdownAttempt = {
  sql: string | null;
  status: PushdownAttemptStatus;
  error: string | null;
};

export type PushdownSkippedReason =
  | "daily_budget"
  | "empty_schema"
  | "restricted_role"
  | "unsupported_selection"
  | "needs_table"
  | "not_possible"
  // 2026-10-06 ("generated data is a saved query" layer): no safe table
  // definition could be written/validated, so no saved query was created
  // (and nothing was built from a sample). builder_suggestion is always
  // null with it - an aggregate builder cannot define a table of rows;
  // the person's way forward is the raw-SQL editor with "Save as table".
  | "table_failed";

// {table: [{name, type}]} for the tables in scope - what the builder's
// selects populate from, straight from the data source's own schema.
export type BuilderColumns = Record<string, { name: string; type: string | null }[]>;

// The fields a live /chat response carries on top of the older ones -
// Workspace.tsx reads these straight off the axios response and maps them
// onto ChatPanel's ChatTurn (see its warehouse fields).
// 2026-10-07 (chart-integrity round, "say what was filtered"): the row
// filters behind an answer's numbers - read off the SQL that ran by the
// backend (services/sql_filters.py) and stored on the message. See backend
// models.Message.query_filters for the full meaning of each field.
//   parsed     false = the statement could not be read; nothing is claimed
//   filters    each WHERE predicate / conditional aggregate / HAVING
//   text       the one line to show ("Filters applied by this query: ...");
//              null when there are no filters (or parsed is false)
//   writer_note  the SQL writer's own statement of a filter it added that
//                the question did not ask for
//   carried    true when the filters come from the saved table(s) a pandas
//              answer was computed over
export type QueryFilter = {
  kind: "where" | "conditional" | "having";
  predicate: string;
  label?: string | null;
  table?: string | null;
  applies_to?: string | null;
  source: "query" | "saved_table";
  saved_table?: string | null;
};
export type QueryFilters = {
  parsed: boolean;
  filters: QueryFilter[];
  tables?: string[];
  text?: string | null;
  writer_note?: string | null;
  carried?: boolean;
};

/** The quiet line under a chart's title. null = say nothing (a file
 *  answer with nothing to report, or a statement that could not be read). */
export function queryFiltersLine(q: QueryFilters | null | undefined): string | null {
  if (!q || !q.parsed) return null;
  if (q.text) return q.writer_note ? `${q.text} \u00b7 GD360 added a filter that was not in your question: ${q.writer_note}` : q.text;
  if (q.carried) return null;
  return "Filters applied by this query: none \u2014 every row is included";
}

export type WarehouseTurnFields = {
  pushdown_sql?: string | null;
  pushdown_provider?: string | null;
  pushdown_bytes_scanned?: number | null;
  pushdown_duration_ms?: number | null;
  pushdown_result_rows?: number | null;
  pushdown_attempts?: PushdownAttempt[] | null;
  pushdown_skipped_reason?: PushdownSkippedReason | null;
  builder_suggestion?: QueryBuilderSpec | null;
  builder_columns?: BuilderColumns | null;
  exact_total_rows?: number | null;
  query_filters?: QueryFilters | null;
};

// The two optional, mutually exclusive ways to finish a warehouse question
// the AI could not turn into a query - sent on the same POST /chat body
// Workspace.tsx's runPrompt already builds (see its `finish` option).
// `prompt` is still required with either one: it is stored as the person's
// own message, so the frontend sends the builder's plain-words summary, or
// a short label for a hand-written query.
export type ChatFinishRequest =
  | { query_builder: QueryBuilderSpec; raw_sql?: undefined; save_as_table?: undefined }
  // 2026-10-06 ("generated data is a saved query" layer): with
  // `save_as_table: true` the person's own SELECT becomes a saved-query
  // table inside the warehouse (validated exactly like an AI-written
  // definition, never charted) - see backend schemas_extra.ChatRequestFull.
  // save_as_table and routers/chat.py's raw_sql branch. SQL kinds only.
  | { raw_sql: string; query_builder?: undefined; save_as_table?: boolean };

// The prompt stored as the person's own message when their SQL is saved
// as a table - one literal, shared by every surface that offers the
// "Save as table" checkbox so the conversation reads the same everywhere.
export const SAVE_AS_TABLE_PROMPT = "My own SQL (saved as a table)";

// One named chart/table card of a multi-result answer (see
// ai_engine._build_result_entry) - the same shape the top-level
// chart_spec/result_* fields already use, just labeled and one of several.
export type ResultEntry = {
  label: string;
  chart_spec: any;
  chart_type: string | null;
  result_columns: any;
  result_rows: any;
  result_row_count: number | null;
  result_truncated: boolean;
  // 2026-09-28 (named-results round): when this card's data was genuinely
  // tabular (see backend chart_builder.result_to_dataframe), it was also
  // saved as its own real, selectable table - see
  // routers/chat.py._save_named_results. version_id is that table's id
  // (the same id a WORKING ON entry or a Data-tab table carries), so a
  // person can pick it as the starting point for their next question the
  // same way they would pick any other saved table. Both null when this
  // particular piece could not be saved as a table (e.g. a bare scalar) -
  // it still shows as a chat card, it just is not chainable.
  version_id?: string | null;
  version_name?: string | null;
  // 2026-09-29 (parallel-pieces round): when this piece ran as its own
  // independent sandboxed call (see ai_engine's result_pieces plan field),
  // this is really when it finished relative to when the whole batch
  // started - not a fabricated stagger. ChatPanel.tsx's MultiResultCards
  // uses it to reveal each card at roughly the real moment it became
  // available, instead of only ever revealing all of them together.
  // Undefined/null for a piece that ran the older way (one shared script
  // computing every piece together) - those all finish at the same instant
  // by construction, so there is nothing real to stagger.
  completed_offset_ms?: number | null;
  // 2026-09-29 (plain-language findings round): a real, grounded plain-
  // English finding for THIS one card specifically (see backend
  // ai_engine._attach_entry_insights) - before this, only the turn's first/
  // primary result ever got one; every other named result showed a bare
  // chart/table with no finding of its own. Computed from this card's own
  // real numbers the exact same no-fabrication way the single-result
  // Insight box always has been. null only in the (essentially impossible
  // in practice) case that this card's own raw value could not be matched
  // up for insight generation - never a placeholder or invented text.
  insight?: string | null;
  // The real method label and the real code that produced this card - see
  // schemas.ChatResponse's identical top-level fields for the full
  // rationale. duration_ms is this card's own real measured wall-clock
  // time when it ran as its own independent piece (see
  // completed_offset_ms above) - null when shared_code is true, since the
  // dict-in-`code` multi-result path has no way to attribute one shared
  // script's total time to any single card without overstating precision
  // it doesn't have (see ai_engine's own comment on this). shared_code
  // marks that case: true means `code` is the ONE script that also
  // produced every other card in this same answer, not something unique to
  // just this one - the "Show calculation" UI says so rather than implying
  // a false per-card precision.
  method_summary?: string | null;
  code?: string | null;
  duration_ms?: number | null;
  shared_code?: boolean | null;
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

// 2026-10-07 (identity-colour round): the appearance document's types live
// with the code that resolves it (src/dashboard/theme/appearance.ts). The
// import sits here, not at the top, so the lines above keep their numbers.
import type { BrandKit, ColorRegistry, DashboardAppearance } from "../dashboard/theme/appearance";

export type WorkspaceSummary = {
  id: string;
  name: string;
  is_personal: boolean;
  role: WorkspaceRole; // the CURRENT signed-in person's role in this workspace
  member_count: number;
  datasource_count: number;
  invite_token: string;
  created_at: string;
  // 2026-10-07 (identity-colour round): the workspace brand kit (null =
  // none) - see workspaceApi.getBrandKit.
  brand_kit?: BrandKit | null;
};

export type WorkspaceBrandKit = { workspace_id: string; workspace_name: string; brand_kit: BrandKit | null; can_edit: boolean };

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
  // 2026-10-07 (identity-colour round): the workspace brand kit - the look
  // every dashboard of the workspace starts from. Any member reads it;
  // only the owner writes it (null clears it).
  getBrandKit: (id: string) => api.get<WorkspaceBrandKit>(`/workspaces/${id}/brand-kit`).then((r) => r.data),
  setBrandKit: (id: string, kit: BrandKit | null) => api.put<WorkspaceBrandKit>(`/workspaces/${id}/brand-kit`, { brand_kit: kit }).then((r) => r.data),
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
  // 2026-10-10 (one kind of dashboard): what it was made from - an answer
  // (/p/:id) or an analysis (/workspace/...) - for its "Made from" line.
  source_kind?: "answer" | "analysis" | null;
  source_title?: string | null;
  source_id?: string | null;
  source_datasource_id?: string | null;
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
  // 2026-10-10: a classic chart board becomes a full dashboard in place
  // (same id/link, name and sharing; every pinned chart kept).
  upgrade: (id: string) => api.post<DashboardSummary>(`/dashboards/${id}/upgrade`).then((r) => r.data),
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
// 2026-09-25 (Round 15, element library): "heading" | "divider" added -
// two pure-layout widgets alongside the original data block types, both
// drag-and-droppable from the canvas's new element library the same way
// every other type already is.
// 2026-10-07 (analyst canvas round): "sql" | "input" added - the two canvas
// cell kinds (see backend routers/dashboard_builder.py, "Canvas cells").
export type DashboardBlockType = "chart" | "table" | "kpi" | "text" | "filter" | "gauge" | "donut" | "sparkline" | "avatar_list" | "heading" | "divider" | "sql" | "input";

// ---- Warehouse-native dashboards (2026-10-06/07) - the contract behind the
// Option A dashboard view (src/dashboard/). Every shape here mirrors the
// backend verbatim: services/query_builder.py (BlockSpec), services/
// dashboard_engine.py (BlockResult), schemas.py (RunPageRequest/Out,
// ParameterOptionsOut, BlockSqlOut, UpgradeBlocksOut) and the parameter /
// saved-view dicts _validate_parameters / update_saved_views write. ----

export type BlockSpecMeasure = {
  alias: string;
  agg: "count" | "sum" | "avg" | "min" | "max" | "count_distinct";
  column?: string | null;
  expr?: string | null;
};
export type BlockSpecFilter = { column: string; op: string; value?: any };
// 2026-10-07 (chart-types round): two grammar extensions, each present
// only when used (backend services/query_builder.py):
//   date_parts  dimensions derived from a date column - the weekday or the
//               month-of-year of each row, as an integer (weekday 1 =
//               Monday .. 7 = Sunday, month 1..12, quarter 1..4, day 1..31,
//               hour 0..23). What a "month x weekday" heatmap groups by.
//   bins        a histogram of one numeric column; the bin edges are
//               computed in the warehouse (see BlockResult.bins).
export type BlockSpecDatePart = { column: string; part: "weekday" | "month" | "quarter" | "day" | "hour"; alias?: string };
export type BlockSpecBins = { column: string; count?: number; min?: number | null; max?: number | null; integer?: boolean };
export type BlockSpec = {
  table: string;
  time?: { column: string; grain: "day" | "week" | "month" | "quarter" | "year" } | null;
  group_by?: string[];
  measures: BlockSpecMeasure[];
  filters?: BlockSpecFilter[];
  order_by?: { by: string; dir: "asc" | "desc" }[];
  limit?: number;
  compare_prior_period?: boolean;
  sparkline?: boolean;
  date_parts?: BlockSpecDatePart[];
  bins?: BlockSpecBins | null;
};

// ---- Forecast and anomalies (2026-10-07) - backend services/forecast.py.
// A block with config.forecast = {horizon, interval, anomalies} gets
// `forecast` and `anomalies` in its run result, computed on the server
// from the block's aggregated series (never raw rows). ----
export type ForecastOptions = { horizon: number; interval: "80" | "95" | "both"; anomalies?: boolean };
export type ForecastPoint = { period: string; value: number; lo80?: number; hi80?: number; lo95?: number; hi95?: number };
export type ForecastBacktest = {
  mape: number | null; smape: number | null; mase: number | null; mae: number | null; folds: number; horizon: number;
  baseline?: { method: string; method_key: string; mape: number | null; smape: number | null; mae: number | null } | null;
};
export type ForecastSeries = {
  key: string;
  measure: string;
  status: "ok" | "refused";
  reason: string | null;
  points: ForecastPoint[];
  method: string | null;
  method_key?: string | null;
  season_length: number | null;
  backtest: ForecastBacktest | null;
  notes: string[];
  fitted_through?: string;
  excluded?: string[];
  horizon?: number;
};
export type PartialPeriods = {
  first: { period: string; from?: string; days: number; of: number } | null;
  last: { period: string; through?: string; days: number; of: number } | null;
};
export type BlockForecast = {
  status: "ok" | "refused";
  reason: string | null;
  horizon: number;
  interval: "80" | "95" | "both";
  grain: string;
  points: ForecastPoint[];
  method: string | null;
  season_length: number | null;
  backtest: ForecastBacktest | null;
  notes: string[];
  series: ForecastSeries[];
  partial?: PartialPeriods;
  anomalies?: BlockAnomaly[];
};
export type BlockAnomaly = { period: string; value: number; expected: number; lo: number; hi: number; direction: "up" | "down"; series?: string; measure?: string };
export type HistogramBins = { column: string; start: number; width: number; count: number; end: number; integer: boolean; underflow: boolean; overflow: boolean; stats?: Record<string, number | null> | null };

// A rail control's definition (Dashboard.parameters[]). `control` is one of
// backend _PARAM_CONTROLS; `name` is what a SQL cell references ({{name}}).
export type DashboardParameterControl = "chips" | "multi" | "search" | "segmented" | "range" | "date_range" | "checkboxes";
export type DashboardParameter = {
  id: string;
  name?: string;
  column: string;
  label: string;
  control: DashboardParameterControl;
  options_from?: "distinct" | null;
  default?: any;
  table?: string | null;
};

// A saved filter state (Dashboard.saved_views[]) - see update_saved_views.
export type DashboardSavedView = {
  id: string;
  name: string;
  filters: FilterCriterion[];
  period?: string | null;
  date_range?: { from: string | null; to: string | null } | null;
  created_by?: string | null;
};

export type DashboardPeriod = "day" | "week" | "month" | "quarter" | "year";
export type DashboardDateRange = { from: string | null; to: string | null };

export type BlockResultStatus =
  | "ok" | "error" | "rejected_unsafe" | "rejected_too_expensive" | "budget_exhausted" | "invalid_spec" | "invalid_sql";
export type BlockResultColumn = { name: string; type?: string | null };
export type BlockResult = {
  status: BlockResultStatus;
  error?: string | null;
  columns: BlockResultColumn[];
  rows: Record<string, any>[];
  row_count: number;
  truncated?: boolean;
  sql?: string;
  bytes_scanned?: number | null;
  duration_ms?: number;
  cached?: boolean;
  computed_in?: string;
  ran_at?: string;
  dimensions?: string[];
  measures?: string[];
  time_column?: string | null;
  exact_total_rows?: number | null;
  prior?: { columns: BlockResultColumn[]; rows: Record<string, any>[]; row_count: number; sql?: string; date_range?: DashboardDateRange | null; status?: string } | null;
  delta?: Record<string, { current: number | null; prior: number | null; abs: number | null; pct: number | null }> | null;
  sparkline?: { columns: BlockResultColumn[]; rows: Record<string, any>[]; sql?: string; grain?: string; status?: string } | null;
  spec?: BlockSpec | null;
  period?: string;
  date_range?: DashboardDateRange | null;
  filters_applied?: any[];
  // 2026-10-07 (analyst canvas round): a sql cell / a block bound to one.
  kind?: "sql" | "derived";
  name?: string | null;
  source_block_id?: string | null;
  parameters?: string[];
  missing_parameters?: string[];
  // 2026-10-07 (chart-types round) - see backend dashboard_engine's
  // docstring: derived date dimensions, a histogram's edges, the buckets
  // the data only partly covers, and the forecast / anomalies of a block
  // with config.forecast. None of these holds SQL.
  date_parts?: Record<string, string> | null;
  bins?: HistogramBins | null;
  partial?: PartialPeriods | null;
  forecast?: BlockForecast | null;
  anomalies?: BlockAnomaly[] | null;
};

export type RunPageRequest = {
  filters?: FilterCriterion[];
  block_filters?: Record<string, FilterCriterion[]>;
  period?: DashboardPeriod | string | null;
  date_range?: DashboardDateRange | null;
  block_ids?: string[] | null;
  force_refresh?: boolean;
  parameters?: Record<string, any>;
};

export type RunPageResponse = {
  blocks: Record<string, BlockResult>;
  matched_rows: number | null;
  total_rows: number | null;
  computed_in: string;
  total_duration_ms: number;
  period: string;
  date_range: DashboardDateRange | null;
  skipped_block_ids: string[];
  dependencies: Record<string, string[]>;
  order: string[];
  parameters_used: Record<string, any>;
  missing_parameters: string[];
  // 2026-10-07 (dashboard edit mode): blocks that were created but never
  // built (no spec, no cell, no saved result) - the editor shows its
  // "Describe what this block should show" empty state for them and a
  // viewer never sees them. Absent on an older backend.
  empty_block_ids?: string[];
  // 2026-10-07 (round 9): {column: {min, max}} ("YYYY-MM-DD") - the real
  // first and last date of the dashboard's date column and of every
  // date_range control's column. {} on a partial run (block_ids).
  date_bounds?: Record<string, { min: string; max: string }>;
  // 2026-10-07 (identity-colour round): the dashboard's colour registry
  // after this run ({column: {value: palette slot}}) - new values the run
  // showed are already in it. Absent on an older backend.
  colors?: ColorRegistry | null;
};

// One block's grid placement in PATCH /pages/{page_id}/layout.
export type BlockLayoutItem = { id: string; x: number; y: number; w: number; h: number };

export type ParameterOptionValue = { value: string | number | boolean | null; count: number | null };
export type ParameterOptions = {
  parameter_id: string;
  column: string;
  table: string;
  search?: string | null;
  values: ParameterOptionValue[];
  truncated: boolean;
  cached: boolean;
  error?: string | null;
};

export type BlockSql = {
  block_id: string;
  sql: string;
  prior_sql?: string | null;
  sparkline_sql?: string | null;
  dialect: string;
  period: string;
  date_range?: DashboardDateRange | null;
  filters_applied: any[];
};

export type UpgradeBlockResult = {
  block_id: string;
  title: string | null;
  status: "upgraded" | "already_has_spec" | "skipped" | "failed";
  error?: string | null;
  spec?: BlockSpec | null;
  sql?: string | null;
};
export type UpgradeBlocksResult = { results: UpgradeBlockResult[]; upgraded: number; failed: number; skipped: number };

export type BlockLastRun = {
  bytes_scanned?: number | null;
  duration_ms?: number | null;
  rows?: number | null;
  ran_at?: string | null;
  cached?: boolean;
};

// The dashboard-level warehouse fields shared by DashboardBuilderDetail
// and PublicDashboard (backend _warehouse_dashboard_fields).
export type WarehouseDashboardFields = {
  datasource_kind: string | null;
  warehouse_native: boolean;
  parameters: DashboardParameter[];
  saved_views: DashboardSavedView[];
  default_period: DashboardPeriod | string | null;
  date_column: string | null;
  // 2026-10-07 (identity-colour round): how the dashboard looks, resolved
  // by the backend (services/appearance.effective_appearance) - palette,
  // colour by value / single colour, pins, the colour registry, density,
  // radius, font, currency, locale, the published link's default theme and
  // footer note. The owner's and the public payload carry the same one.
  // Absent on an older backend (the product defaults apply).
  appearance?: DashboardAppearance | null;
};

// 2026-09-25 (Round 5, template gallery): what GET /dashboard-builder/
// templates returns - a LAYOUT catalog only (page names, block types,
// grid positions, placeholder titles), never data. Every block a
// template creates starts genuinely empty, same as one added by hand
// from the canvas's "+ Add block" toolbar - see backend
// _default_block_config. BuildDashboardModal.tsx's gallery reads this
// same shape to draw each card's preview thumbnail, so the preview can
// never drift from what "Use this template" actually builds.
export type DashboardTemplateBlock = {
  type: DashboardBlockType;
  title: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
};
export type DashboardTemplatePage = { name: string; blocks: DashboardTemplateBlock[] };
export type DashboardTemplate = {
  key: string;
  name: string;
  description: string;
  icon: string;
  pages: DashboardTemplatePage[];
};

// `config`'s shape depends on `type` - deliberately left loosely typed
// here (this client is a pass-through, same convention as PreviewOptions.
// filters above) rather than a discriminated union, since every renderer
// (components/DashboardBlocks.tsx) narrows it itself right where it's
// used. The shapes the backend actually sends, verbatim from
// routers/dashboard_builder.py's _block_config/_ai_result_to_block/
// _run_manual_recipe:
//   chart: { chart_spec: any; result_columns?: any; result_rows?: any; recipe?: ManualRecipe;
//            forecast_enabled?: boolean; anomalies_enabled?: boolean; anomaly_count?: number | null }
//     (result_columns/result_rows are only present when this chart has
//     tidy data attached - that's what makes restyle_block possible; a
//     chart block from before this existed may omit them. `recipe` is
//     only present on a block built with "Build manually" - that's what
//     makes it respond to a cross-filter at all, see dashboardBuilderApi.
//     previewFiltered below. forecast_enabled/anomalies_enabled/
//     anomaly_count are set by setBlockAnalysis below - anomaly_count is
//     null until the anomalies toggle has actually been turned on at least
//     once, then an honest int (possibly 0) after that)
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
  // 2026-09-25g (live-data freshness round): when this block's DATA was
  // last actually recomputed - null for a block never built yet, or one
  // that predates this column (never backfilled with a guessed time). See
  // backend models.DashboardBlock's own docstring for exactly which
  // actions advance it (never a plain drag/resize/rename/restyle).
  data_updated_at?: string | null;
  // 2026-09-29 (design revamp): whether this block has a single-level
  // "undo last change" snapshot to revert to right now - see backend
  // models.DashboardBlock.previous_config's own docstring. Drives whether
  // DashboardCanvas.tsx's kebab menu shows an "Undo last change" option.
  can_undo?: boolean;
  // 2026-10-06 (warehouse-native dashboards layer): the compiled at-rest
  // SQL of a spec'd block and its last run's stats - both null for a
  // file-source block or a warehouse block not yet upgraded.
  query_sql?: string | null;
  last_run?: BlockLastRun | null;
};

export type DashboardBuilderPage = {
  id: string;
  name: string;
  position: number;
  blocks: DashboardBlock[];
  // 2026-09-25 (Round 4, branding): this page's own background tint
  // override, or null to inherit the parent dashboard's background - see
  // backend models.DashboardPage's own docstring.
  background_color: string | null;
};

// 2026-09-25 (Round 4, branding/customization): the shape shared by
// DashboardBuilderDetail and PublicDashboard below - identical fields,
// identical meaning, so lib/branding.ts's hexToRgbTriple/brandingStyleVars
// can render the owner's editor, the owner's preview, and the anonymous
// public/private viewer with exactly one rendering rule, never three
// slightly different ones. has_logo/has_background_image are booleans
// (never the raw bytes, which never travel through this JSON payload at
// all - see dashboardBuilderApi.fetchBrandingImageUrl / the public
// branding image URLs below) so the caller knows whether to even try
// fetching the image, avoiding a broken-<img> flash while it decides.
export type DashboardBranding = {
  brand_primary_color: string | null;
  brand_accent_color: string | null;
  background_style: "default" | "color" | "image" | null;
  background_color: string | null;
  has_logo: boolean;
  has_background_image: boolean;
};

// 2026-09-24 (Phase 3): one named person allowed to open a "private" share
// - see dashboardBuilderApi.addShareEmail/removeShareEmail below.
export type DashboardShareEmail = { id: string; email: string };

// PATCH /dashboard-builder/{id}/appearance - see backend schemas.UpdateAppearanceRequest.
export type AppearancePatch = Partial<Pick<DashboardAppearance, "palette" | "color_mode" | "single_color" | "theme_default" | "density" | "radius" | "font" | "currency" | "locale" | "footer_note" | "value_colors">> & {
  reset?: "workspace" | "colors";
};
export type AppearanceResult = {
  appearance: DashboardAppearance;
  workspace_brand_kit: BrandKit | null;
  brand_workspace_id: string | null;
  brand_workspace_name: string | null;
};

export type DashboardBuilderDetail = DashboardBranding & {
  id: string;
  name: string;
  layout_version: number;
  created_at: string;
  // Which chat Project this was generated from - null for a dashboard
  // started blank (not possible yet in Phase 1, but the field already
  // exists on the model for when Phase 2 adds it).
  source_conversation_id: string | null;
  // 2026-09-29 (design revamp): "from which project this dashboard
  // created" - the Project's own title, and the data source id its own
  // Workspace route needs (Workspace.tsx's URL is /workspace/
  // {datasourceId}?conversation={conversationId}, not just the
  // conversation id alone). Both null exactly when source_conversation_id
  // is null, or when that Project has since been deleted.
  source_conversation_title: string | null;
  source_conversation_datasource_id: string | null;
  // 2026-10-10: "answer" | "analysis" - which page "Made from" opens.
  source_conversation_kind?: "answer" | "analysis" | null;
  // 2026-09-29 (design revamp): "merge with other dashboards in the same
  // project" - every other dashboard built from this same source
  // conversation that this person can currently see, for the merge
  // picker. Always empty when source_conversation_id is null.
  sibling_dashboards: DashboardBuilderSummary[];
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
  // 2026-10-06/07 (warehouse-native dashboards + comments): every table the
  // blocks could be built from ({table: [{name, type}]}, empty for a file
  // source) and per-block {open, total} comment counts (keyed by block
  // id, "page:<id>" or "dashboard").
  tables: Record<string, { name: string; type?: string | null }[]>;
  comment_counts: Record<string, { open: number; total: number }>;
  // 2026-10-07 (identity-colour round): the workspace brand kit this
  // dashboard follows (or would follow after "Reset to workspace brand")
  // and whose it is. `appearance` itself is in WarehouseDashboardFields.
  workspace_brand_kit?: BrandKit | null;
  brand_workspace_id?: string | null;
  brand_workspace_name?: string | null;
} & WarehouseDashboardFields;

// 2026-09-28 (senior-UX round): the lightweight shape behind
// dashboardBuilderApi.listByConversation - just enough to list and link to
// every v2 dashboard built from one chat analysis, without pulling each
// one's full pages/blocks/branding/sharing the way DashboardBuilderDetail
// does. See that endpoint's own backend docstring for the real gap this
// closes (Workspace.tsx's header).
export type DashboardBuilderSummary = {
  id: string;
  name: string;
  created_at: string;
  page_count: number;
  block_count: number;
  can_edit: boolean;
  is_published: boolean;
};

// 2026-10-01 (chat-to-dashboard round): the picker behind "Add to
// dashboard" (PushToDashboardMenu.tsx) - see backend DashboardPickerOut's
// own docstring for exactly what's included and why (every dashboard this
// person can reach, each with just its pages' id/name, never full blocks).
export type DashboardPickerPage = { id: string; name: string };
export type DashboardPickerEntry = {
  id: string;
  name: string;
  can_edit: boolean;
  datasource_name: string | null;
  datasource_id?: string | null;
  pages: DashboardPickerPage[];
};

// What the anonymous, no-login public link actually gets back - no
// can_edit/is_published/ids beyond what's needed to render the pages, so
// nothing about the owner's account leaks into a page a stranger can open.
// 2026-09-25 (Round 4): also carries the owner's branding (DashboardBranding)
// - never the dashboard's own id, same privacy boundary this type already
// held before this round.
export type PublicDashboard = DashboardBranding & WarehouseDashboardFields & {
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
// 2026-10-07 (chart-types round): every native chart form may be asked for
// (the backend checks the block's rows can be drawn as it; "auto" is the
// recommender's own pick).
export type RestyleChartType =
  | "bar" | "line" | "area" | "pie" | "horizontal_bar" | "scatter"
  | "stacked_bar" | "stacked_bar_100" | "stacked_area" | "stacked_area_100" | "combo" | "donut" | "treemap" | "map" | "heatmap"
  | "pivot" | "bubble" | "funnel" | "waterfall" | "histogram" | "bullet" | "grouped_bar" | "auto";

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
  // 2026-10-07 (round 9) - what a recipe that came from a PROPOSAL may
  // also carry (backend _spec_to_recipe): the first measure's alias
  // ("bookings"), a count of rows rather than of a column, a date bucket
  // for the first group-by, and - for a table or a chart - several
  // measures and/or several group-by columns, an order and a row limit.
  // A KPI's sparkline runs over trend_column by trend_grain.
  alias?: string | null;
  count_rows?: boolean;
  time_grain?: "day" | "week" | "month" | "quarter" | "year" | null;
  measures?: { alias: string; agg: ManualAgg; column: string | null }[];
  group_by?: string[];
  order_by?: { by: string; dir: "asc" | "desc" }[];
  limit?: number | null;
  trend_column?: string | null;
  trend_grain?: string | null;
  // 2026-09-25 (Round 3): only meaningful when block_type === "gauge" -
  // see backend _run_manual_recipe for the defaults filled in when either
  // is left unset.
  target_value?: number | null;
  max_value?: number | null;
};

// 2026-09-29 (Hex-level filters round): the SAME operator vocabulary the
// Data tab's own Excel-style column filter panel already uses
// (DataTable.tsx has its own local copy of this exact shape; backend
// routers/datasources.py's _apply_column_filter is what actually reads
// it) - reused here rather than reinvented, so a dashboard filter (page-
// wide or per-chart) gets multi-select, text conditions, a numeric
// comparison OR RANGE, a date range, and a boolean toggle, the same as
// the Data tab always has. Kept as its own copy (not imported from
// DataTable.tsx) so this feature can evolve without risking a regression
// on that already-working component - matching this codebase's own
// established "kept as its own copy" convention (see backend
// routers/dashboard_builder.py's rate limiter for the same reasoning).
export type FilterTextOp = "contains" | "not_contains" | "equals" | "not_equals" | "starts_with" | "ends_with" | "is_empty" | "is_not_empty";
export type FilterNumberOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between";
export type ColumnFilterSpec =
  | { type: "values"; include: (string | number | boolean | null)[] }
  | { type: "text"; op: FilterTextOp; value: string }
  | { type: "number"; op: FilterNumberOp; value: string; value2?: string }
  | { type: "date"; from: string | null; to: string | null }
  | { type: "boolean"; value: "true" | "false" };

// One active cross-filter selection - either on the page-wide filter bar
// or (2026-09-29) scoped to just one block ("per-chart filtering" - see
// previewFiltered's `blockFilters` param below). Lives ONLY in the
// frontend's own component state per viewer, per page - see
// previewFiltered's own docs for why this is never persisted anywhere.
export type FilterCriterion = { column: string; spec: ColumnFilterSpec };

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
  // 2026-09-28 (datasource picker round): `datasourceId` is the answer to
  // BuildDashboardModal's new "Which data source?" picker on the goal
  // step - an explicit override for which DataSource to build against,
  // instead of always silently inheriting whatever data source happens
  // to be behind the currently-open chat. Omitted/undefined keeps the
  // exact original conversation-derived resolution (see backend
  // generate_dashboard's own docstring).
  generate: (conversationId: string, goal?: string, datasourceId?: string) =>
    api
      .post<DashboardBuilderDetail>("/dashboard-builder/generate", {
        conversation_id: conversationId,
        goal: goal?.trim() || undefined,
        datasource_id: datasourceId || undefined,
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
  // 2026-10-10: the Dashboards page's "Blank canvas" - straight from a source.
  createBlankOnSource: (datasourceId: string, name?: string) =>
    api
      .post<DashboardBuilderDetail>("/dashboard-builder/create-blank", { datasource_id: datasourceId, name: name || undefined })
      .then((r) => r.data),
  // 2026-09-25 (Round 5, template gallery): the catalog behind
  // BuildDashboardModal.tsx's "Start from a template" step - see
  // DashboardTemplate above for the shape and backend list_templates for
  // where it comes from.
  listTemplates: () => api.get<DashboardTemplate[]>("/dashboard-builder/templates").then((r) => r.data),
  // 2026-09-25 (Round 5, template gallery): "Use this template" - a v2
  // dashboard pre-laid-out from one catalog entry, tied to this
  // conversation's data source exactly like createBlank above. Every
  // block starts empty; the person fills each one in afterward via Ask
  // AI / build manually on the same canvas as always.
  createFromTemplate: (conversationId: string, templateKey: string) =>
    api
      .post<DashboardBuilderDetail>("/dashboard-builder/create-from-template", {
        conversation_id: conversationId,
        template_key: templateKey,
      })
      .then((r) => r.data),
  get: (id: string) => api.get<DashboardBuilderDetail>(`/dashboard-builder/${id}`).then((r) => r.data),
  // 2026-09-28 (senior-UX round): every v2 dashboard built from THIS chat
  // analysis, most recent first - lets Workspace.tsx show a "View
  // Dashboard(s)" entry point right in the same header "Build Dashboard"
  // already lives in, instead of a dashboard becoming unreachable from
  // its own source chat the moment the build finishes (see backend
  // list_dashboards_for_conversation's own docstring for the real
  // complaint this fixes).
  listByConversation: (conversationId: string) =>
    api
      .get<DashboardBuilderSummary[]>(`/dashboard-builder/by-conversation/${conversationId}`)
      .then((r) => r.data),
  // 2026-10-01 (chat-to-dashboard round): every v2 dashboard this person
  // can reach, for PushToDashboardMenu.tsx's "Add to dashboard" picker -
  // see backend list_my_dashboards' own docstring for the exact scope
  // (unlike listByConversation above, this is NOT scoped to one chat).
  listMine: () => api.get<DashboardPickerEntry[]>("/dashboard-builder").then((r) => r.data),
  // 2026-09-29 (design revamp): "merge with other dashboards in the same
  // project" - copies every page (and its blocks) from sourceDashboardId
  // into dashboardId as new pages, appended at the end. Additive only -
  // the source dashboard is never modified or deleted. Only works between
  // two dashboards that share the same source Project (see the backend
  // endpoint's own docstring) - DashboardBuilderView.tsx only ever offers
  // this dashboard's own sibling_dashboards as merge targets, so that's
  // never actually a live constraint from the UI's side, just defense in
  // depth server-side.
  mergeFrom: (dashboardId: string, sourceDashboardId: string) =>
    api
      .post<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/merge-from/${sourceDashboardId}`)
      .then((r) => r.data),
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
  // 2026-09-25 (Round 4, branding): this one page's own background tint -
  // pass a hex string ("#00ff00") to set it, or "" to clear it back to
  // "inherit the dashboard's background" (empty-string-clears, same
  // convention renamePage's `name` doesn't use but a block's title does).
  setPageBackgroundColor: (dashboardId: string, pageId: string, color: string) =>
    api
      .patch<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/pages/${pageId}`, { background_color: color })
      .then((r) => r.data),
  deletePage: (dashboardId: string, pageId: string) =>
    api.delete<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/pages/${pageId}`).then((r) => r.data),
  duplicatePage: (dashboardId: string, pageId: string) =>
    api.post<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/pages/${pageId}/duplicate`).then((r) => r.data),

  // ---- Phase 2 (2026-09-24): the canvas editor's own calls - every one of
  // these returns the WHOLE updated DashboardBuilderDetail (not just the
  // one block), same convention as generate/publish/unpublish above, so
  // the canvas can just replace its local state wholesale after each edit
  // instead of hand-patching one block in place. ----

  // Adds one empty block to a page - the element library's
  // Chart/Table/KPI/Text/Heading/Divider/... choice. Filled in right
  // after with askAiBlock or buildManualBlock (or, for a text/heading
  // block, a plain updateBlock config write).
  //
  // 2026-09-25 (Round 15, element library): `position` is new - passed
  // when a card was dragged from the library and dropped at a specific
  // grid cell (see DashboardCanvas.tsx's onDrop), so the block lands
  // exactly there instead of always at the bottom of the page.
  // 2026-10-01 (chat-to-dashboard round): `config`, the trailing optional
  // argument, lets this block be created ALREADY FILLED with a real,
  // already-computed result instead of always starting empty - see
  // backend CreateBlockRequest.config's own docstring. Used by
  // PushToDashboardMenu.tsx's "Add to dashboard" action; every other
  // caller (element-library drag-drop, the blank/template dashboard
  // starts) leaves it undefined and gets the exact original
  // always-empty behavior.
  createBlock: (
    dashboardId: string,
    pageId: string,
    type: DashboardBlockType,
    title?: string,
    position?: { x: number; y: number },
    config?: Record<string, any>,
    // 2026-10-07 (chart-types round): "forecast" - a time-series chart
    // with its forecast already on (rows per period over the dashboard's
    // date column), ready to be edited.
    template?: "forecast"
  ) =>
    api
      .post<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/blocks`, {
        page_id: pageId,
        type,
        title: title || undefined,
        x: position?.x,
        y: position?.y,
        config: config || undefined,
        template: template || undefined,
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

  // 2026-09-29 (design revamp): single-level "undo last change" - reverts
  // this block's config (and type, when the last change also changed
  // that) back to whatever it was right before its most recent edit
  // through any of the six content/style-changing endpoints. Only
  // meaningful when block.can_undo is true; a 400 here ("There's no
  // previous version...") means there's nothing left to revert to,
  // either because nothing has changed yet or because undo was already
  // used once for this edit (see backend models.DashboardBlock.
  // previous_config's own docstring - it's one level, not a full stack).
  undoBlock: (dashboardId: string, blockId: string) =>
    api.post<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/blocks/${blockId}/undo`).then((r) => r.data),

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
      // 2026-09-30 (semantic layer v1): set metric_id instead of
      // metric_column/agg to build a kpi/gauge tile from a saved metric
      // (see metricDefinitionsApi above) - it always recomputes live from
      // that metric's own definition, including across a page filter
      // change and after the metric itself is later edited, rather than
      // freezing a one-shot number the plain column+aggregation path
      // below does. Mutually exclusive - the UI only ever sends one or
      // the other (see DashboardCanvas.tsx's ManualBuildPanel).
      metric_id?: string;
      // 2026-09-30 (transformation layer v1): set transform_id to build
      // this block from a SAVED TABLE (see transformsApi below) instead
      // of this data source's raw data - resolved BEFORE metric_id/
      // metric_column, so either can be layered on top of a transform's
      // own derived columns. Always recomputes live (the transform's
      // current steps, re-applied), including across a page filter change
      // and after the transform itself is later edited - see
      // dashboardBuilderApi's own module notes on metric_id above for the
      // identical "never a frozen snapshot" guarantee.
      transform_id?: string;
      metric_column?: string;
      agg?: ManualAgg;
      group_by_column?: string | null;
      block_type: ManualBlockType;
      chart_type?: RestyleChartType | null;
      filters?: FilterCriterion[];
      // 2026-09-25 (Round 3): only read server-side when block_type is
      // "gauge" - see ManualRecipe above.
      target_value?: number;
      max_value?: number;
      // 2026-10-07 (chart-types round): what the new chart forms need on
      // top of "one measure by one column" - a second dimension, more
      // measures, a time bucket on group_by_column, a histogram's bins,
      // the forecast (with time_grain). `table`: warehouse sources.
      table?: string;
      group_by_column_2?: string | null;
      extra_measures?: { agg: ManualAgg; column: string | null }[];
      time_grain?: "day" | "week" | "month" | "quarter" | "year" | null;
      bins?: { column: string; count?: number; min?: number | null; max?: number | null } | null;
      forecast?: boolean;
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
  // 2026-09-25e (elite pass): matched_rows is the real, server-computed
  // row count for `filters` (or the datasource's full row count when
  // `filters` is empty) - see the backend's own preview_filtered_blocks
  // for how it's derived. Returned alongside blocks (not just blocks
  // alone, like before) so the caller can show an honest "Showing N rows"
  // next to the filter controls - see lib/useDashboardFilters.ts.
  // 2026-09-29 (Hex-level filters round): `blockFilters`, keyed by block
  // id, is "per-chart filtering" - extra criteria applied ONLY to that
  // one block's own recompute, on top of `filters` for everyone else.
  // Optional/omitted behaves exactly as before this round.
  // 2026-10-02 fix: matched_rows is now `number | null`, matching the
  // backend's own FilteredBlocksOut.matched_rows (int | None). null means
  // "the live datasource couldn't be loaded this request, no count
  // available" - useDashboardFilters.ts/DashboardBuilderView.tsx already
  // typed and guarded matchedRows as `number | null` with a `!== null`
  // check; only this raw response type was still (incorrectly) claiming
  // matched_rows could never be anything but a number.
  previewFiltered: (dashboardId: string, pageId: string, filters: FilterCriterion[], blockFilters?: Record<string, FilterCriterion[]>) =>
    api
      .post<{ blocks: FilteredBlock[]; matched_rows: number | null; date_bounds?: Record<string, { min: string; max: string }>; colors?: ColorRegistry | null }>(
        `/dashboard-builder/${dashboardId}/pages/${pageId}/preview-filtered`,
        { filters, block_filters: blockFilters || {} }
      )
      .then((r) => ({ blocks: r.data.blocks, matchedRows: r.data.matched_rows, dateBounds: r.data.date_bounds || null, colors: r.data.colors || null })),

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

  // 2026-09-25h (inline editing round): the "click the color swatch right
  // on the tile" control - pure presentation (see the backend endpoint's
  // own docstring for why this is separate from updateBlock). Pass null
  // to reset a tile back to its automatic color.
  setBlockAccentColor: (dashboardId: string, blockId: string, color: string | null) =>
    api
      .patch<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/blocks/${blockId}/accent-color`, { color })
      .then((r) => r.data),

  // 2026-09-28: the "Show forecast" / "Show anomalies" chart-block kebab-
  // menu toggles - see the backend endpoint's own docstring for why this
  // is separate from restyleBlock/setBlockAccentColor (an analysis LENS
  // on an already-built chart_spec, not a data recompute or a chart-type
  // rebuild). Both flags are sent together every call, even when only one
  // changed, since the backend always needs the full current state of
  // both toggles to rebuild the figure correctly - the caller is expected
  // to pass the OTHER flag's current value through unchanged.
  setBlockAnalysis: (
    dashboardId: string,
    blockId: string,
    flags: { forecast_enabled: boolean; anomalies_enabled: boolean }
  ) =>
    api
      .patch<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/blocks/${blockId}/analysis`, flags)
      .then((r) => r.data),

  // ---- Round 4 (2026-09-25): branding/customization - logo, brand
  // colors, background. Every call here returns the whole updated
  // DashboardBuilderDetail, same convention as everything else in this
  // object. See backend routers/dashboard_builder.py's own module
  // docstring (Round 4 section) for the full design. ----

  // Every field optional and independently settable - send only what
  // changed. "" (empty string) for a color clears it back to the app's
  // default; omit/undefined leaves that field unchanged.
  updateBranding: (
    dashboardId: string,
    payload: {
      brand_primary_color?: string;
      brand_accent_color?: string;
      background_style?: "default" | "color" | "image";
      background_color?: string;
    }
  ) => api.patch<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/branding`, payload).then((r) => r.data),

  // 2026-10-07 (identity-colour round): the dashboard's appearance. Only
  // the keys sent are changed. `value_colors` replaces the pinned colours;
  // `reset: "workspace"` follows the workspace brand kit again, `reset:
  // "colors"` forgets the pins and the colour registry. Answers with the
  // resolved appearance (not the whole dashboard): the Appearance sheet
  // saves on every change and applies it optimistically.
  updateAppearance: (dashboardId: string, payload: AppearancePatch, signal?: AbortSignal) =>
    api.patch<AppearanceResult>(`/dashboard-builder/${dashboardId}/appearance`, payload, { signal }).then((r) => r.data),

  // file must already be validated client-side (png/jpeg/webp, under the
  // backend's size cap) - the backend re-validates both regardless, this
  // just gives a faster/friendlier error than a round trip.
  uploadLogo: (dashboardId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api
      .post<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/branding/logo`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data);
  },
  removeLogo: (dashboardId: string) =>
    api.delete<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/branding/logo`).then((r) => r.data),
  uploadBackground: (dashboardId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api
      .post<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/branding/background`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data);
  },
  removeBackground: (dashboardId: string) =>
    api.delete<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/branding/background`).then((r) => r.data),

  // The owner/editor's own preview fetch - GET .../branding/logo|background
  // is authenticated (view access), so a plain <img src> can't carry the
  // Authorization header the way it can on the public/private viewer's
  // unauthenticated equivalent (see PublicDashboardView.tsx). Fetches the
  // bytes through the normal `api` instance (which DOES attach the bearer
  // token) and hands back a blob: object URL for an <img> to point at -
  // see lib/branding.ts's useBrandingAsset, which owns revoking it again.
  fetchBrandingImageUrl: (dashboardId: string, kind: "logo" | "background") =>
    api
      .get(`/dashboard-builder/${dashboardId}/branding/${kind}`, { responseType: "blob" })
      .then((r) => URL.createObjectURL(r.data))
      .catch(() => null as string | null),

  // ---- Warehouse-native dashboards (2026-10-06/07) - the calls behind
  // src/dashboard/ (the Option A view). Every warehouse block is a
  // BlockSpec computed INSIDE the warehouse on each run; nothing here ever
  // loads rows into the app. See backend routers/dashboard_builder.py
  // run_page / get_parameter_options / update_parameters /
  // update_saved_views / get_block_sql / upgrade_blocks / swap_block. ----

  // Runs every warehouse block on the page under the rail's state. View
  // access only. 400 for a file-source dashboard (use previewFiltered).
  // `signal` lets the engine hook cancel an in-flight run when the filters
  // change again before it lands.
  runPage: (dashboardId: string, pageId: string, req: RunPageRequest, signal?: AbortSignal) =>
    api
      .post<RunPageResponse>(`/dashboard-builder/${dashboardId}/pages/${pageId}/run`, {
        filters: req.filters || [],
        block_filters: req.block_filters || {},
        period: req.period || undefined,
        date_range: req.date_range && (req.date_range.from || req.date_range.to) ? req.date_range : undefined,
        block_ids: req.block_ids || undefined,
        force_refresh: req.force_refresh || false,
        parameters: req.parameters || {},
      }, { signal })
      .then((r) => r.data),
  // A rail control's distinct values with counts (one GROUP BY, cached
  // server-side 10 minutes). `search` narrows case-insensitively.
  parameterOptions: (dashboardId: string, paramId: string, opts: { search?: string; limit?: number } = {}, signal?: AbortSignal) =>
    api
      .get<ParameterOptions>(`/dashboard-builder/${dashboardId}/parameters/${paramId}/options`, {
        params: { search: opts.search || undefined, limit: opts.limit || undefined },
        signal,
      })
      .then((r) => r.data),
  // Replaces the whole rail: [{id?, column, label, control, options_from?,
  // default?, table?}] - validated server-side (column must exist).
  updateParameters: (dashboardId: string, parameters: Partial<DashboardParameter>[]) =>
    api.patch<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/parameters`, { parameters }).then((r) => r.data),
  // Replaces the whole saved-view list; ids are minted server-side when
  // missing, so "save current view" sends the existing list + one new entry.
  updateSavedViews: (dashboardId: string, savedViews: Partial<DashboardSavedView>[]) =>
    api.patch<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/saved-views`, { saved_views: savedViews }).then((r) => r.data),
  // The dashboard's period grain and time column ("" clears either).
  updateSettings: (dashboardId: string, payload: { default_period?: string; date_column?: string }) =>
    api.patch<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}`, payload).then((r) => r.data),
  // "Show SQL": the exact statement for this block under the given rail
  // state. Filters travel as repeated `f=<column>:<json spec>` params.
  blockSql: (
    dashboardId: string,
    blockId: string,
    opts: { filters?: FilterCriterion[]; period?: string | null; date_range?: DashboardDateRange | null } = {}
  ) => {
    const params = new URLSearchParams();
    for (const f of opts.filters || []) params.append("f", `${f.column}:${JSON.stringify(f.spec)}`);
    if (opts.period) params.set("period", opts.period);
    if (opts.date_range?.from) params.set("date_from", opts.date_range.from);
    if (opts.date_range?.to) params.set("date_to", opts.date_range.to);
    const qs = params.toString();
    return api.get<BlockSql>(`/dashboard-builder/${dashboardId}/blocks/${blockId}/sql${qs ? `?${qs}` : ""}`).then((r) => r.data);
  },
  // Gives every pre-layer warehouse block a BlockSpec; per-block failures
  // are reported, never hidden. Edit access.
  upgradeBlocks: (dashboardId: string) =>
    api.post<UpgradeBlocksResult>(`/dashboard-builder/${dashboardId}/upgrade-blocks`).then((r) => r.data),
  // The same spec rendered as another chart type / block shape - no model
  // call, no new query. Edit access; undo-able.
  // chart_type "auto" is "swap to best": the recommender's pick for the
  // block's current result. A form the block's data cannot be drawn as is
  // a 400 whose `detail` says what it needs.
  swapBlock: (dashboardId: string, blockId: string, payload: { chart_type?: string; type?: DashboardBlockType }) =>
    api.post<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/blocks/${blockId}/swap`, payload).then((r) => r.data),
  // 2026-10-07 (chart-types round): the "Forecast..." sheet. Stores
  // config.forecast = {horizon, interval, anomalies} (or removes it); the
  // next run of the block carries `forecast` and `anomalies`. A block
  // with no time axis is a 400 with the reason.
  setBlockForecast: (dashboardId: string, blockId: string, payload: { enabled: boolean; horizon?: number | null; interval?: "80" | "95" | "both"; anomalies?: boolean }) =>
    api.patch<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/blocks/${blockId}/forecast`, payload).then((r) => r.data),
  // The same forecaster for a series the page already holds (a chat
  // answer that is a time series). Nothing is queried.
  // `values` = one series; `series` = several over the same periods (with
  // `series_by` the values of one breakdown column of `measure`, without
  // it one measure each).
  forecastSeries: (payload: {
    periods: string[]; values?: (number | null)[]; series?: { key: string; values: (number | null)[] }[]; series_by?: boolean; measure?: string;
    grain: string; horizon?: number | null; interval?: "80" | "95" | "both"; anomalies?: boolean; additive?: boolean; rate?: boolean;
  }) =>
    api.post<BlockForecast>(`/dashboard-builder/forecast/series`, payload).then((r) => r.data),

  // ---- 2026-10-07 (dashboard edit mode): the calls the editable dashboard
  // (src/dashboard/edit/) makes on top of the block endpoints above. ----
  // The whole page's layout in ONE atomic request (never a PATCH per
  // block): every item's x/y/w/h is written or none is. 400/404 carry a
  // readable `detail`.
  updatePageLayout: (dashboardId: string, pageId: string, items: BlockLayoutItem[]) =>
    api.patch<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/pages/${pageId}/layout`, { items }).then((r) => r.data),
  // A copy of the block (same config, never its cached rows) placed right
  // below the original.
  duplicateBlock: (dashboardId: string, blockId: string) =>
    api.post<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/blocks/${blockId}/duplicate`).then((r) => r.data),
  // Sets/replaces a warehouse block's BlockSpec. The backend validates it
  // against the schema and dry-runs it inside the warehouse first; a 400's
  // `detail` is the warehouse's own message.
  setBlockSpec: (
    dashboardId: string,
    blockId: string,
    payload: { spec: BlockSpec; block_type?: DashboardBlockType; chart_type?: string; title?: string }
  ) => api.post<DashboardBuilderDetail>(`/dashboard-builder/${dashboardId}/blocks/${blockId}/spec`, payload).then((r) => r.data),
};

// ---- Dashboard from a prompt (2026-10-07, Builder.dc.html): describe ->
// propose -> refine -> publish. Verbatim from backend schemas.py
// ProposeDashboardRequest / ProposalOut / ProposalBlockOut /
// ProposalTemplateOut / ReviseProposalRequest / CommitProposalRequest and
// routers/dashboard_builder.py's propose_dashboard / revise_proposal /
// commit_proposal. Nothing is created until commit: a proposal lives in a
// 30-minute server cache under proposal_id. The server validates every
// block (spec + a zero-row warehouse dry run) before it is shown, but never
// RUNS it - so a proposal carries specs + at-rest SQL, never numbers; the
// preview says "Will compute on publish" and the real run happens on the
// dashboard page afterwards. ----
export type ProposalBlockType = "kpi" | "chart" | "table" | "text" | "sparkline" | "donut";
export type ProposalBlock = {
  // Stable within one proposal revision (b1, b2, ...) - what `keep` lists.
  client_id: string;
  type: ProposalBlockType;
  title: string;
  // "KPI · Revenue metric" / "Trend · revenue by month" / "Breakdown · country".
  intent: string;
  // The validated BlockSpec (warehouse), the spec the recipe came from
  // (file), or null for a text / invalid block.
  spec: BlockSpec | null;
  // File sources only: the pandas recipe computed at commit time.
  recipe: ManualRecipe | null;
  chart_type: string | null;
  text: string | null;
  layout: { x: number; y: number; w: number; h: number };
  from_metric_id: string | null;
  from_metric_name: string | null;
  // "invalid" blocks are shown with their real reason and never created.
  status: "ok" | "invalid";
  error: string | null;
  // 2026-10-07 (chart-types round): why this chart form was chosen
  // ("Country column -> map"), and the forecast options when asked for.
  chart_reason?: string | null;
  forecast?: ForecastOptions | null;
  // Compiled at-rest SQL for an ok warehouse block ("Show SQL" before commit).
  sql: string | null;
  columns: { name: string; type?: string | null }[];
};
export type ProposalPage = { title: string; blocks: ProposalBlock[] };
export type DashboardProposal = {
  proposal_id: string;
  datasource_id: string;
  datasource_name: string | null;
  datasource_kind: string | null;
  warehouse_native: boolean;
  title: string;
  pages: ProposalPage[];
  used: { metrics?: string[]; columns?: string[]; tables?: string[] };
  suggestions: string[];
  date_column: string | null;
  period: string;
  // The rail the commit will create (same shape as Dashboard.parameters).
  parameters: DashboardParameter[];
  revision: number;
  expires_in_seconds: number;
  generated_in_ms: number;
  proposed_blocks: number;
  valid_blocks: number;
  // Set when the model call failed and this is the schema-only fallback.
  warning: string | null;
};
export type ProposalTemplate = {
  id: string;
  name: string;
  description: string;
  goal: string;
  pages: number;
  period: string;
  layout_hints: string[];
};
export type ProposeDashboardPayload = {
  datasource_id: string;
  goal: string;
  template_id?: string | null;
  pages?: "auto" | 1 | 2;
  period?: string | null;
  conversation_id?: string | null;
};
export const dashboardProposalApi = {
  templates: () => api.get<ProposalTemplate[]>("/dashboard-builder/propose/templates").then((r) => r.data),
  propose: (payload: ProposeDashboardPayload) =>
    api
      .post<DashboardProposal>("/dashboard-builder/propose", {
        datasource_id: payload.datasource_id,
        goal: payload.goal,
        template_id: payload.template_id || undefined,
        pages: payload.pages || undefined,
        period: payload.period || undefined,
        conversation_id: payload.conversation_id || undefined,
      })
      .then((r) => r.data),
  // One model call with the current proposal as context; same proposal_id,
  // revision + 1. The backend's ReviseProposalRequest only reads
  // `instruction` - `keep` rides along so the request records which
  // blocks the person has kept (ignored server-side today; the client
  // re-applies its keep/remove state to the revised proposal itself).
  revise: (proposalId: string, payload: { instruction: string; keep?: string[] }) =>
    api.post<DashboardProposal>(`/dashboard-builder/propose/${proposalId}/revise`, payload).then((r) => r.data),
  // The only step that writes: creates the dashboard from the kept blocks.
  // `name` is the dashboard title (CommitProposalRequest.name); `keep` the
  // client_ids to create (omitted = every valid block).
  commit: (proposalId: string, payload: { name: string; keep: string[]; visibility?: "private" | "workspace" }) =>
    api.post<DashboardBuilderDetail>(`/dashboard-builder/propose/${proposalId}/commit`, payload).then((r) => r.data),
};

// ---- Block / page / dashboard comments (2026-10-07, analyst canvas round)
// - verbatim from backend schemas.py CommentOut / CommentThreadOut /
// CommentsOut and routers/dashboard_comments.py. Authenticated only: the
// published (public) view has no identity to attribute a comment to, so it
// never calls these. ----
export type CommentAuthor = { id: string; name: string; initials: string; email: string | null };
// Where on a chart a thread is pinned: {kind: "bar" | "slice" | "row" |
// "point" | "cell", key: <the category value>} - stored as given.
export type CommentAnchor = { kind: string; key: string | number | boolean | null; column?: string | null; [k: string]: any };
export type DashboardComment = {
  id: string;
  dashboard_id: string;
  block_id: string | null;
  page_id: string | null;
  parent_id: string | null;
  author: CommentAuthor;
  body: string;
  anchor: CommentAnchor | null;
  mentions: string[];
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  // What the CALLER may do with this comment.
  can_edit: boolean;
  can_resolve: boolean;
  can_delete: boolean;
};
export type CommentThread = DashboardComment & { replies: DashboardComment[]; reply_count: number; resolved: boolean };
export type CommentCounts = Record<string, { open: number; total: number }>;
export type CommentsResponse = { threads: CommentThread[]; counts: CommentCounts; total: number; open: number };

export const dashboardCommentsApi = {
  // Threads for one block (block_id), one page's page-level threads
  // (page_id) or the whole dashboard; resolved threads only with
  // include_resolved. View access.
  list: (dashboardId: string, opts: { block_id?: string; page_id?: string; include_resolved?: boolean } = {}, signal?: AbortSignal) =>
    api
      .get<CommentsResponse>(`/dashboard-builder/${dashboardId}/comments`, {
        params: { block_id: opts.block_id || undefined, page_id: opts.page_id || undefined, include_resolved: opts.include_resolved ? true : undefined },
        signal,
      })
      .then((r) => r.data),
  // A new thread (block_id / page_id / neither, optional anchor) or a reply
  // (parent_id). Returns the whole thread the comment belongs to.
  create: (dashboardId: string, payload: { body: string; block_id?: string | null; page_id?: string | null; parent_id?: string | null; anchor?: CommentAnchor | null }) =>
    api.post<CommentThread>(`/dashboard-builder/${dashboardId}/comments`, payload).then((r) => r.data),
  // body: the author only. resolved: the author or an editor (applies to
  // the thread). Returns the thread.
  update: (dashboardId: string, commentId: string, payload: { body?: string; resolved?: boolean }) =>
    api.patch<CommentThread>(`/dashboard-builder/${dashboardId}/comments/${commentId}`, payload).then((r) => r.data),
  // The author or the dashboard owner; a root takes its replies with it.
  // Returns the remaining threads for the same block/page.
  remove: (dashboardId: string, commentId: string) =>
    api.delete<CommentsResponse>(`/dashboard-builder/${dashboardId}/comments/${commentId}`).then((r) => r.data),
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
// Same 422-detail normalisation as `api` above (and nothing else from
// that interceptor - see point 2).
publicApi.interceptors.response.use(
  (res) => res,
  (err) => {
    normalizeErrorDetail(err);
    return Promise.reject(err);
  }
);

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

  // 2026-10-05 (public-filters round): "in published dasbpard i cannot
  // able to use the filters" - Gokul's own words. Backend companion:
  // routers/dashboard_builder.py's preview_filtered_blocks_public, which
  // deliberately never touches the owner's live datasource (see that
  // endpoint's own docstring) - it only recomputes whatever AI-built
  // table/chart blocks on this page already carry their own tidy
  // result_columns/result_rows for. Same request/response shape as
  // dashboardBuilderApi.previewFiltered above, over the public router and
  // the anonymous-viewer X-Dashboard-Access-Token header instead of a
  // real login - see lib/useDashboardFilters.ts's new `previewFn` param,
  // which is what PublicDashboardView.tsx passes this through as.
  // Slug-only for now (no hostname/custom-domain counterpart) - a
  // white-labeled dashboard's filters stay inert until a future round
  // adds one; this round's fix covers the GD360-domain /d/:slug link,
  // which is what the screenshot showed.
  previewFiltered: (
    slug: string,
    pageId: string,
    filters: FilterCriterion[],
    blockFilters: Record<string, FilterCriterion[]> | undefined,
    viewerToken?: string
  ) =>
    publicApi
      .post<{ blocks: FilteredBlock[]; matched_rows: number | null; colors?: ColorRegistry | null }>(
        `/public/dashboards/${slug}/pages/${pageId}/preview-filtered`,
        { filters, block_filters: blockFilters || {} },
        { headers: viewerToken ? { "X-Dashboard-Access-Token": viewerToken } : undefined }
      )
      .then((r) => ({ blocks: r.data.blocks, matchedRows: r.data.matched_rows, colors: r.data.colors || null })),

  // Companion to previewFiltered above: what a filter block's Values tab
  // (ColumnFilterSpecEditor) shows on the public view, since it can't call
  // the authenticated datasourceApi.getColumnDistinctValues (that queries
  // the live datasource directly - exactly what this anonymous view must
  // never do). The backend derives this purely from whatever table/chart
  // blocks on the page already have the requested column in their own
  // materialized result_rows - see get_public_filter_options's own
  // docstring. `dtype` lets DashboardBlocks.tsx's ColumnFilterSpecEditor
  // pick the right Condition editor (number/date/text) without a second
  // network round trip.
  getColumnFilterOptions: (slug: string, pageId: string, column: string, viewerToken?: string) =>
    publicApi
      .get<{
        column: string;
        values: ColumnDistinctValue[];
        null_count: number;
        distinct_total: number;
        truncated: boolean;
        dtype: string;
      }>(`/public/dashboards/${slug}/pages/${pageId}/filter-options`, {
        params: { column },
        headers: viewerToken ? { "X-Dashboard-Access-Token": viewerToken } : undefined,
      })
      .then((r) => r.data),

  // ---- Warehouse-native dashboards (2026-10-06): the published view's
  // twins of dashboardBuilderApi.runPage / parameterOptions, keyed by slug
  // or (white-label) hostname. Same request/response; the owner's
  // connection and budget pay for every run (see backend
  // _public_warehouse_context), rate-limited per ip and per share. ----
  runPage: (slug: string, pageId: string, req: RunPageRequest, viewerToken?: string, signal?: AbortSignal) =>
    publicApi
      .post<RunPageResponse>(`/public/dashboards/${slug}/pages/${pageId}/run`, publicRunBody(req), {
        headers: viewerToken ? { "X-Dashboard-Access-Token": viewerToken } : undefined,
        signal,
      })
      .then((r) => r.data),
  runPageByHostname: (hostname: string, pageId: string, req: RunPageRequest, viewerToken?: string, signal?: AbortSignal) =>
    publicApi
      .post<RunPageResponse>(`/public/domains/${encodeURIComponent(hostname)}/pages/${pageId}/run`, publicRunBody(req), {
        headers: viewerToken ? { "X-Dashboard-Access-Token": viewerToken } : undefined,
        signal,
      })
      .then((r) => r.data),
  parameterOptions: (slug: string, paramId: string, opts: { search?: string; limit?: number } = {}, viewerToken?: string, signal?: AbortSignal) =>
    publicApi
      .get<ParameterOptions>(`/public/dashboards/${slug}/parameters/${paramId}/options`, {
        params: { search: opts.search || undefined, limit: opts.limit || undefined },
        headers: viewerToken ? { "X-Dashboard-Access-Token": viewerToken } : undefined,
        signal,
      })
      .then((r) => r.data),
  parameterOptionsByHostname: (hostname: string, paramId: string, opts: { search?: string; limit?: number } = {}, viewerToken?: string, signal?: AbortSignal) =>
    publicApi
      .get<ParameterOptions>(`/public/domains/${encodeURIComponent(hostname)}/parameters/${paramId}/options`, {
        params: { search: opts.search || undefined, limit: opts.limit || undefined },
        headers: viewerToken ? { "X-Dashboard-Access-Token": viewerToken } : undefined,
        signal,
      })
      .then((r) => r.data),
  // The hostname twin of previewFiltered above (the backend grew one in the
  // warehouse-native layer: preview_filtered_blocks_public_by_domain).
  previewFilteredByHostname: (
    hostname: string,
    pageId: string,
    filters: FilterCriterion[],
    blockFilters: Record<string, FilterCriterion[]> | undefined,
    viewerToken?: string
  ) =>
    publicApi
      .post<{ blocks: FilteredBlock[]; matched_rows: number | null; colors?: ColorRegistry | null }>(
        `/public/domains/${encodeURIComponent(hostname)}/pages/${pageId}/preview-filtered`,
        { filters, block_filters: blockFilters || {} },
        { headers: viewerToken ? { "X-Dashboard-Access-Token": viewerToken } : undefined }
      )
      .then((r) => ({ blocks: r.data.blocks, matchedRows: r.data.matched_rows, colors: r.data.colors || null })),
};

function publicRunBody(req: RunPageRequest) {
  return {
    filters: req.filters || [],
    block_filters: req.block_filters || {},
    period: req.period || undefined,
    date_range: req.date_range && (req.date_range.from || req.date_range.to) ? req.date_range : undefined,
    block_ids: req.block_ids || undefined,
    force_refresh: req.force_refresh || false,
    parameters: req.parameters || {},
  };
}

// ---- Scheduled auto-refresh + background jobs (2026-09-28, pages/Jobs.tsx)
// - see backend routers/jobs.py's own module docstring for the full
// design. Per-DASHBOARD schedules (not per-block - see backend
// models.Dashboard's own docstring for why), backed by the exact same
// recompute logic the manual "Ask AI"/"Build manually" block editor
// already uses. ----
export type RefreshInterval = "off" | "15m" | "1h" | "6h" | "daily";

export type DashboardSchedule = {
  dashboard_id: string;
  dashboard_name: string;
  source_label: string | null;
  refresh_interval: RefreshInterval;
  next_refresh_at: string | null;
  last_refreshed_at: string | null;
  last_run_status: "running" | "success" | "failed" | null;
  last_run_duration_seconds: number | null;
  last_run_error: string | null;
  can_edit: boolean;
};

export type JobRun = {
  id: string;
  dashboard_id: string | null;
  job_type: "scheduled_refresh" | "manual_refresh";
  target_label: string;
  source_label: string | null;
  status: "running" | "success" | "failed";
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  duration_seconds: number | null;
  next_run_at: string | null;
};

export type JobRunsPage = { runs: JobRun[]; total: number; page: number; page_size: number };

export const jobsApi = {
  // Every dashboard this person can see, one row per dashboard, whether or
  // not it has a schedule turned on yet - the Jobs page's main table.
  listSchedules: () => api.get<DashboardSchedule[]>("/jobs/schedules").then((r) => r.data),
  // "off" turns scheduling off entirely (next_refresh_at goes back to
  // null) - never a separate "disable" call, mirroring how the backend
  // itself treats "off" as just another refresh_interval value.
  updateSchedule: (dashboardId: string, refreshInterval: RefreshInterval) =>
    api
      .patch<DashboardSchedule>(`/jobs/schedules/${dashboardId}`, { refresh_interval: refreshInterval })
      .then((r) => r.data),
  // Runs this dashboard's refresh right now, outside its own schedule (or
  // with none set at all) - logged into the same run history as any
  // scheduled tick. Returns the JobRun this click just created.
  runNow: (dashboardId: string) => api.post<JobRun>(`/jobs/schedules/${dashboardId}/run-now`).then((r) => r.data),
  // The run-history table underneath the schedule table - newest first,
  // paginated.
  listRuns: (page = 1, pageSize = 20) =>
    api.get<JobRunsPage>("/jobs/runs", { params: { page, page_size: pageSize } }).then((r) => r.data),
};

// ---- Phase 4 (2026-09-28, Experimentation / A/B testing, pages/
// Experiments.tsx) - see backend routers/experiments.py's own module
// docstring for the full design, including why the public assign/convert
// calls a founder's own website makes are NOT exposed from here: those are
// called directly from that OTHER website's own client-side JS, never from
// this app's frontend. ----
export type ExperimentStatus = "running" | "stopped";

export type ExperimentVariantStats = {
  variant_name: string;
  assigned_count: number;
  converted_count: number;
  // null when assigned_count is 0 - a conversion rate is genuinely
  // undefined with zero visitors assigned yet, never shown as a
  // fabricated 0%.
  conversion_rate: number | null;
};

export type ExperimentStats = {
  variant_a: ExperimentVariantStats;
  variant_b: ExperimentVariantStats;
  p_value: number | null;
  is_significant: boolean;
  insufficient_data: boolean;
};

export type Experiment = {
  id: string;
  name: string;
  metric_name: string;
  variant_a_name: string;
  variant_b_name: string;
  status: ExperimentStatus;
  public_key: string;
  // Ready-to-paste URLs for the founder's OWN external website's
  // client-side assign/convert calls.
  assign_url: string;
  convert_url: string;
  created_at: string;
  started_at: string;
  stopped_at: string | null;
  stats: ExperimentStats;
  can_edit: boolean;
};

export type CreateExperimentPayload = {
  name: string;
  metric_name: string;
  variant_a_name?: string;
  variant_b_name?: string;
};

export const experimentsApi = {
  list: () => api.get<Experiment[]>("/experiments").then((r) => r.data),
  create: (payload: CreateExperimentPayload) => api.post<Experiment>("/experiments", payload).then((r) => r.data),
  get: (id: string) => api.get<Experiment>(`/experiments/${id}`).then((r) => r.data),
  // The only status transition this phase exposes - see backend
  // schemas.SetExperimentStatusRequest's own comment for why "stopped" is
  // the only value this ever accepts.
  setStatus: (id: string, status: "stopped") =>
    api.patch<Experiment>(`/experiments/${id}/status`, { status }).then((r) => r.data),
  delete: (id: string) => api.delete(`/experiments/${id}`).then(() => undefined),
};

// ---- Phase 5, Batch A (2026-09-28, "Data governance & quality" roadmap) -
// automated column-level quality checks on a data source, plus a
// workspace's own real, persisted audit log and access-review overview.
// See backend models.DataQualityRule/AuditEvent and
// routers/quality_checks.py/routers/governance.py for the full design. ----

export type QualityRuleType = "not_null" | "unique" | "min_value" | "max_value" | "allowed_values";

// {} for not_null/unique, {min: number} for min_value, {max: number} for
// max_value, {values: (string|number)[]} for allowed_values - see backend
// models.DataQualityRule's own docstring. Loosely typed here, same
// convention as PreviewOptions.filters/SavedView.config above - this
// client just passes it straight through.
export type QualityRuleConfig = { min?: number; max?: number; values?: (string | number)[] };

export type QualityRule = {
  id: string;
  datasource_id: string;
  column_name: string;
  rule_type: QualityRuleType;
  rule_config: QualityRuleConfig;
  created_at: string;
  last_run_at: string | null;
  // null only for a rule that has genuinely never run yet - in practice
  // every rule this app creates is run once immediately (see
  // qualityChecksApi.create), so this is here for completeness, not
  // because the panel expects to see it often.
  last_status: "pass" | "fail" | "error" | null;
  last_checked_row_count: number | null;
  last_failing_row_count: number | null;
  last_message: string | null;
  created_by_name: string | null;
  created_by_email: string | null;
};

// What a dashboard polls (once per data source it uses) to decide whether
// to show its "quality checks are failing" banner - cheap, read-only,
// never triggers a live re-run (see backend get_quality_status's own
// docstring).
export type QualityStatus = { has_failing_rules: boolean; failing_count: number };

export const qualityChecksApi = {
  list: (datasourceId: string) => api.get<QualityRule[]>(`/datasources/${datasourceId}/quality-rules`).then((r) => r.data),
  create: (datasourceId: string, payload: { column_name: string; rule_type: QualityRuleType; rule_config: QualityRuleConfig }) =>
    api.post<QualityRule>(`/datasources/${datasourceId}/quality-rules`, payload).then((r) => r.data),
  run: (datasourceId: string, ruleId: string) =>
    api.post<QualityRule>(`/datasources/${datasourceId}/quality-rules/${ruleId}/run`).then((r) => r.data),
  delete: (datasourceId: string, ruleId: string) => api.delete(`/datasources/${datasourceId}/quality-rules/${ruleId}`),
  status: (datasourceId: string) => api.get<QualityStatus>(`/datasources/${datasourceId}/quality-status`).then((r) => r.data),
};

export type GovernanceMemberAccess = { user_id: string; name: string | null; email: string; role: WorkspaceRole };

export type GovernanceDataSource = {
  id: string;
  name: string;
  kind: string;
  member_access: GovernanceMemberAccess[];
  governance_last_reviewed_at: string | null;
  // Already a display name/email, resolved server-side - never a raw id
  // the frontend can't render (see backend schemas.GovernanceDataSourceOut).
  governance_last_reviewed_by: string | null;
};

export type AuditEvent = {
  id: string;
  workspace_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  event_metadata: Record<string, unknown> | null;
  created_at: string;
  actor_name: string | null;
  actor_email: string | null;
};

export type AuditLogPage = { events: AuditEvent[]; total: number; page: number; page_size: number };

export const governanceApi = {
  overview: (workspaceId: string) =>
    api.get<{ datasources: GovernanceDataSource[] }>(`/workspaces/${workspaceId}/governance-overview`).then((r) => r.data.datasources),
  markReviewed: (datasourceId: string) =>
    api
      .post<{ datasource_id: string; governance_last_reviewed_at: string; governance_last_reviewed_by_id: string }>(
        `/datasources/${datasourceId}/mark-reviewed`
      )
      .then((r) => r.data),
  auditLog: (workspaceId: string, page = 1, pageSize = 20) =>
    api
      .get<AuditLogPage>(`/workspaces/${workspaceId}/audit-log`, { params: { page, page_size: pageSize } })
      .then((r) => r.data),
};

// ---- Phase 5, Batch B (data governance & quality - row/column
// permissions) - a data source owner restricting what their workspace's
// "member"/"viewer" role tiers see of the data: hide a column entirely, or
// restrict a column to an explicit allow-list of values (row filtering).
// See backend models.DataAccessRule and routers/data_access_rules.py for
// the full design; owner-only, stricter than every other write on a data
// source's own row (see that router's own module docstring). ----

export type AccessRuleRole = "member" | "viewer";
export type AccessRuleKind = "row" | "column";

export interface AccessRule {
  id: string;
  datasource_id: string;
  role: AccessRuleRole;
  kind: AccessRuleKind;
  column_name: string;
  allowed_values: (string | number | boolean)[] | null;
  created_at: string;
  created_by_id: string;
  created_by_name: string | null;
}

export const accessRulesApi = {
  list: (datasourceId: string) => api.get<AccessRule[]>(`/datasources/${datasourceId}/access-rules`).then((r) => r.data),
  create: (
    datasourceId: string,
    payload: { role: AccessRuleRole; kind: AccessRuleKind; column_name: string; allowed_values?: (string | number | boolean)[] }
  ) => api.post<AccessRule>(`/datasources/${datasourceId}/access-rules`, payload).then((r) => r.data),
  delete: (datasourceId: string, ruleId: string) => api.delete(`/datasources/${datasourceId}/access-rules/${ruleId}`),
};

// ---- 2026-09-28 (ML Models round) - the real ML feature: train, list,
// view, predict with, bulk-score with, retrain and delete a real
// scikit-learn model. See backend models.MLModel/MLPrediction and
// routers/ml_models.py for the full design. Always "ML Model(s)" here -
// never just "Model(s)" - a naming-collision habit kept from when this app
// also had a "Saved Tables" feature (since removed) sitting right next to
// this one. ----

export type MLTaskType = "classification" | "regression";
export type MLModelStatus = "training" | "ready" | "failed";

export type MLExcludedColumn = { column: string; reason: string };

// Keys depend on task_type - classification: accuracy/precision/recall/f1
// (each 0-1); regression: mae/rmse/r2. Always real, computed numbers from
// the model's own held-out test split - never fabricated (see
// services/ml_training.py's own module docstring).
export type MLClassificationMetrics = { accuracy: number; precision: number; recall: number; f1: number };
export type MLRegressionMetrics = { mae: number; rmse: number; r2: number };
export type MLMetrics = Partial<MLClassificationMetrics & MLRegressionMetrics>;

// 2026-09-30 (model trustworthiness round): real, GLOBAL feature
// importance - see backend models.MLModel.feature_importance's own
// docstring. importance is normalized to sum to 1.0 across a model's own
// list, so it always reads as "share of this model's own reasoning",
// never an absolute unit.
export type FeatureImportanceEntry = { feature: string; importance: number };

// The real, per-feature contribution breakdown behind ONE specific
// prediction - only ever present for a linear/logistic model. See
// backend models.MLPrediction.explanation's own docstring for why a
// random-forest prediction leaves this out entirely rather than
// approximating it.
export type PredictionExplanationEntry = { feature: string; value: string | number | boolean | null; contribution: number };

// 2026-09-30 (leakage-guardrail round): real, threshold-based information
// about an already-trained result worth a second look - see backend
// models.MLModel.quality_warnings/services/ml_training.py's own module
// docstring for the full story (a real, confirmed "predict Sales" leakage
// case that motivated this) and lib/mlModelText.ts's own
// qualityWarningText for how each type below becomes a plain sentence.
// Every field here is a real number the backend already computed - this
// type never carries a pre-written message.
// 2026-10-05: "sampled_training_data" added alongside the three leakage-
// guardrail-round types above - a different KIND of notice (a transparency
// disclosure, not a quality concern) but it travels through this exact
// same real-numbers-only mechanism rather than inventing a second one. See
// backend services/ml_training.py's MAX_TRAINING_ROWS for why this exists:
// a very large uploaded file is now trained on a random, honestly-labeled
// sample instead of risking the same out-of-memory crash the chat/upload
// paths were fixed against earlier the same day.
export type MLQualityWarningType =
  | "near_perfect_score" | "dominant_feature" | "high_correlation_feature" | "sampled_training_data";
export type MLQualityWarning = {
  type: MLQualityWarningType;
  metric?: "r2" | "accuracy" | null; // near_perfect_score only
  value?: number | null; // near_perfect_score only - that metric's real value
  feature?: string | null; // dominant_feature / high_correlation_feature only
  importance?: number | null; // dominant_feature only - real share, 0-1
  correlation?: number | null; // high_correlation_feature only - real, signed Pearson correlation
  rows_used?: number | null; // sampled_training_data only - the real sample size actually trained on
  rows_total?: number | null; // sampled_training_data only - the real total rows available before sampling
};

// The real, computed "would this column actually be used, and does it
// look risky" answer for ONE candidate feature - see backend
// services/ml_training.preview_features's own docstring. Only ever
// carries a real `correlation`/`risk` for a REGRESSION target's numeric
// candidates; both stay null for a classification target or a
// non-numeric column, never a fabricated placeholder.
export type MLFeatureRisk = "high" | "medium";
export type MLFeatureCandidate = {
  column: string;
  is_numeric: boolean;
  distinct_count: number;
  correlation: number | null;
  risk: MLFeatureRisk | null;
};

export type PreviewMLFeaturesResult = {
  task_type: MLTaskType;
  usable: MLFeatureCandidate[];
  excluded: MLExcludedColumn[];
};

export type MLModel = {
  id: string;
  datasource_id: string;
  datasource_name: string;
  name: string;
  description: string | null;
  task_type: MLTaskType | null;
  target_column: string;
  feature_columns: string[] | null;
  excluded_columns: MLExcludedColumn[] | null;
  algorithm: string | null;
  metrics: MLMetrics | null;
  feature_importance: FeatureImportanceEntry[] | null;
  // See MLQualityWarning's own comment above. null for a model trained
  // before this round existed; [] for one trained since with nothing to
  // flag - only [] actually means "checked, and it's clean".
  quality_warnings: MLQualityWarning[] | null;
  status: MLModelStatus;
  error_message: string | null;
  trained_row_count: number | null;
  created_at: string;
  trained_at: string | null;
  prediction_count: number;
  last_predicted_at: string | null;
  // Which version (see MLModelVersion below) is currently active.
  version_number: number;
  owner_id: string;
  // Resolved server-side (owner_id === the caller) - the frontend hides
  // the delete button entirely for anyone else, matching the backend's own
  // creator-only enforcement (see routers/ml_models.py delete_ml_model).
  can_delete: boolean;
};

// 2026-09-30 (model trustworthiness round): one real, past snapshot of an
// MLModel - see backend models.MLModelVersion's own docstring. Retraining
// no longer discards the model that came before it; this is that history.
export type MLModelVersion = {
  id: string;
  version_number: number;
  is_current: boolean;
  created_reason: "trained" | "promoted";
  algorithm: string | null;
  metrics: MLMetrics | null;
  feature_importance: FeatureImportanceEntry[] | null;
  // This version's own real snapshot - see MLQualityWarning's own comment
  // above. Travels with the version, so promoting an old one restores its
  // own warnings too, never someone else's.
  quality_warnings: MLQualityWarning[] | null;
  trained_row_count: number | null;
  created_at: string;
};

export type TrainMLModelPayload = {
  datasource_id: string;
  target_column: string;
  // Omitted (or undefined) means "auto-select every usable column" - the
  // wizard's zero-configuration default path (see
  // services/ml_training.select_features).
  feature_columns?: string[] | null;
  name: string;
  description?: string | null;
};

export type PredictResult = {
  predicted_value: string | number | boolean | null;
  confidence: number | null;
  // See PredictionExplanationEntry's own comment above - null for a
  // random-forest or multiclass winning algorithm, never fabricated.
  explanation: PredictionExplanationEntry[] | null;
};
export type ScoreTableResult = { new_version_id: string; new_version_name: string; row_count: number };

export const mlModelsApi = {
  train: (payload: TrainMLModelPayload) => api.post<MLModel>("/ml-models/train", payload).then((r) => r.data),
  list: () => api.get<MLModel[]>("/ml-models").then((r) => r.data),
  get: (id: string) => api.get<MLModel>(`/ml-models/${id}`).then((r) => r.data),
  // 2026-09-30 (leakage-guardrail round): the real, computed "what would
  // training actually use, and does any of it look risky" answer, with
  // zero side effects - no model is created or trained. See backend
  // services/ml_training.preview_features's own docstring.
  previewFeatures: (datasourceId: string, targetColumn: string) =>
    api
      .post<PreviewMLFeaturesResult>("/ml-models/preview-features", { datasource_id: datasourceId, target_column: targetColumn })
      .then((r) => r.data),
  predict: (id: string, inputValues: Record<string, unknown>) =>
    api.post<PredictResult>(`/ml-models/${id}/predict`, { input_values: inputValues }).then((r) => r.data),
  score: (id: string, table?: string | null) =>
    api.post<ScoreTableResult>(`/ml-models/${id}/score`, { table: table || undefined }).then((r) => r.data),
  // 2026-09-30 (leakage-guardrail round): `featureColumns` is optional and
  // still defaults to the original, unchanged behavior (reuse whichever
  // columns this model's last training run actually used) when omitted -
  // see backend schemas.RetrainMLModelRequest's own comment for why this
  // now exists: without it, changing an EXISTING model's feature set
  // needed a direct database edit.
  retrain: (id: string, featureColumns?: string[]) =>
    api
      .post<MLModel>(`/ml-models/${id}/retrain`, featureColumns ? { feature_columns: featureColumns } : undefined)
      .then((r) => r.data),
  delete: (id: string) => api.delete(`/ml-models/${id}`).then(() => undefined),
  // 2026-09-30 (model trustworthiness round): see MLModelVersion's own
  // comment above and backend routers/ml_models.py.
  listVersions: (id: string) => api.get<MLModelVersion[]>(`/ml-models/${id}/versions`).then((r) => r.data),
  promoteVersion: (id: string, versionId: string) =>
    api.post<MLModel>(`/ml-models/${id}/versions/${versionId}/promote`).then((r) => r.data),
};

// ---- Semantic layer v1 (2026-09-30) - a data source's own saved metric
// glossary: define "Revenue" or "Active Users" once with an exact column,
// aggregation, and filter criteria, and reuse that exact definition on a
// dashboard kpi/gauge tile (DashboardCanvas.tsx's ManualBuildPanel) and in
// chat (backend services/ai_engine.py, entirely server-side - nothing
// here to call for that part). See backend models.MetricDefinition's own
// docstring and services/metrics.py for the full design. ----

export type MetricAgg = "sum" | "avg" | "count" | "min" | "max";

export type MetricDefinition = {
  id: string;
  datasource_id: string;
  datasource_name: string;
  name: string;
  description: string | null;
  metric_column: string;
  agg: MetricAgg;
  filters: FilterCriterion[];
  created_at: string;
  updated_at: string;
  owner_id: string;
  created_by_name: string | null;
  // Resolved live, server-side, every time this metric is listed/fetched -
  // never a stale cached number. null (with current_value_error explaining
  // why) rather than a fabricated 0 when it can't currently be computed.
  current_value: number | null;
  current_value_error: string | null;
  // Same creator-only convention as MLModel.can_delete - resolved
  // server-side so this client never has to re-derive ownership logic.
  can_delete: boolean;
};

export type MetricDefinitionPayload = {
  name: string;
  description?: string | null;
  metric_column: string;
  agg: MetricAgg;
  filters?: FilterCriterion[];
};

export const metricDefinitionsApi = {
  list: (datasourceId: string) =>
    api.get<MetricDefinition[]>(`/datasources/${datasourceId}/metric-definitions`).then((r) => r.data),
  create: (datasourceId: string, payload: MetricDefinitionPayload) =>
    api.post<MetricDefinition>(`/datasources/${datasourceId}/metric-definitions`, payload).then((r) => r.data),
  update: (datasourceId: string, metricId: string, payload: MetricDefinitionPayload) =>
    api.put<MetricDefinition>(`/datasources/${datasourceId}/metric-definitions/${metricId}`, payload).then((r) => r.data),
  delete: (datasourceId: string, metricId: string) =>
    api.delete(`/datasources/${datasourceId}/metric-definitions/${metricId}`).then(() => undefined),
};

// ---- Transformation layer v1 (2026-09-30) - a data source's own saved
// tables: a named, ordered pipeline of small steps (filter, add a derived
// column, keep only certain columns, rename a column, group + aggregate)
// that turns the raw data into a new, reusable derived table. Reuse that
// exact table on a dashboard block (DashboardCanvas.tsx's ManualBuildPanel,
// same "Use a saved ___" pattern as metricDefinitionsApi above) and in chat
// (backend services/ai_engine.py, entirely server-side). See backend
// models.DataTransform's own docstring and services/transforms.py for the
// full design and the exact shape of each step type. ----

export type TransformStep = {
  op: "filter" | "add_column" | "select_columns" | "rename_column" | "group_by";
  // Every other field is op-specific - kept as a loose index signature
  // (not five separate TS types unioned together) for the same reason the
  // backend keeps TransformStep as a permissive dict rather than a
  // discriminated Pydantic union: services/transforms.py's own validation
  // is the single source of truth for what's valid, and this client's job
  // is only to build and display these, never to validate them itself.
  [key: string]: any;
};

export type DataTransform = {
  id: string;
  datasource_id: string;
  datasource_name: string;
  name: string;
  description: string | null;
  steps: TransformStep[];
  // One plain-English line per step, in order - mirrors backend
  // services/transforms.describe_transform, so this panel's own summary
  // never disagrees with what the AI is told.
  step_summary: string[];
  created_at: string;
  updated_at: string;
  owner_id: string;
  created_by_name: string | null;
  // Resolved live, server-side, every time this transform is listed/
  // fetched - never a stale cached result. null (with preview_error
  // explaining why) rather than a fabricated empty table when it can't
  // currently be computed.
  preview_columns: string[] | null;
  preview_row_count: number | null;
  preview_error: string | null;
  can_delete: boolean;
};

export type DataTransformPayload = {
  name: string;
  description?: string | null;
  steps: TransformStep[];
};

export type TransformPreview = {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  error: string | null;
};

export const transformsApi = {
  list: (datasourceId: string) =>
    api.get<DataTransform[]>(`/datasources/${datasourceId}/transforms`).then((r) => r.data),
  create: (datasourceId: string, payload: DataTransformPayload) =>
    api.post<DataTransform>(`/datasources/${datasourceId}/transforms`, payload).then((r) => r.data),
  update: (datasourceId: string, transformId: string, payload: DataTransformPayload) =>
    api.put<DataTransform>(`/datasources/${datasourceId}/transforms/${transformId}`, payload).then((r) => r.data),
  delete: (datasourceId: string, transformId: string) =>
    api.delete(`/datasources/${datasourceId}/transforms/${transformId}`).then(() => undefined),
  // Live preview of UNSAVED steps while building/editing - posts the
  // in-progress steps list directly rather than a saved transform id, so
  // the builder's preview stays in sync with every edit before Save.
  preview: (datasourceId: string, steps: TransformStep[]) =>
    api.post<TransformPreview>(`/datasources/${datasourceId}/transforms/preview`, { steps }).then((r) => r.data),
  // The real preview ROWS for an already-saved transform - used by
  // ManualBuildPanel to populate its "which column" pickers from a saved
  // transform's OWN output columns, not the raw data source's.
  getData: (datasourceId: string, transformId: string) =>
    api.get<TransformPreview>(`/datasources/${datasourceId}/transforms/${transformId}/data`).then((r) => r.data),
};

// ---- Orchestration v1 (2026-09-30) - see backend models.Pipeline's own
// docstring for the full design: a named, saved, LINEAR chain of a few
// whitelisted step types, run strictly in order, on demand or on a
// schedule reusing the exact same four-value interval vocabulary
// (RefreshInterval, above) the Jobs page's dashboard schedules already
// use. 2026-09-30 (Governance/Jobs redesign round): the standalone
// pages/Pipelines.tsx page is gone - this same pipelinesApi now backs the
// "Chains" tab inside pages/Jobs.tsx instead. Every type/call below is
// unchanged; only which page renders them moved. ----
export type PipelineStepType = "refresh_datasource" | "rebuild_dashboard" | "run_quality_checks";

export type PipelineStep =
  | { type: "refresh_datasource"; datasource_id: string }
  | { type: "rebuild_dashboard"; dashboard_id: string }
  | { type: "run_quality_checks"; datasource_id: string };

export type PipelineStepResult = {
  index: number;
  type: string | null;
  label: string | null;
  status: "success" | "failed";
  detail: Record<string, unknown> | null;
  error: string | null;
};

export type PipelineRun = {
  id: string;
  pipeline_id: string | null;
  run_type: "scheduled" | "manual";
  pipeline_name: string;
  status: "running" | "success" | "failed";
  error_message: string | null;
  step_results: PipelineStepResult[];
  started_at: string;
  finished_at: string | null;
  duration_seconds: number | null;
  next_run_at: string | null;
};

export type PipelineRunsPage = {
  runs: PipelineRun[];
  total: number;
  page: number;
  page_size: number;
};

export type Pipeline = {
  id: string;
  name: string;
  description: string | null;
  steps: PipelineStep[];
  // Plain-English one-liner per step, resolved live from each step's
  // current target name - same "always live, never stale" convention
  // DataTransform.step_summary already established.
  step_summary: string[];
  schedule_interval: RefreshInterval; // "off" | "15m" | "1h" | "6h" | "daily"
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: "running" | "success" | "failed" | null;
  can_edit: boolean;
  can_delete: boolean;
  created_at: string;
  updated_at: string;
};

export type PipelinePayload = {
  name: string;
  description?: string | null;
  steps: PipelineStep[];
  schedule_interval: RefreshInterval;
  workspace_id?: string | null;
};

export const pipelinesApi = {
  list: () => api.get<Pipeline[]>("/pipelines").then((r) => r.data),
  get: (pipelineId: string) => api.get<Pipeline>(`/pipelines/${pipelineId}`).then((r) => r.data),
  create: (payload: PipelinePayload) => api.post<Pipeline>("/pipelines", payload).then((r) => r.data),
  update: (pipelineId: string, payload: Partial<PipelinePayload>) =>
    api.put<Pipeline>(`/pipelines/${pipelineId}`, payload).then((r) => r.data),
  delete: (pipelineId: string) => api.delete(`/pipelines/${pipelineId}`).then(() => undefined),
  // Runs this pipeline's steps immediately, outside its own schedule (or
  // with none set at all) - logged into the same run history as any
  // scheduled tick. Returns the PipelineRun this click just created.
  runNow: (pipelineId: string) => api.post<PipelineRun>(`/pipelines/${pipelineId}/run-now`).then((r) => r.data),
  listRuns: (pipelineId: string, page = 1, pageSize = 20) =>
    api
      .get<PipelineRunsPage>(`/pipelines/${pipelineId}/runs`, { params: { page, page_size: pageSize } })
      .then((r) => r.data),
};

// ---- Data catalog v1 (2026-09-30) - REMOVED (Governance/Jobs redesign +
// Pipelines/Catalog removal round). Gokul's own report: the Catalog page's
// account-wide search duplicated the Projects filter and Data Sources
// page and "leads to confusion" - pages/Catalog.tsx, this catalogApi, and
// backend routers/catalog.py + services/catalog.py are all gone. Its one
// real, non-redundant capability (editing a data source's short
// description) now lives inline on DataSources.tsx, calling the same
// datasourceApi.updateDescription below that was already independent of
// catalogApi. ----
