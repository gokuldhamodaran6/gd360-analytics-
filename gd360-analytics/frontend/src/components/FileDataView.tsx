import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  datasourceApi, DatasetVersion, DataProfile, ProfileColumnStat, FileImportState, FileImportSettings,
  CleaningSuggestion,
} from "../api/client";
import {
  Tile, SkeletonTile, ColumnStatCells, COLUMN_GRID, COLUMN_GRID_STYLE, typeGroup, useItAs, dateCoverage, formatBytes,
} from "./WarehouseDataView";
import type { TypeGroup } from "./WarehouseDataView";

// 2026-10-06 (pro local-file Data tab): the Data tab for an uploaded CSV /
// Excel file. A file is COMPLETE data inside GD360 (never a sample), so
// unlike WarehouseDataView.tsx this view keeps DataTable.tsx's full grid -
// sort, filter, totals, export - and wraps it with what the import
// pipeline (backend services/file_import.py) knows about the file: the
// four-step import strip, the sheet picker, the real import settings, the
// five profile tiles (pandas over every row), the cleaning suggestions
// (each one a new saved version - the original is never changed), the
// per-column profile and the versions rail. DataTable.tsx renders this
// strictly for kind "csv" / "excel" and hands the grid in as `grid`;
// every other kind renders exactly as before.
//
// Tiles, column cells and the column grid are the same exported pieces
// WarehouseDataView.tsx and GeneratedTableView.tsx use, so a file and a
// warehouse table read as siblings.

const COLUMNS_INITIALLY_SHOWN = 12;
const EMPTY_HEAVY_PCT = 5;

const FAMILY_LABEL: Record<string, string> = { text: "Text", number: "Number", date: "Date", boolean: "Boolean" };
const FIX_LABEL: Record<string, string> = { to_date: "date", to_number: "number", to_bool: "boolean" };

export function formatAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`).getTime();
  if (Number.isNaN(t)) return "";
  const min = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

function CheckGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden className="shrink-0">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function FileGlyph({ kind }: { kind: "csv" | "excel" }) {
  return (
    <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/30 text-primary flex items-center justify-center shrink-0" aria-hidden>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
        {kind === "excel" ? <path d="M9 12h6M9 15h6M9 18h6M12 12v6" /> : <path d="M9 13h6M9 16h6" />}
      </svg>
    </div>
  );
}

function ArrowGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden className="shrink-0 text-muted">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function Step({ label, done, testId }: { label: ReactNode; done: boolean; testId: string }) {
  return (
    <div className="flex items-center gap-2 min-w-0" data-testid={testId} data-done={done ? "true" : "false"}>
      <span
        className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
          done ? "bg-primary text-white" : "border border-border text-muted"
        }`}
      >
        {done ? <CheckGlyph /> : <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      </span>
      <span className={`text-[13px] truncate ${done ? "text-text" : "text-muted"}`}>{label}</span>
    </div>
  );
}

