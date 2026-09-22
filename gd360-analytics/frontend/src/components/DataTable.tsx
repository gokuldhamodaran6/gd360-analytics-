import { useEffect, useMemo, useRef, useState } from "react";
import { datasourceApi, DataPreview, DatasetVersion, ColumnStat } from "../api/client";

// Rows-per-page choices for the numbered pagination footer below. Capped at
// 250 (and no more "1000"/"All" option) on purpose - see config.py's
// PREVIEW_ROW_LIMIT comment for the incident this ties back to: loading a
// huge page just to show it in a scrolling table was never actually useful
// to a person, and it was the single biggest avoidable driver of the
// server's memory footprint. 100 is the default so a fresh table opens on
// a page that both loads fast and still shows a meaningful amount of data.
const PAGE_SIZE_OPTIONS = [50, 100, 250];
const DEFAULT_PAGE_SIZE = 100;

type Density = "compact" | "comfortable";
type ScaleColor = "blue" | "green" | "amber" | "red" | "violet";
type RuleOp = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "contains";
type FormatMode = "none" | "scale" | "rules";
type FormatRule = { id: string; op: RuleOp; value: string; color: ScaleColor };
type ColumnFormat = { mode: FormatMode; scaleColor: ScaleColor; rules: FormatRule[] };
type StatKey = "none" | "sum" | "mean" | "min" | "max" | "count" | "non_null" | "distinct";

const DEFAULT_FORMAT: ColumnFormat = { mode: "none", scaleColor: "blue", rules: [] };

const SCALE_RGB: Record<ScaleColor, [number, number, number]> = {
  blue: [56, 189, 248],
  green: [52, 211, 153],
  amber: [251, 191, 36],
  red: [248, 113, 113],
  violet: [167, 139, 250],
};
const SWATCH_CLASS: Record<ScaleColor, string> = {
  blue: "bg-sky-400",
  green: "bg-emerald-400",
  amber: "bg-amber-400",
  red: "bg-red-400",
  violet: "bg-violet-400",
};
const OP_LABELS: Record<RuleOp, string> = {
  gt: "is greater than", gte: "is at least", lt: "is less than", lte: "is at most",
  eq: "equals", neq: "does not equal", contains: "contains",
};
const STAT_LABELS: Record<StatKey, string> = {
  none: "—", sum: "Sum", mean: "Average", min: "Min", max: "Max",
  count: "Count", non_null: "Filled", distinct: "Distinct",
};

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function scaleBackground(color: ScaleColor, t: number): string {
  const [r, g, b] = SCALE_RGB[color];
  const alpha = 0.1 + clamp01(t) * 0.55;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function ruleBackground(color: ScaleColor): string {
  const [r, g, b] = SCALE_RGB[color];
  return `rgba(${r}, ${g}, ${b}, 0.32)`;
}

function ruleMatches(rawValue: any, rule: FormatRule): boolean {
  if (!rule.value) return false;
  if (rawValue === null || rawValue === undefined || rawValue === "") return false;
  const strVal = String(rawValue);
  if (rule.op === "contains") return strVal.toLowerCase().includes(rule.value.toLowerCase());
  const num = Number(rawValue);
  const ruleNum = Number(rule.value);
  if (Number.isNaN(num) || Number.isNaN(ruleNum)) {
    if (rule.op === "eq") return strVal === rule.value;
    if (rule.op === "neq") return strVal !== rule.value;
    return false;
  }
  switch (rule.op) {
    case "gt": return num > ruleNum;
    case "gte": return num >= ruleNum;
    case "lt": return num < ruleNum;
    case "lte": return num <= ruleNum;
    case "eq": return num === ruleNum;
    case "neq": return num !== ruleNum;
    default: return false;
  }
}

function availableStats(stat: ColumnStat | undefined): StatKey[] {
  if (!stat) return ["none"];
  const opts: StatKey[] = ["none", "count", "non_null"];
  if (stat.sum !== null) opts.push("sum");
  if (stat.mean !== null) opts.push("mean");
  if (stat.min !== null) opts.push("min");
  if (stat.max !== null) opts.push("max");
  if (stat.distinct !== null) opts.push("distinct");
  return opts;
}

function defaultStat(stat: ColumnStat | undefined): StatKey {
  if (!stat) return "none";
  if (stat.sum !== null) return "sum";
  if (stat.distinct !== null) return "distinct";
  return "none";
}

function formatStatValue(key: StatKey, stat: ColumnStat | undefined): string {
  if (!stat || key === "none") return "";
  const v = (stat as any)[key];
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    return (key === "sum" || key === "mean")
      ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : v.toLocaleString();
  }
  return String(v);
}

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

