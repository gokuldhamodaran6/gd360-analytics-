import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { datasourceApi, DataPreview, DataProfile, ProfileColumnStat } from "../api/client";

// 2026-10-06 (profile-first Data tab): the Data tab for an ORIGINAL table
// of a warehouse/database source. The founder's rule for these sources is
// that the table never loads into GD360 - not 2,000 rows, not 100,000 - so
// instead of DataTable.tsx's row-grid (which pulled up to
// BIGQUERY_MAX_ROWS_LOADED / PREVIEW_ROW_LIMIT rows just to page through
// them), this shows the SHAPE of the whole table: the full-table profile
// (/profile - one aggregate query run inside the warehouse over every
// row, cached server-side) as stat tiles and a per-column table, with a
// tiny, clearly labelled set of example rows underneath
// (/preview?sample_rows=20 - the connector is asked for exactly 20 rows).
//
// Everything the old grid offered that depended on having rows in the
// browser (column filters, sort, pagination, totals, the Excel-style
// menus) is deliberately absent here - the 20 rows are read-only
// examples, every real number comes from the profile. DataTable.tsx
// renders this instead of its grid strictly when `isProfileSupportedKind`
// AND no saved DatasetVersion is selected; every other source kind (CSV/
// Excel/API/Google Sheets/Microsoft Excel/MongoDB) and every saved table
// still gets the existing grid, untouched.

// Mirrors backend routers/datasources.py's _PROFILE_SUPPORTED_KINDS
// exactly - MongoDB is profile-unsupported there and keeps the grid.
export const PROFILE_SUPPORTED_KINDS = ["bigquery", "snowflake", "postgres", "mysql", "sqlserver", "supabase"] as const;

export function isProfileSupportedKind(kind: string | undefined | null): boolean {
  return !!kind && (PROFILE_SUPPORTED_KINDS as readonly string[]).includes(kind);
}

export const KIND_LABELS: Record<string, string> = {
  bigquery: "BigQuery",
  snowflake: "Snowflake",
  postgres: "Postgres",
  mysql: "MySQL",
  sqlserver: "SQL Server",
  supabase: "Supabase",
};

// How many column rows show before the "Show N more columns" expander.
const COLUMNS_INITIALLY_SHOWN = 12;
// A column this empty (or emptier) is tinted amber - the mockup's
// "agent"/"company" rows. Below that, the empty count is still shown,
// just in muted text (the mockup's "country · 488 empty").
const EMPTY_HEAVY_PCT = 5;

export type TypeGroup = "text" | "number" | "date" | "bool" | "other";

// One coarse family per declared warehouse/database type string, across
// every dialect this app connects to (BigQuery "INT64"/"STRING"/"DATE",
// Snowflake "NUMBER"/"TEXT"/"TIMESTAMP_NTZ", Postgres "INTEGER"/"character
// varying"/"timestamp without time zone", MySQL "VARCHAR(255)", SQL Server
// "nvarchar"/"datetime2", ...). Honest fallback is "other", never a guess.
export function typeGroup(type: string | null | undefined): TypeGroup {
  const t = (type || "").toLowerCase();
  if (!t) return "other";
  if (/bool|^bit$/.test(t)) return "bool";
  if (/date|time/.test(t)) return "date";
  if (/int|float|double|decimal|numeric|number|real|money|serial/.test(t)) return "number";
  if (/char|text|string|varchar|clob|uuid|enum/.test(t)) return "text";
  return "other";
}

export type UseItAs =
  | "Category"
  | "Category · geo"
  | "Flag"
  | "Measure"
  | "Measure · money"
  | "Time · year"
  | "Time · month"
  | "Time · date"
  | "ID"
  | "Text";

