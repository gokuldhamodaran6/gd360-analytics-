import { useEffect, useMemo, useState } from "react";
import "react-grid-layout/css/styles.css";
import { ReactGridLayout as RGL, WidthProvider } from "react-grid-layout/legacy";
import {
  dashboardBuilderApi,
  datasourceApi,
  DashboardBuilderDetail,
  DashboardBuilderPage,
  DashboardBlock,
  DashboardBlockType,
  ManualAgg,
  ManualBlockType,
  RestyleChartType,
  FilterCriterion,
} from "../api/client";
import {
  KpiTile,
  BlockTable,
  BlockChart,
  TextBlock,
  FilterControl,
  GaugeBlock,
  DonutBlock,
  SparklineBlock,
  AvatarListBlock,
} from "./DashboardBlocks";
import { DashboardFilterState } from "../lib/useDashboardFilters";

// 2026-09-24 (Dashboard Builder Phase 2 + Phase 2b): the real canvas editor -
// drag, resize, add, remove blocks, and fill each one in either by asking
// GD360's AI or by building it manually from a column + aggregation.
// Deliberately scoped to ONE page's blocks at a time (multi-page management
// is still Phase 3).
//
// Phase 2b adds a "filter" block type (a column picker here in edit mode,
// plus the same interactive FilterControl used in Preview) and threads the
// page's live filterState down into every block card, so a "Build manually"
// block edited while a filter is active can be rebuilt pre-filtered, and so
// restyling a filtered chart is disabled rather than silently discarding the
// filter (restyle_block only ever reads a block's PERSISTED config - see the
// backend module docstring's own Phase 2b section for why).
//
// react-grid-layout's v2 default export is a new hooks-based composable
// API with no widely-documented examples yet; this imports its `/legacy`
// subpath instead, which is the same well-known v1 flat-prop API
// (layout/cols/rowHeight/onDragStop/onResizeStop/...) - lower implementation
// risk for something this central. ROW_UNIT_PX matches DashboardBlocks.tsx's
// own constant exactly, so a block is the same physical size whether you're
// viewing it (DashboardBlockGrid) or editing it (this component).
const ROW_UNIT_PX = 48;
const GRID_COLUMNS = 12;
const ReactGridLayout = WidthProvider(RGL);

// No automatic collision avoidance this round (see the backend module
// docstring's own scope note) - compactType={null} + allowOverlap so
// react-grid-layout never silently reflows a block the person didn't touch,
// and a manual overlap (dragging one block onto another on purpose) is
// allowed rather than fought.

function PlusIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function TrashIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16Z" />
    </svg>
  );
}
function SparkleIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
    </svg>
  );
}
function WrenchIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a4 4 0 0 0-5.6 5L3 17.4V21h3.6l6.1-6.1a4 4 0 0 0 5-5.6l-3 3-2-2 3-3Z" />
    </svg>
  );
}
function PaletteIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="9" cy="10" r="1" fill="currentColor" />
      <circle cx="13" cy="8" r="1" fill="currentColor" />
      <circle cx="16" cy="12" r="1" fill="currentColor" />
      <path d="M12 21a2 2 0 0 1-2-2c0-.6.4-1.1.4-1.7 0-.7-.6-1.3-1.3-1.3H8a5 5 0 0 1 0-8" />
    </svg>
  );
}

const BLOCK_TYPE_LABEL: Record<DashboardBlockType, string> = {
  chart: "Chart",
  table: "Table",
  kpi: "KPI",
  text: "Text",
  filter: "Filter",
  // 2026-09-25 (Round 3): four new native widget types - manual-build-only
  // (see MANUAL_ONLY_TYPES below and the backend module docstring, Round
  // 3 section, for why these never get an "Ask AI" option this round).
  gauge: "Gauge",
  donut: "Donut",
  sparkline: "Sparkline",
  avatar_list: "Top list",
};

// 2026-09-25 (Round 3): these four are only ever filled in through "Build
// manually" - _ai_result_to_block's fallback cascade only ever produces
// chart/kpi/table/text, so offering "Ask AI" on one of these would just
// silently flip it into one of those instead of respecting the type the
// person actually chose. Same honest-scope decision Phase 2b made for the
// "filter" block type.
const MANUAL_ONLY_TYPES: DashboardBlockType[] = ["gauge", "donut", "sparkline", "avatar_list"];

