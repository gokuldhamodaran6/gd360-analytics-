import { useEffect, useMemo, useRef, useState } from "react";
import { datasourceApi, DataPreview, DatasetVersion, ColumnStat, ColumnDistinctValues } from "../api/client";

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

// --- Excel-style column filters -------------------------------------------
//
// Every column's filter panel now has two tabs, exactly the way Excel's and
// Google Sheets' own column filter dropdowns do: "Values" (a searchable
// checkbox list of the column's actual distinct values, fetched on demand -
// see backend get_column_distinct_values) and "Condition" (a type-aware
// operator: text contains/equals/etc, a number comparison, a date range, or
// a true/false toggle - whichever fits the column's dtype). Both tabs write
// into the same `filters` map the backend already understood as JSON;
// _apply_column_filter on the backend is what actually reads this shape.
type TextOp = "contains" | "not_contains" | "equals" | "not_equals" | "starts_with" | "ends_with" | "is_empty" | "is_not_empty";
type NumberOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between";
type ColumnFilterSpec =
  | { type: "values"; include: (string | number | boolean | null)[] }
  | { type: "text"; op: TextOp; value: string }
  | { type: "number"; op: NumberOp; value: string; value2?: string }
  | { type: "date"; from: string | null; to: string | null }
  | { type: "boolean"; value: "true" | "false" };

const TEXT_OP_LABELS: Record<TextOp, string> = {
  contains: "contains", not_contains: "does not contain", equals: "is exactly",
  not_equals: "is not", starts_with: "starts with", ends_with: "ends with",
  is_empty: "is blank", is_not_empty: "is not blank",
};
const NUMBER_OP_LABELS: Record<NumberOp, string> = {
  eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", between: "is between",
};

// A stand-in key for "(Blanks)" in the values checklist - real column
// values are stringified for the checkbox `checked` lookup, and no real
// value can ever collide with this one.
const NULL_KEY = "\u0000__NULL__";

function dtypeGroup(dtype: string): "number" | "date" | "boolean" | "text" {
  const d = (dtype || "").toLowerCase();
  if (d.startsWith("bool")) return "boolean";
  if (d.startsWith("int") || d.startsWith("float") || d.startsWith("uint") || d.startsWith("double")) return "number";
  if (d.startsWith("datetime") || d.startsWith("date")) return "date";
  return "text";
}

function defaultConditionForGroup(group: "number" | "date" | "boolean" | "text"): ColumnFilterSpec {
  if (group === "number") return { type: "number", op: "eq", value: "" };
  if (group === "date") return { type: "date", from: null, to: null };
  if (group === "boolean") return { type: "boolean", value: "true" };
  return { type: "text", op: "contains", value: "" };
}

function isConditionActive(d: ColumnFilterSpec): boolean {
  if (d.type === "text") return d.op === "is_empty" || d.op === "is_not_empty" || !!d.value;
  if (d.type === "number") return d.op === "between" ? !!(d.value && d.value2) : !!d.value;
  if (d.type === "date") return !!d.from || !!d.to;
  if (d.type === "boolean") return d.value === "true" || d.value === "false";
  return false;
}

function isFilterActive(spec: ColumnFilterSpec | undefined): boolean {
  if (!spec) return false;
  if (spec.type === "values") return (spec.include || []).length > 0;
  return isConditionActive(spec);
}

function describeFilter(spec: ColumnFilterSpec, label: string): string {
  if (spec.type === "values") {
    const n = (spec.include || []).length;
    return `${label}: ${n} value${n === 1 ? "" : "s"} selected`;
  }
  if (spec.type === "text") {
    const opLabel = TEXT_OP_LABELS[spec.op];
    return spec.op === "is_empty" || spec.op === "is_not_empty" ? `${label} ${opLabel}` : `${label} ${opLabel} "${spec.value}"`;
  }
  if (spec.type === "number") {
    if (spec.op === "between") return `${label} between ${spec.value} and ${spec.value2}`;
    return `${label} ${NUMBER_OP_LABELS[spec.op]} ${spec.value}`;
  }
  if (spec.type === "date") {
    if (spec.from && spec.to) return `${label}: ${spec.from} → ${spec.to}`;
    if (spec.from) return `${label} on/after ${spec.from}`;
    if (spec.to) return `${label} on/before ${spec.to}`;
    return label;
  }
  return `${label} is ${spec.value}`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const DATE_PRESETS: { label: string; range: () => { from: string; to: string } }[] = [
  { label: "Today", range: () => { const t = isoDate(new Date()); return { from: t, to: t }; } },
  {
    label: "Last 7 days",
    range: () => {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 6);
      return { from: isoDate(from), to: isoDate(to) };
    },
  },
  {
    label: "This month",
    range: () => {
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { from: isoDate(from), to: isoDate(to) };
    },
  },
  {
    label: "This year",
    range: () => {
      const now = new Date();
      return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
    },
  },
];

