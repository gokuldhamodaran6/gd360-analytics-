import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  PALETTES,
  SIGNATURE_COLORS,
  PaletteId,
  colorableLabels,
  defaultChartStyle,
  canForecastSpec,
  canDetectAnomaliesSpec,
} from "../lib/chartStyle";
import "react-grid-layout/css/styles.css";
import { ReactGridLayout as RGL, WidthProvider } from "react-grid-layout/legacy";
import {
  dashboardBuilderApi,
  datasourceApi,
  metricDefinitionsApi,
  transformsApi,
  DashboardBuilderDetail,
  DashboardBuilderPage,
  DashboardBlock,
  DashboardBlockType,
  ManualAgg,
  ManualBlockType,
  RestyleChartType,
  FilterCriterion,
  MetricDefinition,
  DataTransform,
  TransformPreview,
} from "../api/client";
import { useExclusiveOpen } from "../lib/useExclusiveOpen";
import {
  KpiTile,
  BlockTable,
  BlockChart,
  TextBlock,
  FilterControl,
  BlockFilterButton,
  isSpecActive,
  describeFilterSpec,
  GaugeBlock,
  DonutBlock,
  SparklineBlock,
  AvatarListBlock,
  DividerBlock,
  useIsNarrow,
  STACK_MIN_HEIGHT,
  BLOCK_DEFAULT_SIZE,
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

// 2026-09-29 (design revamp): the flat backend default heights a fresh
// chart block has ever shipped with for its `h` grid units - 6 rows from
// before this round (backend/app/routers/dashboard_builder.py's
// _OTHER_ITEM_HEIGHT/_default_block_size, still true of every chart block
// created before this round) and 8 rows from this round onward. BlockCard's
// one-time auto-grow (see handleChartMinHeight below) only ever touches a
// chart block whose CURRENT h is still exactly one of these - the moment a
// person drags a chart's own corner to any other height, that becomes the
// new "untouched" baseline forever (this set intentionally never grows to
// include it), so auto-grow can never quietly re-fight a deliberate resize
// on a later page reload.
const CHART_DEFAULT_HEIGHTS = new Set([6, 8]);
// Rough per-row pixel cost once react-grid-layout's own row margin is
// folded in (margin={[16,16]} below - a 16px gap sits between every pair
// of adjacent rows). Matches DashboardBlocks.tsx's own ROW_UNIT_PX.
const ROW_MARGIN_PX = 16;
// A chart block's own chrome that sits OUTSIDE the Plot element ChartCanvas
// sizes to suggestedChartMinHeight: BlockCard's title/kebab header bar
// (~33px incl. its border) plus ChartCanvas's own `.dash-card` padding
// (`p-4` = 16px top + 16px bottom). Deliberately a little generous (an
// approximation documented as one, not measured live via a ref) so the
// one-time auto-grow below rounds UP to a card that comfortably fits the
// chart rather than one just barely tall enough.
const CHART_CARD_CHROME_PX = 72;
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
// 2026-09-28: the two new chart-block analysis toggles ("Show forecast" /
// "Show anomalies") get their own small icons in the kebab menu, same
// stroke style as every other icon in this file.
function TrendIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17 9 11l4 4 8-8" />
      <path d="M15 6h6v6" strokeDasharray="2 2" />
    </svg>
  );
}
function AlertIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <circle cx="12" cy="16" r="0.5" fill="currentColor" />
    </svg>
  );
}
// A small checkmark shown next to a toggle-style menu item (Show forecast/
// Show anomalies below) when it's currently on - this app has no existing
// "checked menu item" pattern to copy (grepped for menuitemcheckbox/
// aria-checked - nothing), so this is the simplest honest equivalent: a
// plain checkmark, not a different background/border, so it reads clearly
// even against the menu's existing hover state.
function CheckIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12l5 5L20 6" />
    </svg>
  );
}
// 2026-09-25d (elite pass): every block card used to show up to four
// separate icon buttons (Ask AI, Build manually, Chart style, Delete) in
// its header at all times - the literal "lot of unwanted editing options"
// a side-by-side against a premium reference dashboard called out (none of
// Vision UI/Horizon UI's cards carry a permanent row of controls like
// that). Collapsed into the same single "..." kebab menu pattern
// ChartCanvas.tsx already uses for a chart's export menu, so a block's
// header reads as just its title - same actions, one click behind a menu
// instead of four buttons competing for attention on every single card.
// 2026-09-29 (design revamp): "Explain this chart" affordance - see
// BlockCard's explainOpen popover below for where this is used.
function InfoIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <circle cx="12" cy="8" r="0.5" fill="currentColor" />
    </svg>
  );
}
// 2026-10-01 (lineage round): "How this was built" affordance - see
// BlockCard's lineageOpen popover below. A stacked-layers glyph reads as
// "what this is made of", distinct enough from InfoIcon's plain "i" not to
// be confused with the Explain popover sitting right next to it.
function LayersIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </svg>
  );
}
// 2026-09-29 (round 5, real-bug fix): "* is showing in bold words" - the
// AI's own INSIGHT_SYSTEM_PROMPT (backend/app/services/ai_engine.py)
// deliberately writes this exact text with **Key insight:**/
// **Implication:**/**Next step:** markdown-bold labels (see that
// prompt's own docstring, and _crosstab_narrative's matching
// f"**Key insight:** ..." for the deterministic fallback path) - this
// popover used to just dump the raw string, so a person saw the literal
// ** characters instead of bold text. This renders exactly the one
// markdown construct that prompt ever produces - a **bold** span, one
// or more per line - nothing more: not a general markdown parser (this
// text's whole real vocabulary is three bold labels followed by plain
// sentences, per that prompt's own strict "nothing else before or after
// it" instruction) and never dangerouslySetInnerHTML for text an AI
// wrote - each line is built as real React text nodes instead.
function renderExplanation(text: string): ReactNode {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => (
      <p key={i} className={i > 0 ? "mt-1.5" : undefined}>
        {line.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
          part.startsWith("**") && part.endsWith("**") ? (
            <strong key={j} className="font-semibold text-text">
              {part.slice(2, -2)}
            </strong>
          ) : (
            <span key={j}>{part}</span>
          )
        )}
      </p>
    ));
}

function UndoIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 7 3 12l5 5" />
      <path d="M3 12h11a6 6 0 0 1 0 12h-1" />
    </svg>
  );
}

// FilterIcon and BlockFilterButton (per-chart filtering) now live in
// DashboardBlocks.tsx, shared with Preview mode - see their own comments
// there for why (2026-09-29, Hex-level filters round 2).
function KebabIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="12" cy="19" r="1.9" />
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
  // 2026-09-25 (Round 15, element library): two pure-layout widgets - see
  // NO_DATA_TYPES below for why neither ever offers Ask AI/Build manually.
  heading: "Heading",
  divider: "Divider",
};

// 2026-09-25 (Round 3): these four are only ever filled in through "Build
// manually" - _ai_result_to_block's fallback cascade only ever produces
// chart/kpi/table/text, so offering "Ask AI" on one of these would just
// silently flip it into one of those instead of respecting the type the
// person actually chose. Same honest-scope decision Phase 2b made for the
// "filter" block type.
const MANUAL_ONLY_TYPES: DashboardBlockType[] = ["gauge", "donut", "sparkline", "avatar_list"];

// 2026-09-25 (Round 15, element library): block types with no computed
// data behind them at all - a person types a heading's text directly
// (same as a text block's note) and a divider has no content whatsoever -
// so neither "Ask AI" nor "Build manually" (which both exist to compute
// something FROM the data source) ever makes sense on either. Replaces
// the old `block.type !== "text" && block.type !== "filter"` checks
// below with one shared list "text"/"filter" already belonged in.
const NO_DATA_TYPES: DashboardBlockType[] = ["text", "filter", "heading", "divider"];

// 2026-09-25 (Round 15, element library): every type the "Add block" row
// renders as a draggable/clickable card - the exact same nine as before,
// plus heading/divider. Pulled out as its own constant (was an inline
// array literal) so onDrop below can validate a browser drag's payload
// against it - a foreign drag from outside the app (an image, selected
// text) could still register as an isDroppable drop event, but its
// dataTransfer text will never match one of these, so onDrop just no-ops.
const ELEMENT_LIBRARY_TYPES: DashboardBlockType[] = [
  "chart", "table", "kpi", "gauge", "donut", "sparkline", "avatar_list", "text", "filter", "heading", "divider",
];

// 2026-09-29 (design revamp, add-block popover): the same eleven types
// above, grouped for the compact popover this replaces the always-visible
// row with (see the "Add block" trigger below) - purely a grouping/display
// concern, never a second source of truth for which types exist: every
// array here is a subset of ELEMENT_LIBRARY_TYPES, and onDrop's payload
// check still validates against that one list regardless of which group a
// dragged card came from.
const ADD_BLOCK_GROUPS: { label: string; types: DashboardBlockType[] }[] = [
  { label: "Data", types: ["chart", "table", "kpi"] },
  { label: "Visual", types: ["gauge", "donut", "sparkline", "avatar_list"] },
  { label: "Layout", types: ["text", "filter", "heading", "divider"] },
];