// The "Build manually" form's own Type picker - every type
// build_manual_block can produce (everything except "text" and "filter",
// which are edited directly rather than computed from a recipe).
const MANUAL_BUILD_TYPES: ManualBlockType[] = ["kpi", "table", "chart", "gauge", "donut", "sparkline", "avatar_list"];

const RESTYLE_OPTIONS: { value: RestyleChartType; label: string }[] = [
  { value: "bar", label: "Bar" },
  { value: "horizontal_bar", label: "Horizontal bar" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "pie", label: "Pie" },
  { value: "scatter", label: "Scatter" },
];

const AGG_OPTIONS: { value: ManualAgg; label: string }[] = [
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "count", label: "Count" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
];

type ColumnInfo = { name: string; dtype: string };

function AskAiPanel({
  dashboardId,
  block,
  onDone,
  onClose,
}: {
  dashboardId: string;
  block: DashboardBlock;
  onDone: (d: DashboardBuilderDetail) => void;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ask = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const updated = await dashboardBuilderApi.askAiBlock(dashboardId, block.id, prompt.trim());
      onDone(updated);
    } catch (err: any) {
      // A 422 here IS a clarifying question the AI is asking back - show it
      // inline so the person can just refine their prompt, not a generic
      // failure. A 502 is already a short, friendly message. Anything else
      // falls back to a generic line.
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Couldn't answer that. Please try rephrasing.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="no-drag flex flex-col gap-2 p-3 h-full">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-muted flex items-center gap-1.5">
          <SparkleIcon className="w-3.5 h-3.5 text-accent" /> Ask GD360&apos;s AI
        </div>
        <button type="button" className="text-xs text-muted hover:text-text" onClick={onClose}>
          Cancel
        </button>
      </div>
      <textarea
        className="input text-sm flex-1 min-h-[70px] resize-none"
        placeholder='e.g. "Revenue by region this quarter"'
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask();
        }}
        autoFocus
      />
      {error && <div className="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-1.5">{error}</div>}
      <button type="button" disabled={busy || !prompt.trim()} className="btn-primary text-xs w-full disabled:opacity-50" onClick={ask}>
        {busy ? "Thinking…" : "Build this block"}
      </button>
    </div>
  );
}