// A short glyph next to each column name showing what kind of data it
// holds - "#" for a number, a checkmark for a boolean, a calendar for a
// date, and the default "Abc" for text - the same at-a-glance affordance a
// spreadsheet/database grid gives, using the dtype the backend already
// returns (preview.dtypes) rather than re-sniffing it client-side.
function ColumnTypeIcon({ dtype }: { dtype: string }) {
  const d = dtype.toLowerCase();
  let label = "Abc";
  let cls = "text-muted";
  if (d.startsWith("bool")) {
    label = "✓︎";
    cls = "text-emerald-400";
  } else if (d.startsWith("int") || d.startsWith("float") || d.startsWith("uint") || d.startsWith("double")) {
    label = "#";
    cls = "text-sky-400";
  } else if (d.startsWith("datetime") || d.startsWith("date")) {
    label = "\u{1F4C5}";
    cls = "text-amber-400";
  }
  return (
    <span className={`text-[10px] font-semibold shrink-0 ${cls}`} title={dtype} aria-hidden>
      {label}
    </span>
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

// Builds the numbered page list for the footer, collapsing a long run into
// "…" the way any competent paginator does - always the first and last
// page, plus a small window around whichever page is current.
function buildPageList(current: number, total: number): (number | "…")[] {
  const pages = new Set<number>();
  pages.add(1);
  pages.add(total);
  for (let p = current - 1; p <= current + 1; p++) {
    if (p >= 1 && p <= total) pages.add(p);
  }
  const sorted = Array.from(pages).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
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
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
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

  // --- "Pro" table view state - all per-viewer, client-only, and reset
  // whenever a different table is opened (see the reset effect below),
  // exactly like sort/filter already were before this. ---
  const [colOrder, setColOrder] = useState<string[]>([]);
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [dragColKey, setDragColKey] = useState<string | null>(null);
  const [showColumnsPanel, setShowColumnsPanel] = useState(false);
  const [formatRules, setFormatRules] = useState<Record<string, ColumnFormat>>({});
  const [showTotals, setShowTotals] = useState(false);
  const [totalsSelection, setTotalsSelection] = useState<Record<string, StatKey>>({});
  const [density, setDensity] = useState<Density>("comfortable");

  const menuRef = useRef<HTMLDivElement | null>(null);
  const columnsPanelRef = useRef<HTMLDivElement | null>(null);
  const thRefs = useRef<Record<string, HTMLTableCellElement | null>>({});
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
          datasourceId, activeVersionId, pageSize, offset,
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
  // sort column, filter, column order/width, highlight rule or totals pick
  // from a previous table would not make sense here.
  useEffect(() => {
    setSortBy(null);
    setSortDir("asc");
    setFilters({});
    setDebouncedFilters({});
    setPageSize(DEFAULT_PAGE_SIZE);
    setOffset(0);
    setOpenFilterCol(null);
    setColOrder([]);
    setHiddenCols(new Set());
    setColWidths({});
    setFormatRules({});
    setShowTotals(false);
    setTotalsSelection({});
    setShowColumnsPanel(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId, activeVersionId, activeTable]);

  // Closes an open popover/panel on a click anywhere else on the page. A
  // click inside the panel itself never reaches here, because its own
  // trigger stops its mousedown from bubbling.
  useEffect(() => {
    if (!openFilterCol && !showColumnsPanel) return;
    const onClickOutside = (e: MouseEvent) => {
      if (openFilterCol && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenFilterCol(null);
      }
      if (showColumnsPanel && columnsPanelRef.current && !columnsPanelRef.current.contains(e.target as Node)) {
        setShowColumnsPanel(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [openFilterCol, showColumnsPanel]);

  const toggleColumnMenu = (col: string) => {
    setOpenFilterCol((c) => (c === col ? null : col));
  };

  const applySort = (col: string, dir: "asc" | "desc") => {
    setOffset(0);
    setSortBy(col);
    setSortDir(dir);
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

  const changePageSize = (v: number) => {
    setPageSize(v);
    setOffset(0);
  };

  const goToPage = (page: number, totalPages: number) => {
    const clamped = Math.max(1, Math.min(page, totalPages));
    setOffset((clamped - 1) * pageSize);
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

  // --- Column order / visibility / width helpers ---

  const orderedColumns = useMemo(() => {
    if (!preview) return [];
    const sameSet = colOrder.length === preview.columns.length && colOrder.every((c) => preview.columns.includes(c));
    return sameSet ? colOrder : preview.columns;
  }, [preview, colOrder]);

  const visibleColumns = useMemo(
    () => orderedColumns.filter((c) => !hiddenCols.has(c)),
    [orderedColumns, hiddenCols]
  );

  const reorderColumn = (from: string | null, to: string) => {
    if (!preview || !from || from === to) return;
    const base = colOrder.length === preview.columns.length ? colOrder : preview.columns;
    const next = base.filter((c) => c !== from);
    const idx = next.indexOf(to);
    next.splice(idx, 0, from);
    setColOrder(next);
  };

  const toggleColumnHidden = (col: string) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  const startResize = (e: React.MouseEvent, col: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = colWidths[col] || thRefs.current[col]?.getBoundingClientRect().width || 170;
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      setColWidths((w) => ({ ...w, [col]: Math.max(70, Math.round(startWidth + delta)) }));
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // --- Conditional formatting helpers ---

  const getColumnFormat = (col: string): ColumnFormat => formatRules[col] || DEFAULT_FORMAT;

  const setColumnFormatMode = (col: string, mode: FormatMode) => {
    setFormatRules((prev) => ({ ...prev, [col]: { ...getColumnFormat(col), mode } }));
  };

  const setColumnScaleColor = (col: string, scaleColor: ScaleColor) => {
    setFormatRules((prev) => ({ ...prev, [col]: { ...getColumnFormat(col), scaleColor } }));
  };

  const addFormatRule = (col: string) => {
    const fmt = getColumnFormat(col);
    if (fmt.rules.length >= 4) return;
    const rule: FormatRule = { id: `${Date.now()}-${Math.random()}`, op: "gt", value: "", color: fmt.scaleColor };
    setFormatRules((prev) => ({ ...prev, [col]: { ...fmt, mode: "rules", rules: [...fmt.rules, rule] } }));
  };

  const updateFormatRule = (col: string, ruleId: string, patch: Partial<FormatRule>) => {
    const fmt = getColumnFormat(col);
    setFormatRules((prev) => ({
      ...prev,
      [col]: { ...fmt, rules: fmt.rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r)) },
    }));
  };

  const removeFormatRule = (col: string, ruleId: string) => {
    const fmt = getColumnFormat(col);
    setFormatRules((prev) => ({ ...prev, [col]: { ...fmt, rules: fmt.rules.filter((r) => r.id !== ruleId) } }));
  };

  const cellBackground = (col: string, value: any): string | undefined => {
    const fmt = formatRules[col];
    if (!fmt || fmt.mode === "none") return undefined;
    if (fmt.mode === "scale") {
      const stat = preview?.column_stats[col];
      if (!stat || typeof stat.min !== "number" || typeof stat.max !== "number") return undefined;
      const num = Number(value);
      if (Number.isNaN(num)) return undefined;
      const range = stat.max - stat.min;
      const t = range > 0 ? clamp01((num - stat.min) / range) : 0.5;
      return scaleBackground(fmt.scaleColor, t);
    }
    for (const rule of fmt.rules) {
      if (ruleMatches(value, rule)) return ruleBackground(rule.color);
    }
    return undefined;
  };

  // --- Totals row helpers ---

  const statFor = (col: string): StatKey => totalsSelection[col] ?? defaultStat(preview?.column_stats[col]);

  if (loading && !preview) {
    return <div className="card h-full flex items-center justify-center text-muted p-10 text-center">Loading data...</div>;
  }

  if (error && !preview) {
    return <div className="card h-full flex items-center justify-center text-red-400 p-10 text-center">{error}</div>;
  }

  if (!preview) return null;

  const from = preview.total_rows === 0 ? 0 : offset + 1;
  const to = Math.min(offset + preview.limit, preview.total_rows);
  const totalPages = Math.max(1, Math.ceil(preview.total_rows / preview.limit));
  const currentPage = Math.floor(offset / preview.limit) + 1;
  const pageList = buildPageList(currentPage, totalPages);
  const rowPad = density === "compact" ? "py-1" : "py-1.5";
  const rowNumWidth = 46;
  const activeFilterCount = Object.values(debouncedFilters).filter((v) => !!v).length;

  // The table's own real total width - every column's explicit width, row
  // number column included. Handed to the <table> itself (not just its
  // <colgroup>) because table-layout:fixed only fixes each column's SHARE
  // of the table's width, not the table's own overall width: left unset,
  // the browser still stretches the whole table (and every column
  // proportionally beyond what was actually asked for) to fill the scroll
  // container, which is exactly what made a freshly resized column keep
  // drifting back to some other width. Setting this explicitly is what
  // makes "drag this column to 250px" actually mean 250px, and it's also
  // what makes the table scroll horizontally once real content genuinely
  // needs more room than the panel has.
  const totalTableWidth =
    rowNumWidth + visibleColumns.reduce((sum, c) => sum + (colWidths[c] || 170), 0);

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

      {/* The table's own toolbar - column visibility, per-column totals,
          row density, active-filter summary, and page size. Everything
          here is a per-viewer preference (never sent to the server, never
          affects anyone else looking at the same table), reset fresh
          whenever a different table is opened - see the reset effect
          above. */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              className="btn-secondary text-xs px-2.5 py-1.5 flex items-center gap-1.5"
              onClick={(e) => { e.stopPropagation(); setShowColumnsPanel((v) => !v); }}
              title="Show or hide columns"
            >
              <span aria-hidden>&#8862;</span> Columns
              {hiddenCols.size > 0 && <span className="text-accent">({visibleColumns.length}/{preview.columns.length})</span>}
            </button>
            {showColumnsPanel && (
              <div
                ref={columnsPanelRef}
                className="absolute z-30 top-full left-0 mt-1 w-56 card p-2 shadow-xl max-h-72 overflow-y-auto"
              >
                <div className="flex items-center justify-between px-1 pb-1.5 mb-1 border-b border-border">
                  <span className="text-[10px] uppercase tracking-wide text-muted">Columns</span>
                  {hiddenCols.size > 0 && (
                    <button className="text-[11px] text-accent underline" onClick={() => setHiddenCols(new Set())}>
                      Show all
                    </button>
                  )}
                </div>
                {orderedColumns.map((col) => (
                  <label key={col} className="flex items-center gap-2 px-1 py-1 text-xs rounded hover:bg-surface2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!hiddenCols.has(col)}
                      onChange={() => toggleColumnHidden(col)}
                      className="accent-primary"
                    />
                    <span className="truncate">{col}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <button
            className={`text-xs px-2.5 py-1.5 rounded-lg font-medium transition flex items-center gap-1.5 ${
              showTotals ? "bg-primary text-white" : "btn-secondary"
            }`}
            onClick={() => setShowTotals((v) => !v)}
            title="Show a totals row with a per-column sum/average/count"
          >
            <span aria-hidden>&Sigma;</span> Totals
          </button>

          <div className="flex items-center gap-0.5 bg-surface2 border border-border rounded-lg p-0.5">
            <button
              className={`text-xs px-2.5 py-1 rounded-md font-medium transition ${
                density === "comfortable" ? "bg-primary text-white" : "text-muted hover:text-text"
              }`}
              onClick={() => setDensity("comfortable")}
              title="Comfortable row spacing"
            >
              Comfortable
            </button>
            <button
              className={`text-xs px-2.5 py-1 rounded-md font-medium transition ${
                density === "compact" ? "bg-primary text-white" : "text-muted hover:text-text"
              }`}
              onClick={() => setDensity("compact")}
              title="Compact row spacing"
            >
              Compact
            </button>
          </div>

          {activeFilterCount > 0 && (
            <button
              className="text-xs px-2.5 py-1.5 rounded-lg bg-accent/10 text-accent border border-accent/30 flex items-center gap-1.5"
              onClick={clearAllFilters}
              title="Clear all column filters"
            >
              {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"} active &middot; Clear
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-muted">
          <span>Rows per page:</span>
          <div className="flex gap-1">
            {PAGE_SIZE_OPTIONS.map((size) => (
              <button
                key={size}
                className={`text-xs px-2.5 py-1 rounded-lg transition ${
                  pageSize === size ? "bg-primary text-white" : "btn-secondary"
                }`}
                onClick={() => changePageSize(size)}
              >
                {size}
              </button>
            ))}
          </div>
        </div>
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

      <div className="flex-1 overflow-auto dt-scroll">
        {preview.rows.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted text-sm p-10 text-center">
            {hasActiveFilters ? "No rows match your column filters." : "No rows to show."}
          </div>
        ) : (
          <table
            className="text-xs"
            style={{ tableLayout: "fixed", width: totalTableWidth, borderCollapse: "separate", borderSpacing: 0 }}
          >
            <colgroup>
              <col style={{ width: rowNumWidth }} />
              {visibleColumns.map((col) => (
                <col key={col} style={{ width: colWidths[col] || 170 }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 bg-surface2 z-10">
              <tr>
                <th className="sticky left-0 z-20 bg-surface2 text-right px-2 py-2 font-semibold border-b border-r border-border text-muted">
                  #
                </th>
                {visibleColumns.map((col) => (
                  <th
                    key={col}
                    ref={(el) => { thRefs.current[col] = el; }}
                    draggable
                    onDragStart={() => setDragColKey(col)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); reorderColumn(dragColKey, col); setDragColKey(null); }}
                    onDragEnd={() => setDragColKey(null)}
                    className={`relative text-left px-3 py-2 font-semibold border-b border-border whitespace-nowrap overflow-hidden ${
                      dragColKey === col ? "opacity-50" : ""
                    }`}
                    title="Drag to reorder • click to sort/filter"
                  >
                    <div
                      className="flex items-center gap-1.5 cursor-pointer select-none hover:text-primary transition overflow-hidden"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => toggleColumnMenu(col)}
                    >
                      <span className="text-muted/50 shrink-0 cursor-grab" aria-hidden>&#8942;&#8942;</span>
                      <ColumnTypeIcon dtype={preview.dtypes[col]} />
                      <span className="truncate">
                        {col}
                        {sortBy === col && <span className="ml-1 text-primary">{sortDir === "asc" ? "▲" : "▼"}</span>}
                        {formatRules[col] && formatRules[col].mode !== "none" && (
                          <span className="ml-1" title="Conditional formatting on" aria-hidden>&#9679;</span>
                        )}
                      </span>
                      <span className="ml-auto shrink-0">
                        <FilterIcon active={sortBy === col || !!filters[col]} />
                      </span>
                    </div>

                    {openFilterCol === col && (
                      <div
                        ref={menuRef}
                        className="absolute z-20 top-full left-0 mt-1 w-72 card p-2 space-y-1 shadow-xl font-normal normal-case"
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
                        <div className="border-t border-border my-1" />
                        <div className="px-2 pb-1">
                          <label className="text-[10px] uppercase tracking-wide text-muted block mb-1.5">
                            Highlight this column
                          </label>
                          <div className="flex gap-1 mb-2">
                            {(["none", "scale", "rules"] as FormatMode[]).map((mode) => (
                              <button
                                key={mode}
                                className={`text-[11px] px-2 py-1 rounded-md flex-1 transition ${
                                  getColumnFormat(col).mode === mode ? "bg-primary text-white" : "bg-surface2 text-muted hover:text-text"
                                }`}
                                onClick={() => setColumnFormatMode(col, mode)}
                              >
                                {mode === "none" ? "Off" : mode === "scale" ? "Color scale" : "Rules"}
                              </button>
                            ))}
                          </div>
                          {getColumnFormat(col).mode === "scale" && (
                            <div>
                              <div className="flex gap-1.5 mb-1">
                                {(Object.keys(SWATCH_CLASS) as ScaleColor[]).map((c) => (
                                  <button
                                    key={c}
                                    className={`w-5 h-5 rounded-full ${SWATCH_CLASS[c]} ${
                                      getColumnFormat(col).scaleColor === c ? "ring-2 ring-offset-1 ring-primary" : ""
                                    }`}
                                    onClick={() => setColumnScaleColor(col, c)}
                                    title={c}
                                  />
                                ))}
                              </div>
                              {preview.column_stats[col]?.min === null && (
                                <div className="text-[10px] text-muted">Only works on a numeric column.</div>
                              )}
                            </div>
                          )}
                          {getColumnFormat(col).mode === "rules" && (
                            <div className="space-y-1.5">
                              {getColumnFormat(col).rules.map((rule) => (
                                <div key={rule.id} className="flex items-center gap-1">
                                  <select
                                    className="input text-[11px] py-1 px-1 flex-1"
                                    value={rule.op}
                                    onChange={(e) => updateFormatRule(col, rule.id, { op: e.target.value as RuleOp })}
                                  >
                                    {(Object.keys(OP_LABELS) as RuleOp[]).map((op) => (
                                      <option key={op} value={op}>{OP_LABELS[op]}</option>
                                    ))}
                                  </select>
                                  <input
                                    className="input text-[11px] py-1 px-1.5 w-16"
                                    value={rule.value}
                                    onChange={(e) => updateFormatRule(col, rule.id, { value: e.target.value })}
                                    placeholder="value"
                                  />
                                  <button
                                    className={`w-4 h-4 rounded-full shrink-0 ${SWATCH_CLASS[rule.color]}`}
                                    onClick={() => {
                                      const colors = Object.keys(SWATCH_CLASS) as ScaleColor[];
                                      const next = colors[(colors.indexOf(rule.color) + 1) % colors.length];
                                      updateFormatRule(col, rule.id, { color: next });
                                    }}
                                    title="Click to change color"
                                  />
                                  <button
                                    className="text-muted hover:text-red-400 px-0.5"
                                    onClick={() => removeFormatRule(col, rule.id)}
                                    title="Remove rule"
                                  >
                                    &times;
                                  </button>
                                </div>
                              ))}
                              {getColumnFormat(col).rules.length < 4 && (
                                <button className="text-[11px] text-accent underline" onClick={() => addFormatRule(col)}>
                                  + Add rule
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div
                      className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/40"
                      onMouseDown={(e) => startResize(e, col)}
                      onClick={(e) => e.stopPropagation()}
                      title="Drag to resize"
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, i) => (
                <tr key={i} className="hover:bg-surface2/60 border-b border-border/50 even:bg-surface2/20">
                  <td className="sticky left-0 bg-inherit text-right px-2 text-muted border-r border-border/50 tabular-nums">
                    {offset + i + 1}
                  </td>
                  {visibleColumns.map((col) => {
                    const value = row[col];
                    const bg = cellBackground(col, value);
                    return (
                      <td
                        key={col}
                        className={`px-3 ${rowPad} overflow-hidden text-ellipsis whitespace-nowrap`}
                        style={bg ? { backgroundColor: bg } : undefined}
                        title={value === null || value === undefined ? "" : String(value)}
                      >
                        {value === null || value === undefined || value === "" ? (
                          <span className="text-muted">&mdash;</span>
                        ) : (
                          String(value)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            {showTotals && (
              <tfoot className="sticky bottom-0 bg-surface2 z-10 border-t-2 border-border">
                <tr>
                  <td className="sticky left-0 bg-surface2 px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted border-r border-border">
                    &Sigma;
                  </td>
                  {visibleColumns.map((col) => {
                    const stat = preview.column_stats[col];
                    const key = statFor(col);
                    return (
                      <td key={col} className="px-2 py-1 border-l border-border/40">
                        <div className="flex items-center gap-1">
                          <select
                            className="bg-transparent text-[10px] text-muted border-none outline-none cursor-pointer"
                            value={key}
                            onChange={(e) => setTotalsSelection((prev) => ({ ...prev, [col]: e.target.value as StatKey }))}
                          >
                            {availableStats(stat).map((k) => (
                              <option key={k} value={k}>{STAT_LABELS[k]}</option>
                            ))}
                          </select>
                        </div>
                        {key !== "none" && (
                          <div className="text-xs font-semibold text-text truncate" title={formatStatValue(key, stat)}>
                            {formatStatValue(key, stat)}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>

      {preview.stats_capped && showTotals && (
        <div className="px-3 pt-1 text-[10px] text-amber-400 shrink-0">
          Totals are based on a large sample of this table, not necessarily every row.
        </div>
      )}

      <div className="p-3 border-t border-border flex items-center justify-between gap-3 flex-wrap shrink-0 text-xs text-muted">
        <div>
          {from}-{to} of {preview.total_rows.toLocaleString()}{preview.stats_capped ? "+" : ""} rows
          {hasActiveFilters && <span className="ml-1 text-accent">(filtered)</span>}
        </div>
        <div className="flex items-center gap-1">
          <button
            className="btn-secondary text-xs px-2.5 py-1 disabled:opacity-40"
            disabled={currentPage <= 1 || loading}
            onClick={() => goToPage(currentPage - 1, totalPages)}
          >
            &#8249; Prev
          </button>
          {pageList.map((p, idx) =>
            p === "…" ? (
              <span key={`e${idx}`} className="px-1.5 text-muted">&hellip;</span>
            ) : (
              <button
                key={p}
                className={`text-xs w-7 h-7 rounded-lg transition ${
                  p === currentPage ? "bg-primary text-white" : "btn-secondary"
                }`}
                disabled={loading}
                onClick={() => goToPage(p, totalPages)}
              >
                {p}
              </button>
            )
          )}
          <button
            className="btn-secondary text-xs px-2.5 py-1 disabled:opacity-40"
            disabled={currentPage >= totalPages || loading}
            onClick={() => goToPage(currentPage + 1, totalPages)}
          >
            Next &#8250;
          </button>
        </div>
      </div>
    </div>
  );
}