// --- Type-aware display formatting (Format... in the reference menu) -----
// Purely a rendering transform - never touches the underlying value, the
// filter/sort/total math, or what gets exported, so it is always safe to
// flip on and off.
type NumberDisplayMode = "automatic" | "number" | "currency" | "percent" | "date";
type DateStyle = "iso" | "us" | "long";
type NumberDisplayFormat = { mode: NumberDisplayMode; decimals: number; currency: string; dateStyle: DateStyle };
const DEFAULT_DISPLAY_FORMAT: NumberDisplayFormat = { mode: "automatic", decimals: 2, currency: "USD", dateStyle: "iso" };
const FORMAT_MODE_LABELS: Record<NumberDisplayMode, string> = {
  automatic: "Automatic", number: "Number", currency: "Currency", percent: "Percent", date: "Date",
};
const CURRENCY_OPTIONS = ["USD", "EUR", "GBP", "INR", "JPY", "CAD"];

function formatCellValue(raw: any, fmt: NumberDisplayFormat | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (!fmt || fmt.mode === "automatic") return null; // caller falls back to the plain String(raw) it always used.
  const num = Number(raw);
  if (fmt.mode === "number") {
    return Number.isNaN(num) ? String(raw) : num.toLocaleString(undefined, { minimumFractionDigits: fmt.decimals, maximumFractionDigits: fmt.decimals });
  }
  if (fmt.mode === "currency") {
    return Number.isNaN(num)
      ? String(raw)
      : num.toLocaleString(undefined, { style: "currency", currency: fmt.currency, minimumFractionDigits: fmt.decimals, maximumFractionDigits: fmt.decimals });
  }
  if (fmt.mode === "percent") {
    return Number.isNaN(num) ? String(raw) : num.toLocaleString(undefined, { style: "percent", minimumFractionDigits: fmt.decimals, maximumFractionDigits: fmt.decimals });
  }
  if (fmt.mode === "date") {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return String(raw);
    if (fmt.dateStyle === "us") return d.toLocaleDateString("en-US");
    if (fmt.dateStyle === "long") return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    return isoDate(d);
  }
  return null;
}

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
  const group = dtypeGroup(dtype);
  const label = group === "boolean" ? "✓︎" : group === "number" ? "#" : group === "date" ? "\u{1F4C5}" : "Abc";
  const cls = group === "boolean" ? "text-emerald-400" : group === "number" ? "text-sky-400" : group === "date" ? "text-amber-400" : "text-muted";
  return (
    <span className={`text-[10px] font-semibold shrink-0 ${cls}`} title={dtype} aria-hidden>
      {label}
    </span>
  );
}

