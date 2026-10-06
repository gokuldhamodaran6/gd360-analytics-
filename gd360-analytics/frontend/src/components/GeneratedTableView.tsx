import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { datasourceApi, DataPreview, DataProfile, DatasetVersion, isWarehouseQueryVersion, ProfileColumnStat } from "../api/client";
import {
  COLUMN_GRID, COLUMN_GRID_STYLE, ColumnStatCells, ExampleRowsBlock, KIND_LABELS, SkeletonTile, Tile,
  formatBytes, formatDuration, formatScalar, typeGroup, useItAs,
} from "./WarehouseDataView";
import { SqlThatRan } from "./WarehouseTurn";

// 2026-10-06 ("generated data is a saved query" layer): the Data tab for a
// table a prompt GENERATED from a warehouse/database source. The founder's
// rule for those sources is that the table never loads into GD360 - and
// this layer extends it to generated data: "keep only non-canceled
// bookings and add total nights" becomes ONE SQL definition stored by GD360
// (DatasetVersion.source_kind === "warehouse_query"), never a copy of the
// rows. So this tab looks exactly like the original table's (see
// WarehouseDataView.tsx, whose tiles/column cells/example-rows pieces it
// reuses): an exact row count, a per-column profile, 20 example rows - all
// from running the definition inside the warehouse - plus what only a
// generated table has: its lineage (source table -> alias), the prompt and
// definition that made it, and a CHANGE column that compares every column
// against the table it was built from (both profiles are fetched; nothing
// here is derived from the example rows).
//
// Deliberately absent, exactly as on the original-table view: filters,
// sort, pagination, totals, and the pandas-based Export (the only exits are
// the warehouse-streamed "Download N rows" and asking the next question).

const COLUMNS_INITIALLY_SHOWN = 12;

export type ColumnChange =
  | { kind: "new" }
  | { kind: "one_value"; wasDistinct: number | null }
  | { kind: "narrowed"; wasMin: number | string | null; wasMax: number | string | null }
  | { kind: "unchanged" };

// What changed for one column versus the parent profile. Honest rules, in
// order: a column the parent does not have is NEW (derived); a column
// whose exact distinct count dropped to 1 was "filtered to one value"; a
// numeric/date column whose min rose or max fell had its "range narrowed";
// anything else is unchanged. Only ever computed when BOTH profiles are
// usable - never guessed from the example rows.
export function classifyChange(
  name: string, now: ProfileColumnStat, parent: ProfileColumnStat | undefined,
): ColumnChange {
  if (!parent) return { kind: "new" };
  if (now.distinct === 1 && parent.distinct != null && parent.distinct > 1) {
    return { kind: "one_value", wasDistinct: parent.distinct };
  }
  const group = typeGroup(now.type || parent.type);
  if ((group === "number" || group === "date") && now.min != null && now.max != null && parent.min != null && parent.max != null) {
    const minUp = typeof now.min === "number" && typeof parent.min === "number" ? now.min > parent.min : String(now.min) > String(parent.min);
    const maxDown = typeof now.max === "number" && typeof parent.max === "number" ? now.max < parent.max : String(now.max) < String(parent.max);
    if (minUp || maxDown) return { kind: "narrowed", wasMin: parent.min, wasMax: parent.max };
  }
  void name;
  return { kind: "unchanged" };
}

const profileUsable = (p: DataProfile | null): p is DataProfile & { columns: Record<string, ProfileColumnStat> } =>
  !!p && p.supported && !p.too_expensive && !p.error && !!p.columns;