function ManualBuildPanel({
  dashboardId,
  block,
  columns,
  activeFilters,
  onDone,
  onClose,
}: {
  dashboardId: string;
  block: DashboardBlock;
  columns: ColumnInfo[];
  // 2026-09-24 (Phase 2b): whatever cross-filter is currently selected on
  // this page, so a block (re)built here starts out correctly pre-filtered
  // instead of showing unfiltered data until the next filter change forces
  // a recompute - mirrors ManualBuildBlockRequest.filters on the backend.
  activeFilters?: FilterCriterion[];
  onDone: (d: DashboardBuilderDetail) => void;
  onClose: () => void;
}) {
  const numericColumns = useMemo(
    () => columns.filter((c) => /int|float|double|number|decimal/i.test(c.dtype)).map((c) => c.name),
    [columns]
  );
  const [metric, setMetric] = useState(columns[0]?.name || "");
  const [agg, setAgg] = useState<ManualAgg>("sum");
  const [groupBy, setGroupBy] = useState("");
  const [blockType, setBlockType] = useState<ManualBlockType>(
    (MANUAL_BUILD_TYPES as readonly string[]).includes(block.type) ? (block.type as ManualBlockType) : "table"
  );
  const [chartType, setChartType] = useState<RestyleChartType>("bar");
  // 2026-09-25 (Round 3): only read/sent when blockType === "gauge" - both
  // optional, kept as plain text state (rather than number) so the field
  // can sit empty instead of defaulting to 0, which build_manual_block
  // would otherwise treat as a REAL target of zero instead of "unset."
  const [targetValue, setTargetValue] = useState("");
  const [maxValue, setMaxValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const needsNumeric = agg === "sum" || agg === "avg";
  const needsGroupBy = blockType !== "kpi" && blockType !== "gauge";
  const isGauge = blockType === "gauge";

  const build = async () => {
    if (!metric || busy) return;
    if (needsGroupBy && !groupBy) {
      setError("Pick a column to group by for a table, chart, donut, sparkline, or top list.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const updated = await dashboardBuilderApi.buildManualBlock(dashboardId, block.id, {
        metric_column: metric,
        agg,
        group_by_column: needsGroupBy ? groupBy : undefined,
        block_type: blockType,
        chart_type: blockType === "chart" ? chartType : undefined,
        target_value: isGauge && targetValue.trim() !== "" ? Number(targetValue) : undefined,
        max_value: isGauge && maxValue.trim() !== "" ? Number(maxValue) : undefined,
        filters: activeFilters && activeFilters.length > 0 ? activeFilters : undefined,
      });
      onDone(updated);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Couldn't build that. Please check your choices.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="no-drag flex flex-col gap-2 p-3 h-full overflow-auto">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-muted flex items-center gap-1.5">
          <WrenchIcon className="w-3.5 h-3.5" /> Build manually
        </div>
        <button type="button" className="text-xs text-muted hover:text-text" onClick={onClose}>
          Cancel
        </button>
      </div>

      {activeFilters && activeFilters.length > 0 && (
        <div className="text-[11px] text-accent bg-accent/10 border border-accent/30 rounded-lg px-2.5 py-1.5">
          Building with {activeFilters.length} active filter{activeFilters.length > 1 ? "s" : ""} applied.
        </div>
      )}

      <div className="grid grid-cols-3 gap-1.5">
        {MANUAL_BUILD_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={`text-xs px-2 py-1.5 rounded-lg border transition ${
              blockType === t ? "bg-primary text-white border-primary" : "border-border text-muted hover:text-text"
            }`}
            onClick={() => setBlockType(t)}
          >
            {BLOCK_TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      <label className="text-[11px] text-muted uppercase tracking-wide">Column</label>
      <select className="input text-sm" value={metric} onChange={(e) => setMetric(e.target.value)}>
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>

      <label className="text-[11px] text-muted uppercase tracking-wide">Aggregation</label>
      <select className="input text-sm" value={agg} onChange={(e) => setAgg(e.target.value as ManualAgg)}>
        {AGG_OPTIONS.map((o) => (
          <option key={o.value} value={o.value} disabled={(o.value === "sum" || o.value === "avg") && numericColumns.length === 0}>
            {o.label}
          </option>
        ))}
      </select>
      {needsNumeric && !numericColumns.includes(metric) && (
        <div className="text-[11px] text-amber-500">Sum/Average need a numeric column.</div>
      )}

      {needsGroupBy && (
        <>
          <label className="text-[11px] text-muted uppercase tracking-wide">Group by</label>
          <select className="input text-sm" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            <option value="">Choose a column…</option>
            {columns
              .filter((c) => c.name !== metric)
              .map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
          </select>
        </>
      )}

      {blockType === "chart" && (
        <>
          <label className="text-[11px] text-muted uppercase tracking-wide">Chart type</label>
          <select className="input text-sm" value={chartType} onChange={(e) => setChartType(e.target.value as RestyleChartType)}>
            {RESTYLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </>
      )}

      {isGauge && (
        <>
          <label className="text-[11px] text-muted uppercase tracking-wide">Target (optional)</label>
          <input
            type="number"
            className="input text-sm"
            placeholder="e.g. 100000"
            value={targetValue}
            onChange={(e) => setTargetValue(e.target.value)}
          />
          <label className="text-[11px] text-muted uppercase tracking-wide">Gauge max (optional)</label>
          <input
            type="number"
            className="input text-sm"
            placeholder="Leave blank to set automatically"
            value={maxValue}
            onChange={(e) => setMaxValue(e.target.value)}
          />
        </>
      )}

      {error && <div className="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-1.5">{error}</div>}

      <button type="button" disabled={busy || !metric} className="btn-primary text-xs w-full mt-auto disabled:opacity-50" onClick={build}>
        {busy ? "Building…" : "Build"}
      </button>
    </div>
  );
}

function StylePanel({
  dashboardId,
  block,
  onDone,
  onClose,
}: {
  dashboardId: string;
  block: DashboardBlock;
  onDone: (d: DashboardBuilderDetail) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<RestyleChartType | null>(null);
  const [error, setError] = useState("");
  const hasTidyData = Boolean(block.config?.result_columns && block.config?.result_rows);

  const restyle = async (type: RestyleChartType) => {
    setBusy(type);
    setError("");
    try {
      const updated = await dashboardBuilderApi.restyleBlock(dashboardId, block.id, type);
      onDone(updated);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Couldn't restyle this chart.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="no-drag flex flex-col gap-2 p-3 h-full">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-muted flex items-center gap-1.5">
          <PaletteIcon className="w-3.5 h-3.5" /> Chart style
        </div>
        <button type="button" className="text-xs text-muted hover:text-text" onClick={onClose}>
          Cancel
        </button>
      </div>
      {!hasTidyData ? (
        <div className="text-xs text-muted leading-relaxed">
          This chart doesn&apos;t have restyle data attached yet (it was built before this option existed). Ask GD360&apos;s AI to
          rebuild it, or build a new chart block, to enable style options.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {RESTYLE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={busy !== null}
              className="text-xs px-2 py-1.5 rounded-lg border border-border text-muted hover:text-text hover:bg-surface2 transition disabled:opacity-50"
              onClick={() => restyle(o.value)}
            >
              {busy === o.value ? "Applying…" : o.label}
            </button>
          ))}
        </div>
      )}
      {error && <div className="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-1.5">{error}</div>}
    </div>
  );
}

function FilterColumnPicker({
  dashboardId,
  block,
  columns,
  onDone,
}: {
  dashboardId: string;
  block: DashboardBlock;
  columns: ColumnInfo[];
  onDone: (d: DashboardBuilderDetail) => void;
}) {
  const [column, setColumn] = useState<string>(block.config?.column || "");
  const [busy, setBusy] = useState(false);

  const save = async (next: string) => {
    setColumn(next);
    setBusy(true);
    try {
      onDone(await dashboardBuilderApi.updateBlock(dashboardId, block.id, { config: { column: next || null } }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="no-drag p-3 flex flex-col gap-2 h-full">
      <label className="text-[11px] text-muted uppercase tracking-wide">Filters on column</label>
      <select className="input text-sm" value={column} disabled={busy} onChange={(e) => save(e.target.value)}>
        <option value="">Choose a column…</option>
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
      {!column && <div className="text-[11px] text-muted italic">Pick a column - this filter won&apos;t do anything until you do.</div>}
    </div>
  );
}

function BlockCard({
  dashboardId,
  block,
  columns,
  datasourceId,
  filterState,
  onChange,
}: {
  dashboardId: string;
  block: DashboardBlock;
  columns: ColumnInfo[];
  datasourceId?: string | null;
  filterState?: DashboardFilterState;
  onChange: (d: DashboardBuilderDetail) => void;
}) {
  const [panel, setPanel] = useState<"none" | "ask" | "manual" | "style">("none");
  const [titleDraft, setTitleDraft] = useState(block.title || "");
  const [textDraft, setTextDraft] = useState(block.config?.text || "");
  const [deleting, setDeleting] = useState(false);
  const filtersActive = Boolean(filterState && filterState.activeFilters.length > 0);

  useEffect(() => setTitleDraft(block.title || ""), [block.id, block.title]);
  useEffect(() => setTextDraft(block.config?.text || ""), [block.id, block.config?.text]);

  const saveTitle = async () => {
    const trimmed = titleDraft.trim();
    if (trimmed === (block.title || "")) return;
    try {
      onChange(await dashboardBuilderApi.updateBlock(dashboardId, block.id, { title: trimmed }));
    } catch {
      setTitleDraft(block.title || "");
    }
  };

  const saveText = async () => {
    if (textDraft === (block.config?.text || "")) return;
    try {
      onChange(await dashboardBuilderApi.updateBlock(dashboardId, block.id, { config: { text: textDraft } }));
    } catch {
      setTextDraft(block.config?.text || "");
    }
  };

  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      onChange(await dashboardBuilderApi.deleteBlock(dashboardId, block.id));
    } finally {
      setDeleting(false);
    }
  };

  const onDone = (d: DashboardBuilderDetail) => {
    setPanel("none");
    onChange(d);
  };

  return (
    <div className="card h-full flex flex-col overflow-hidden border-2 border-transparent hover:border-primary/30 transition">
      <div className="no-drag flex items-center gap-1.5 px-2 py-1.5 border-b border-border shrink-0 bg-surface2/60">
        <input
          className="flex-1 min-w-0 bg-transparent text-xs font-semibold truncate outline-none focus:underline"
          value={titleDraft}
          placeholder="Untitled block"
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-surface border border-border text-muted shrink-0">
          {BLOCK_TYPE_LABEL[block.type]}
        </span>
        {block.type !== "text" && block.type !== "filter" && !MANUAL_ONLY_TYPES.includes(block.type) && (
          <button
            type="button"
            title="Ask AI"
            className="p-1 rounded hover:bg-surface text-muted hover:text-accent transition shrink-0"
            onClick={() => setPanel(panel === "ask" ? "none" : "ask")}
          >
            <SparkleIcon />
          </button>
        )}
        {block.type !== "text" && block.type !== "filter" && (
          <button
            type="button"
            title="Build manually"
            className="p-1 rounded hover:bg-surface text-muted hover:text-text transition shrink-0"
            onClick={() => setPanel(panel === "manual" ? "none" : "manual")}
          >
            <WrenchIcon />
          </button>
        )}
        {block.type === "chart" && (
          <button
            type="button"
            title={filtersActive ? "Restyling is disabled while a filter is active - it would overwrite this filtered view with the chart's real, unfiltered data." : "Chart style"}
            disabled={filtersActive}
            className="p-1 rounded hover:bg-surface text-muted hover:text-text transition shrink-0 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
            onClick={() => !filtersActive && setPanel(panel === "style" ? "none" : "style")}
          >
            <PaletteIcon />
          </button>
        )}
        <button
          type="button"
          title="Delete block"
          className="p-1 rounded hover:bg-red-500/10 text-muted hover:text-red-400 transition shrink-0"
          onClick={remove}
        >
          <TrashIcon />
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {panel === "ask" && <AskAiPanel dashboardId={dashboardId} block={block} onDone={onDone} onClose={() => setPanel("none")} />}
        {panel === "manual" && (
          <ManualBuildPanel
            dashboardId={dashboardId}
            block={block}
            columns={columns}
            activeFilters={filterState?.activeFilters}
            onDone={onDone}
            onClose={() => setPanel("none")}
          />
        )}
        {panel === "style" && <StylePanel dashboardId={dashboardId} block={block} onDone={onDone} onClose={() => setPanel("none")} />}

        {panel === "none" && (
          <>
            {block.type === "kpi" && <KpiTile title={block.title} config={filterState?.overrides[block.id]?.config ?? block.config} />}
            {block.type === "table" && <BlockTable title={block.title} config={filterState?.overrides[block.id]?.config ?? block.config} />}
            {block.type === "chart" && <BlockChart title={block.title} config={filterState?.overrides[block.id]?.config ?? block.config} />}
            {block.type === "gauge" && <GaugeBlock title={block.title} config={filterState?.overrides[block.id]?.config ?? block.config} />}
            {block.type === "donut" && <DonutBlock title={block.title} config={filterState?.overrides[block.id]?.config ?? block.config} />}
            {block.type === "sparkline" && <SparklineBlock title={block.title} config={filterState?.overrides[block.id]?.config ?? block.config} />}
            {block.type === "avatar_list" && <AvatarListBlock title={block.title} config={filterState?.overrides[block.id]?.config ?? block.config} />}
            {block.type === "filter" && (
              <div className="h-full flex flex-col divide-y divide-border">
                <div className="flex-1 min-h-0">
                  <FilterColumnPicker dashboardId={dashboardId} block={block} columns={columns} onDone={onChange} />
                </div>
                {block.config?.column && (
                  <div className="shrink-0">
                    {filterState ? (
                      <FilterControl
                        block={block}
                        datasourceId={datasourceId || null}
                        value={filterState.values[block.id] || ""}
                        onChange={(v) => filterState.setFilterValue(block.id, v)}
                      />
                    ) : (
                      <div className="no-drag text-[11px] text-muted italic p-3">Loading filter…</div>
                    )}
                  </div>
                )}
              </div>
            )}
            {block.type === "text" && (
              <textarea
                className="no-drag w-full h-full p-3 text-sm bg-transparent outline-none resize-none leading-relaxed"
                placeholder="Type a note…"
                value={textDraft}
                onChange={(e) => setTextDraft(e.target.value)}
                onBlur={saveText}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function DashboardCanvas({
  dash,
  page,
  onChange,
  filterState,
}: {
  dash: DashboardBuilderDetail;
  page: DashboardBuilderPage;
  onChange: (d: DashboardBuilderDetail) => void;
  // 2026-09-24 (Phase 2b): optional purely for prop-shape symmetry with
  // DashboardBlockGrid - in practice DashboardBuilderView.tsx only ever
  // renders DashboardCanvas for someone who can_edit, and always passes
  // this, so it's live here whenever this component is on screen at all.
  filterState?: DashboardFilterState;
}) {
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!dash.datasource_id) return;
    let cancelled = false;
    // Reuses the existing preview endpoint purely to read this data
    // source's column names/dtypes for the manual-build form's pickers -
    // deliberately not a new "list columns" endpoint, since preview
    // already returns exactly this.
    datasourceApi
      .preview(dash.datasource_id, null, 1, 0)
      .then((p) => {
        if (cancelled) return;
        setColumns(p.columns.map((name) => ({ name, dtype: p.dtypes[name] || "" })));
      })
      .catch(() => {
        if (!cancelled) setColumns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [dash.datasource_id]);

  const layout = useMemo(
    () => page.blocks.map((b) => ({ i: b.id, x: b.x, y: b.y, w: b.w, h: b.h })),
    [page.blocks]
  );

  const addBlock = async (type: DashboardBlockType) => {
    if (adding) return;
    setAdding(true);
    try {
      onChange(await dashboardBuilderApi.createBlock(dash.id, page.id, type));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span className="text-xs text-muted mr-1">Add block:</span>
        {(["chart", "table", "kpi", "gauge", "donut", "sparkline", "avatar_list", "text", "filter"] as DashboardBlockType[]).map((t) => (
          <button
            key={t}
            type="button"
            disabled={adding}
            className="dash-toolbtn disabled:opacity-50"
            onClick={() => addBlock(t)}
          >
            <PlusIcon className="w-3.5 h-3.5" /> {BLOCK_TYPE_LABEL[t]}
          </button>
        ))}
        {!dash.datasource_id && (
          <span className="text-[11px] text-muted ml-1">
            No linked data source - Ask AI and manual build aren&apos;t available on this dashboard.
          </span>
        )}
      </div>

      {page.blocks.length === 0 ? (
        <div className="text-sm text-muted py-16 text-center border border-dashed border-border rounded-xl">
          This page has no blocks yet - add one above to get started.
        </div>
      ) : (
        <ReactGridLayout
          className="layout"
          layout={layout}
          cols={GRID_COLUMNS}
          rowHeight={ROW_UNIT_PX}
          margin={[16, 16]}
          isDraggable
          isResizable
          allowOverlap
          compactType={null}
          preventCollision={false}
          draggableCancel=".no-drag"
          onDragStop={(_layout, oldItem, newItem) => {
            if (!newItem || !oldItem) return;
            if (newItem.x === oldItem.x && newItem.y === oldItem.y) return;
            dashboardBuilderApi.updateBlock(dash.id, newItem.i, { x: newItem.x, y: newItem.y }).then(onChange);
          }}
          onResizeStop={(_layout, oldItem, newItem) => {
            if (!newItem || !oldItem) return;
            if (newItem.w === oldItem.w && newItem.h === oldItem.h && newItem.x === oldItem.x && newItem.y === oldItem.y) return;
            dashboardBuilderApi
              .updateBlock(dash.id, newItem.i, { x: newItem.x, y: newItem.y, w: newItem.w, h: newItem.h })
              .then(onChange);
          }}
        >
          {page.blocks.map((b) => (
            <div key={b.id}>
              <BlockCard
                dashboardId={dash.id}
                block={b}
                columns={columns}
                datasourceId={dash.datasource_id}
                filterState={filterState}
                onChange={onChange}
              />
            </div>
          ))}
        </ReactGridLayout>
      )}
    </div>
  );
}