// A small pin glyph shown next to a pinned column's name.
function PinIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" className="text-primary shrink-0" fill="currentColor" aria-hidden>
      <path d="M9.5 1.5 14.5 6.5 12 9l-1 4-1.5-1.5L6 15l-1-1 3.5-3.5L7 9 4.5 11 3 9.5l4.5-4.5L9.5 1.5z" />
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
  const [filters, setFilters] = useState<Record<string, ColumnFilterSpec>>({});
  const [debouncedFilters, setDebouncedFilters] = useState<Record<string, ColumnFilterSpec>>({});
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

  // --- Excel-parity additions: rename, wrap text, pin, and type-aware
  // display format - all per-viewer/per-table, same reset lifecycle. ---
  const [colLabels, setColLabels] = useState<Record<string, string>>({});
  const [renamingColKey, setRenamingColKey] = useState<string | null>(null);
  const [colRenameDraft, setColRenameDraft] = useState("");
  const [wrapCols, setWrapCols] = useState<Set<string>>(new Set());
  const [pinnedCols, setPinnedCols] = useState<string[]>([]);
  const [numberFormats, setNumberFormats] = useState<Record<string, NumberDisplayFormat>>({});

  // --- Excel-style filter panel: values-checklist vs. condition tab,
  // scoped to whichever one column's panel is currently open (only one
  // can be open at a time - see toggleColumnMenu, which seeds all of
  // these fresh every time a different column's menu opens). ---
  const [filterTab, setFilterTab] = useState<"values" | "condition">("values");
  const [conditionDraft, setConditionDraft] = useState<ColumnFilterSpec>({ type: "text", op: "contains", value: "" });
  const [selectedValueKeys, setSelectedValueKeys] = useState<Set<string>>(new Set());
  const [valuesQuery, setValuesQuery] = useState("");
  const [valuesResult, setValuesResult] = useState<ColumnDistinctValues | null>(null);
  const [valuesLoading, setValuesLoading] = useState(false);
  const [formatSectionOpen, setFormatSectionOpen] = useState(false);
  const [highlightSectionOpen, setHighlightSectionOpen] = useState(false);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const columnsPanelRef = useRef<HTMLDivElement | null>(null);
  const thRefs = useRef<Record<string, HTMLTableCellElement | null>>({});
  const hasActiveFilters = Object.keys(debouncedFilters).length > 0;

  // Typing into a filter box should not fire a request on every keystroke -
  // wait for a short pause before actually re-querying the server. Kept as
  // a safety buffer even though the new Values/Condition panel now commits
  // through an explicit Apply click rather than live typing.
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
  // sort column, filter, column order/width, rename, pin, format, highlight
  // rule or totals pick from a previous table would not make sense here.
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
    setColLabels({});
    setRenamingColKey(null);
    setWrapCols(new Set());
    setPinnedCols([]);
    setNumberFormats({});
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

  // Lazily fetches this column's real distinct values (with counts) the
  // moment its filter panel is open AND the Values tab is showing - never
  // eagerly for every column, matching the backend endpoint's own design
  // (see get_column_distinct_values). Re-fetches, debounced, as the
  // search-within-values box changes.
  useEffect(() => {
    if (!openFilterCol || filterTab !== "values" || !preview) return;
    let cancelled = false;
    setValuesLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await datasourceApi.getColumnDistinctValues(
          datasourceId, openFilterCol, activeVersionId,
          { table: activeVersionId ? null : activeTable, search: valuesQuery || undefined, limit: 200 }
        );
        if (!cancelled) setValuesResult(res);
      } catch {
        if (!cancelled) setValuesResult(null);
      } finally {
        if (!cancelled) setValuesLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [openFilterCol, filterTab, valuesQuery, datasourceId, activeVersionId, activeTable, preview]);

  const displayLabel = (col: string) => colLabels[col] || col;

  const toggleColumnMenu = (col: string) => {
    setOpenFilterCol((c) => {
      const next = c === col ? null : col;
      if (next) {
        const existing = filters[col];
        const group = dtypeGroup(preview?.dtypes[col] || "");
        if (existing && existing.type === "values") {
          setSelectedValueKeys(new Set((existing.include || []).map((v) => (v === null ? NULL_KEY : String(v)))));
          setFilterTab("values");
          setConditionDraft(defaultConditionForGroup(group));
        } else if (existing) {
          setSelectedValueKeys(new Set());
          setConditionDraft(existing);
          setFilterTab("condition");
        } else {
          setSelectedValueKeys(new Set());
          setConditionDraft(defaultConditionForGroup(group));
          setFilterTab("values");
        }
        setValuesQuery("");
        setValuesResult(null);
        setFormatSectionOpen(false);
        setHighlightSectionOpen(false);
        setRenamingColKey(null);
      }
      return next;
    });
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

  const toggleValueKey = (key: string) => {
    setSelectedValueKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const selectAllLoadedValues = () => {
    const keys = (valuesResult?.values || []).map((v) => (v.value === null ? NULL_KEY : String(v.value)));
    if (valuesResult && valuesResult.null_count > 0 && !valuesQuery) keys.push(NULL_KEY);
    setSelectedValueKeys(new Set(keys));
  };

  const clearSelectedValues = () => setSelectedValueKeys(new Set());

  const applyFilter = (col: string) => {
    if (filterTab === "values") {
      const values = valuesResult?.values || [];
      const include: (string | number | boolean | null)[] = [];
      if (selectedValueKeys.has(NULL_KEY)) include.push(null);
      for (const v of values) {
        const key = v.value === null ? NULL_KEY : String(v.value);
        if (key !== NULL_KEY && selectedValueKeys.has(key)) include.push(v.value);
      }
      if (include.length === 0) clearColumnFilter(col);
      else {
        setOffset(0);
        setFilters((f) => ({ ...f, [col]: { type: "values", include } }));
      }
    } else {
      if (!isConditionActive(conditionDraft)) clearColumnFilter(col);
      else {
        setOffset(0);
        setFilters((f) => ({ ...f, [col]: conditionDraft }));
      }
    }
    setOpenFilterCol(null);
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

  // --- Column order / visibility / width / rename / wrap / pin helpers ---

  const orderedColumns = useMemo(() => {
    if (!preview) return [];
    const sameSet = colOrder.length === preview.columns.length && colOrder.every((c) => preview.columns.includes(c));
    return sameSet ? colOrder : preview.columns;
  }, [preview, colOrder]);

  const visibleColumns = useMemo(
    () => orderedColumns.filter((c) => !hiddenCols.has(c)),
    [orderedColumns, hiddenCols]
  );

  // Pinned columns always render first (right after the row-number column),
  // in the order they were pinned - the same "frozen columns slide to the
  // edge" behavior Excel/Sheets use, rather than pinning in place wherever
  // they happened to be in colOrder.
  const pinnedVisible = useMemo(() => pinnedCols.filter((c) => visibleColumns.includes(c)), [pinnedCols, visibleColumns]);
  const renderColumns = useMemo(
    () => [...pinnedVisible, ...visibleColumns.filter((c) => !pinnedCols.includes(c))],
    [pinnedVisible, visibleColumns, pinnedCols]
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

  const commitColumnRename = (col: string) => {
    const name = colRenameDraft.trim();
    setRenamingColKey(null);
    setColLabels((prev) => {
      if (!name || name === col) {
        if (!(col in prev)) return prev;
        const next = { ...prev };
        delete next[col];
        return next;
      }
      return { ...prev, [col]: name };
    });
  };

  const copyColumnName = async (col: string) => {
    try {
      await navigator.clipboard.writeText(displayLabel(col));
    } catch {
      // Clipboard permission denied or unavailable - nothing to recover,
      // silently ignore rather than show an alarming error for a
      // convenience action.
    }
  };

  const toggleWrap = (col: string) => {
    setWrapCols((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  const togglePin = (col: string) => {
    setPinnedCols((prev) => (prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]));
    setOpenFilterCol(null);
  };

  const getNumberFormat = (col: string): NumberDisplayFormat => numberFormats[col] || DEFAULT_DISPLAY_FORMAT;
  const setNumberFormatPatch = (col: string, patch: Partial<NumberDisplayFormat>) => {
    setNumberFormats((prev) => ({ ...prev, [col]: { ...getNumberFormat(col), ...patch } }));
  };

  const addTotalForColumn = (col: string) => {
    setShowTotals(true);
    setTotalsSelection((prev) => ({ ...prev, [col]: defaultStat(preview?.column_stats[col]) }));
    setOpenFilterCol(null);
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
  const activeFilterEntries = Object.entries(filters);

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

  // Left offsets for every pinned column, in their render order - what
  // makes "Pin column" actually freeze them in place while the rest of the
  // table scrolls underneath, the same way Excel's freeze panes work.
  const pinnedLeftOffset: Record<string, number> = {};
  {
    let cum = rowNumWidth;
    for (const c of pinnedVisible) {
      pinnedLeftOffset[c] = cum;
      cum += colWidths[c] || 170;
    }
  }
  const lastPinnedCol = pinnedVisible.length > 0 ? pinnedVisible[pinnedVisible.length - 1] : null;

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
          row density, and page size. Everything here is a per-viewer
          preference (never sent to the server, never affects anyone else
          looking at the same table), reset fresh whenever a different
          table is opened - see the reset effect above. */}
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
                    <span className="truncate">{displayLabel(col)}</span>
                    {pinnedCols.includes(col) && <PinIcon />}
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

      {/* Active-filters chip bar - every column filter currently applied,
          in plain language, each removable on its own, plus "Clear all".
          Shown whenever at least one filter (of any kind: values checklist
          or a type-aware condition) is set. */}
      {activeFilterEntries.length > 0 && (
        <div className="px-3 py-2 border-b border-border flex items-center gap-1.5 flex-wrap shrink-0">
          <span className="text-[10px] uppercase tracking-wide text-muted mr-0.5">Filters:</span>
          {activeFilterEntries.map(([col, spec]) => (
            <span
              key={col}
              className="text-[11px] pl-2.5 pr-1.5 py-1 rounded-full bg-accent/10 text-accent border border-accent/30 flex items-center gap-1.5"
            >
              {describeFilter(spec, displayLabel(col))}
              <button className="hover:text-red-400 leading-none" onClick={() => clearColumnFilter(col)} title="Remove this filter">
                &times;
              </button>
            </span>
          ))}
          <button className="text-[11px] text-muted underline ml-1" onClick={clearAllFilters}>
            Clear all
          </button>
        </div>
      )}

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
              {renderColumns.map((col) => (
                <col key={col} style={{ width: colWidths[col] || 170 }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 bg-surface2 z-10">
              <tr>
                <th className="sticky left-0 z-20 bg-surface2 text-right px-2 py-2 font-semibold border-b border-r border-border text-muted">
                  #
                </th>
                {renderColumns.map((col) => {
                  const pinned = pinnedVisible.includes(col);
                  const isLastPinned = pinned && col === lastPinnedCol;
                  return (
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
                      } ${pinned ? "bg-surface2" : ""} ${isLastPinned ? "border-r-2 border-r-primary/40" : ""}`}
                      style={pinned ? { position: "sticky", left: pinnedLeftOffset[col], zIndex: 15 } : undefined}
                      title="Drag to reorder • click to sort/filter"
                    >
                      <div
                        className="flex items-center gap-1.5 cursor-pointer select-none hover:text-primary transition overflow-hidden"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => toggleColumnMenu(col)}
                      >
                        <span className="text-muted/50 shrink-0 cursor-grab" aria-hidden>&#8942;&#8942;</span>
                        <ColumnTypeIcon dtype={preview.dtypes[col]} />
                        {pinned && <PinIcon />}
                        <span className="truncate">
                          {displayLabel(col)}
                          {sortBy === col && <span className="ml-1 text-primary">{sortDir === "asc" ? "▲" : "▼"}</span>}
                          {formatRules[col] && formatRules[col].mode !== "none" && (
                            <span className="ml-1" title="Conditional formatting on" aria-hidden>&#9679;</span>
                          )}
                        </span>
                        <span className="ml-auto shrink-0">
                          <FilterIcon active={sortBy === col || isFilterActive(filters[col])} />
                        </span>
                      </div>

                      {openFilterCol === col && (
                        <div
                          ref={menuRef}
                          className="absolute z-20 top-full left-0 mt-1 w-80 card p-2 space-y-1 shadow-xl font-normal normal-case max-h-[32rem] overflow-y-auto"
                        >
                          {/* Rename / copy name */}
                          {renamingColKey === col ? (
                            <div className="px-2 pb-1.5 flex items-center gap-1">
                              <input
                                autoFocus
                                className="input text-xs py-1 px-2 flex-1"
                                value={colRenameDraft}
                                onChange={(e) => setColRenameDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") commitColumnRename(col);
                                  if (e.key === "Escape") setRenamingColKey(null);
                                }}
                              />
                              <button className="text-[11px] text-primary font-medium px-1" onClick={() => commitColumnRename(col)}>
                                Save
                              </button>
                            </div>
                          ) : (
                            <button
                              className="w-full text-left text-xs px-2 py-1.5 rounded-lg hover:bg-surface2"
                              onClick={() => { setRenamingColKey(col); setColRenameDraft(displayLabel(col)); }}
                            >
                              Rename column&hellip;
                            </button>
                          )}
                          <button
                            className="w-full text-left text-xs px-2 py-1.5 rounded-lg hover:bg-surface2"
                            onClick={() => copyColumnName(col)}
                          >
                            Copy column name
                          </button>

                          <div className="border-t border-border my-1" />
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
                            <label className="text-[10px] uppercase tracking-wide text-muted block mb-1.5">Filter</label>
                            <div className="flex gap-1 mb-1.5">
                              <button
                                className={`text-[11px] px-2 py-1 rounded-md flex-1 transition ${
                                  filterTab === "values" ? "bg-primary text-white" : "bg-surface2 text-muted hover:text-text"
                                }`}
                                onClick={() => setFilterTab("values")}
                              >
                                Values
                              </button>
                              <button
                                className={`text-[11px] px-2 py-1 rounded-md flex-1 transition ${
                                  filterTab === "condition" ? "bg-primary text-white" : "bg-surface2 text-muted hover:text-text"
                                }`}
                                onClick={() => setFilterTab("condition")}
                              >
                                Condition
                              </button>
                            </div>

                            {filterTab === "values" && (
                              <div className="space-y-1.5">
                                <input
                                  className="input text-xs py-1 px-2"
                                  placeholder={`Search ${displayLabel(col)} values...`}
                                  value={valuesQuery}
                                  onChange={(e) => setValuesQuery(e.target.value)}
                                />
                                <div className="flex items-center justify-between text-[11px] text-muted">
                                  <button className="underline" onClick={selectAllLoadedValues}>Select all</button>
                                  <button className="underline" onClick={clearSelectedValues}>Clear</button>
                                </div>
                                <div className="max-h-40 overflow-y-auto border border-border rounded-lg divide-y divide-border/50">
                                  {valuesLoading && <div className="px-2 py-2 text-[11px] text-muted">Loading values...</div>}
                                  {!valuesLoading && valuesResult && !valuesQuery && valuesResult.null_count > 0 && (
                                    <label className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-surface2 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        className="accent-primary"
                                        checked={selectedValueKeys.has(NULL_KEY)}
                                        onChange={() => toggleValueKey(NULL_KEY)}
                                      />
                                      <span className="italic text-muted flex-1">(Blanks)</span>
                                      <span className="text-[10px] text-muted">{valuesResult.null_count.toLocaleString()}</span>
                                    </label>
                                  )}
                                  {!valuesLoading && valuesResult && valuesResult.values.map((v) => {
                                    const key = v.value === null ? NULL_KEY : String(v.value);
                                    return (
                                      <label key={key} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-surface2 cursor-pointer">
                                        <input
                                          type="checkbox"
                                          className="accent-primary"
                                          checked={selectedValueKeys.has(key)}
                                          onChange={() => toggleValueKey(key)}
                                        />
                                        <span className="truncate flex-1">
                                          {v.value === null || v.value === "" ? <span className="italic text-muted">(empty)</span> : String(v.value)}
                                        </span>
                                        <span className="text-[10px] text-muted">{v.count.toLocaleString()}</span>
                                      </label>
                                    );
                                  })}
                                  {!valuesLoading && valuesResult && valuesResult.values.length === 0 && (
                                    <div className="px-2 py-2 text-[11px] text-muted">No matching values.</div>
                                  )}
                                </div>
                                {valuesResult?.truncated && (
                                  <div className="text-[10px] text-amber-400">
                                    Showing the top {valuesResult.values.length.toLocaleString()} of {valuesResult.distinct_total.toLocaleString()} values — search to narrow down.
                                  </div>
                                )}
                              </div>
                            )}

                            {filterTab === "condition" && (
                              <div className="space-y-1.5">
                                {conditionDraft.type === "text" && (
                                  <>
                                    <select
                                      className="input text-xs py-1 px-2"
                                      value={conditionDraft.op}
                                      onChange={(e) => setConditionDraft({ ...conditionDraft, op: e.target.value as TextOp })}
                                    >
                                      {(Object.keys(TEXT_OP_LABELS) as TextOp[]).map((op) => (
                                        <option key={op} value={op}>{TEXT_OP_LABELS[op]}</option>
                                      ))}
                                    </select>
                                    {conditionDraft.op !== "is_empty" && conditionDraft.op !== "is_not_empty" && (
                                      <input
                                        className="input text-xs py-1 px-2"
                                        placeholder="value"
                                        value={conditionDraft.value}
                                        onChange={(e) => setConditionDraft({ ...conditionDraft, value: e.target.value })}
                                      />
                                    )}
                                  </>
                                )}
                                {conditionDraft.type === "number" && (
                                  <>
                                    <select
                                      className="input text-xs py-1 px-2"
                                      value={conditionDraft.op}
                                      onChange={(e) => setConditionDraft({ ...conditionDraft, op: e.target.value as NumberOp })}
                                    >
                                      {(Object.keys(NUMBER_OP_LABELS) as NumberOp[]).map((op) => (
                                        <option key={op} value={op}>{NUMBER_OP_LABELS[op]}</option>
                                      ))}
                                    </select>
                                    <div className="flex items-center gap-1">
                                      <input
                                        type="number"
                                        className="input text-xs py-1 px-2 flex-1 min-w-0"
                                        placeholder="value"
                                        value={conditionDraft.value}
                                        onChange={(e) => setConditionDraft({ ...conditionDraft, value: e.target.value })}
                                      />
                                      {conditionDraft.op === "between" && (
                                        <>
                                          <span className="text-muted text-[11px] shrink-0">and</span>
                                          <input
                                            type="number"
                                            className="input text-xs py-1 px-2 flex-1 min-w-0"
                                            placeholder="value"
                                            value={conditionDraft.value2 || ""}
                                            onChange={(e) => setConditionDraft({ ...conditionDraft, value2: e.target.value })}
                                          />
                                        </>
                                      )}
                                    </div>
                                  </>
                                )}
                                {conditionDraft.type === "date" && (
                                  <>
                                    <div className="flex flex-wrap gap-1">
                                      {DATE_PRESETS.map((p) => (
                                        <button
                                          key={p.label}
                                          className="text-[10px] px-2 py-1 rounded-md bg-surface2 hover:bg-surface2/70 text-muted hover:text-text"
                                          onClick={() => setConditionDraft({ type: "date", ...p.range() })}
                                        >
                                          {p.label}
                                        </button>
                                      ))}
                                    </div>
                                    <div className="flex items-center gap-1">
                                      <input
                                        type="date"
                                        className="input text-xs py-1 px-2 flex-1 min-w-0"
                                        value={conditionDraft.from || ""}
                                        onChange={(e) => setConditionDraft({ ...conditionDraft, from: e.target.value || null })}
                                      />
                                      <span className="text-muted text-[11px] shrink-0">to</span>
                                      <input
                                        type="date"
                                        className="input text-xs py-1 px-2 flex-1 min-w-0"
                                        value={conditionDraft.to || ""}
                                        onChange={(e) => setConditionDraft({ ...conditionDraft, to: e.target.value || null })}
                                      />
                                    </div>
                                  </>
                                )}
                                {conditionDraft.type === "boolean" && (
                                  <div className="flex gap-1.5">
                                    {(["true", "false"] as const).map((v) => (
                                      <button
                                        key={v}
                                        className={`text-[11px] px-2.5 py-1 rounded-md flex-1 ${
                                          conditionDraft.value === v ? "bg-primary text-white" : "bg-surface2 text-muted hover:text-text"
                                        }`}
                                        onClick={() => setConditionDraft({ type: "boolean", value: v })}
                                      >
                                        {v === "true" ? "True" : "False"}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            <div className="flex items-center justify-end gap-2 pt-1.5">
                              {isFilterActive(filters[col]) && (
                                <button className="text-[11px] text-muted mr-auto" onClick={() => clearColumnFilter(col)}>
                                  Clear filter
                                </button>
                              )}
                              <button className="text-[11px] text-muted" onClick={() => setOpenFilterCol(null)}>Cancel</button>
                              <button
                                className="text-[11px] px-2.5 py-1 rounded-md bg-primary text-white font-medium"
                                onClick={() => applyFilter(col)}
                              >
                                Apply
                              </button>
                            </div>
                          </div>

                          <div className="border-t border-border my-1" />
                          <button
                            className="w-full text-left text-xs px-2 py-1.5 rounded-lg hover:bg-surface2"
                            onClick={() => addTotalForColumn(col)}
                          >
                            Add total&hellip;
                          </button>

                          <div className="border-t border-border my-1" />
                          <button
                            className="w-full flex items-center justify-between text-xs px-2 py-1.5 rounded-lg hover:bg-surface2"
                            onClick={() => setFormatSectionOpen((v) => !v)}
                          >
                            <span>
                              Format
                              {getNumberFormat(col).mode !== "automatic" && (
                                <span className="text-accent ml-1">({FORMAT_MODE_LABELS[getNumberFormat(col).mode]})</span>
                              )}
                            </span>
                            <span className="text-muted">{formatSectionOpen ? "▾" : "▸"}</span>
                          </button>
                          {formatSectionOpen && (
                            <div className="px-2 pb-1 space-y-1.5">
                              <div className="grid grid-cols-3 gap-1">
                                {(Object.keys(FORMAT_MODE_LABELS) as NumberDisplayMode[]).map((m) => (
                                  <button
                                    key={m}
                                    className={`text-[10px] px-1.5 py-1 rounded-md transition ${
                                      getNumberFormat(col).mode === m ? "bg-primary text-white" : "bg-surface2 text-muted hover:text-text"
                                    }`}
                                    onClick={() => setNumberFormatPatch(col, { mode: m })}
                                  >
                                    {FORMAT_MODE_LABELS[m]}
                                  </button>
                                ))}
                              </div>
                              {(getNumberFormat(col).mode === "number" || getNumberFormat(col).mode === "currency" || getNumberFormat(col).mode === "percent") && (
                                <div className="flex items-center gap-1.5 text-[11px] text-muted">
                                  <span>Decimals</span>
                                  <select
                                    className="input text-[11px] py-0.5 px-1"
                                    value={getNumberFormat(col).decimals}
                                    onChange={(e) => setNumberFormatPatch(col, { decimals: Number(e.target.value) })}
                                  >
                                    {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                                  </select>
                                </div>
                              )}
                              {getNumberFormat(col).mode === "currency" && (
                                <select
                                  className="input text-[11px] py-1 px-2"
                                  value={getNumberFormat(col).currency}
                                  onChange={(e) => setNumberFormatPatch(col, { currency: e.target.value })}
                                >
                                  {CURRENCY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                                </select>
                              )}
                              {getNumberFormat(col).mode === "percent" && (
                                <div className="text-[10px] text-muted">Multiplies the value by 100 automatically (0.42 becomes 42%).</div>
                              )}
                              {getNumberFormat(col).mode === "date" && (
                                <div className="flex gap-1">
                                  {([["iso", "2024-01-05"], ["us", "01/05/2024"], ["long", "Jan 5, 2024"]] as [DateStyle, string][]).map(([style, example]) => (
                                    <button
                                      key={style}
                                      className={`text-[10px] px-1.5 py-1 rounded-md flex-1 transition ${
                                        getNumberFormat(col).dateStyle === style ? "bg-primary text-white" : "bg-surface2 text-muted hover:text-text"
                                      }`}
                                      onClick={() => setNumberFormatPatch(col, { dateStyle: style })}
                                    >
                                      {example}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          <div className="border-t border-border my-1" />
                          <button
                            className="w-full flex items-center justify-between text-xs px-2 py-1.5 rounded-lg hover:bg-surface2"
                            onClick={() => setHighlightSectionOpen((v) => !v)}
                          >
                            <span>
                              Conditional formatting
                              {getColumnFormat(col).mode !== "none" && <span className="text-accent ml-1">(on)</span>}
                            </span>
                            <span className="text-muted">{highlightSectionOpen ? "▾" : "▸"}</span>
                          </button>
                          {highlightSectionOpen && (
                            <div className="px-2 pb-1">
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
                          )}

                          <div className="border-t border-border my-1" />
                          <button
                            className="w-full text-left text-xs px-2 py-1.5 rounded-lg hover:bg-surface2 flex items-center justify-between"
                            onClick={() => toggleWrap(col)}
                          >
                            <span>Wrap text</span>
                            <span className={wrapCols.has(col) ? "text-primary" : "text-muted"}>{wrapCols.has(col) ? "On" : "Off"}</span>
                          </button>
                          <button
                            className="w-full text-left text-xs px-2 py-1.5 rounded-lg hover:bg-surface2"
                            onClick={() => { toggleColumnHidden(col); setOpenFilterCol(null); }}
                          >
                            Hide column
                          </button>
                          <button
                            className="w-full text-left text-xs px-2 py-1.5 rounded-lg hover:bg-surface2"
                            onClick={() => togglePin(col)}
                          >
                            {pinned ? "Unpin column" : "Pin column"}
                          </button>
                        </div>
                      )}

                      <div
                        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/40"
                        onMouseDown={(e) => startResize(e, col)}
                        onClick={(e) => e.stopPropagation()}
                        title="Drag to resize"
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, i) => {
                // Tailwind's `even:` striping targets nth-child(even) - the
                // 2nd, 4th, ... row, 1-indexed - which is odd `i` here
                // (0-indexed). A sticky column (the row-number cell, or any
                // pinned column) needs an opaque background matching that
                // same stripe rather than `bg-inherit`: it sits on top of
                // whatever scrolls underneath it once the table actually
                // scrolls horizontally, and the ordinary translucent
                // striping (`even:bg-surface2/20`) let that scrolled
                // content visibly bleed through - a real bug caught while
                // screenshot-testing the new Pin column feature.
                const stripeClass = i % 2 === 1 ? "bg-surface2" : "bg-surface";
                return (
                <tr key={i} className="group hover:bg-surface2/60 border-b border-border/50 even:bg-surface2/20">
                  <td
                    className={`sticky left-0 z-[6] ${stripeClass} group-hover:bg-surface2/60 text-right px-2 align-top text-muted border-r border-border/50 tabular-nums`}
                  >
                    {offset + i + 1}
                  </td>
                  {renderColumns.map((col) => {
                    const value = row[col];
                    const bg = cellBackground(col, value);
                    const pinned = pinnedVisible.includes(col);
                    const isLastPinned = pinned && col === lastPinnedCol;
                    const formatted = formatCellValue(value, numberFormats[col]);
                    const wrap = wrapCols.has(col);
                    return (
                      <td
                        key={col}
                        className={`px-3 ${rowPad} overflow-hidden align-top ${
                          wrap ? "whitespace-normal break-words" : "text-ellipsis whitespace-nowrap"
                        } ${pinned ? `${stripeClass} group-hover:bg-surface2/60 z-[5]` : ""} ${isLastPinned ? "border-r-2 border-r-primary/40" : ""}`}
                        style={{
                          ...(bg ? { backgroundColor: bg } : {}),
                          ...(pinned ? { position: "sticky", left: pinnedLeftOffset[col] } : {}),
                        }}
                        title={value === null || value === undefined ? "" : String(value)}
                      >
                        {value === null || value === undefined || value === "" ? (
                          <span className="text-muted">&mdash;</span>
                        ) : (
                          formatted ?? String(value)
                        )}
                      </td>
                    );
                  })}
                </tr>
                );
              })}
            </tbody>
            {showTotals && (
              <tfoot className="sticky bottom-0 bg-surface2 z-10 border-t-2 border-border">
                <tr>
                  <td className="sticky left-0 bg-surface2 px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted border-r border-border">
                    &Sigma;
                  </td>
                  {renderColumns.map((col) => {
                    const stat = preview.column_stats[col];
                    const key = statFor(col);
                    const pinned = pinnedVisible.includes(col);
                    return (
                      <td
                        key={col}
                        className={`px-2 py-1 border-l border-border/40 ${pinned ? "bg-surface2" : ""}`}
                        style={pinned ? { position: "sticky", left: pinnedLeftOffset[col] } : undefined}
                      >
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