// A deliberately simple, honest "what is this column for" heuristic from
// the declared type + exact distinct count + a few name hints. The brief's
// own rules, in order: 2 or fewer distinct values is a Flag; a date type,
// or date/year/month in the name, is Time; a string with 50 or fewer
// distinct values is a Category (geo when the name says so); a numeric
// column with many distinct values is a Measure (money when the name says
// so); a high-distinct string with an id/agent/company-style name is an
// ID; anything else high-distinct is plain Text. Nothing here is ever
// derived from the example rows.
export function useItAs(name: string, type: string | null | undefined, stat: ProfileColumnStat | undefined): UseItAs {
  const n = name.toLowerCase();
  const group = typeGroup(type);
  const distinct = stat?.distinct ?? null;
  if (group === "bool") return "Flag";
  if (group === "date") return "Time · date";
  if (/(^|_)(year|yr)(_|$)/.test(n)) return "Time · year";
  if (/(^|_)month(_|$)/.test(n)) return "Time · month";
  if (/(^|_)(date|day|week|quarter|timestamp)(_|$)/.test(n)) return "Time · date";
  if (distinct != null && distinct <= 2) return "Flag";
  const idLike = /(^|_)(id|ids|uuid|key|code|number|no)(_|$)|^id|_id$|agent|company|customer|account|user|email|phone|sku/.test(n);
  if (group === "number") {
    if (idLike && (distinct == null || distinct > 50)) return "ID";
    if (/price|amount|revenue|cost|adr|rate|fee|salary|total|sales|income|spend|budget|paid|payment|usd|eur|gbp|profit|margin/.test(n)) {
      return "Measure · money";
    }
    return "Measure";
  }
  if (/country|city|state|region|province|county|continent|nation|territory|zip|postal|geo|lat|lon|address/.test(n)) {
    return "Category · geo";
  }
  if (distinct != null && distinct <= 50) return "Category";
  if (idLike) return "ID";
  return "Text";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatAgo(cachedAtEpochSeconds: number): { line: string; short: string } {
  const ageMin = Math.max(0, Math.round((Date.now() - cachedAtEpochSeconds * 1000) / 60000));
  if (ageMin < 1) return { line: "just now", short: "just now" };
  if (ageMin === 1) return { line: "1 minute ago", short: "cached 1 min" };
  return { line: `${ageMin} minutes ago`, short: `cached ${ageMin} min` };
}

function formatNumber(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function formatScalar(v: number | string | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  // An ISO timestamp from the backend's _jsonify_scalar - trim the time
  // part when it is midnight, so a DATE column reads as a date.
  const m = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?$/.exec(v);
  return m ? m[1] : v;
}

function parseDate(v: number | string | null | undefined): Date | null {
  if (typeof v !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthYear(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// The widest date range among the profiled columns - a real date-typed
// column first (min/max as ISO strings), else a numeric "year" column
// whose min/max look like years. null means "hide the tile", never a
// fabricated range.
export function dateCoverage(columns: Record<string, ProfileColumnStat>): { from: string; to: string; source: string } | null {
  let best: { span: number; from: string; to: string; source: string } | null = null;
  for (const [name, stat] of Object.entries(columns)) {
    if (typeGroup(stat.type) !== "date") continue;
    const a = parseDate(stat.min);
    const b = parseDate(stat.max);
    if (!a || !b) continue;
    const span = b.getTime() - a.getTime();
    if (!best || span > best.span) best = { span, from: monthYear(a), to: monthYear(b), source: name };
  }
  if (best) return { from: best.from, to: best.to, source: best.source };
  for (const [name, stat] of Object.entries(columns)) {
    if (!/(^|_)(year|yr)(_|$)/.test(name.toLowerCase())) continue;
    const a = Number(stat.min);
    const b = Number(stat.max);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1900 || b > 2200) continue;
    const span = b - a;
    if (!best || span > best.span) best = { span, from: String(a), to: String(b), source: name };
  }
  return best ? { from: best.from, to: best.to, source: best.source } : null;
}

// Exported (Tile, SkeletonTile, ColumnStatCells, ExampleRowsBlock below)
// so GeneratedTableView.tsx - the Data tab for a warehouse SAVED-QUERY
// version (2026-10-06, "generated data is a saved query" layer) - renders
// the exact same tiles, column cells and example-rows block as this
// original-table view, rather than a second copy that could drift.
export function Tile({ label, value, sub, testId, valueSize = "lg" }: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  testId: string;
  valueSize?: "lg" | "md";
}) {
  return (
    <div className="bg-surface border border-border rounded-xl px-4 py-3.5 flex flex-col gap-1 min-w-0" data-testid={testId}>
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div
        className={`font-semibold tabular-nums text-text truncate ${valueSize === "lg" ? "text-2xl" : "text-base pt-1"}`}
        data-testid={`${testId}-value`}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-muted truncate">{sub}</div>}
    </div>
  );
}

export function SkeletonTile() {
  return (
    <div className="bg-surface border border-border rounded-xl px-4 py-3.5 flex flex-col gap-2 animate-pulse" data-testid="wh-skeleton-tile">
      <div className="h-2.5 w-16 rounded bg-surface2" />
      <div className="h-6 w-24 rounded bg-surface2" />
      <div className="h-2.5 w-28 rounded bg-surface2" />
    </div>
  );
}

export const COLUMN_GRID = "grid gap-3 items-center";
export const COLUMN_GRID_STYLE: CSSProperties = {
  gridTemplateColumns: "200px 90px 140px 90px minmax(0, 1fr) 130px",
};

// The Type / Filled / Distinct / Values cells of one column row - the four
// middle cells every column table on a warehouse Data tab shares (the
// first cell, the name, and the last, "Use it as" or "Change", differ per
// view, so each view renders those itself around this fragment). Every
// number comes from the profile stat alone; `extraValues` lets a view
// append its own note inside the Values cell (the generated view's
// "was 63% / 37%"), rendered after the empty count exactly where this
// view would put nothing.
export function ColumnStatCells({
  stat, totalRows, showTopValues, extraValues,
}: {
  stat: ProfileColumnStat;
  totalRows: number | null;
  showTopValues: boolean;
  extraValues?: ReactNode;
}) {
  const filledPct = stat.null_pct != null ? Math.max(0, 100 - stat.null_pct) : null;
  const emptyCount = totalRows != null && stat.non_null != null ? Math.max(0, totalRows - stat.non_null) : 0;
  const emptyHeavy = (stat.null_pct ?? 0) >= EMPTY_HEAVY_PCT;
  const group = typeGroup(stat.type);
  const hasRange = (group === "number" || group === "date") && stat.min != null && stat.max != null;
  const topValues = showTopValues && stat.top_values && stat.top_values.length > 0 ? stat.top_values : null;
  return (
    <>
      <div className="text-xs text-muted truncate" title={stat.type || undefined}>{stat.type || "—"}</div>
      <div className="flex items-center gap-2">
        <div className="w-16 h-1.5 rounded-full bg-surface2 overflow-hidden shrink-0">
          <div
            className={`h-1.5 ${emptyHeavy ? "bg-amber-500" : "bg-primary"}`}
            style={{ width: `${filledPct ?? 0}%` }}
          />
        </div>
        <span className={`text-xs tabular-nums ${emptyHeavy ? "text-amber-400" : "text-text"}`}>
          {filledPct != null ? `${filledPct < 99.95 && filledPct > 0 ? filledPct.toFixed(1) : Math.round(filledPct)}%` : "—"}
        </span>
      </div>
      <div className="tabular-nums text-text">{stat.distinct != null ? stat.distinct.toLocaleString() : "—"}</div>
      <div className="flex items-center gap-1.5 flex-wrap text-xs min-w-0" data-testid="wh-values">
        {topValues ? (
          <>
            {topValues.map((tv, i) => (
              <span
                key={`${String(tv.value)}-${i}`}
                className={`rounded-md px-2 py-0.5 whitespace-nowrap ${i === 0 ? "bg-primary/10 text-primary" : "bg-surface2 text-text"}`}
                data-testid="wh-top-value"
              >
                {formatScalar(tv.value)}{tv.pct != null ? ` ${tv.pct < 1 ? "<1" : Math.round(tv.pct)}%` : ""}
              </span>
            ))}
            {stat.distinct != null && stat.distinct > topValues.length && (
              <span className="text-muted">+ {(stat.distinct - topValues.length).toLocaleString()} more</span>
            )}
          </>
        ) : hasRange ? (
          <div className="flex items-center gap-2.5 tabular-nums min-w-0">
            <span className="text-text whitespace-nowrap">{formatScalar(stat.min)}</span>
            <div className="h-1.5 rounded-full bg-primary/30 w-24 sm:w-40 shrink" />
            <span className="text-text whitespace-nowrap">{formatScalar(stat.max)}</span>
          </div>
        ) : stat.distinct != null ? (
          <span className="text-muted">{stat.distinct.toLocaleString()} different values</span>
        ) : (
          <span className="text-muted">—</span>
        )}
        {emptyCount > 0 && (
          <span className={emptyHeavy ? "text-amber-400" : "text-muted"} data-testid="wh-empty-count">
            {emptyCount.toLocaleString()} empty
          </span>
        )}
        {extraValues}
      </div>
    </>
  );
}

// The "Example rows" card: a tiny, clearly labelled, read-only set of rows
// (never used for a number) with the real statement the connector ran as
// its footer. `highlightColumns` tints a column's header and cells (the
// generated view marks its derived columns this way) - empty for the
// original-table view, which renders exactly as it always has.
export function ExampleRowsBlock({
  sample, sampleLoading, sampleError, caption, highlightColumns,
}: {
  sample: DataPreview | null;
  sampleLoading: boolean;
  sampleError: string | null;
  caption: string;
  highlightColumns?: Set<string>;
}) {
  const sampleCount = sample?.rows?.length ?? 0;
  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden" data-testid="wh-examples">
      <div className="flex flex-wrap items-center gap-2.5 px-4 py-3 border-b border-border">
        <div className="font-semibold text-[15px] text-text">Example rows</div>
        <span
          className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-md px-2 py-0.5"
          data-testid="wh-examples-caption"
        >
          {caption} · for reading values only
        </span>
        <div className="text-xs text-muted">never used for totals, charts or AI answers</div>
      </div>
      <div className="overflow-x-auto">
        {sampleLoading ? (
          <div className="px-4 py-6 text-xs text-muted animate-pulse">Fetching 20 example rows…</div>
        ) : sampleError ? (
          <div className="px-4 py-6 text-xs text-red-400">{sampleError}</div>
        ) : sample && sample.columns.length > 0 ? (
          <table className="border-collapse w-full text-[13px] tabular-nums min-w-max" data-testid="wh-examples-table">
            <thead>
              <tr className="bg-surface2 text-muted text-left">
                {sample.columns.map((c) => (
                  <th
                    key={c}
                    className={`px-3 py-2 font-medium font-mono text-[11px] whitespace-nowrap${highlightColumns?.has(c) ? " text-primary bg-primary/10" : ""}`}
                    data-new-column={highlightColumns?.has(c) ? "true" : undefined}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sample.rows.map((row, i) => (
                <tr key={i} className="border-t border-border/50">
                  {sample.columns.map((c) => {
                    const v = row[c];
                    const empty = v === null || v === undefined || v === "";
                    return (
                      <td
                        key={c}
                        className={`px-3 py-1.5 whitespace-nowrap max-w-[280px] truncate ${empty ? "text-muted/50" : "text-text"}${highlightColumns?.has(c) ? " bg-primary/5 font-medium" : ""}`}
                      >
                        {empty ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-4 py-6 text-xs text-muted">No example rows came back.</div>
        )}
      </div>
      {sample && (
        <div className="px-4 py-2 bg-surface2/60 border-t border-border/50 text-[11px] text-muted" data-testid="wh-examples-sql">
          {sampleCount} example {sampleCount === 1 ? "row" : "rows"}
          {sample.sample_sql ? <> · <span className="font-mono text-text/80">{sample.sample_sql}</span></> : null}
        </div>
      )}
    </div>
  );
}

export default function WarehouseDataView({
  datasourceId,
  datasourceKind,
  activeTable,
  originalTablesCount,
}: {
  datasourceId: string;
  datasourceKind: string;
  activeTable?: string | null;
  // Same guard DataTable.tsx's own profile effect uses (see its comment):
  // for a multi-table source, `activeTable` is transiently null while
  // Workspace resolves the default table - fetching then would profile
  // the wrong (default) table AND the real one, two billable queries.
  originalTablesCount: number;
}) {
  const [profile, setProfile] = useState<DataProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileRequestError, setProfileRequestError] = useState<string | null>(null);
  const [profileRetryKey, setProfileRetryKey] = useState(0);

  const [sample, setSample] = useState<DataPreview | null>(null);
  const [sampleLoading, setSampleLoading] = useState(true);
  const [sampleError, setSampleError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [showTopValues, setShowTopValues] = useState(true);
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [showAllColumns, setShowAllColumns] = useState(false);

  const resolutionPending = originalTablesCount > 1 && !activeTable;

  // The full-table profile: once per table open (plus an explicit Retry),
  // never on any in-page interaction. The backend's own TTL cache keeps a
  // re-open cheap; nothing is cached client-side.
  useEffect(() => {
    setProfile(null);
    setProfileRequestError(null);
    if (resolutionPending) return;
    let cancelled = false;
    setProfileLoading(true);
    (async () => {
      try {
        const data = await datasourceApi.profile(datasourceId, activeTable);
        if (!cancelled) setProfile(data);
      } catch (err: any) {
        if (!cancelled) setProfileRequestError(err?.response?.data?.detail || "The profile request failed.");
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [datasourceId, activeTable, resolutionPending, profileRetryKey]);

  // The 20 example rows: the connector is asked for exactly 20 (LIMIT 20),
  // once per table open. Same multi-table guard as the profile above.
  useEffect(() => {
    setSample(null);
    setSampleError(null);
    if (resolutionPending) return;
    let cancelled = false;
    setSampleLoading(true);
    (async () => {
      try {
        const data = await datasourceApi.previewSample(datasourceId, activeTable, 20);
        if (!cancelled) setSample(data);
      } catch (err: any) {
        if (!cancelled) setSampleError(err?.response?.data?.detail || "Could not load the example rows.");
      } finally {
        if (!cancelled) setSampleLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [datasourceId, activeTable, resolutionPending]);

  // Per-table view controls start fresh for a different table.
  useEffect(() => {
    setSearch("");
    setOnlyGaps(false);
    setShowAllColumns(false);
  }, [datasourceId, activeTable]);

  const profileUsable = !!profile && profile.supported && !profile.too_expensive && !profile.error && !!profile.columns;
  const columns: Record<string, ProfileColumnStat> = profileUsable ? profile!.columns! : {};
  const columnOrder = useMemo(() => {
    const profiled = profileUsable ? (profile!.profiled_columns || Object.keys(columns)) : [];
    return profiled.filter((c) => c in columns);
  }, [profileUsable, profile, columns]);
  const totalRows = profileUsable ? profile!.exact_total_rows ?? null : null;

  // --- Tile numbers, every one from the profile alone. ---
  const typeBreakdown = useMemo(() => {
    const counts: Record<TypeGroup, number> = { text: 0, number: 0, date: 0, bool: 0, other: 0 };
    for (const name of columnOrder) counts[typeGroup(columns[name]?.type)]++;
    return counts;
  }, [columnOrder, columns]);
  const totalColumnCount = sample?.columns?.length ?? columnOrder.length;

  const emptiness = useMemo(() => {
    if (!totalRows || columnOrder.length === 0) return null;
    let emptyCells = 0;
    const perColumn: { name: string; empty: number; pct: number }[] = [];
    for (const name of columnOrder) {
      const stat = columns[name];
      if (!stat || stat.non_null == null) continue;
      const empty = Math.max(0, totalRows - stat.non_null);
      emptyCells += empty;
      if (empty > 0) perColumn.push({ name, empty, pct: stat.null_pct ?? (100 * empty) / totalRows });
    }
    perColumn.sort((a, b) => b.empty - a.empty);
    return { pct: (100 * emptyCells) / (totalRows * columnOrder.length), top: perColumn.slice(0, 2) };
  }, [columnOrder, columns, totalRows]);

  const coverage = useMemo(() => dateCoverage(columns), [columns]);

  // --- The column rows: search / gaps-only / expander. ---
  const filteredColumns = useMemo(() => {
    const q = search.trim().toLowerCase();
    return columnOrder.filter((name) => {
      if (q && !name.toLowerCase().includes(q)) return false;
      if (onlyGaps && !((columns[name]?.null_pct ?? 0) > 0)) return false;
      return true;
    });
  }, [columnOrder, columns, search, onlyGaps]);
  const isNarrowed = search.trim() !== "" || onlyGaps;
  const visibleColumns = showAllColumns || isNarrowed ? filteredColumns : filteredColumns.slice(0, COLUMNS_INITIALLY_SHOWN);
  const hiddenCount = filteredColumns.length - visibleColumns.length;

  const kindLabel = KIND_LABELS[datasourceKind] || "your warehouse";
  const isWarehouse = datasourceKind === "bigquery" || datasourceKind === "snowflake";
  const sourceNoun = isWarehouse ? "warehouse" : "database";
  const queryCount = profileUsable && profile!.top_values_computed ? 2 : 1;
  const ago = profileUsable && profile!.cached_at != null ? formatAgo(profile!.cached_at) : null;

  const profileFailureMessage = (() => {
    if (profileRequestError) return profileRequestError;
    if (!profile) return null;
    if (!profile.supported) return "this source kind cannot be profiled inside its own warehouse.";
    if (profile.too_expensive) return profile.message || "it would exceed today's warehouse query budget.";
    if (profile.error) return "the profiling query failed at the source.";
    if (!profile.columns) return "the source returned no columns to profile.";
    return null;
  })();

  const sampleCount = sample?.rows?.length ?? 0;
  const sampleCaption = totalRows != null
    ? `${sampleCount} of ${totalRows.toLocaleString()} rows`
    : `${sampleCount} rows`;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" data-testid="warehouse-data-view">
      <div className="p-4 flex flex-col gap-4">
        {/* (1) The one-line promise - green, the app's "verified" tint. */}
        <div
          className="flex items-start gap-3 px-4 py-3 rounded-xl bg-primary/10 border border-primary/30 text-primary text-[13px]"
          data-testid="wh-stays-line"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden className="shrink-0 mt-0.5">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <div>
            <strong>This table stays in {kindLabel}.</strong>{" "}
            {profileUsable && totalRows != null ? (
              <>
                Nothing below was loaded into GD360 — every number comes from {queryCount === 1 ? "one query" : "two queries"} that ran inside your {sourceNoun} over all {totalRows.toLocaleString()} rows{ago ? `, ${ago.line}` : ""}.
              </>
            ) : (
              <>Nothing below was loaded into GD360 — the only rows shown are {sampleCount || 20} labelled examples.</>
            )}
          </div>
        </div>

        {/* (2) Stat tiles - skeletons while the profile is in flight, an
            honest inline failure (with Retry) if it did not come back. */}
        {profileLoading ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }} data-testid="wh-skeleton">
            <SkeletonTile /><SkeletonTile /><SkeletonTile /><SkeletonTile /><SkeletonTile />
          </div>
        ) : profileUsable ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }} data-testid="wh-tiles">
            <Tile
              testId="wh-tile-rows"
              label="Rows"
              value={totalRows != null ? totalRows.toLocaleString() : "—"}
              sub={
                <span className="inline-flex items-center gap-1.5 text-primary">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" />exact · COUNT(*)
                </span>
              }
            />
            <Tile
              testId="wh-tile-columns"
              label="Columns"
              value={totalColumnCount.toLocaleString()}
              sub={[
                typeBreakdown.text ? `${typeBreakdown.text} text` : null,
                typeBreakdown.number ? `${typeBreakdown.number} number` : null,
                typeBreakdown.date ? `${typeBreakdown.date} date` : null,
                typeBreakdown.bool ? `${typeBreakdown.bool} bool` : null,
                typeBreakdown.other ? `${typeBreakdown.other} other` : null,
                profile!.truncated_columns ? `first ${columnOrder.length} profiled` : null,
              ].filter(Boolean).join(" · ")}
            />
            <Tile
              testId="wh-tile-empty"
              label="Empty cells"
              value={emptiness ? `${emptiness.pct < 10 ? emptiness.pct.toFixed(1) : Math.round(emptiness.pct)}%` : "—"}
              sub={
                emptiness && emptiness.top.length > 0 ? (
                  <>
                    mostly{" "}
                    {emptiness.top.map((c, i) => (
                      <span key={c.name}>
                        {i > 0 ? " and " : ""}
                        <span className="font-mono text-text">{c.name}</span>
                      </span>
                    ))}
                  </>
                ) : (
                  "no empty cells in the profiled columns"
                )
              }
            />
            {coverage && (
              <Tile
                testId="wh-tile-dates"
                label="Date coverage"
                valueSize="md"
                value={`${coverage.from} → ${coverage.to}`}
                sub={<>from <span className="font-mono">{coverage.source}</span></>}
              />
            )}
            <Tile
              testId="wh-tile-cost"
              label="Profile cost"
              valueSize="md"
              value={[
                profile!.bytes_scanned != null ? formatBytes(profile!.bytes_scanned) : null,
                profile!.duration_ms != null ? formatDuration(profile!.duration_ms) : null,
              ].filter(Boolean).join(" · ") || "—"}
              sub={[
                `${queryCount} ${queryCount === 1 ? "query" : "queries"}`,
                ago ? ago.short : null,
              ].filter(Boolean).join(" · ")}
            />
          </div>
        ) : (
          <div
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-400 text-[13px]"
            data-testid="wh-profile-failed"
          >
            <span>Could not profile this table: {profileFailureMessage || "no profile came back."}</span>
            <button
              className="btn-secondary text-xs px-3 py-1.5"
              onClick={() => setProfileRetryKey((k) => k + 1)}
            >
              Retry
            </button>
          </div>
        )}

        {/* (3) The COLUMNS table - one row per column, all from the profile. */}
        {(profileLoading || profileUsable) && (
          <div className="bg-surface border border-border rounded-xl overflow-hidden" data-testid="wh-columns">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
              <div className="flex items-baseline gap-2.5 min-w-0">
                <div className="font-semibold text-[15px] text-text">Columns</div>
                <div className="text-xs text-muted truncate">
                  {profileUsable && totalRows != null
                    ? `what every row in the table looks like, computed over all ${totalRows.toLocaleString()} rows`
                    : "profiling inside your warehouse…"}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <label className="flex items-center gap-1.5 text-xs text-text border border-border rounded-lg px-2.5 py-1.5 bg-surface2 cursor-pointer">
                  <input type="checkbox" checked={showTopValues} onChange={(e) => setShowTopValues(e.target.checked)} data-testid="wh-toggle-topvalues" />
                  Show top values
                </label>
                <label className="flex items-center gap-1.5 text-xs text-text border border-border rounded-lg px-2.5 py-1.5 bg-surface2 cursor-pointer">
                  <input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} data-testid="wh-toggle-gaps" />
                  Only columns with gaps
                </label>
                <input
                  type="search"
                  placeholder="Find a column"
                  aria-label="Find a column"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="input text-xs py-1.5 w-44"
                  data-testid="wh-column-search"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <div className="min-w-[900px]">
                <div
                  className={`${COLUMN_GRID} px-4 py-2 text-[10px] uppercase tracking-wide text-muted border-b border-border bg-surface2`}
                  style={COLUMN_GRID_STYLE}
                >
                  <div>Column</div><div>Type</div><div>Filled</div><div>Distinct</div><div>Values · range or top values</div><div>Use it as</div>
                </div>

                {profileLoading && (
                  <div className="px-4 py-6 text-xs text-muted animate-pulse">Computing the shape of every column inside your {sourceNoun}…</div>
                )}

                {profileUsable && visibleColumns.map((name) => {
                  const stat = columns[name];
                  const emptyHeavy = (stat.null_pct ?? 0) >= EMPTY_HEAVY_PCT;
                  const role = useItAs(name, stat.type, stat);
                  return (
                    <div
                      key={name}
                      className={`${COLUMN_GRID} px-4 py-2.5 border-b border-border/50 text-[13px] ${emptyHeavy ? "bg-amber-500/5" : ""}`}
                      style={COLUMN_GRID_STYLE}
                      data-testid="wh-column-row"
                      data-column={name}
                      data-empty-heavy={emptyHeavy ? "true" : "false"}
                    >
                      <div className="font-mono font-medium text-text truncate" title={name}>{name}</div>
                      <ColumnStatCells stat={stat} totalRows={totalRows} showTopValues={showTopValues} />
                      <div className="text-xs text-muted" data-testid="wh-use-as">{role}</div>
                    </div>
                  );
                })}

                {profileUsable && visibleColumns.length === 0 && (
                  <div className="px-4 py-6 text-xs text-muted">No columns match.</div>
                )}
              </div>
            </div>

            {profileUsable && (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-surface2/60 text-[11px] text-muted">
                {hiddenCount > 0 ? (
                  <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => setShowAllColumns(true)} data-testid="wh-show-more">
                    Show {hiddenCount} more {hiddenCount === 1 ? "column" : "columns"}
                  </button>
                ) : showAllColumns && !isNarrowed && filteredColumns.length > COLUMNS_INITIALLY_SHOWN ? (
                  <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => setShowAllColumns(false)}>
                    Show fewer columns
                  </button>
                ) : (
                  <span />
                )}
                <div>
                  Filled · distinct · min · max: one query, all rows.{" "}
                  {profile!.top_values_computed
                    ? "Top values: one extra query, only for columns with ≤ 50 distinct values."
                    : "Top values were not computed this time."}
                </div>
              </div>
            )}
          </div>
        )}

        {/* (4) Example rows - read-only, clearly labelled, never used for a number. */}
        <ExampleRowsBlock sample={sample} sampleLoading={sampleLoading} sampleError={sampleError} caption={sampleCaption} />
      </div>
    </div>
  );
}
