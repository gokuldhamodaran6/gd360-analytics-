import { useEffect, useRef, useState } from "react";
import { datasourceApi, DataPreview, DatasetVersion } from "../api/client";

const PAGE_SIZE_OPTIONS: { value: number | "all"; label: string }[] = [
  { value: 50, label: "50" },
  { value: 100, label: "100" },
  { value: 1000, label: "1000" },
  { value: "all", label: "All" },
];

function FilterIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      className={active ? "text-primary shrink-0" : "text-muted shrink-0"}
      fill="currentColor"
    >
      <path d="M1 2.2h14L9.6 9v4.6l-3.2 1.6V9L1 2.2z" />
    </svg>
  );
}

// The cleaning-log summary the AI writes for "what changed" (see
// backend/app/services/ai_engine.py) marks its own section headers with
// plain **bold** markdown ("**Data prep:** ...", "**Analysis:** ..."). This
// renders those spans as real bold text instead of showing the literal
// asterisks - a small, dependency-free stand-in for a full markdown parser,
// since bold is the only markdown this one piece of AI-written text ever
// uses.
function renderBoldText(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((p) => p.length > 0);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i} className="font-semibold text-text">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

export default function DataTable({
  datasourceId,
  refreshKey,
  versions,
  activeVersionId,
  onActiveVersionChange,
  onVersionsChanged,
  originalTables,
  activeTable,
  onActiveTableChange,
}: {
  datasourceId: string;
  refreshKey: number;
  versions: DatasetVersion[];
  activeVersionId: string | null;
  onActiveVersionChange: (versionId: string | null) => void;
  onVersionsChanged: () => void;
  // Real table/sheet names for THIS datasource's own original data - only
  // populated (more than one entry) for a multi-table datasource (a
  // multi-sheet Excel workbook, or a multi-table Postgres/MySQL/SQL
  // Server/Supabase/MongoDB/BigQuery connection). Empty for an ordinary
  // single-table source, in which case the tab strip below shows the same
  // single "Original data" button it always has.
  originalTables?: string[];
  // Which of `originalTables` is currently previewed - only meaningful
  // while activeVersionId is null (a saved/AI-built table has no table
  // name of its own to pick). Ignored (and safe to pass null) for a
  // single-table source.
  activeTable?: string | null;
  onActiveTableChange?: (table: string | null) => void;
}) {
  const [preview, setPreview] = useState<DataPreview | null>(null);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState<number | "all">(50);
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [debouncedFilters, setDebouncedFilters] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [openFilterCol, setOpenFilterCol] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const menuRef = useRef<HTMLDivElement | null>(null);
  const effectiveLimit = pageSize === "all" ? 100000 : pageSize;
  const hasActiveFilters = Object.values(debouncedFilters).some((v) => !!v);

  // Typing into a filter box should not fire a request on every keystroke -
  // wait for a short pause before actually re-querying the server.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilters(filters), 350);
    return () => clearTimeout(t);
  }, [filters]);

  // Fetches whichever table (the original data, or one of the saved/named
  // ones) is currently selected. Which one that is lives one level up, in
  // Workspace, so the chat panel and this table always agree on it.
  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const data = await datasourceApi.preview(
          datasourceId, activeVersionId, effectiveLimit, offset,
          { sortBy, sortDir, filters: debouncedFilters },
          activeVersionId ? null : activeTable
        );
        setPreview(data);
      } catch (err: any) {
        setError(err?.response?.data?.detail || "Could not load data preview.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId, activeVersionId, activeTable, refreshKey, offset, pageSize, sortBy, sortDir, debouncedFilters]);

  // Switching tables (a different tab, a different original table/sheet, or
  // a different data source entirely) starts every view control fresh - a
  // sort column or filter from a previous table would not make sense here.
  useEffect(() => {
    setSortBy(null);
    setSortDir("asc");
    setFilters({});
    setDebouncedFilters({});
    setPageSize(50);
    setOffset(0);
    setOpenFilterCol(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId, activeVersionId, activeTable]);

  // Closes the open column menu on a click anywhere else on the page. A
  // click inside the menu itself never reaches here, because the header
  // trigger that opens/closes it stops its own mousedown from bubbling.
  useEffect(() => {
    if (!openFilterCol) return;
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenFilterCol(null);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [openFilterCol]);

  const toggleColumnMenu = (col: string) => {
    setOpenFilterCol((c) => (c === col ? null : col));
  };

  const applySort = (col: string, dir: "asc" | "desc") => {
    setOffset(0);
    setSortBy(col);
    setSortDir(dir);
    setOpenFilterCol(null);
  };

  const clearSort = () => {
    setOffset(0);
    setSortBy(null);
    setSortDir("asc");
  };

  const setColumnFilter = (col: string, value: string) => {
    setOffset(0);
    setFilters((f) => ({ ...f, [col]: value }));
  };

  const clearColumnFilter = (col: string) => {
    setOffset(0);
    setFilters((f) => {
      const next = { ...f };
      delete next[col];
      return next;
    });
  };

  const clearAllFilters = () => {
    setOffset(0);
    setFilters({});
    setDebouncedFilters({});
  };

  const changePageSize = (v: number | "all") => {
    setPageSize(v);
    setOffset(0);
  };

  const nextPage = () => {
    if (!preview) return;
    const step = typeof effectiveLimit === "number" ? effectiveLimit : preview.limit;
    const newOffset = offset + step;
    if (newOffset >= preview.total_rows) return;
    setOffset(newOffset);
  };

  const prevPage = () => {
    const step = typeof effectiveLimit === "number" ? effectiveLimit : (preview?.limit || 50);
    const newOffset = Math.max(0, offset - step);
    setOffset(newOffset);
  };

  const startRename = (v: DatasetVersion) => {
    setRenamingId(v.id);
    setRenameDraft(v.name);
  };

  const commitRename = async (v: DatasetVersion) => {
    const name = renameDraft.trim();
    setRenamingId(null);
    if (!name || name === v.name) return;
    try {
      await datasourceApi.renameVersion(datasourceId, v.id, name);
      onVersionsChanged();
    } catch {
      setError("Could not rename that table. Please try again.");
    }
  };

  const doDeleteVersion = async (v: DatasetVersion) => {
    if (!confirm(`Delete the table "${v.name}"? This cannot be undone.`)) return;
    setBusyAction(`delete-${v.id}`);
    try {
      await datasourceApi.deleteVersion(datasourceId, v.id);
      if (activeVersionId === v.id) onActiveVersionChange(null);
      onVersionsChanged();
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Could not delete that table.");
    } finally {
      setBusyAction("");
    }
  };

  const doExport = async (format: "csv" | "xlsx") => {
    setBusyAction(format);
    try {
      await datasourceApi.downloadExport(datasourceId, activeVersionId, format, activeVersionId ? null : activeTable);
    } catch {
      setError("Could not export the data. Please try again.");
    } finally {
      setBusyAction("");
    }
  };

  if (loading && !preview) {
    return <div className="card h-full flex items-center justify-center text-muted p-10 text-center">Loading data...</div>;
  }

  if (error && !preview) {
    return <div className="card h-full flex items-center justify-center text-red-400 p-10 text-center">{error}</div>;
  }

  if (!preview) return null;

  const from = preview.total_rows === 0 ? 0 : offset + 1;
  const to = Math.min(offset + preview.limit, preview.total_rows);

  return (
    <div className="card h-full flex flex-col overflow-hidden">
      <div className="p-3 border-b border-border flex items-center gap-3 overflow-x-auto shrink-0">
        {/* Original-data tab(s): teal, the same color used for a "real,
            untouched source table" everywhere else in the app now (see the
            WORKING ON picker's SourceDot in ChatPanel.tsx and the "+ Add
            data" popup) - kept visually distinct from a saved/AI-built
            table's violet tab below on purpose, so which is which reads at
            a glance even with several of each open. A multi-table source
            (more than one entry in originalTables) gets one tab per real
            table/sheet name instead of a single generic "Original data"
            button - every one of them is still "original data", just teal
            either way, exactly as many teal tabs as there are real source
            tables, however many that is. */}
        {originalTables && originalTables.length > 1 ? (
          originalTables.map((t) => (
            <button
              key={t}
              className={`text-xs px-3 py-1.5 rounded-lg font-medium transition shrink-0 flex items-center gap-1.5 ${
                activeVersionId === null && activeTable === t
                  ? "bg-sky-600 text-white"
                  : "border border-sky-500/40 text-sky-300 bg-sky-500/10 hover:bg-sky-500/20"
              }`}
              onClick={() => { onActiveVersionChange(null); onActiveTableChange?.(t); }}
              title={`Original data — ${t}`}
            >
              {t}
            </button>
          ))
        ) : (
          <button
            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition shrink-0 ${
              activeVersionId === null
                ? "bg-sky-600 text-white"
                : "border border-sky-500/40 text-sky-300 bg-sky-500/10 hover:bg-sky-500/20"
            }`}
            onClick={() => onActiveVersionChange(null)}
          >
            Original data
          </button>
        )}
        {versions.map((v) => (
          <div
            key={v.id}
            className={`flex items-center gap-1 rounded-lg pl-3 pr-1.5 py-1.5 text-xs font-medium shrink-0 transition ${
              activeVersionId === v.id ? "bg-primary text-white" : "btn-secondary"
            }`}
          >
            {renamingId === v.id ? (
              <input
                autoFocus
                className="bg-transparent border-b border-current outline-none w-24 text-xs"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(v);
                  if (e.key === "Escape") setRenamingId(null);
                }}
                onBlur={() => commitRename(v)}
              />
            ) : (
              <span className="cursor-pointer whitespace-nowrap" onClick={() => onActiveVersionChange(v.id)}>
                {v.name}
              </span>
            )}
            <button className="opacity-70 hover:opacity-100 px-0.5" title="Rename this table" onClick={() => startRename(v)}>
              &#9998;
            </button>
            <button
              className="opacity-70 hover:opacity-100 px-0.5"
              title="Delete this table"
              disabled={busyAction === `delete-${v.id}`}
              onClick={() => doDeleteVersion(v)}
            >
              &times;
            </button>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {loading && <span className="text-[11px] text-accent animate-pulse">Updating...</span>}
          <button className="btn-secondary text-xs px-2.5 py-1.5" disabled={!!busyAction} onClick={() => doExport("csv")}>
            {busyAction === "csv" ? "Exporting..." : "Export CSV"}
          </button>
          <button className="btn-secondary text-xs px-2.5 py-1.5" disabled={!!busyAction} onClick={() => doExport("xlsx")}>
            {busyAction === "xlsx" ? "Exporting..." : "Export Excel"}
          </button>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted">
          <span>Rows per page:</span>
          <div className="flex gap-1">
            {PAGE_SIZE_OPTIONS.map((o) => (
              <button
                key={o.label}
                className={`text-xs px-2.5 py-1 rounded-lg transition ${
                  pageSize === o.value ? "bg-primary text-white" : "btn-secondary"
                }`}
                onClick={() => changePageSize(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        {hasActiveFilters && (
          <button className="text-xs text-accent underline" onClick={clearAllFilters}>
            Clear all filters
          </button>
        )}
      </div>

      {error && <div className="mx-3 mt-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}

      {preview.cleaning_log.length > 0 && (
        <div className="px-3 pt-2 shrink-0">
          <button className="text-xs text-accent underline" onClick={() => setShowLog((v) => !v)}>
            {showLog ? "Hide" : "Show"} what changed ({preview.cleaning_log.length} step{preview.cleaning_log.length === 1 ? "" : "s"})
          </button>
          {showLog && (
            <div className="mt-2 space-y-1.5 max-h-32 overflow-y-auto">
              {preview.cleaning_log.map((entry, i) => (
                <div key={i} className="text-xs bg-surface2 border border-border rounded-lg px-2.5 py-1.5">
                  <div className="text-muted italic">"{entry.prompt}"</div>
                  <div className="text-text mt-0.5 leading-relaxed">
                    {entry.summary ? renderBoldText(entry.summary) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {preview.rows.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted text-sm p-10 text-center">
            {hasActiveFilters ? "No rows match your column filters." : "No rows to show."}
          </div>
        ) : (
          <table className="min-w-full text-xs">
            <thead className="sticky top-0 bg-surface2 z-10">
              <tr>
                {preview.columns.map((col) => (
                  <th key={col} className="relative text-left px-3 py-2 font-semibold border-b border-border whitespace-nowrap">
                    <div
                      className="flex items-center gap-1.5 cursor-pointer select-none hover:text-primary transition"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => toggleColumnMenu(col)}
                      title="Sort or filter this column"
                    >
                      <span>
                        {col}
                        {sortBy === col && <span className="ml-1 text-primary">{sortDir === "asc" ? "▲" : "▼"}</span>}
                      </span>
                      <span className="text-muted font-normal">{preview.dtypes[col]}</span>
                      <FilterIcon active={sortBy === col || !!filters[col]} />
                    </div>

                    {openFilterCol === col && (
                      <div
                        ref={menuRef}
                        className="absolute z-20 top-full left-0 mt-1 w-56 card p-2 space-y-1 shadow-xl font-normal normal-case"
                      >
                        <button
                          className="w-full text-left text-xs px-2 py-1.5 rounded-lg hover:bg-surface2 flex items-center gap-1.5"
                          onClick={() => applySort(col, "asc")}
                        >
                          <span>{"▲"}</span> Sort ascending
                        </button>
                        <button
                          className="w-full text-left text-xs px-2 py-1.5 rounded-lg hover:bg-surface2 flex items-center gap-1.5"
                          onClick={() => applySort(col, "desc")}
                        >
                          <span>{"▼"}</span> Sort descending
                        </button>
                        {sortBy === col && (
                          <button
                            className="w-full text-left text-xs px-2 py-1.5 rounded-lg hover:bg-surface2 text-muted"
                            onClick={clearSort}
                          >
                            Clear sort
                          </button>
                        )}
                        <div className="border-t border-border my-1" />
                        <div className="px-2 pb-1">
                          <label className="text-[10px] uppercase tracking-wide text-muted block mb-1">Filter</label>
                          <input
                            autoFocus
                            className="input text-xs py-1 px-2"
                            placeholder={`Search ${col}...`}
                            value={filters[col] || ""}
                            onChange={(e) => setColumnFilter(col, e.target.value)}
                          />
                          {filters[col] && (
                            <button className="text-[11px] text-accent underline mt-1" onClick={() => clearColumnFilter(col)}>
                              Clear filter
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, i) => (
                <tr key={i} className="hover:bg-surface2/60 border-b border-border/50">
                  {preview.columns.map((col) => (
                    <td key={col} className="px-3 py-1.5 whitespace-nowrap">
                      {row[col] === null || row[col] === undefined || row[col] === "" ? (
                        <span className="text-muted">&mdash;</span>
                      ) : (
                        String(row[col])
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="p-3 border-t border-border flex items-center justify-between shrink-0 text-xs text-muted">
        <div>
          {from}-{to} of {preview.total_rows} rows
          {hasActiveFilters && <span className="ml-1 text-accent">(filtered)</span>}
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary text-xs px-2.5 py-1" disabled={offset === 0 || loading} onClick={prevPage}>
            Prev
          </button>
          <button className="btn-secondary text-xs px-2.5 py-1" disabled={to >= preview.total_rows || loading} onClick={nextPage}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