function LineageChip({ children, generated, testId }: { children: ReactNode; generated?: boolean; testId?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono text-[12px] rounded-md px-1.5 py-px border ${
        generated ? "text-primary bg-primary/10 border-primary/30" : "text-text bg-surface2 border-border"
      }`}
      data-testid={testId}
    >
      {generated && <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" />}
      {children}
    </span>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="shrink-0 h-5 w-5 rounded-full bg-primary text-white text-[11px] font-semibold flex items-center justify-center">{n}</span>
      <div>{children}</div>
    </div>
  );
}

export default function GeneratedTableView({
  datasourceId, datasourceKind, version, versions, onAskAboutTable, onAskQuestion, onEditDefinition,
}: {
  datasourceId: string;
  datasourceKind: string;
  // The warehouse saved-query version this tab shows (source_kind
  // "warehouse_query" - DataTable.tsx only routes such a version here).
  version: DatasetVersion;
  // Every saved table of this data source - used to recognise a CHAINED
  // table (a parent that is itself a saved query), whose comparison base
  // is that parent's own profile rather than the raw source table's.
  versions: DatasetVersion[];
  // "Ask about this table": points the chat's WORKING ON selection at this
  // table and focuses the composer (Workspace.tsx owns both).
  onAskAboutTable?: (versionId: string) => void;
  // "Ask the next question on this table": runs `prompt` against exactly
  // this table - it chains: the next query wraps this definition as a CTE.
  onAskQuestion?: (versionId: string, prompt: string) => void;
  // "Edit & re-run": opens the chat composer's write-SQL mode prefilled
  // with the definition, with "Save as table" already on.
  onEditDefinition?: (versionId: string, sql: string) => void;
}) {
  const [profile, setProfile] = useState<DataProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileRequestError, setProfileRequestError] = useState<string | null>(null);
  const [profileRetryKey, setProfileRetryKey] = useState(0);

  const [parentProfile, setParentProfile] = useState<DataProfile | null>(null);
  const [parentLoading, setParentLoading] = useState(true);

  const [sample, setSample] = useState<DataPreview | null>(null);
  const [sampleLoading, setSampleLoading] = useState(true);
  const [sampleError, setSampleError] = useState<string | null>(null);

  const [onlyChanged, setOnlyChanged] = useState(true);
  const [showAllColumns, setShowAllColumns] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");

  // The comparison base: a saved-query parent (chained table) when there is
  // one in the list, else the raw source table named on the version.
  const parentVersion = useMemo(() => {
    const ids = version.parent_version_ids && version.parent_version_ids.length
      ? version.parent_version_ids
      : version.parent_version_id ? [version.parent_version_id] : [];
    for (const id of ids) {
      const p = versions.find((v) => v.id === id);
      if (p && isWarehouseQueryVersion(p)) return p;
    }
    return null;
  }, [version.parent_version_ids, version.parent_version_id, versions]);
  const baseLabel = parentVersion ? (parentVersion.sql_alias || parentVersion.name) : (version.source_table || "the source table");

  // This table's own profile: once per open (plus an explicit Retry). The
  // backend caches it under (datasource, "version:<id>").
  useEffect(() => {
    setProfile(null);
    setProfileRequestError(null);
    let cancelled = false;
    setProfileLoading(true);
    (async () => {
      try {
        const data = await datasourceApi.profileVersion(datasourceId, version.id);
        if (!cancelled) setProfile(data);
      } catch (err: any) {
        if (!cancelled) setProfileRequestError(err?.response?.data?.detail || "The profile request failed.");
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [datasourceId, version.id, profileRetryKey]);

  // The parent's profile, for the CHANGE column and the "of N rows" line.
  // A failure here only disables the comparison - it never hides this
  // table's own numbers.
  useEffect(() => {
    setParentProfile(null);
    const hasBase = !!parentVersion || !!version.source_table;
    if (!hasBase) { setParentLoading(false); return; }
    let cancelled = false;
    setParentLoading(true);
    (async () => {
      try {
        const data = parentVersion
          ? await datasourceApi.profileVersion(datasourceId, parentVersion.id)
          : await datasourceApi.profile(datasourceId, version.source_table);
        if (!cancelled) setParentProfile(data);
      } catch {
        if (!cancelled) setParentProfile(null);
      } finally {
        if (!cancelled) setParentLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [datasourceId, version.id, version.source_table, parentVersion?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 20 example rows: `SELECT * FROM (<definition>) LIMIT 20` inside the
  // warehouse - the only way rows of a saved query are ever read.
  useEffect(() => {
    setSample(null);
    setSampleError(null);
    let cancelled = false;
    setSampleLoading(true);
    (async () => {
      try {
        const data = await datasourceApi.previewVersionSample(datasourceId, version.id, 20);
        if (!cancelled) setSample(data);
      } catch (err: any) {
        if (!cancelled) setSampleError(err?.response?.data?.detail || "Could not run this saved query for example rows.");
      } finally {
        if (!cancelled) setSampleLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [datasourceId, version.id]);

  useEffect(() => {
    setOnlyChanged(true);
    setShowAllColumns(false);
    setDownloadError(null);
    setQuestion("");
  }, [datasourceId, version.id]);

  const usable = profileUsable(profile);
  const columns: Record<string, ProfileColumnStat> = usable ? profile.columns : {};
  const columnOrder = useMemo(() => {
    if (usable) return (profile.profiled_columns || Object.keys(columns)).filter((c) => c in columns);
    return [];
  }, [usable, profile, columns]);
  const declaredColumns = useMemo(
    () => (version.columns_json || sample?.columns_json || []).map((c) => c.name).filter(Boolean),
    [version.columns_json, sample?.columns_json],
  );
  const totalColumnCount = declaredColumns.length || sample?.columns?.length || columnOrder.length;

  const parentUsable = profileUsable(parentProfile);
  const parentColumns: Record<string, ProfileColumnStat> = parentUsable ? parentProfile.columns : {};
  const canCompare = usable && parentUsable;

  const totalRows: number | null = usable ? profile.exact_total_rows ?? version.row_count ?? null : version.row_count ?? null;
  const lastLog = useMemo(() => {
    const log = sample?.cleaning_log || [];
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i] as any;
      if (entry && (entry.source_kind === "warehouse_query" || entry.query_sql)) return entry;
    }
    return log.length ? (log[log.length - 1] as any) : null;
  }, [sample?.cleaning_log]);
  const parentRows: number | null =
    (parentUsable ? parentProfile.exact_total_rows ?? null : null)
    ?? parentVersion?.row_count
    ?? (typeof lastLog?.rows_before === "number" ? lastLog.rows_before : null);
  const keptPct = totalRows != null && parentRows ? Math.round((100 * totalRows) / parentRows) : null;

  // --- The CHANGE column. ---
  const changes = useMemo(() => {
    const out: Record<string, ColumnChange> = {};
    if (!canCompare) return out;
    for (const name of columnOrder) out[name] = classifyChange(name, columns[name], parentColumns[name]);
    return out;
  }, [canCompare, columnOrder, columns, parentColumns]);
  const newColumns = useMemo(() => {
    // From the profile when both sides are known; else from the declared
    // result schema versus the parent's declared columns - still real.
    if (canCompare) return columnOrder.filter((n) => changes[n]?.kind === "new");
    if (parentUsable && declaredColumns.length) return declaredColumns.filter((n) => !(n in parentColumns));
    return [];
  }, [canCompare, parentUsable, columnOrder, changes, declaredColumns, parentColumns]);
  const originalColumnCount = Math.max(0, totalColumnCount - newColumns.length);
  const changedColumns = columnOrder.filter((n) => changes[n] && changes[n].kind !== "unchanged");
  const unchangedCount = canCompare ? columnOrder.length - changedColumns.length : 0;

  const listed = canCompare && onlyChanged ? changedColumns : columnOrder;
  const visibleColumns = showAllColumns || (canCompare && onlyChanged) ? listed : listed.slice(0, COLUMNS_INITIALLY_SHOWN);
  const hiddenCount = listed.length - visibleColumns.length;

  const kindLabel = KIND_LABELS[datasourceKind] || "your warehouse";
  const isWarehouse = datasourceKind === "bigquery" || datasourceKind === "snowflake";
  const sourceNoun = isWarehouse ? "warehouse" : "database";
  const alias = version.sql_alias || version.name;
  const definition = version.query_sql || sample?.query_sql || "";
  const prompt: string | null = typeof lastLog?.prompt === "string" && lastLog.prompt.trim() ? lastLog.prompt : null;

  const profileFailureMessage = (() => {
    if (profileRequestError) return profileRequestError;
    if (!profile) return null;
    if (!profile.supported) return "this saved query cannot be profiled inside its own warehouse.";
    if (profile.too_expensive) return profile.message || "it would exceed today's warehouse query budget.";
    if (profile.error) return "the profiling query failed at the source.";
    if (!profile.columns) return "the source returned no columns to profile.";
    return null;
  })();

  // Two honest next-question suggestions from the real columns: a measure
  // by a small category, and a count by a second category/time column.
  const suggestions = useMemo(() => {
    const out: string[] = [];
    if (!usable) return out;
    const roles = columnOrder.map((n) => ({ n, role: useItAs(n, columns[n]?.type, columns[n]) }));
    const measure = roles.find((r) => r.role === "Measure" || r.role === "Measure · money")?.n;
    const cats = roles.filter((r) => r.role === "Category" || r.role === "Category · geo" || r.role === "Flag").map((r) => r.n);
    const time = roles.find((r) => r.role.startsWith("Time"))?.n;
    if (measure && cats[0]) out.push(`Average ${measure} by ${cats[0]}`);
    if (measure && time) out.push(`Total ${measure} by ${time}`);
    else if (cats[1]) out.push(`Count of rows by ${cats[1]}`);
    return out.slice(0, 2);
  }, [usable, columnOrder, columns]);

  const download = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      await datasourceApi.downloadVersionCsv(datasourceId, version.id);
    } catch (err: any) {
      setDownloadError(err?.response?.data?.detail || "The download could not start.");
    } finally {
      setDownloading(false);
    }
  };

  const ask = () => {
    const q = question.trim();
    if (!q || !onAskQuestion) return;
    onAskQuestion(version.id, q);
    setQuestion("");
  };

  const sampleCount = sample?.rows?.length ?? 0;
  const sampleCaption = totalRows != null ? `${sampleCount} of ${totalRows.toLocaleString()}` : `${sampleCount} rows`;
  const newSet = useMemo(() => new Set(newColumns), [newColumns]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" data-testid="generated-table-view">
      <div className="p-4 flex flex-col gap-4">
        {/* Lineage header: source -> alias, and the two exits. */}
        <div className="flex flex-wrap items-start justify-between gap-3" data-testid="gen-header">
          <div className="flex flex-col gap-1.5 min-w-0">
            <div className="text-lg font-semibold text-text truncate" data-testid="gen-title">{version.name}</div>
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted" data-testid="gen-lineage">
              <LineageChip testId="gen-source-chip">{baseLabel}</LineageChip>
              {parentRows != null && <span>{parentRows.toLocaleString()} rows</span>}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M5 12h14" /><path d="m13 6 6 6-6 6" />
              </svg>
              <LineageChip generated testId="gen-alias-chip">{alias}</LineageChip>
              <span className="text-primary font-medium">saved query · lives in {kindLabel}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              className="btn-secondary text-xs px-3 py-2"
              disabled={downloading}
              onClick={download}
              data-testid="gen-download"
              title="Streams the query's rows straight from your warehouse to your browser as CSV - GD360's server never holds them"
            >
              {downloading ? "Downloading…" : totalRows != null ? `Download ${totalRows.toLocaleString()} rows` : "Download rows"}
            </button>
            {onAskAboutTable && (
              <button
                type="button"
                className="btn-primary text-xs px-3 py-2"
                onClick={() => onAskAboutTable(version.id)}
                data-testid="gen-ask-about"
              >
                Ask about this table
              </button>
            )}
          </div>
        </div>
        {downloadError && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2" role="alert" data-testid="gen-download-error">
            {downloadError}
          </div>
        )}

        <div className="flex flex-wrap gap-4 items-start">
          {/* LEFT: how it was made + next question. Same flex recipe as the
              approved mockup: a narrow column that wraps under the main
              one on a small screen. */}
          <div className="flex flex-col gap-4 min-w-0" style={{ flex: "1 1 300px", maxWidth: 380 }} data-testid="gen-left">
            <div className="bg-surface border border-border rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-border font-semibold text-[14px] text-text">How this table was made</div>
              <div className="p-4 flex flex-col gap-3 text-[13px]">
                {prompt && (
                  <div className="self-end max-w-[95%] bg-primary text-white rounded-2xl rounded-br-sm px-3 py-2 text-[13px]" data-testid="gen-prompt">
                    {prompt}
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  <Step n={1}>
                    <strong>Wrote one query</strong> — a SELECT on top of <span className="font-mono">{baseLabel}</span>
                    {newColumns.length > 0 ? (
                      <>, with {newColumns.length} new column{newColumns.length === 1 ? "" : "s"} (<span className="font-mono">{newColumns.join(", ")}</span>).</>
                    ) : "."}
                  </Step>
                  <Step n={2}>
                    <strong>Saved it as a query, not a copy.</strong> Nothing was downloaded. {kindLabel} runs it whenever this table is used.
                  </Step>
                  <Step n={3}>
                    {usable && totalRows != null ? (
                      <><strong>Profiled it</strong> the same way as the original — one query over all {totalRows.toLocaleString()} rows.</>
                    ) : profileLoading ? (
                      <><strong>Profiling it</strong> the same way as the original — one query inside {kindLabel}…</>
                    ) : (
                      <><strong>Profiling it</strong> did not work this time — see the note on the right.</>
                    )}
                  </Step>
                </div>
                {definition && (
                  <SqlThatRan
                    sql={definition}
                    provider={datasourceKind}
                    label="Definition"
                    defaultOpen
                    maxHeightClass="max-h-64"
                    action={onEditDefinition ? (
                      <button
                        type="button"
                        className="text-[11px] text-accent hover:opacity-80 font-medium shrink-0"
                        onClick={() => onEditDefinition(version.id, definition)}
                        data-testid="gen-edit-rerun"
                      >
                        Edit &amp; re-run
                      </button>
                    ) : undefined}
                  />
                )}
              </div>
            </div>

            {onAskQuestion && (
              <div className="bg-surface border border-border rounded-xl p-4 flex flex-col gap-2.5" data-testid="gen-next-question">
                <div className="font-semibold text-[14px] text-text">Ask the next question on this table</div>
                <div className="text-xs text-muted">It chains: the next query wraps this definition, still inside {kindLabel}.</div>
                {suggestions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((s) => (
                      <button key={s} type="button" className="btn-secondary text-xs px-2.5 py-1.5" onClick={() => onAskQuestion(version.id, s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    className="input text-[13px]"
                    placeholder={`Ask about ${alias}`}
                    aria-label="Ask about this table"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") ask(); }}
                    data-testid="gen-question-input"
                  />
                  <button type="button" className="btn-primary shrink-0 text-xs px-3" disabled={!question.trim()} onClick={ask}>
                    Send
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* RIGHT: the promise line, tiles, columns with CHANGE, example rows. */}
          <div className="flex flex-col gap-4 min-w-0" style={{ flex: "999 1 520px" }} data-testid="gen-right">
            <div
              className="flex items-start gap-3 px-4 py-3 rounded-xl bg-primary/10 border border-primary/30 text-primary text-[13px]"
              data-testid="gen-stays-line"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden className="shrink-0 mt-0.5">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              <div>
                <strong>This table is a saved query on top of {baseLabel}.</strong>{" "}
                {usable && totalRows != null ? (
                  <>It has no copy of its own — the numbers below come from running it inside {kindLabel} over all {totalRows.toLocaleString()} rows{profile.cached ? "" : ", just now"}.</>
                ) : (
                  <>It has no copy of its own — every number below comes from running it inside {kindLabel}; the only rows shown are {sampleCount || 20} labelled examples.</>
                )}
              </div>
            </div>

            {profileLoading ? (
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }} data-testid="gen-skeleton">
                <SkeletonTile /><SkeletonTile /><SkeletonTile /><SkeletonTile />
              </div>
            ) : usable ? (
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }} data-testid="gen-tiles">
                <Tile
                  testId="gen-tile-rows"
                  label="Rows"
                  value={totalRows != null ? totalRows.toLocaleString() : "—"}
                  sub={
                    parentRows != null && keptPct != null ? (
                      <>of {parentRows.toLocaleString()} · <span className="text-primary">{keptPct}% kept</span></>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-primary">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" />exact · COUNT(*)
                      </span>
                    )
                  }
                />
                <Tile
                  testId="gen-tile-columns"
                  label="Columns"
                  value={totalColumnCount.toLocaleString()}
                  sub={
                    parentUsable || newColumns.length ? (
                      <>{originalColumnCount} original · <span className="text-primary">{newColumns.length} new</span></>
                    ) : "from the saved query's own result"
                  }
                />
                <Tile
                  testId="gen-tile-built-from"
                  label="Built from"
                  valueSize="md"
                  value={<span className="font-mono">{baseLabel}</span>}
                  sub={[
                    keptPct != null && keptPct < 100 ? "rows filtered" : null,
                    newColumns.length ? `${newColumns.length} derived column${newColumns.length === 1 ? "" : "s"}` : null,
                  ].filter(Boolean).join(" · ") || "same rows and columns"}
                />
                <Tile
                  testId="gen-tile-last-run"
                  label="Last run"
                  valueSize="md"
                  value={[
                    profile.bytes_scanned != null ? formatBytes(profile.bytes_scanned) : null,
                    profile.duration_ms != null ? formatDuration(profile.duration_ms) : null,
                  ].filter(Boolean).join(" · ") || "—"}
                  sub={`re-runs when ${baseLabel} changes`}
                />
              </div>
            ) : (
              <div
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-400 text-[13px]"
                data-testid="gen-profile-failed"
              >
                <span>Could not profile this table: {profileFailureMessage || "no profile came back."}</span>
                <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => setProfileRetryKey((k) => k + 1)}>
                  Retry
                </button>
              </div>
            )}

            {(profileLoading || usable) && (
              <div className="bg-surface border border-border rounded-xl overflow-hidden" data-testid="gen-columns">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
                  <div className="flex items-baseline gap-2.5 min-w-0">
                    <div className="font-semibold text-[15px] text-text">Columns</div>
                    <div className="text-xs text-muted truncate">
                      {canCompare
                        ? `what changed versus ${baseLabel} is marked`
                        : parentLoading
                        ? `comparing against ${baseLabel}…`
                        : `could not profile ${baseLabel} to compare`}
                    </div>
                  </div>
                  <label className={`flex items-center gap-1.5 text-xs text-text border border-border rounded-lg px-2.5 py-1.5 bg-surface2 ${canCompare ? "cursor-pointer" : "opacity-50"}`}>
                    <input
                      type="checkbox"
                      checked={onlyChanged}
                      disabled={!canCompare}
                      onChange={(e) => setOnlyChanged(e.target.checked)}
                      data-testid="gen-toggle-changed"
                    />
                    Only changed columns
                  </label>
                </div>

                <div className="overflow-x-auto">
                  <div className="min-w-[900px]">
                    <div
                      className={`${COLUMN_GRID} px-4 py-2 text-[10px] uppercase tracking-wide text-muted border-b border-border bg-surface2`}
                      style={COLUMN_GRID_STYLE}
                    >
                      <div>Column</div><div>Type</div><div>Filled</div><div>Distinct</div><div>Values · range or top values</div><div>Change</div>
                    </div>

                    {profileLoading && (
                      <div className="px-4 py-6 text-xs text-muted animate-pulse">Running the definition's profile inside your {sourceNoun}…</div>
                    )}

                    {usable && visibleColumns.map((name) => {
                      const stat = columns[name];
                      const change = changes[name] || null;
                      const parentStat = parentColumns[name];
                      const tint = change?.kind === "new" ? "bg-primary/5" : change?.kind === "one_value" ? "bg-amber-500/5" : "";
                      let changeLabel: ReactNode = canCompare ? <span className="text-muted">unchanged</span> : <span className="text-muted">—</span>;
                      let extra: ReactNode = null;
                      if (change?.kind === "new") {
                        changeLabel = <span className="text-primary">derived</span>;
                      } else if (change?.kind === "one_value") {
                        changeLabel = <span className="text-amber-400">filtered to one value</span>;
                        if (parentStat?.top_values?.length) {
                          extra = (
                            <span className="text-muted">
                              was {parentStat.top_values.map((tv) => `${tv.pct != null ? Math.round(tv.pct) : "?"}%`).join(" / ")}
                            </span>
                          );
                        } else if (change.wasDistinct != null) {
                          extra = <span className="text-muted">was {change.wasDistinct.toLocaleString()} values</span>;
                        }
                      } else if (change?.kind === "narrowed") {
                        changeLabel = <span className="text-muted">range narrowed</span>;
                        extra = <span className="text-muted">was {formatScalar(change.wasMin)} → {formatScalar(change.wasMax)}</span>;
                      }
                      return (
                        <div
                          key={name}
                          className={`${COLUMN_GRID} px-4 py-2.5 border-b border-border/50 text-[13px] ${tint}`}
                          style={COLUMN_GRID_STYLE}
                          data-testid="gen-column-row"
                          data-column={name}
                          data-change={change?.kind || "unknown"}
                        >
                          <div className="font-mono font-medium text-text truncate flex items-center gap-2" title={name}>
                            <span className="truncate">{name}</span>
                            {change?.kind === "new" && (
                              <span className="font-sans text-[10px] font-semibold text-primary bg-primary/10 border border-primary/30 rounded px-1.5 py-px shrink-0" data-testid="gen-new-marker">
                                NEW
                              </span>
                            )}
                          </div>
                          <ColumnStatCells stat={stat} totalRows={totalRows} showTopValues extraValues={extra} />
                          <div className="text-xs" data-testid="gen-change">{changeLabel}</div>
                        </div>
                      );
                    })}

                    {usable && visibleColumns.length === 0 && (
                      <div className="px-4 py-6 text-xs text-muted">
                        {canCompare && onlyChanged ? `No column differs from ${baseLabel}.` : "No columns to show."}
                      </div>
                    )}
                  </div>
                </div>

                {usable && (
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-surface2/60 text-[11px] text-muted">
                    {canCompare && onlyChanged && unchangedCount > 0 ? (
                      <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => { setOnlyChanged(false); setShowAllColumns(true); }} data-testid="gen-show-all">
                        Show all {columnOrder.length} columns
                      </button>
                    ) : hiddenCount > 0 ? (
                      <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => setShowAllColumns(true)} data-testid="gen-show-more">
                        Show {hiddenCount} more {hiddenCount === 1 ? "column" : "columns"}
                      </button>
                    ) : (
                      <span />
                    )}
                    <div data-testid="gen-unchanged-line">
                      {canCompare
                        ? `${unchangedCount} column${unchangedCount === 1 ? "" : "s"} unchanged from ${baseLabel}`
                        : "Filled · distinct · min · max: one query over the definition, all rows."}
                    </div>
                  </div>
                )}
              </div>
            )}

            <ExampleRowsBlock
              sample={sample}
              sampleLoading={sampleLoading}
              sampleError={sampleError}
              caption={sampleCaption}
              highlightColumns={newSet}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