// The "Build manually" form's own Type picker - every type
// build_manual_block can produce (everything except "text" and "filter",
// which are edited directly rather than computed from a recipe).
const MANUAL_BUILD_TYPES: ManualBlockType[] = ["kpi", "table", "chart", "gauge", "donut", "sparkline", "avatar_list"];

// 2026-09-29 (design revamp): the same palette choices the live Workspace
// chart's own Style panel already offers (lib/chartStyle.ts's PALETTES),
// plus "original" (GD360's validated Signature palette, SIGNATURE_COLORS -
// see that file's own comment for why this exact 8-hue set is what "Ask
// AI"/"Build manually" charts already start out painted with by default).
// A dashboard chart previously had no way to change this at all; it can
// now also drop into a "Custom" mode with one swatch per bar/slice/series
// (StylePanel below, right next to this list) - the same per-trace picker
// the live chat chart editor's own Style panel (ChartStylePanel.tsx) has
// always had, ported here now that this panel has room for it too.
// "Signature" is listed first since it's the default every chart already
// starts on.
const COLOR_PALETTE_OPTIONS: { id: PaletteId; name: string; colors: string[] }[] = [
  { id: "original", name: "Signature", colors: SIGNATURE_COLORS },
  ...PALETTES,
];

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
  datasourceId,
  activeFilters,
  onDone,
  onClose,
}: {
  dashboardId: string;
  block: DashboardBlock;
  columns: ColumnInfo[];
  // 2026-09-30 (semantic layer v1): which data source this dashboard's
  // data actually comes from - needed here only to offer "Use a saved
  // metric" (metricDefinitionsApi.list) for a kpi/gauge block. Optional/
  // absent is handled the same way BlockCard already treats it elsewhere
  // on this page (a dashboard with no resolvable data source at all) -
  // the toggle below simply never appears.
  datasourceId?: string | null;
  // 2026-09-24 (Phase 2b): whatever cross-filter is currently selected on
  // this page, so a block (re)built here starts out correctly pre-filtered
  // instead of showing unfiltered data until the next filter change forces
  // a recompute - mirrors ManualBuildBlockRequest.filters on the backend.
  activeFilters?: FilterCriterion[];
  onDone: (d: DashboardBuilderDetail) => void;
  onClose: () => void;
}) {
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
  const canUseSavedMetric = blockType === "kpi" || blockType === "gauge";

  // 2026-09-30 (semantic layer v1): "Use a saved metric" - builds this
  // kpi/gauge tile from a data source's own saved metric glossary
  // (see components/MetricsPanel.tsx and backend models.MetricDefinition)
  // instead of a fresh column+aggregation pick. Lazily loaded (only once
  // this panel is actually showing a kpi/gauge block type) so opening the
  // manual builder for a table/chart never makes this extra call.
  const [savedMetrics, setSavedMetrics] = useState<MetricDefinition[] | null>(null);
  const [useSavedMetric, setUseSavedMetric] = useState(false);
  const [selectedMetricId, setSelectedMetricId] = useState("");

  useEffect(() => {
    if (!canUseSavedMetric || !datasourceId || savedMetrics !== null) return;
    metricDefinitionsApi
      .list(datasourceId)
      .then((list) => {
        setSavedMetrics(list);
        if (list.length > 0 && !selectedMetricId) setSelectedMetricId(list[0].id);
      })
      .catch(() => setSavedMetrics([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseSavedMetric, datasourceId]);

  // Switching away from kpi/gauge (or the block type changing under this
  // panel) always falls back to the plain column+aggregation path - a
  // saved metric only ever applies to a kpi/gauge tile in the first place.
  useEffect(() => {
    if (!canUseSavedMetric) setUseSavedMetric(false);
  }, [canUseSavedMetric]);

  // 2026-09-30 (transformation layer v1): "Use a saved table" - builds
  // THIS block from a saved transform's (see components/TransformsPanel.tsx
  // and backend models.DataTransform) own derived table instead of this
  // data source's raw data, resolved BEFORE either the saved-metric or the
  // plain column+aggregation pick above - so unlike "Use a saved metric",
  // this is available for every block type (table/chart/kpi/gauge/...) and
  // sits ALONGSIDE that toggle, not instead of it: a kpi/gauge can combine
  // both (a saved metric built from a saved table's own derived column).
  // Lazily loaded once, the same "only once this panel is open" pattern as
  // savedMetrics above.
  const [savedTransforms, setSavedTransforms] = useState<DataTransform[] | null>(null);
  const [useSavedTransform, setUseSavedTransform] = useState(false);
  const [selectedTransformId, setSelectedTransformId] = useState("");
  const [transformPreview, setTransformPreview] = useState<TransformPreview | null>(null);

  useEffect(() => {
    if (!datasourceId || savedTransforms !== null) return;
    transformsApi
      .list(datasourceId)
      .then((list) => {
        setSavedTransforms(list);
        if (list.length > 0 && !selectedTransformId) setSelectedTransformId(list[0].id);
      })
      .catch(() => setSavedTransforms([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId]);

  // The selected transform's OWN output columns - fetched fresh (its live
  // preview) whenever the pick changes, so the Column/Group-by dropdowns
  // below offer what this saved table actually produces (which can differ
  // completely from the raw data source's own columns - a group_by step
  // replaces them outright) rather than the raw column list this panel
  // was handed.
  useEffect(() => {
    if (!useSavedTransform || !datasourceId || !selectedTransformId) {
      setTransformPreview(null);
      return;
    }
    let cancelled = false;
    transformsApi
      .getData(datasourceId, selectedTransformId)
      .then((p) => {
        if (!cancelled) setTransformPreview(p);
      })
      .catch(() => {
        if (!cancelled) setTransformPreview({ columns: [], rows: [], row_count: 0, truncated: false, error: "Couldn't load this table." });
      });
    return () => {
      cancelled = true;
    };
  }, [useSavedTransform, datasourceId, selectedTransformId]);

  // The columns/aggregation pickers below always read from `effectiveColumns`
  // rather than the raw `columns` prop directly - identical to the prop's
  // own {name, dtype} shape, just sourced from the transform's live preview
  // (dtype inferred from a sample value, since TransformPreviewOut is rows
  // of plain values, not a schema) when a saved table is in use.
  const effectiveColumns: ColumnInfo[] = useMemo(() => {
    if (!useSavedTransform || !transformPreview || transformPreview.error) return columns;
    return transformPreview.columns.map((name) => {
      const sample = transformPreview.rows.find((r) => r[name] !== null && r[name] !== undefined)?.[name];
      const dtype = typeof sample === "number" ? "float64" : typeof sample === "boolean" ? "bool" : "object";
      return { name, dtype };
    });
  }, [useSavedTransform, transformPreview, columns]);
  const numericColumns = useMemo(
    () => effectiveColumns.filter((c) => /int|float|double|number|decimal/i.test(c.dtype)).map((c) => c.name),
    [effectiveColumns]
  );

  // Switching the saved-table toggle (on, off, or to a different table)
  // resets whatever column/group-by pick was made against the PREVIOUS
  // column set - a stale pick from the raw data could easily not exist on
  // the newly selected table's own output, and vice versa.
  useEffect(() => {
    if (effectiveColumns.length === 0) return;
    setMetric((prev) => (effectiveColumns.some((c) => c.name === prev) ? prev : effectiveColumns[0].name));
    setGroupBy((prev) => (effectiveColumns.some((c) => c.name === prev) ? prev : ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveColumns]);

  const build = async () => {
    if (busy) return;
    if (useSavedTransform && !selectedTransformId) {
      setError("Pick a saved table.");
      return;
    }
    if (useSavedMetric && canUseSavedMetric) {
      if (!selectedMetricId) {
        setError("Pick a saved metric.");
        return;
      }
      setBusy(true);
      setError("");
      try {
        const updated = await dashboardBuilderApi.buildManualBlock(dashboardId, block.id, {
          metric_id: selectedMetricId,
          transform_id: useSavedTransform ? selectedTransformId : undefined,
          block_type: blockType,
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
      return;
    }
    if (!metric) return;
    if (needsGroupBy && !groupBy) {
      setError("Pick a column to group by for a table, chart, donut, sparkline, or top list.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const updated = await dashboardBuilderApi.buildManualBlock(dashboardId, block.id, {
        transform_id: useSavedTransform ? selectedTransformId : undefined,
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

      {/* 2026-09-30 (transformation layer v1): offered for EVERY block
          type, unlike "Use a saved metric" below - see
          components/TransformsPanel.tsx and backend models.DataTransform.
          Swaps in a saved table's own derived data as what this block is
          built FROM; the column/group-by pickers below then show THAT
          table's own columns, and (for a kpi/gauge) it combines freely
          with "Use a saved metric" - a metric can itself reference one of
          this table's derived columns. Always recomputes live (services/
          transforms.py), including across a page filter change and after
          the table's own steps are later edited. */}
      {savedTransforms && savedTransforms.length > 0 && (
        <>
          <label className="flex items-center gap-2 text-[11px] text-muted uppercase tracking-wide cursor-pointer">
            <input type="checkbox" checked={useSavedTransform} onChange={(e) => setUseSavedTransform(e.target.checked)} />
            Use a saved table
          </label>
          {useSavedTransform && (
            <>
              <select className="input text-sm" value={selectedTransformId} onChange={(e) => setSelectedTransformId(e.target.value)}>
                {savedTransforms.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {transformPreview?.error && (
                <div className="text-[11px] text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-1.5">
                  {transformPreview.error}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* 2026-09-30 (semantic layer v1): only offered for a kpi/gauge tile -
          see components/MetricsPanel.tsx and backend models.MetricDefinition.
          Building from a saved metric always recomputes live (through
          services/metrics.py), even after a page filter change or a later
          edit to the metric itself, unlike the plain column+aggregation
          path below, which freezes a one-shot recipe. */}
      {canUseSavedMetric && savedMetrics && savedMetrics.length > 0 && (
        <label className="flex items-center gap-2 text-[11px] text-muted uppercase tracking-wide cursor-pointer">
          <input type="checkbox" checked={useSavedMetric} onChange={(e) => setUseSavedMetric(e.target.checked)} />
          Use a saved metric
        </label>
      )}

      {useSavedMetric && canUseSavedMetric ? (
        <>
          <label className="text-[11px] text-muted uppercase tracking-wide">Metric</label>
          <select className="input text-sm" value={selectedMetricId} onChange={(e) => setSelectedMetricId(e.target.value)}>
            {(savedMetrics || []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <div className="text-[11px] text-muted">
            Always matches this metric's own saved definition - edit it from the Metrics tab, not here.
          </div>
        </>
      ) : (
        <>
          <label className="text-[11px] text-muted uppercase tracking-wide">Column</label>
          <select className="input text-sm" value={metric} onChange={(e) => setMetric(e.target.value)}>
            {effectiveColumns.map((c) => (
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
        </>
      )}

      {needsGroupBy && !useSavedMetric && (
        <>
          <label className="text-[11px] text-muted uppercase tracking-wide">Group by</label>
          <select className="input text-sm" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            <option value="">Choose a column…</option>
            {effectiveColumns
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

      <button
        type="button"
        disabled={busy || (useSavedMetric && canUseSavedMetric ? !selectedMetricId : !metric)}
        className="btn-primary text-xs w-full mt-auto disabled:opacity-50"
        onClick={build}
      >
        {busy ? "Building…" : "Build"}
      </button>
    </div>
  );
}

// 2026-09-29 (round 5): the two switches themselves, split out of
// StylePanel so the "current effective value" logic (computed default,
// overridden by whatever the person has already explicitly toggled) lives
// in one place. Mirrors pickPalette's PATCH shape exactly - spread
// block.config first, then only the one nested chart_style key changes -
// since update_block's `config` is a wholesale replace, not a merge.
function DisplayTogglesRow({
  dashboardId,
  block,
  onDone,
}: {
  dashboardId: string;
  block: DashboardBlock;
  onDone: (d: DashboardBuilderDetail) => void;
}) {
  const [busy, setBusy] = useState<"legend" | "labels" | null>(null);
  const [error, setError] = useState("");
  const computedDefault = useMemo(() => defaultChartStyle(block.config?.chart_spec), [block.config?.chart_spec]);
  const effective = { ...computedDefault, ...(block.config?.chart_style || {}) };

  const setFlag = async (key: "showLegend" | "dataLabels", value: boolean, which: "legend" | "labels") => {
    setBusy(which);
    setError("");
    try {
      const updated = await dashboardBuilderApi.updateBlock(dashboardId, block.id, {
        config: { ...block.config, chart_style: { ...block.config?.chart_style, [key]: value } },
      });
      onDone(updated);
    } catch {
      setError("Couldn't change this chart's display options.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text">Show legend</span>
        <label className="switch">
          <input
            type="checkbox"
            checked={Boolean(effective.showLegend)}
            disabled={busy !== null}
            onChange={(e) => setFlag("showLegend", e.target.checked, "legend")}
          />
          <span className="switch-track" />
        </label>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-text">Data labels</span>
        <label className="switch">
          <input
            type="checkbox"
            checked={Boolean(effective.dataLabels)}
            disabled={busy !== null}
            onChange={(e) => setFlag("dataLabels", e.target.checked, "labels")}
          />
          <span className="switch-track" />
        </label>
      </div>
      {error && <div className="text-[11px] text-amber-500">{error}</div>}
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

  // 2026-09-29 (design revamp): the palette choice lives at
  // block.config.chart_style.paletteId - a small, additive corner of this
  // block's config (read by DashboardBlocks.tsx's BlockChart, see its own
  // comment) - so this reads and writes ONLY that one nested key, always
  // spreading the block's real existing config first. update_block's
  // `config` field is a wholesale REPLACE, not a merge (see routers/
  // dashboard_builder.py's update_block) - omitting the spread here would
  // silently wipe this chart's own chart_spec/result_columns/result_rows
  // the moment a person picked a color.
  const [colorBusy, setColorBusy] = useState(false);
  const [colorError, setColorError] = useState("");
  const activePaletteId: PaletteId = block.config?.chart_style?.paletteId || "original";

  const pickPalette = async (paletteId: PaletteId) => {
    if (paletteId === activePaletteId || colorBusy) return;
    setColorBusy(true);
    setColorError("");
    try {
      const updated = await dashboardBuilderApi.updateBlock(dashboardId, block.id, {
        config: { ...block.config, chart_style: { ...block.config?.chart_style, paletteId } },
      });
      onDone(updated);
    } catch {
      setColorError("Couldn't change this chart's colors.");
    } finally {
      setColorBusy(false);
    }
  };

  // 2026-09-29 (design revamp): per-bar/per-slice/per-series custom colors -
  // the one piece of the live chat chart editor's own Style panel
  // (ChartStylePanel.tsx's "Custom colors, pick your own" mode) that this
  // dashboard-block version never had, even though the underlying
  // mechanism (ChartStyle.customColors, read by applyChartStyle via
  // colorableLabels - see chartStyle.ts) already exists and is already
  // wired up on the render side (DashboardBlocks.tsx's BlockChart merges
  // block.config.chart_style straight into the same applyChartStyle call
  // the live chart uses) - this panel was simply never given the UI to
  // set it. colorLabels is exactly this chart's own real colorable things
  // (one swatch per bar/slice/series, never a padded fixed count), same
  // function the live editor uses, so a 3-bar chart gets 3 swatches and a
  // 10-bar chart gets 10.
  const colorLabels = useMemo(() => colorableLabels(block.config?.chart_spec), [block.config?.chart_spec]);
  const activeCustomColors: string[] = block.config?.chart_style?.customColors || [];
  // Same drag-safe pattern as BrandingPanel's colorDraft/colorTimer/
  // colorSeq in DashboardBuilderView.tsx (see that file's own comment for
  // the exact race this fixes): a native <input type="color"> can fire
  // onChange many times while a person drags inside the OS color picker,
  // and sending one un-debounced updateBlock PATCH per tick let a slower
  // early response land AFTER a later one and silently snap a swatch back
  // to an older color mid-drag. customColorDraft gives each swatch
  // instant, purely local visual feedback; customColorTimer debounces the
  // actual PATCH to ~350ms after the last change per swatch index; and
  // customColorSeq drops any response that isn't from the newest request
  // for that same index.
  const [customColorDraft, setCustomColorDraft] = useState<Record<number, string>>({});
  // Mirrors customColorDraft synchronously (state updates are async/batched,
  // and the debounced PATCH below needs the truly-latest set of pending
  // edits at fire time, not whatever was in scope when its timer was
  // scheduled) - this is what lets two swatches changed within the same
  // ~350ms window both end up in the array a PATCH actually sends, instead
  // of the second one's request clobbering the first one's still-in-flight
  // change.
  const customColorDraftRef = useRef<Record<number, string>>({});
  const customColorTimer = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const customColorSeq = useRef<Record<number, number>>({});
  useEffect(() => {
    const timers = customColorTimer.current;
    return () => {
      Object.values(timers).forEach((t) => t && clearTimeout(t));
    };
  }, []);

  const pickCustomPalette = async () => {
    if (activePaletteId === "custom" || colorBusy) return;
    setColorBusy(true);
    setColorError("");
    try {
      // Same seed-from-Signature fallback the live chart editor's own
      // setCustomColor uses when no custom colors have been picked yet -
      // so switching into "Custom" starts from real, already-on-the-chart
      // colors instead of every swatch defaulting to the same one shade.
      const seeded =
        activeCustomColors.length > 0
          ? activeCustomColors
          : colorLabels.map((_, i) => SIGNATURE_COLORS[i % SIGNATURE_COLORS.length]);
      const updated = await dashboardBuilderApi.updateBlock(dashboardId, block.id, {
        config: { ...block.config, chart_style: { ...block.config?.chart_style, paletteId: "custom", customColors: seeded } },
      });
      onDone(updated);
    } catch {
      setColorError("Couldn't change this chart's colors.");
    } finally {
      setColorBusy(false);
    }
  };

  const setCustomColor = (i: number, hex: string) => {
    customColorDraftRef.current = { ...customColorDraftRef.current, [i]: hex };
    setCustomColorDraft(customColorDraftRef.current);
    const timer = customColorTimer.current[i];
    if (timer) clearTimeout(timer);
    const seq = (customColorSeq.current[i] || 0) + 1;
    customColorSeq.current[i] = seq;
    customColorTimer.current[i] = setTimeout(async () => {
      const base = activeCustomColors.length ? [...activeCustomColors] : colorLabels.map((_, k) => SIGNATURE_COLORS[k % SIGNATURE_COLORS.length]);
      while (base.length < colorLabels.length) base.push(SIGNATURE_COLORS[base.length % SIGNATURE_COLORS.length]);
      // Fold in every still-pending local edit (not just this swatch's own),
      // so a PATCH fired for swatch i doesn't clobber a sibling swatch
      // that was also changed - but not yet server-confirmed - in the same
      // debounce window. See customColorDraftRef's own comment above.
      Object.entries(customColorDraftRef.current).forEach(([idx, val]) => {
        const n = Number(idx);
        while (base.length <= n) base.push(SIGNATURE_COLORS[base.length % SIGNATURE_COLORS.length]);
        base[n] = val;
      });
      try {
        const updated = await dashboardBuilderApi.updateBlock(dashboardId, block.id, {
          config: { ...block.config, chart_style: { ...block.config?.chart_style, paletteId: "custom", customColors: base } },
        });
        if (customColorSeq.current[i] !== seq) return; // a newer edit to this swatch already superseded this request
        onDone(updated);
        delete customColorDraftRef.current[i];
        setCustomColorDraft({ ...customColorDraftRef.current });
      } catch {
        if (customColorSeq.current[i] !== seq) return;
        setColorError("Couldn't change this chart's colors.");
      }
    }, 350);
  };

  return (
    <div className="no-drag flex flex-col gap-3 p-3 h-full overflow-auto">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-muted flex items-center gap-1.5">
          <PaletteIcon className="w-3.5 h-3.5" /> Chart style
        </div>
        <button type="button" className="text-xs text-muted hover:text-text" onClick={onClose}>
          Cancel
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Colors</div>
        <div className="grid grid-cols-2 gap-1.5">
          {COLOR_PALETTE_OPTIONS.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={colorBusy}
              className={`flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-lg border transition disabled:opacity-50 ${
                activePaletteId === p.id
                  ? "border-primary bg-primary/10 text-text"
                  : "border-border text-muted hover:text-text hover:bg-surface2"
              }`}
              onClick={() => pickPalette(p.id)}
            >
              <span className="flex -space-x-0.5 shrink-0">
                {p.colors.slice(0, 4).map((c, i) => (
                  <span
                    key={i}
                    className="w-2.5 h-2.5 rounded-full border border-surface"
                    style={{ backgroundColor: c }}
                  />
                ))}
              </span>
              <span className="truncate">{p.name}</span>
            </button>
          ))}
          {/* 2026-09-29 (design revamp): "Custom" - the same per-bar/
              per-slice/per-series picker the live chat chart editor
              already offers (ChartStylePanel.tsx), now here too. Spans
              both grid columns since its label ("Custom") reads oddly
              squeezed at half width next to a 4-dot swatch preview. */}
          <button
            type="button"
            disabled={colorBusy}
            className={`col-span-2 flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-lg border transition disabled:opacity-50 ${
              activePaletteId === "custom"
                ? "border-primary bg-primary/10 text-text"
                : "border-border text-muted hover:text-text hover:bg-surface2"
            }`}
            onClick={pickCustomPalette}
          >
            <span
              className="w-3 h-3 rounded-full border border-surface shrink-0"
              style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}
            />
            <span className="truncate">Custom, pick your own colors</span>
          </button>
        </div>
        {colorError && <div className="text-[11px] text-amber-500">{colorError}</div>}

        {activePaletteId === "custom" && (
          <div className="mt-1 grid grid-cols-3 gap-2">
            {colorLabels.length === 0 ? (
              <div className="col-span-3 text-[11px] text-muted leading-relaxed">
                This chart doesn&apos;t have separate bars/slices/series to color individually - try a chart type
                with more than one category first.
              </div>
            ) : (
              colorLabels.map((label, i) => {
                const swatchValue = customColorDraft[i] ?? activeCustomColors[i] ?? SIGNATURE_COLORS[i % SIGNATURE_COLORS.length];
                return (
                  <div key={i} className="flex flex-col items-center gap-1 min-w-0">
                    <input
                      type="color"
                      value={swatchValue}
                      onChange={(e) => setCustomColor(i, e.target.value)}
                      className="w-7 h-7 rounded-md border border-border bg-transparent cursor-pointer p-0"
                    />
                    <span className="text-[9px] text-muted text-center truncate w-full" title={label}>
                      {label}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* 2026-09-29 (round 5): "no options in style as well" - the live
          chat's own ChartStylePanel.tsx already lets a person turn the
          legend and permanent on-chart value labels on/off (ChartStyle.
          showLegend/dataLabels); this dashboard-block version never had
          that UI even though the underlying mechanism (block.config.
          chart_style, merged over defaultChartStyle - see DashboardBlocks.
          tsx's BlockChart) already supports it, so this was purely a
          missing control, not a missing feature. The most direct way to
          fix an overlapping/unreadable label on any chart - including an
          older dual-axis-combo one this Style panel's own restyle options
          can't convert away from - is to let the person just turn labels
          off themselves, right here, rather than only via a system-wide
          default. Reads its current on/off state from the same computed
          default the chart itself renders with (defaultChartStyle) unless
          the person has already explicitly set it. */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Display</div>
        <DisplayTogglesRow dashboardId={dashboardId} block={block} onDone={onDone} />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Chart type</div>
        {!hasTidyData ? (
          <div className="text-xs text-muted leading-relaxed">
            This chart doesn&apos;t have restyle data attached yet (it was built before this option existed). Ask GD360&apos;s AI to
            rebuild it, or build a new chart block, to enable type options.
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
    </div>
  );
}

// 2026-09-29 (round 5, real-bug fix): "the filter options is merging with
// other boxes and also no proper alignment" - traced to real arithmetic:
// this control used to always show a full label-above-select stack
// (~70-90px) sitting on top of FilterControl's OWN label-above-select
// stack (~56-60px) inside a card whose body had well under that much
// room (see _FILTER_ROW_HEIGHT's own comment in dashboard_builder.py for
// the exact numbers), and the card's `overflow-hidden` clipped whatever
// didn't fit. Once a column IS chosen, which column it's filtering on is
// rarely touched again - so this collapses to one compact "Filtering on
// X · Change" line the moment a column is set, freeing the vertical
// room a person actually needs for the control they touch every time
// (the value dropdown below). Paired with _FILTER_ROW_HEIGHT's bump from
// 2 to 3 rows so there's real breathing room either way, not just the
// bare minimum that stops clipping.
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
  const [editing, setEditing] = useState(!block.config?.column);

  useEffect(() => {
    setColumn(block.config?.column || "");
    if (!block.config?.column) setEditing(true);
  }, [block.id, block.config?.column]);

  const save = async (next: string) => {
    setColumn(next);
    setBusy(true);
    try {
      const updated = await dashboardBuilderApi.updateBlock(dashboardId, block.id, { config: { column: next || null } });
      onDone(updated);
      if (next) setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  if (!editing && column) {
    return (
      <div className="no-drag px-3 py-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted truncate">
          Filtering on <span className="text-text font-medium">{column}</span>
        </span>
        <button
          type="button"
          className="text-[11px] text-primary hover:underline shrink-0"
          onClick={() => setEditing(true)}
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="no-drag px-3 py-2 flex items-center gap-2">
      <label className="text-[11px] text-muted uppercase tracking-wide shrink-0">On</label>
      <select className="input text-sm py-1.5 flex-1 min-w-0" value={column} disabled={busy} onChange={(e) => save(e.target.value)}>
        <option value="">Choose a column…</option>
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function BlockCard({
  dashboardId,
  block,
  columns,
  datasourceId,
  datasourceName,
  filterState,
  onChange,
}: {
  dashboardId: string;
  block: DashboardBlock;
  columns: ColumnInfo[];
  datasourceId?: string | null;
  // 2026-10-01 (lineage round): this dashboard's own resolved data source
  // name (DashboardBuilderDetail.datasource_name, already computed server-
  // side from source_conversation_id - see backend _dashboard_datasource)
  // - the "Source" line in the new "How this was built" panel below. Never
  // re-fetched or guessed here, just threaded down from the one place the
  // dashboard object already carries it.
  datasourceName?: string | null;
  filterState?: DashboardFilterState;
  onChange: (d: DashboardBuilderDetail) => void;
}) {
  // 2026-09-30 (bug fix, Gokul's own report): menuOpen/panel/explainOpen
  // used to be three independent local useState<boolean> (well, panel was a
  // 4-value enum) - see lib/useExclusiveOpen.ts's own module docstring for
  // the exact "old one doesn't close" bug that caused and why the fix is a
  // page-wide registry rather than state lifted into DashboardCanvas. panel
  // keeps its original 4-value shape (none/ask/manual/style) on the outside -
  // every call site below (setPanel(panel === "ask" ? "none" : "ask"), the
  // onClose callbacks, etc.) is untouched - only how it's backed changed.
  const [panelOpen, setPanelOpenSlot, panelSlotId] = useExclusiveOpen();
  const [panelKind, setPanelKind] = useState<"ask" | "manual" | "style">("ask");
  const panel: "none" | "ask" | "manual" | "style" = panelOpen ? panelKind : "none";
  const setPanel = (next: "none" | "ask" | "manual" | "style") => {
    if (next === "none") {
      setPanelOpenSlot(false);
    } else {
      setPanelKind(next);
      setPanelOpenSlot(true);
    }
  };
  const [titleDraft, setTitleDraft] = useState(block.title || "");
  const [textDraft, setTextDraft] = useState(block.config?.text || "");
  const [deleting, setDeleting] = useState(false);
  // 2026-09-25d (elite pass) - see KebabIcon above.
  const [menuOpen, setMenuOpen, menuSlotId] = useExclusiveOpen();
  // 2026-09-29 (design revamp) - see InfoIcon above and the "ai_explanation"
  // comment on _ai_result_to_block in dashboard_builder.py for where this
  // text comes from: analyze()'s own real, already-generated narrative for
  // this exact block, never a second AI call and never fabricated here.
  const [explainOpen, setExplainOpen, explainSlotId] = useExclusiveOpen();
  // 2026-09-29 (round 5, real-bug fix): "for small field like kpi and i
  // cannot able to read that suggestions about the blocks" - this popover
  // used to be positioned with plain `absolute` inside the block's own
  // header, which sits inside BlockCard's `overflow-hidden` card (see
  // this component's own return below) - so on a small KPI tile the
  // popover's own bottom/right edge got silently clipped by the card's
  // boundary instead of the popover ever running off past it visibly.
  // Portaling it to document.body and positioning it with real viewport
  // coordinates (same pattern DataTable.tsx's own column-filter popover
  // already uses) means its size is never constrained by whatever card it
  // was opened from - a KPI tile gets exactly as much room to explain
  // itself as a full chart does.
  const explainBtnRef = useRef<HTMLButtonElement>(null);
  const [explainPos, setExplainPos] = useState<{ top: number; left: number } | null>(null);
  const EXPLAIN_WIDTH = 288;
  const EXPLAIN_MARGIN = 8;
  const toggleExplain = () => {
    setMenuOpen(false);
    setExplainOpen((wasOpen) => {
      const next = !wasOpen;
      if (next && explainBtnRef.current) {
        const rect = explainBtnRef.current.getBoundingClientRect();
        const left = Math.min(Math.max(rect.right - EXPLAIN_WIDTH, EXPLAIN_MARGIN), window.innerWidth - EXPLAIN_WIDTH - EXPLAIN_MARGIN);
        setExplainPos({ top: rect.bottom + 4, left });
      }
      return next;
    });
  };
  const filtersActive = Boolean(filterState && filterState.activeFilters.length > 0);
  const explanation = (filterState?.overrides[block.id]?.config ?? block.config)?.ai_explanation as string | undefined;

  // 2026-10-01 (lineage round, Gokul's own report: "i cannot able to know
  // how and which data columns re connect in this table... i want to know
  // how this chart firmed and which column and tables connects"): the
  // "How this was built" popover - same portal/positioning pattern as
  // Explain above (explainBtnRef/explainPos), reading whichever REAL,
  // already-stored lineage fields this exact block has rather than
  // deriving/guessing anything new (see backend _attach_source_lineage's
  // own docstring for why: the real generated code, verbatim, is the
  // honest answer to "which columns/tables" rather than a parsed-out
  // summary that risks being wrong). Deliberately reads block.config
  // directly (not the filtered override) - lineage describes how the
  // block's REAL, saved data was built, not however it happens to look
  // under a page filter someone else may be previewing right now.
  const lineageRecipe = block.config?.recipe as
    | { metric_column?: string; agg?: string; group_by_column?: string | null; transform_id?: string | null }
    | undefined;
  const lineageCode = block.config?.source_code as string | undefined;
  const lineagePrompt = block.config?.ai_prompt as string | undefined;
  const lineageTable = block.config?.source_table as string | undefined;
  const lineageColumns = (block.config?.result_columns as { name: string }[] | undefined)?.map((c) => c.name);
  const hasLineage = Boolean(lineageRecipe || lineageCode || lineagePrompt || datasourceName || lineageTable);
  const [lineageOpen, setLineageOpen, lineageSlotId] = useExclusiveOpen();
  const lineageBtnRef = useRef<HTMLButtonElement>(null);
  const [lineagePos, setLineagePos] = useState<{ top: number; left: number } | null>(null);
  const LINEAGE_WIDTH = 320;
  const toggleLineage = () => {
    setMenuOpen(false);
    setLineageOpen((wasOpen) => {
      const next = !wasOpen;
      if (next && lineageBtnRef.current) {
        const rect = lineageBtnRef.current.getBoundingClientRect();
        const left = Math.min(Math.max(rect.right - LINEAGE_WIDTH, EXPLAIN_MARGIN), window.innerWidth - LINEAGE_WIDTH - EXPLAIN_MARGIN);
        setLineagePos({ top: rect.bottom + 4, left });
      }
      return next;
    });
  };
  const AGG_LABEL: Record<string, string> = { sum: "Sum", avg: "Average", count: "Count", min: "Min", max: "Max" };
  // 2026-09-30 bug fix (Gokul's own report, verbatim: "show anomoly and
  // show forecast dont show for every chart only if it need show"): only
  // offer "Show forecast" / "Show anomalies" in the kebab menu below when
  // THIS block's own real chart_spec has a shape those toggles could
  // honestly compute against - mirrors chart_builder.py's
  // apply_analysis_overlays gating exactly (see canForecastSpec/
  // canDetectAnomaliesSpec in chartStyle.ts), so a bar/pie/funnel-shaped
  // chart never shows an option that would just 400 when clicked. Reads
  // block.config directly (not the filtered override above) since the
  // toggle itself acts on the block's real persisted config via
  // setBlockAnalysis, same as the existing block.config?.forecast_enabled/
  // anomalies_enabled reads further down.
  const canForecast = useMemo(() => canForecastSpec(block.config?.chart_spec), [block.config?.chart_spec]);
  const canDetectAnomalies = useMemo(
    () => canDetectAnomaliesSpec(block.config?.chart_spec),
    [block.config?.chart_spec]
  );

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

  // 2026-09-29 (design revamp): "i want a option i each chart like undo
  // or redo because just now i chaange somethingand i cannot able to get
  // that old version back" - single-level undo, see undoBlock's own
  // comment in api/client.ts. Shown/enabled only when block.can_undo (the
  // server's own signal that a snapshot actually exists), so this never
  // sits there clickable-but-useless; a failure here IS shown, the same
  // as setAnalysis above, since "nothing happened" with no explanation
  // would look like the feature is broken rather than there being
  // genuinely nothing left to undo.
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState("");
  const undo = async () => {
    if (undoBusy) return;
    setUndoBusy(true);
    setUndoError("");
    try {
      onChange(await dashboardBuilderApi.undoBlock(dashboardId, block.id));
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setUndoError(typeof detail === "string" ? detail : "Couldn't undo this block's last change.");
    } finally {
      setUndoBusy(false);
    }
  };

  // 2026-09-25h (inline editing round): best-effort - a failed save just
  // leaves the swatch showing whatever color it already had, which is
  // low-stakes enough not to need a scary inline error for something this
  // cosmetic.
  const setAccentColor = async (color: string | null) => {
    try {
      onChange(await dashboardBuilderApi.setBlockAccentColor(dashboardId, block.id, color));
    } catch {
      /* see comment above */
    }
  };

  // 2026-09-28: "Show forecast" / "Show anomalies" toggles. Unlike
  // setAccentColor above, a failure here IS shown to the person - toggling
  // one of these can genuinely fail for an honest reason (e.g. "Forecasting
  // only works on a line, area, or step chart") that they need to actually
  // see, not have silently swallowed. This copies restyle_block's own
  // error-surfacing mechanism verbatim (StylePanel above): read
  // err.response.data.detail, fall back to a generic message, show it in
  // the same amber inline box.
  const [analysisError, setAnalysisError] = useState("");
  const setAnalysis = async (next: { forecast_enabled: boolean; anomalies_enabled: boolean }) => {
    setAnalysisError("");
    try {
      onChange(await dashboardBuilderApi.setBlockAnalysis(dashboardId, block.id, next));
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setAnalysisError(typeof detail === "string" ? detail : "Couldn't update this chart's analysis options.");
    }
  };

  const onDone = (d: DashboardBuilderDetail) => {
    setPanel("none");
    onChange(d);
  };

  // 2026-09-29 (design revamp): a fresh chart block used to land at a flat
  // grid size regardless of what its chart actually needed, and anything
  // taller than that card simply got clipped off (BlockCard/ChartCanvas are
  // both overflow-hidden) - the literal bug behind Gokul's own screenshot
  // of a bar chart's bottom axis cut off. This grows the card ONCE, the
  // first time this chart's real content reports how tall it actually
  // needs to be (see ChartCanvas's onMinHeight - ultimately from
  // lib/chartStyle.ts's suggestedChartMinHeight), so a person never has to
  // drag-resize a brand new chart open just to see the whole thing. The
  // `autoFitDone` ref (not a Set/effect-cleanup) is enough on its own to
  // fire only once per card: BlockCard remounts fresh per block.id (this
  // grid item's own React key), so a fresh ref naturally comes with it.
  const autoFitDone = useRef(false);
  const handleChartMinHeight = useCallback(
    (px: number) => {
      if (autoFitDone.current) return;
      if (!CHART_DEFAULT_HEIGHTS.has(block.h)) return; // already a deliberate, non-default size - never touch it
      autoFitDone.current = true;
      const neededPx = px + CHART_CARD_CHROME_PX;
      const rowsNeeded = Math.ceil((neededPx + ROW_MARGIN_PX) / (ROW_UNIT_PX + ROW_MARGIN_PX));
      const newH = Math.min(rowsNeeded, 20);
      if (newH > block.h) {
        dashboardBuilderApi.updateBlock(dashboardId, block.id, { h: newH }).then(onChange).catch(() => {
          // Low-stakes and silent, same reasoning as setAccentColor above -
          // worst case the card just stays at its original size, exactly
          // as if this feature didn't run at all.
        });
      }
    },
    [block.h, block.id, dashboardId, onChange]
  );

  // 2026-09-29 (design revamp): the honest signal routers/dashboard_builder
  // .py's own module docstring already promised ("the frontend says so
  // rather than silently pretending they responded" - Phase 2b, point 2)
  // but never actually shipped on this side. 2026-09-29 (thought-leader
  // filters round): "chart wise filters" - a "Build manually" block's own
  // `recipe` is no longer the ONLY way a block responds to this page's
  // filter - a table/chart block built with Ask AI (or bulk-generated)
  // now also responds, as long as it still has its own tidy
  // result_columns/result_rows attached (see preview_filtered_blocks'
  // own backend docstring for exactly what that extension does and why
  // it deliberately stops short of a kpi, whose single value has no
  // recorded aggregation to honestly re-derive from a filtered subset).
  // So the real, still-true gap this banner should flag has narrowed to:
  // a kpi/gauge/donut/sparkline/avatar_list (none of these have a
  // recipe-free filtered path), OR a chart/table built before
  // result_columns/result_rows were even stored (an old block with
  // neither a recipe nor tidy data to filter).
  const isFilterableType = ["chart", "table", "kpi", "gauge", "donut", "sparkline", "avatar_list"].includes(block.type);
  const hasTidyResultData = Boolean(block.config?.result_columns && block.config?.result_rows);
  const respondsToFilters =
    Boolean(block.config?.recipe) || (["chart", "table"].includes(block.type) && hasTidyResultData);
  const notFilterAware = filtersActive && isFilterableType && !respondsToFilters;

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
        {respondsToFilters && datasourceId && filterState && (
          <BlockFilterButton
            datasourceId={datasourceId}
            columns={columns}
            criteria={filterState.blockFilters[block.id] || []}
            onChange={(criteria) => filterState.setBlockFilters(block.id, criteria)}
          />
        )}
        {explanation && (
          <div className="shrink-0">
            <button
              ref={explainBtnRef}
              type="button"
              className="dash-chart-menu-btn"
              aria-label="Explain this chart"
              aria-haspopup="dialog"
              aria-expanded={explainOpen}
              title="Explain this chart"
              data-exclusive-id={explainSlotId}
              onClick={toggleExplain}
            >
              <InfoIcon />
            </button>
            {explainOpen &&
              explainPos &&
              createPortal(
                <div
                  role="dialog"
                  aria-label="Explanation"
                  data-exclusive-id={explainSlotId}
                  className="fixed card bg-surface shadow-2xl border border-border p-3 z-50 text-xs leading-relaxed text-foreground"
                  style={{
                    top: explainPos.top,
                    left: explainPos.left,
                    width: EXPLAIN_WIDTH,
                    maxHeight: Math.min(400, window.innerHeight - explainPos.top - EXPLAIN_MARGIN),
                    overflowY: "auto",
                  }}
                >
                  {renderExplanation(explanation)}
                </div>,
                document.body
              )}
          </div>
        )}
        {hasLineage && (
          <div className="shrink-0">
            <button
              ref={lineageBtnRef}
              type="button"
              className="dash-chart-menu-btn"
              aria-label="How this was built"
              aria-haspopup="dialog"
              aria-expanded={lineageOpen}
              title="How this was built"
              data-exclusive-id={lineageSlotId}
              onClick={toggleLineage}
            >
              <LayersIcon />
            </button>
            {lineageOpen &&
              lineagePos &&
              createPortal(
                <div
                  role="dialog"
                  aria-label="How this was built"
                  data-exclusive-id={lineageSlotId}
                  className="fixed card bg-surface shadow-2xl border border-border p-3 z-50 text-xs leading-relaxed text-foreground space-y-2.5"
                  style={{
                    top: lineagePos.top,
                    left: lineagePos.left,
                    width: LINEAGE_WIDTH,
                    maxHeight: Math.min(440, window.innerHeight - lineagePos.top - EXPLAIN_MARGIN),
                    overflowY: "auto",
                  }}
                >
                  {(datasourceName || lineageTable) && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-0.5">Source</div>
                      <div>
                        {datasourceName || "This dashboard's data source"}
                        {lineageTable && <span className="text-muted"> &rarr; table &ldquo;{lineageTable}&rdquo;</span>}
                      </div>
                    </div>
                  )}
                  {lineageRecipe && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-0.5">Built from</div>
                      <div>
                        {AGG_LABEL[lineageRecipe.agg || ""] || lineageRecipe.agg} of{" "}
                        <code className="px-1 py-0.5 rounded bg-surface2 border border-border">{lineageRecipe.metric_column}</code>
                        {lineageRecipe.group_by_column && (
                          <>
                            {" "}grouped by{" "}
                            <code className="px-1 py-0.5 rounded bg-surface2 border border-border">{lineageRecipe.group_by_column}</code>
                          </>
                        )}
                        {lineageRecipe.transform_id && <span className="text-muted"> &middot; from a saved table</span>}
                      </div>
                    </div>
                  )}
                  {lineagePrompt && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-0.5">Question asked</div>
                      <div className="italic">&ldquo;{lineagePrompt}&rdquo;</div>
                    </div>
                  )}
                  {lineageColumns && lineageColumns.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-0.5">Output columns</div>
                      <div className="flex flex-wrap gap-1">
                        {lineageColumns.map((c) => (
                          <code key={c} className="px-1 py-0.5 rounded bg-surface2 border border-border text-[10px]">
                            {c}
                          </code>
                        ))}
                      </div>
                    </div>
                  )}
                  {lineageCode && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-0.5">
                        The real code GD360 ran
                      </div>
                      <pre className="whitespace-pre-wrap break-words px-2 py-1.5 rounded bg-surface2 border border-border font-mono text-[10px] leading-relaxed">
                        {lineageCode}
                      </pre>
                    </div>
                  )}
                </div>,
                document.body
              )}
          </div>
        )}
        <div className="relative shrink-0">
          <button
            type="button"
            className="dash-chart-menu-btn"
            aria-label="Block options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-exclusive-id={menuSlotId}
            onClick={() => {
              setExplainOpen(false);
              setMenuOpen((o) => !o);
            }}
          >
            <KebabIcon />
          </button>
          {menuOpen && (
            <div role="menu" data-exclusive-id={menuSlotId} className="absolute right-0 top-full mt-1 w-40 card bg-surface shadow-2xl border border-border p-1.5 z-20">
              {!NO_DATA_TYPES.includes(block.type) && !MANUAL_ONLY_TYPES.includes(block.type) && (
                <button
                  type="button"
                  role="menuitem"
                  className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors flex items-center gap-2"
                  onClick={() => {
                    setMenuOpen(false);
                    setPanel(panel === "ask" ? "none" : "ask");
                  }}
                >
                  <SparkleIcon className="w-3.5 h-3.5" /> Ask AI
                </button>
              )}
              {!NO_DATA_TYPES.includes(block.type) && (
                <button
                  type="button"
                  role="menuitem"
                  className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors flex items-center gap-2"
                  onClick={() => {
                    setMenuOpen(false);
                    setPanel(panel === "manual" ? "none" : "manual");
                  }}
                >
                  <WrenchIcon className="w-3.5 h-3.5" /> Build manually
                </button>
              )}
              {block.type === "chart" && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={filtersActive}
                  title={
                    filtersActive
                      ? "Chart style is disabled while a filter is active - changing the chart type would overwrite this filtered view with the chart's real, unfiltered data."
                      : undefined
                  }
                  className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  onClick={() => {
                    if (filtersActive) return;
                    setMenuOpen(false);
                    setPanel(panel === "style" ? "none" : "style");
                  }}
                >
                  <PaletteIcon className="w-3.5 h-3.5" /> Chart style
                </button>
              )}
              {/* 2026-09-28: forecast/anomalies are deliberately chart-block
                  only (not kpi/sparkline/table/gauge) - see
                  chart_builder.py's apply_analysis_overlays for why: both
                  read off a Plotly trace's own x/y arrays, which only a
                  chart block's chart_spec has.
                  2026-09-30: and even among chart blocks, only a chart
                  whose own shape can honestly support a forecast (a line/
                  area/step chart with 4+ points) - "show for every chart"
                  meant a bar or pie chart offered this too, only to 400
                  when clicked. See canForecast/canForecastSpec above. */}
              {block.type === "chart" && canForecast && (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={Boolean(block.config?.forecast_enabled)}
                  className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors flex items-center gap-2"
                  onClick={() => {
                    setMenuOpen(false);
                    setAnalysis({
                      forecast_enabled: !block.config?.forecast_enabled,
                      anomalies_enabled: Boolean(block.config?.anomalies_enabled),
                    });
                  }}
                >
                  <TrendIcon className="w-3.5 h-3.5" />
                  <span className="flex-1">Show forecast</span>
                  {block.config?.forecast_enabled && <CheckIcon className="w-3.5 h-3.5 text-primary" />}
                </button>
              )}
              {/* 2026-09-30: same reasoning as "Show forecast" above - only
                  offered when this chart's primary trace actually has a
                  y-value array to inspect (a pie/donut/funnel doesn't). */}
              {block.type === "chart" && canDetectAnomalies && (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={Boolean(block.config?.anomalies_enabled)}
                  className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors flex items-center gap-2"
                  onClick={() => {
                    setMenuOpen(false);
                    setAnalysis({
                      forecast_enabled: Boolean(block.config?.forecast_enabled),
                      anomalies_enabled: !block.config?.anomalies_enabled,
                    });
                  }}
                >
                  <AlertIcon className="w-3.5 h-3.5" />
                  <span className="flex-1">Show anomalies</span>
                  {block.config?.anomalies_enabled && <CheckIcon className="w-3.5 h-3.5 text-primary" />}
                </button>
              )}
              {block.can_undo && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={undoBusy}
                  className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors flex items-center gap-2 disabled:opacity-50"
                  onClick={() => {
                    setMenuOpen(false);
                    undo();
                  }}
                >
                  <UndoIcon className="w-3.5 h-3.5" /> {undoBusy ? "Undoing…" : "Undo last change"}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-red-500/10 text-red-400 transition-colors flex items-center gap-2"
                onClick={() => {
                  setMenuOpen(false);
                  remove();
                }}
              >
                <TrashIcon className="w-3.5 h-3.5" /> Delete block
              </button>
            </div>
          )}
        </div>
      </div>

      {analysisError && (
        <div className="no-drag text-xs text-amber-500 bg-amber-500/10 border-b border-amber-500/30 px-2.5 py-1.5 shrink-0">
          {analysisError}
        </div>
      )}

      {undoError && (
        <div className="no-drag text-xs text-amber-500 bg-amber-500/10 border-b border-amber-500/30 px-2.5 py-1.5 shrink-0">
          {undoError}
        </div>
      )}

      {notFilterAware && (
        <div
          className="no-drag flex items-center justify-between gap-2 text-[11px] text-muted bg-surface2/70 border-b border-border px-2.5 py-1 shrink-0"
          title={
            block.type === "kpi"
              ? "This number has no recorded sum/average/count to honestly recompute from filtered data - rebuild it below to make it respond to this page's filters."
              : "This block was built before filter-aware blocks existed, so it has no data of its own to filter from - rebuild it below to make it respond to this page's filters."
          }
        >
          {/* 2026-10-01 wording fix (Gokul's own report: the old "Not
              updated by this filter" + an uppercase "Fix this" button read
              together like a leftover engineering TODO, not real product
              copy - he's right, it did. Same honest meaning, same one-click
              fix (still opens the exact same Build manually panel, which
              always stores a real recipe - the thing respondsToFilters
              above actually checks for), just said the way a finished
              product says it. */}
          <span className="truncate">Doesn't update with filters yet</span>
          <button
            type="button"
            className="no-drag shrink-0 text-[10px] font-semibold uppercase tracking-wide text-primary hover:underline"
            onClick={() => setPanel("manual")}
          >
            Make it filterable
          </button>
        </div>
      )}

      {/* 2026-10-02 fix: tagged with panelSlotId so the new outside-click
          dismiss (lib/useExclusiveOpen.ts) never mistakes typing or
          clicking inside this form-like panel (an Ask AI prompt box, a
          Build-manually field, a Style control) for a click "outside" it -
          the panel only ever closes via its own explicit onClose, exactly
          as before. */}
      <div className="flex-1 min-h-0" data-exclusive-id={panelSlotId}>
        {panel === "ask" && <AskAiPanel dashboardId={dashboardId} block={block} onDone={onDone} onClose={() => setPanel("none")} />}
        {panel === "manual" && (
          <ManualBuildPanel
            dashboardId={dashboardId}
            block={block}
            columns={columns}
            datasourceId={datasourceId}
            activeFilters={filterState?.activeFilters}
            onDone={onDone}
            onClose={() => setPanel("none")}
          />
        )}
        {panel === "style" && <StylePanel dashboardId={dashboardId} block={block} onDone={onDone} onClose={() => setPanel("none")} />}

        {panel === "none" && (
          <>
            {block.type === "kpi" && (
              <KpiTile
                title={block.title}
                // The accent color always comes from the block's own REAL
                // persisted config, even while a filter override is
                // showing different (filtered) content - an override's
                // config is a fresh, ephemeral recompute (see
                // lib/useDashboardFilters.ts) that never carries a custom
                // color along, so without this overlay a custom color
                // would visibly vanish for as long as a filter is active.
                config={{ ...(filterState?.overrides[block.id]?.config ?? block.config), accent_color: block.config?.accent_color }}
                compareValue={filterState?.overrides[block.id] ? block.config?.value : undefined}
                editable
                onAccentColorChange={setAccentColor}
              />
            )}
            {block.type === "table" && (
              <BlockTable
                title={block.title}
                config={{ ...(filterState?.overrides[block.id]?.config ?? block.config), accent_color: block.config?.accent_color }}
                editable
                onAccentColorChange={setAccentColor}
              />
            )}
            {block.type === "chart" && (
              <BlockChart
                title={block.title}
                config={filterState?.overrides[block.id]?.config ?? block.config}
                onMinHeight={handleChartMinHeight}
                blockFilterCriteria={filterState?.blockFilters[block.id] || []}
                onBlockFilterChange={filterState ? (criteria) => filterState.setBlockFilters(block.id, criteria) : undefined}
              />
            )}
            {block.type === "gauge" && (
              <GaugeBlock
                title={block.title}
                config={{ ...(filterState?.overrides[block.id]?.config ?? block.config), accent_color: block.config?.accent_color }}
                editable
                onAccentColorChange={setAccentColor}
              />
            )}
            {block.type === "donut" && <DonutBlock title={block.title} config={filterState?.overrides[block.id]?.config ?? block.config} />}
            {block.type === "sparkline" && (
              <SparklineBlock
                title={block.title}
                config={{ ...(filterState?.overrides[block.id]?.config ?? block.config), accent_color: block.config?.accent_color }}
                editable
                onAccentColorChange={setAccentColor}
              />
            )}
            {block.type === "avatar_list" && <AvatarListBlock title={block.title} config={filterState?.overrides[block.id]?.config ?? block.config} />}
            {block.type === "filter" && (
              // 2026-09-29 (round 5, real-bug fix): the column picker is
              // now `shrink-0` (it's a single compact line, or a chip once
              // a column is set - see FilterColumnPicker's own comment)
              // and the value control - the one thing a viewer actually
              // touches every time - gets the remaining space and is
              // vertically centered in it, instead of the old flex-1 on
              // the PICKER leaving the control squeezed at the bottom.
              <div className="h-full flex flex-col divide-y divide-border">
                <div className="shrink-0">
                  <FilterColumnPicker dashboardId={dashboardId} block={block} columns={columns} onDone={onChange} />
                </div>
                {block.config?.column && (
                  // 2026-10-01 bug fix (Gokul's own report, verbatim: "if i
                  // press any button i dashboard in editing more its not
                  // going when i preses the same button again"): every
                  // other interactive surface in this card (the header
                  // toolbar, FilterColumnPicker's own two branches) is
                  // wrapped in `no-drag` so react-grid-layout's drag
                  // handling on the grid item never intercepts its clicks -
                  // this was the one wrapper that wasn't, which is exactly
                  // why the FILTER pill's second click (to close it) could
                  // get swallowed by a drag gesture instead of reaching the
                  // popover's own onClick. FilterControl's own button now
                  // also carries `no-drag` directly (see DashboardBlocks.tsx)
                  // - both belt and suspenders, matching every sibling
                  // control's own pattern in this same card.
                  <div className="no-drag flex-1 min-h-0 flex items-center px-3">
                    {filterState ? (
                      <FilterControl
                        block={block}
                        datasourceId={datasourceId || null}
                        value={filterState.values[block.id] ?? null}
                        onChange={(spec) => filterState.setFilterValue(block.id, spec)}
                      />
                    ) : (
                      <div className="no-drag text-[11px] text-muted italic">Loading filter…</div>
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
            {/* 2026-09-25 (Round 15, element library): a heading's content
                lives in the exact same config.text field/draft/save path a
                text block already uses - just a single-line input styled
                large and bold instead of a note's textarea. */}
            {block.type === "heading" && (
              <div className="h-full flex items-center px-3">
                <input
                  className="no-drag w-full bg-transparent outline-none text-xl font-bold text-text placeholder:text-muted placeholder:italic placeholder:font-normal"
                  placeholder="Untitled heading"
                  value={textDraft}
                  onChange={(e) => setTextDraft(e.target.value)}
                  onBlur={saveText}
                />
              </div>
            )}
            {/* A divider has no content to ever edit - see DividerBlock's
                own comment in DashboardBlocks.tsx - so it renders the exact
                same way in edit mode as it does everywhere else. */}
            {block.type === "divider" && <DividerBlock />}
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
  // 2026-09-25e (responsive pass): below the same phone/small-tablet
  // breakpoint Preview/the public viewer already switch at (see
  // DashboardBlocks.tsx's own NARROW_BREAKPOINT comment), the desktop-tuned
  // 12-column absolute grid isn't just cramped here - it's the one
  // genuinely unusable surface in the whole app on a phone: react-grid-
  // layout's drag/resize handles need real precision, and a block sized
  // "3 wide" on a 375px screen is a sliver no one can grab. Rather than
  // trying to make free-form drag/resize work with touch (and risk writing
  // squashed, phone-sized x/y/w/h back over the SAME stored layout the
  // desktop view relies on), this drops react-grid-layout entirely below
  // the breakpoint and stacks blocks full-width in their existing order -
  // same choice Preview already made, and the one place drag/resize
  // positioning stays a "use a bigger screen" action rather than a broken
  // one. Every other editing action (add, Ask AI, build manually, restyle,
  // delete, edit title/text) stays fully available on mobile.
  const narrow = useIsNarrow();

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

  // 2026-09-25 (Round 15, element library): addBlock now takes an optional
  // drop position - set only when a library card was dragged onto the
  // canvas and dropped at a specific cell (see onDrop below); a plain
  // click still omits it and lands at the bottom via the backend's own
  // _place_new_block, exactly as it always has.
  const addBlock = async (type: DashboardBlockType, position?: { x: number; y: number }) => {
    if (adding) return;
    setAdding(true);
    try {
      onChange(await dashboardBuilderApi.createBlock(dash.id, page.id, type, undefined, position));
    } finally {
      setAdding(false);
    }
  };

  // The card currently being dragged from the element library, if any -
  // drives both the ghost placeholder's size while hovering the canvas
  // (droppingItem/onDropDragOver below) and, as a fallback, what onDrop
  // creates if the browser's own dataTransfer read comes back empty.
  const [draggingType, setDraggingType] = useState<DashboardBlockType | null>(null);

  // 2026-09-29 (design revamp, add-block popover): replaces the old
  // permanently-visible row of all eleven element-library buttons (still
  // available in full below, just no longer sitting open above the canvas
  // at all times) with a closed-by-default trigger + small categorized
  // popover - the same real click-to-add and drag-onto-canvas behavior as
  // before (addBlock/onDragStart/onDragEnd are untouched), just not taking
  // up permanent header space or reading as an always-on wall of buttons.
  const [addOpen, setAddOpen] = useState(false);
  const addPopRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!addOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (addPopRef.current && !addPopRef.current.contains(e.target as Node)) setAddOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [addOpen]);

  const addBlockAndClose = async (type: DashboardBlockType) => {
    setAddOpen(false);
    await addBlock(type);
  };

  return (
    <div>
      <div className="mb-4">
        <div className="relative inline-block" ref={addPopRef}>
          <button
            type="button"
            className="dash-toolbtn disabled:opacity-50"
            disabled={adding}
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => setAddOpen((o) => !o)}
          >
            <PlusIcon className="w-3.5 h-3.5" /> Add block
          </button>
          {addOpen && (
            <div
              role="menu"
              className="absolute left-0 top-full mt-1.5 w-[280px] card bg-surface shadow-2xl border border-border p-2.5 z-20 flex flex-col gap-2.5"
            >
              {!narrow && (
                <div className="text-[10px] text-muted leading-snug px-0.5">
                  Click to add, or drag a card onto the canvas.
                </div>
              )}
              {ADD_BLOCK_GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted px-0.5 mb-1">
                    {group.label}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {group.types.map((t) => (
                      <button
                        key={t}
                        type="button"
                        disabled={adding}
                        draggable={!narrow && !adding}
                        className="text-xs px-2 py-1.5 rounded-lg border border-border text-muted hover:text-text hover:border-accent/40 hover:bg-accent/5 transition disabled:opacity-50 text-left cursor-grab active:cursor-grabbing"
                        title={narrow ? undefined : `Drag onto the canvas, or click to add "${BLOCK_TYPE_LABEL[t]}"`}
                        onClick={() => addBlockAndClose(t)}
                        onDragStart={(e) => {
                          setDraggingType(t);
                          setAddOpen(false);
                          e.dataTransfer.effectAllowed = "copy";
                          e.dataTransfer.setData("text/plain", t);
                        }}
                        onDragEnd={() => setDraggingType(null)}
                      >
                        {BLOCK_TYPE_LABEL[t]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {!dash.datasource_id && (
          <span className="text-[11px] text-muted mt-1.5 block">
            No linked data source - Ask AI and manual build aren&apos;t available on this dashboard.
          </span>
        )}
      </div>

      {narrow && page.blocks.length > 0 && (
        <div className="text-[11px] text-muted mb-3 -mt-1">
          Blocks are shown full-width and in order on this screen size. Drag-and-drop positioning and resizing need a
          wider screen - everything else here still works.
        </div>
      )}

      {page.blocks.length === 0 ? (
        <div className="text-sm text-muted py-16 text-center border border-dashed border-border rounded-xl">
          This page has no blocks yet - add one above to get started.
        </div>
      ) : narrow ? (
        <div className="flex flex-col gap-4">
          {[...page.blocks]
            .sort((a, b) => a.y - b.y || a.x - b.x)
            .map((b) => (
              <div key={b.id} style={{ height: (STACK_MIN_HEIGHT[b.type] ?? 200) + 40 }}>
                <BlockCard
                  dashboardId={dash.id}
                  block={b}
                  columns={columns}
                  datasourceId={dash.datasource_id}
                  datasourceName={dash.datasource_name}
                  filterState={filterState}
                  onChange={onChange}
                />
              </div>
            ))}
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
          // 2026-09-25 (Round 15, element library): native react-grid-
          // layout external-drag-drop - isDroppable makes the grid listen
          // for a browser drag entering/leaving/dropping over it;
          // droppingItem sizes the ghost placeholder shown while hovering
          // (kept in sync with whichever card is actually being dragged,
          // via draggingType + BLOCK_DEFAULT_SIZE - the same numbers
          // _default_block_size computes server-side); onDrop fires once,
          // on release, with the grid cell it landed on.
          isDroppable
          droppingItem={{ i: "__dropping-elem__", x: 0, y: 0, ...(draggingType ? BLOCK_DEFAULT_SIZE[draggingType] : { w: 6, h: 6 }) }}
          onDropDragOver={() => (draggingType ? BLOCK_DEFAULT_SIZE[draggingType] : undefined)}
          onDrop={(_layout, item, e) => {
            const dropped = (e as DragEvent)?.dataTransfer?.getData("text/plain") as DashboardBlockType | undefined;
            const type = dropped && ELEMENT_LIBRARY_TYPES.includes(dropped) ? dropped : draggingType;
            setDraggingType(null);
            if (!type || !item) return;
            addBlock(type, { x: item.x, y: item.y });
          }}
        >
          {page.blocks.map((b) => (
            <div key={b.id}>
              <BlockCard
                dashboardId={dash.id}
                block={b}
                columns={columns}
                datasourceId={dash.datasource_id}
                datasourceName={dash.datasource_name}
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