export default function FileDataView({
  datasourceId,
  datasourceKind,
  datasourceName,
  activeTable,
  onActiveTableChange,
  versions,
  activeVersionId,
  onActiveVersionChange,
  onVersionsChanged,
  onRenameVersion,
  onDeleteVersion,
  onAskQuestion,
  onExport,
  exportBusy,
  refreshKey,
  grid,
}: {
  datasourceId: string;
  datasourceKind: "csv" | "excel";
  datasourceName?: string;
  activeTable?: string | null;
  onActiveTableChange?: (table: string | null) => void;
  versions: DatasetVersion[];
  activeVersionId: string | null;
  onActiveVersionChange: (versionId: string | null) => void;
  onVersionsChanged: () => void;
  onRenameVersion: (v: DatasetVersion, name: string) => Promise<void> | void;
  onDeleteVersion: (v: DatasetVersion) => void;
  onAskQuestion?: () => void;
  onExport: (format: "csv" | "xlsx") => void;
  exportBusy: boolean;
  refreshKey: number;
  // DataTable.tsx's own grid (sort / filter / totals / export), rendered
  // last, unchanged in behaviour.
  grid: ReactNode;
}) {
  const [importState, setImportState] = useState<FileImportState | null>(null);
  const [importLoading, setImportLoading] = useState(true);
  const [importError, setImportError] = useState<string | null>(null);
  const [settings, setSettings] = useState<FileImportSettings | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [importBump, setImportBump] = useState(0);

  const [profile, setProfile] = useState<DataProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [suggestions, setSuggestions] = useState<CleaningSuggestion[] | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(true);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [showTopValues, setShowTopValues] = useState(true);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [showAllColumns, setShowAllColumns] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const suggestionsRef = useRef<HTMLDivElement | null>(null);

  const sheetArg = activeTable || null;

  // (1) Import state for the active sheet - and, for an upload that
  // predates the pipeline (no summary yet), run it once so the strip and
  // the Import-health tile describe something real.
  useEffect(() => {
    let cancelled = false;
    setImportLoading(true);
    setImportError(null);
    (async () => {
      try {
        let state = await datasourceApi.getFileImport(datasourceId, sheetArg);
        if (!state.imported) {
          try {
            state = await datasourceApi.rerunFileImport(datasourceId, { sheet: state.sheet });
          } catch {
            // keep the uninspected state - the strip shows the pending step
          }
        }
        if (!cancelled) {
          setImportState(state);
          setSettings(state.settings);
        }
      } catch (err: any) {
        if (!cancelled) setImportError(err?.response?.data?.detail || "Could not read the import settings.");
      } finally {
        if (!cancelled) setImportLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [datasourceId, sheetArg, importBump]);

  // (2) The pandas profile - original sheet or the active saved version.
  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setProfileError(null);
    setProfileLoading(true);
    (async () => {
      try {
        const data = activeVersionId
          ? await datasourceApi.profileVersion(datasourceId, activeVersionId)
          : await datasourceApi.profile(datasourceId, sheetArg);
        if (!cancelled) setProfile(data);
      } catch (err: any) {
        if (!cancelled) setProfileError(err?.response?.data?.detail || "The profile request failed.");
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [datasourceId, sheetArg, activeVersionId, refreshKey, importBump]);

  // (3) Cleaning suggestions over the same frame.
  useEffect(() => {
    let cancelled = false;
    setSuggestions(null);
    setSuggestionsError(null);
    setDismissed(new Set());
    setApplyError(null);
    setSuggestionsLoading(true);
    (async () => {
      try {
        const data = await datasourceApi.getCleaningSuggestions(datasourceId, activeVersionId, sheetArg);
        if (!cancelled) setSuggestions(data.suggestions);
      } catch (err: any) {
        if (!cancelled) setSuggestionsError(err?.response?.data?.detail || "Could not compute cleaning suggestions.");
      } finally {
        if (!cancelled) setSuggestionsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [datasourceId, sheetArg, activeVersionId, refreshKey, importBump]);

  useEffect(() => {
    setSearch("");
    setOnlyFlagged(false);
    setShowAllColumns(false);
  }, [datasourceId, sheetArg, activeVersionId]);

  const rerunImport = async (overrides: Partial<FileImportSettings> = {}) => {
    if (!settings && !importState) return;
    setRerunning(true);
    setImportError(null);
    try {
      const next = await datasourceApi.rerunFileImport(datasourceId, { ...(settings || {}), sheet: importState?.sheet ?? null, ...overrides });
      setImportState(next);
      setSettings(next.settings);
      setImportBump((k) => k + 1);
      onVersionsChanged();
    } catch (err: any) {
      setImportError(err?.response?.data?.detail || "Could not re-run the import with those settings.");
    } finally {
      setRerunning(false);
    }
  };

  const switchSheet = (name: string) => {
    onActiveVersionChange(null);
    onActiveTableChange?.(name);
  };

  const applySuggestions = async (ids: string[]) => {
    if (ids.length === 0) return;
    setApplying(ids.length === 1 ? ids[0] : "all");
    setApplyError(null);
    try {
      const created = await datasourceApi.applyCleaningSuggestions(datasourceId, ids, activeVersionId, sheetArg);
      onVersionsChanged();
      onActiveVersionChange(created.id);
    } catch (err: any) {
      setApplyError(err?.response?.data?.detail || "Could not apply that cleaning step.");
    } finally {
      setApplying(null);
    }
  };

  // --- Derived numbers, every one from the profile / import summary. ---
  const profileUsable = !!profile && profile.supported && !profile.too_expensive && !profile.error && !!profile.columns;
  const columns: Record<string, ProfileColumnStat & { mixed_types?: number }> = profileUsable ? (profile!.columns as any) : {};
  const columnOrder = useMemo(() => {
    const profiled = profileUsable ? (profile!.profiled_columns || Object.keys(columns)) : [];
    return profiled.filter((c) => c in columns);
  }, [profileUsable, profile, columns]);
  const totalRows = profileUsable ? profile!.exact_total_rows ?? null : null;
  const summary = importState?.summary ?? null;
  const fixByColumn = useMemo(() => {
    const m: Record<string, { from: string; to: string }> = {};
    // Fix badges describe the ORIGINAL sheet's import; a saved version
    // inherits them only through its own lineage, so show them for the
    // original data alone.
    if (activeVersionId) return m;
    for (const f of summary?.type_fixes || []) m[f.column] = { from: f.from, to: f.to };
    return m;
  }, [summary, activeVersionId]);

  const typeBreakdown = useMemo(() => {
    const counts: Record<TypeGroup, number> = { text: 0, number: 0, date: 0, bool: 0, other: 0 };
    for (const name of columnOrder) counts[typeGroup(columns[name]?.type)]++;
    return counts;
  }, [columnOrder, columns]);

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
  const mixedColumns = useMemo(
    () => columnOrder.filter((name) => (columns[name]?.mixed_types ?? 0) > 0),
    [columnOrder, columns],
  );

  const filteredColumns = useMemo(() => {
    const q = search.trim().toLowerCase();
    return columnOrder.filter((name) => {
      if (q && !name.toLowerCase().includes(q)) return false;
      if (onlyFlagged && !(fixByColumn[name] || (columns[name]?.mixed_types ?? 0) > 0 || (columns[name]?.null_pct ?? 0) >= EMPTY_HEAVY_PCT)) return false;
      return true;
    });
  }, [columnOrder, columns, search, onlyFlagged, fixByColumn]);
  const isNarrowed = search.trim() !== "" || onlyFlagged;
  const visibleColumns = showAllColumns || isNarrowed ? filteredColumns : filteredColumns.slice(0, COLUMNS_INITIALLY_SHOWN);
  const hiddenCount = filteredColumns.length - visibleColumns.length;

  const visibleSuggestions = (suggestions || []).filter((s) => !dismissed.has(s.id));

  const kindLabel = datasourceKind === "excel" ? "Excel" : "CSV";
  const fileName = importState?.filename || datasourceName || "Uploaded file";
  const sheets = importState?.sheets || [];
  const activeSheetName = importState?.sheet || sheets[0]?.name || null;
  const sheetRows = summary?.rows ?? sheets.find((s) => s.name === activeSheetName)?.rows ?? null;
  const originalRows = summary?.rows ?? sheets.find((s) => s.name === activeSheetName)?.rows ?? (activeVersionId ? null : totalRows);
  const activeVersion = activeVersionId ? versions.find((v) => v.id === activeVersionId) ?? null : null;
  const currentRows = activeVersion ? activeVersion.row_count ?? totalRows : totalRows ?? originalRows;
  const fileVersions = versions.filter((v) => v.source_kind !== "warehouse_query");

  const metaLine = [
    sheets.length > 1 ? `${sheets.length} sheets` : sheets.length === 1 ? "1 sheet" : null,
    importState ? formatBytes(importState.size_bytes) : null,
    importState?.uploaded_at
      ? `uploaded ${formatAgo(importState.uploaded_at)}${importState.uploaded_by_initials ? ` by ${importState.uploaded_by_initials}` : ""}`
      : null,
  ].filter(Boolean).join(" · ");

  const detected = importState?.detected;
  const headerDiffers = !!detected && !!settings && detected.header_row !== settings.header_row;

  const lastStep = (v: DatasetVersion) => {
    const log = v.cleaning_log || [];
    const last = log[log.length - 1];
    return last ? (last.summary || last.prompt) : null;
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" data-testid="file-data-view">
      <div className="p-4 flex flex-col gap-4">
        {/* ---- File header ---- */}
        <div className="flex flex-wrap items-center gap-3" data-testid="fdv-header">
          <FileGlyph kind={datasourceKind} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <div className="text-[16px] font-semibold text-text truncate" data-testid="fdv-filename">{fileName}</div>
              <span className="text-[11px] uppercase tracking-wide text-muted border border-border rounded-md px-1.5 py-0.5">{kindLabel}</span>
            </div>
            <div className="text-xs text-muted truncate" data-testid="fdv-meta">{metaLine || (importLoading ? "inspecting the file…" : "")}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              className="btn-secondary text-xs px-3 py-1.5"
              disabled
              title="Replacing a file's bytes is not supported yet — upload the new file as a data source and move your saved views."
            >
              Replace file
            </button>
            <button className="btn-secondary text-xs px-3 py-1.5" disabled={exportBusy} onClick={() => onExport("csv")} data-testid="fdv-download">
              {exportBusy ? "Downloading…" : "Download"}
            </button>
            {onAskQuestion && (
              <button className="btn-primary text-xs px-3 py-1.5" onClick={onAskQuestion} data-testid="fdv-ask">
                Ask a question
              </button>
            )}
          </div>
        </div>

        {/* ---- Import steps strip ---- */}
        <div className="bg-surface border border-border rounded-xl px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2" data-testid="fdv-steps">
          {importLoading && !importState ? (
            <div className="text-xs text-muted animate-pulse">Reading how this file was imported…</div>
          ) : importState ? (
            <>
              <Step testId="fdv-step-uploaded" done label={<>Uploaded {formatBytes(importState.size_bytes)}</>} />
              <ArrowGlyph />
              <Step
                testId="fdv-step-sheet"
                done
                label={<>Sheet: <span className="font-mono">{activeSheetName || "data"}</span>{sheetRows != null ? ` (${sheetRows.toLocaleString()} rows)` : ""}</>}
              />
              <ArrowGlyph />
              <Step testId="fdv-step-header" done label={<>Header row detected: row {detected?.header_row ?? 1}</>} />
              <ArrowGlyph />
              <Step
                testId="fdv-step-types"
                done={!!summary}
                label={
                  summary
                    ? <>Types inferred · {summary.fixed_count} {summary.fixed_count === 1 ? "fix" : "fixes"} applied</>
                    : <>Types not inferred yet</>
                }
              />
              <div className="ml-auto">
                <button className="btn-secondary text-xs px-3 py-1.5" disabled={rerunning} onClick={() => rerunImport()} data-testid="fdv-rerun-top">
                  {rerunning ? "Importing…" : summary ? "Re-run import" : "Run import"}
                </button>
              </div>
            </>
          ) : (
            <div className="text-xs text-red-400">{importError || "Could not read how this file was imported."}</div>
          )}
        </div>

        {/* ---- Sheet picker ---- */}
        {sheets.length > 1 && (
          <div className="flex items-center gap-2 overflow-x-auto" data-testid="fdv-sheets">
            {sheets.map((s) => {
              const active = s.name === activeSheetName && !activeVersionId;
              return (
                <button
                  key={s.name}
                  className={`text-xs px-3 py-1.5 rounded-full font-medium transition shrink-0 ${
                    active ? "bg-primary text-white" : "btn-secondary"
                  }`}
                  onClick={() => switchSheet(s.name)}
                  data-testid="fdv-sheet-tab"
                  data-active={active ? "true" : "false"}
                >
                  {s.name}{s.rows != null ? ` · ${s.rows.toLocaleString()} rows` : ""}
                </button>
              );
            })}
          </div>
        )}

        {/* ---- Import settings ---- */}
        {importState && settings && (
          <div className="bg-surface border border-border rounded-xl overflow-hidden" data-testid="fdv-settings">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
              <div className="flex items-baseline gap-2.5 min-w-0">
                <div className="font-semibold text-[15px] text-text">Import settings</div>
                <div className="text-xs text-muted truncate">
                  how the {activeSheetName ? <span className="font-mono">{activeSheetName}</span> : "file"} sheet was read · {summary ? "detected automatically, change anything below" : "not imported yet"}
                </div>
              </div>
              <span className="text-[11px] text-primary bg-primary/10 border border-primary/30 rounded-md px-2 py-0.5">auto-detected</span>
            </div>
            <div className="px-4 py-3 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
              <label className="flex flex-col gap-1 text-xs text-muted">
                Header row
                <input
                  type="number"
                  min={1}
                  className="input text-xs py-1.5"
                  value={settings.header_row}
                  onChange={(e) => setSettings({ ...settings, header_row: Math.max(1, Number(e.target.value) || 1) })}
                  data-testid="fdv-setting-header-row"
                />
                {headerDiffers && <span className="text-amber-400">detected row {detected!.header_row}</span>}
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                Delimiter
                <select
                  className="input text-xs py-1.5"
                  value={settings.delimiter}
                  disabled={datasourceKind === "excel"}
                  onChange={(e) => setSettings({ ...settings, delimiter: e.target.value as FileImportSettings["delimiter"] })}
                  data-testid="fdv-setting-delimiter"
                >
                  <option value="auto">{datasourceKind === "excel" ? "Auto (sheet)" : `Auto${detected?.delimiter ? ` (${detected.delimiter === "\t" ? "tab" : detected.delimiter})` : ""}`}</option>
                  <option value=",">Comma</option>
                  <option value={"\t"}>Tab</option>
                  <option value=";">Semicolon</option>
                  <option value="|">Pipe</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                Date format
                <select
                  className="input text-xs py-1.5"
                  value={settings.date_format}
                  onChange={(e) => setSettings({ ...settings, date_format: e.target.value as FileImportSettings["date_format"] })}
                  data-testid="fdv-setting-date-format"
                >
                  <option value="auto">Auto{detected?.date_format ? `: ${detected.date_format}` : ""}</option>
                  <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                  <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                  <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                  <option value="YYYY/MM/DD">YYYY/MM/DD</option>
                  <option value="DD-MM-YYYY">DD-MM-YYYY</option>
                  <option value="MM-DD-YYYY">MM-DD-YYYY</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                Thousands separator
                <select
                  className="input text-xs py-1.5"
                  value={settings.thousands}
                  onChange={(e) => setSettings({ ...settings, thousands: e.target.value as FileImportSettings["thousands"] })}
                  data-testid="fdv-setting-thousands"
                >
                  <option value="auto">Auto</option>
                  <option value=",">Comma ( , )</option>
                  <option value=".">Period ( . )</option>
                  <option value=" ">Space</option>
                  <option value="none">None</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                Decimal
                <select
                  className="input text-xs py-1.5"
                  value={settings.decimal}
                  onChange={(e) => setSettings({ ...settings, decimal: e.target.value as FileImportSettings["decimal"] })}
                  data-testid="fdv-setting-decimal"
                >
                  <option value=".">Period ( . )</option>
                  <option value=",">Comma ( , )</option>
                </select>
              </label>
              <div className="flex flex-col gap-2 text-xs text-text justify-end">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={settings.trim_whitespace} onChange={(e) => setSettings({ ...settings, trim_whitespace: e.target.checked })} data-testid="fdv-setting-trim" />
                  Trim whitespace
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={settings.skip_empty_rows} onChange={(e) => setSettings({ ...settings, skip_empty_rows: e.target.checked })} data-testid="fdv-setting-skip-empty" />
                  Skip empty rows
                </label>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-surface2/60 border-t border-border/50 text-[11px] text-muted">
              <span>
                {detected?.encoding ? `Encoding ${detected.encoding}` : null}
                {detected?.encoding && summary ? " · " : null}
                {summary ? `last import ${formatAgo(summary.imported_at)} · ${summary.rows.toLocaleString()} rows · ${summary.columns} columns` : null}
                {importError ? <span className="text-red-400"> · {importError}</span> : null}
              </span>
              <button className="btn-primary text-xs px-3 py-1.5" disabled={rerunning} onClick={() => rerunImport()} data-testid="fdv-rerun">
                {rerunning ? "Importing…" : "Re-run import"}
              </button>
            </div>
          </div>
        )}

        {/* ---- The one-line promise ---- */}
        <div
          className="flex items-start gap-3 px-4 py-3 rounded-xl bg-primary/10 border border-primary/30 text-primary text-[13px]"
          data-testid="fdv-complete-line"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden className="shrink-0 mt-0.5">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <div>
            <strong>This file is fully loaded</strong> — every number below is computed over all{" "}
            {currentRows != null ? `${currentRows.toLocaleString()} rows` : "rows"}. Nothing is sampled.
          </div>
        </div>

        {/* ---- Tiles ---- */}
        {profileLoading ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }} data-testid="fdv-skeleton">
            <SkeletonTile /><SkeletonTile /><SkeletonTile /><SkeletonTile /><SkeletonTile />
          </div>
        ) : profileUsable ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }} data-testid="fdv-tiles">
            <Tile
              testId="fdv-tile-rows"
              label="Rows"
              value={totalRows != null ? totalRows.toLocaleString() : "—"}
              sub={
                <span className="inline-flex items-center gap-1.5 text-primary">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" />exact · whole {activeVersionId ? "version" : "sheet"}
                </span>
              }
            />
            <Tile
              testId="fdv-tile-columns"
              label="Columns"
              value={columnOrder.length.toLocaleString()}
              sub={[
                typeBreakdown.text ? `${typeBreakdown.text} text` : null,
                typeBreakdown.number ? `${typeBreakdown.number} number` : null,
                typeBreakdown.date ? `${typeBreakdown.date} date` : null,
                typeBreakdown.bool ? `${typeBreakdown.bool} bool` : null,
                typeBreakdown.other ? `${typeBreakdown.other} other` : null,
              ].filter(Boolean).join(" · ")}
            />
            <Tile
              testId="fdv-tile-empty"
              label="Empty cells"
              value={emptiness ? `${emptiness.pct < 10 ? emptiness.pct.toFixed(1) : Math.round(emptiness.pct)}%` : "0%"}
              sub={
                emptiness && emptiness.top.length > 0 ? (
                  <>
                    {emptiness.top.map((c, i) => (
                      <span key={c.name}>
                        {i > 0 ? " · " : ""}
                        <span className="font-mono text-text">{c.name}</span> {c.pct < 1 ? "<1" : Math.round(c.pct)}% empty
                      </span>
                    ))}
                  </>
                ) : (
                  "no empty cells"
                )
              }
            />
            {coverage && (
              <Tile
                testId="fdv-tile-dates"
                label="Date coverage"
                valueSize="md"
                value={`${coverage.from} → ${coverage.to}`}
                sub={<>from <span className="font-mono">{coverage.source}</span></>}
              />
            )}
            <Tile
              testId="fdv-tile-health"
              label="Import health"
              valueSize="md"
              value={summary ? `${summary.fixed_count} type ${summary.fixed_count === 1 ? "fix" : "fixes"} · ${summary.errors} ${summary.errors === 1 ? "error" : "errors"}` : "not imported yet"}
              sub={
                mixedColumns.length > 0
                  ? `${mixedColumns.length} ${mixedColumns.length === 1 ? "column" : "columns"} with mixed types`
                  : "no columns with mixed types"
              }
            />
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-400 text-[13px]" data-testid="fdv-profile-failed">
            <span>Could not profile this file: {profileError || (profile && profile.error ? "the profile failed." : "no profile came back.")}</span>
            <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => setImportBump((k) => k + 1)}>Retry</button>
          </div>
        )}

        {/* ---- Suggested cleaning ---- */}
        <div ref={suggestionsRef} className="bg-surface border border-border rounded-xl overflow-hidden" data-testid="fdv-suggestions">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
            <div className="flex items-baseline gap-2.5 min-w-0">
              <div className="font-semibold text-[15px] text-text">Suggested cleaning</div>
              <div className="text-xs text-muted truncate">
                {suggestionsLoading
                  ? "profiling every row…"
                  : suggestionsError
                    ? suggestionsError
                    : `${visibleSuggestions.length} ${visibleSuggestions.length === 1 ? "suggestion" : "suggestions"} found while profiling · each one is reversible`}
              </div>
            </div>
            {visibleSuggestions.length > 1 && (
              <button
                className="btn-primary text-xs px-3 py-1.5"
                disabled={!!applying}
                onClick={() => applySuggestions(visibleSuggestions.map((s) => s.id))}
                data-testid="fdv-apply-all"
              >
                {applying === "all" ? "Applying…" : `Apply all ${visibleSuggestions.length}`}
              </button>
            )}
          </div>
          {suggestionsLoading ? (
            <div className="px-4 py-5 text-xs text-muted animate-pulse">Looking for duplicates, blanks, variants and unconverted types across every row…</div>
          ) : visibleSuggestions.length === 0 ? (
            <div className="px-4 py-5 text-xs text-muted" data-testid="fdv-no-suggestions">
              {suggestionsError ? "Suggestions are unavailable right now." : "Nothing to clean — no duplicates, stray whitespace, unconverted types or near-empty numeric columns were found."}
            </div>
          ) : (
            visibleSuggestions.map((s) => (
              <div key={s.id} className="flex flex-wrap items-start gap-3 px-4 py-3 border-b border-border/50" data-testid="fdv-suggestion" data-suggestion-id={s.id}>
                <div className="flex-1 min-w-[240px]">
                  <div className="text-[13px] font-medium text-text" data-testid="fdv-suggestion-title">{s.title}</div>
                  <div className="text-xs text-muted mt-0.5">{s.reason}</div>
                </div>
                <div className="text-xs text-muted tabular-nums shrink-0 self-center" data-testid="fdv-suggestion-rows">{s.affected_rows.toLocaleString()} {s.affected_rows === 1 ? "row" : "rows"}</div>
                <div className="flex items-center gap-2 shrink-0 self-center">
                  <button
                    className="btn-primary text-xs px-3 py-1.5"
                    disabled={!!applying}
                    onClick={() => applySuggestions([s.id])}
                    data-testid="fdv-suggestion-apply"
                  >
                    {applying === s.id ? "Applying…" : "Apply"}
                  </button>
                  <button
                    className="btn-secondary text-xs px-3 py-1.5"
                    disabled={!!applying}
                    onClick={() => setDismissed((prev) => new Set(prev).add(s.id))}
                    data-testid="fdv-suggestion-dismiss"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-surface2/60 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1.5">
              <CheckGlyph /> Applying creates a new version — the original is never changed.
            </span>
            {applyError && <span className="text-red-400" data-testid="fdv-apply-error">{applyError}</span>}
          </div>
        </div>

        {/* ---- Columns ---- */}
        {(profileLoading || profileUsable) && (
          <div className="bg-surface border border-border rounded-xl overflow-hidden" data-testid="fdv-columns">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
              <div className="flex items-baseline gap-2.5 min-w-0">
                <div className="font-semibold text-[15px] text-text">Columns</div>
                <div className="text-xs text-muted truncate">
                  {profileUsable && totalRows != null
                    ? `what every row looks like, computed over all ${totalRows.toLocaleString()} rows`
                    : "profiling every row…"}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <label className="flex items-center gap-1.5 text-xs text-text border border-border rounded-lg px-2.5 py-1.5 bg-surface2 cursor-pointer">
                  <input type="checkbox" checked={showTopValues} onChange={(e) => setShowTopValues(e.target.checked)} data-testid="fdv-toggle-topvalues" />
                  Show top values
                </label>
                <label className="flex items-center gap-1.5 text-xs text-text border border-border rounded-lg px-2.5 py-1.5 bg-surface2 cursor-pointer">
                  <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} data-testid="fdv-toggle-flagged" />
                  Only fixed or flagged
                </label>
                <input
                  type="search"
                  placeholder="Find a column"
                  aria-label="Find a column"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="input text-xs py-1.5 w-44"
                  data-testid="fdv-column-search"
                />
              </div>
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[900px]">
                <div className={`${COLUMN_GRID} px-4 py-2 text-[10px] uppercase tracking-wide text-muted border-b border-border bg-surface2`} style={COLUMN_GRID_STYLE}>
                  <div>Column</div><div>Type</div><div>Filled</div><div>Distinct</div><div>Values · range or top values</div><div>Use it as</div>
                </div>
                {profileLoading && <div className="px-4 py-6 text-xs text-muted animate-pulse">Computing the shape of every column over the whole file…</div>}
                {profileUsable && visibleColumns.map((name) => {
                  const raw = columns[name];
                  const stat: ProfileColumnStat = { ...raw, type: FAMILY_LABEL[(raw.type || "").toLowerCase()] || raw.type };
                  const fix = fixByColumn[name];
                  const mixed = raw.mixed_types ?? 0;
                  const emptyHeavy = (raw.null_pct ?? 0) >= EMPTY_HEAVY_PCT;
                  const role = useItAs(name, stat.type, stat);
                  return (
                    <div
                      key={name}
                      className={`${COLUMN_GRID} px-4 py-2.5 border-b border-border/50 text-[13px] ${emptyHeavy ? "bg-amber-500/5" : ""}`}
                      style={COLUMN_GRID_STYLE}
                      data-testid="fdv-column-row"
                      data-column={name}
                    >
                      <div className="min-w-0">
                        <div className="font-mono font-medium text-text truncate" title={name}>{name}</div>
                        {fix && (
                          <span className="inline-block mt-0.5 text-[10px] text-primary bg-primary/10 border border-primary/30 rounded px-1.5 py-px" data-testid="fdv-fixed-badge">
                            fixed: {fix.from} → {fix.to}
                          </span>
                        )}
                      </div>
                      <ColumnStatCells
                        stat={stat}
                        totalRows={totalRows}
                        showTopValues={showTopValues}
                        extraValues={
                          mixed > 0 ? (
                            <span className="text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-px text-[10px]" data-testid="fdv-mixed-badge">
                              mixed types: {mixed.toLocaleString()} {mixed === 1 ? "cell" : "cells"}
                            </span>
                          ) : undefined
                        }
                      />
                      <div className="text-xs text-muted" data-testid="fdv-use-as">{role}</div>
                    </div>
                  );
                })}
                {profileUsable && visibleColumns.length === 0 && <div className="px-4 py-6 text-xs text-muted">No columns match.</div>}
              </div>
            </div>
            {profileUsable && (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-surface2/60 text-[11px] text-muted">
                {hiddenCount > 0 ? (
                  <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => setShowAllColumns(true)} data-testid="fdv-show-more">
                    Show {hiddenCount} more {hiddenCount === 1 ? "column" : "columns"}
                  </button>
                ) : showAllColumns && !isNarrowed && filteredColumns.length > COLUMNS_INITIALLY_SHOWN ? (
                  <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => setShowAllColumns(false)}>Show fewer columns</button>
                ) : (
                  <span />
                )}
                <div>Filled · distinct · min · max · top values: one pass over the whole {activeVersionId ? "version" : "sheet"}, recomputed when a version is applied.</div>
              </div>
            )}
          </div>
        )}

        {/* ---- Versions rail ---- */}
        <div className="bg-surface border border-border rounded-xl overflow-hidden" data-testid="fdv-versions">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
            <div className="flex items-baseline gap-2.5 min-w-0">
              <div className="font-semibold text-[15px] text-text">Versions</div>
              <div className="text-xs text-muted truncate">every cleaning step is a new version · switch back any time</div>
            </div>
            <button
              className="btn-secondary text-xs px-3 py-1.5"
              onClick={() => suggestionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
              data-testid="fdv-new-version"
            >
              + New version
            </button>
          </div>
          <div className="px-4 py-3 flex items-stretch gap-2 overflow-x-auto">
            <button
              className={`text-left rounded-xl border px-3 py-2.5 min-w-[200px] shrink-0 transition ${
                activeVersionId === null ? "border-primary bg-primary/10" : "border-border bg-surface2/40 hover:bg-surface2"
              }`}
              onClick={() => onActiveVersionChange(null)}
              data-testid="fdv-version-card"
              data-version-id="original"
              data-current={activeVersionId === null ? "true" : "false"}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-muted">v1</span>
                <span className="text-[13px] font-medium text-text">Original</span>
                {activeVersionId === null && <span className="ml-auto text-[10px] text-primary bg-primary/10 border border-primary/30 rounded-full px-1.5 py-px" data-testid="fdv-version-current">Current</span>}
              </div>
              <div className="text-xs text-muted mt-0.5 tabular-nums">
                {originalRows != null ? `${originalRows.toLocaleString()} rows` : "all rows"}{columnOrder.length && !activeVersionId ? ` · ${columnOrder.length} columns` : ""} · as uploaded
              </div>
              <div className="text-[11px] text-muted mt-0.5">
                {importState?.uploaded_at ? formatAgo(importState.uploaded_at) : ""}{importState?.uploaded_by_initials ? ` · ${importState.uploaded_by_initials}` : ""}
              </div>
            </button>
            {fileVersions.map((v, i) => {
              const current = activeVersionId === v.id;
              const step = lastStep(v);
              return (
                <div key={v.id} className="flex items-center gap-2 shrink-0">
                  <ArrowGlyph />
                  <div
                    className={`text-left rounded-xl border px-3 py-2.5 min-w-[200px] max-w-[280px] transition cursor-pointer ${
                      current ? "border-primary bg-primary/10" : "border-border bg-surface2/40 hover:bg-surface2"
                    }`}
                    onClick={() => onActiveVersionChange(v.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") onActiveVersionChange(v.id); }}
                    data-testid="fdv-version-card"
                    data-version-id={v.id}
                    data-current={current ? "true" : "false"}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] font-mono text-muted">v{i + 2}</span>
                      {renamingId === v.id ? (
                        <input
                          autoFocus
                          className="bg-transparent border-b border-current outline-none w-28 text-[13px]"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") { setRenamingId(null); onRenameVersion(v, renameDraft.trim()); }
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          onBlur={() => { setRenamingId(null); onRenameVersion(v, renameDraft.trim()); }}
                        />
                      ) : (
                        <span className="text-[13px] font-medium text-text truncate">{v.name}</span>
                      )}
                      {current && <span className="ml-auto text-[10px] text-primary bg-primary/10 border border-primary/30 rounded-full px-1.5 py-px shrink-0" data-testid="fdv-version-current">Current</span>}
                    </div>
                    <div className="text-xs text-muted mt-0.5 truncate tabular-nums" title={step || undefined}>
                      {v.row_count != null ? `${v.row_count.toLocaleString()} rows` : ""}{v.row_count != null && step ? " · " : ""}{step || ""}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted mt-0.5">
                      <span>{formatAgo(v.created_at)}</span>
                      <span className="ml-auto flex items-center gap-1">
                        <button className="opacity-70 hover:opacity-100 px-0.5" title="Rename this table" onClick={(e) => { e.stopPropagation(); setRenamingId(v.id); setRenameDraft(v.name); }}>
                          &#9998;
                        </button>
                        <button className="opacity-70 hover:opacity-100 px-0.5" title="Delete this table" onClick={(e) => { e.stopPropagation(); onDeleteVersion(v); }}>
                          &times;
                        </button>
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ---- Rows: the full grid ---- */}
        <div data-testid="fdv-rows">
          <div className="flex flex-wrap items-baseline gap-2.5 px-1 pb-2">
            <div className="font-semibold text-[15px] text-text">Rows</div>
            <div className="text-xs text-muted">
              {activeVersion ? activeVersion.name : "Original"}{currentRows != null ? ` · ${currentRows.toLocaleString()} rows` : ""} · complete
            </div>
            <div className="text-xs text-muted" data-testid="fdv-rows-caption">Files are complete, so filtering, sorting and totals work on every row.</div>
          </div>
          <div className="h-[70vh] min-h-[480px]">{grid}</div>
        </div>
      </div>
    </div>
  );
}
