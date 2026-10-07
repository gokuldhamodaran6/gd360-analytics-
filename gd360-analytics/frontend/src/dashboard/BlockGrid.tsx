import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BlockResult, DashboardBlock, DashboardBlockType, DashboardParameter, FilteredBlock } from "../api/client";
import type { ChartExportApi } from "../components/ChartCanvas";
import { BlockFilterButton, useIsNarrow } from "../components/DashboardBlocks";
import {
  BarChartIcon, Button, ChartCard, CommentIcon, ConfirmDialog, CopyIcon, DownloadIcon, EditIcon, GripIcon, HashIcon, IconButton, MoreIcon, Popover, RefreshIcon, Sheet, SqlIcon, TableIcon, TrashIcon, cn,
} from "../ui";
import { crossFilterColumn, downloadText, isDataBlock, isEmptyBlock, isLegacyBlock, markNoun, resultOk, rowsToCsv, safeFilename } from "./blockData";
import { effectiveChartType } from "./charts/recommend";
import { BlockRenderer, hasTableView } from "./BlockRenderer";
import { BlockMenu } from "./edit/BlockMenu";
import { EditGrid } from "./edit/EditGrid";
import { BLOCK_NOUN, EmptyBlockBody, EmptyBlockPlaceholder } from "./edit/EmptyBlock";
import { blockHeightPx, isGridBlock, viewLayout } from "./edit/layout";
import { useGridMetrics } from "./theme/ChartThemeContext";
import type { DashboardEditor } from "./edit/useDashboardEditor";
import { MenuRow, SwapChips } from "./menu";
import { fileBlockSpec } from "./fileData";
import { describeSpecShort } from "./format";
import { type CrossFilter, describeSpec, type ParamValue } from "./runState";
import type { DashboardRun, RunSource } from "./useDashboardRun";

// 2026-10-07 (Option A dashboard view): the 12-column block grid under
// the KPI strip. Every block sits in a kit ChartCard - title, a subtitle
// that says what it is and whether a filter narrows it, a quiet toolbar
// ("Filter this chart", "Show SQL", "..."), the block body from
// BlockRenderer, and the "Computed in BigQuery · 119,386 rows · 0.8 s"
// footer. KPI blocks live in KpiStrip, so the rows they occupied are
// collapsed here; otherwise each block keeps its stored x/y/w/h.
//
// 2026-10-07 (dashboard edit mode): the same grid, editable. With an
// `editor` (src/dashboard/edit/useDashboardEditor) the blocks are laid out
// by react-grid-layout on exactly this geometry (edit/layout.ts decides it
// for both renderings), a card's header is its drag handle, its title is
// click-to-rename, its "..." menu becomes the edit menu, and a block that
// was never built shows the "Describe what this block should show" state.
// Without one, an empty block is hidden from a viewer and a slim dashed
// placeholder for the owner.

export { ROW_UNIT_PX } from "./edit/layout";
export { MenuRow, SWAP_OPTIONS } from "./menu";
const STACK_HEIGHT: Partial<Record<DashboardBlockType, number>> = { table: 360, chart: 340, sql: 360, donut: 320, avatar_list: 300, gauge: 260, sparkline: 220, text: 160, heading: 64, divider: 40, input: 96 };

export type BlockSqlInfo = { sql: string; prior_sql?: string | null; sparkline_sql?: string | null; dialect?: string | null };

export type BlockOwnerActions = {
  // "Edit dashboard": switches the page to edit mode.
  onEdit?: (block?: DashboardBlock) => void;
  onSwap?: (block: DashboardBlock, payload: { chart_type?: string; type?: DashboardBlockType }) => Promise<void>;
  onRemove?: (block: DashboardBlock) => Promise<void>;
  commentCounts?: Record<string, { open: number; total: number }>;
  // 2026-10-07 (analyst canvas round): opens the block's comment threads
  // (the same panel the canvas pins to a cell).
  onComments?: (block: DashboardBlock) => void;
  datasourceId?: string | null;
  columnsFor?: (block: DashboardBlock) => { name: string; dtype: string }[] | undefined;
};

export type BlockGridProps = {
  page: { id: string; blocks: DashboardBlock[] };
  run: DashboardRun;
  source: RunSource;
  mode: "warehouse" | "file";
  parameters?: DashboardParameter[];
  owner?: BlockOwnerActions | null;
  // "Show SQL": the exact statement under the current rail state (owner:
  // GET /blocks/{id}/sql). Absent -> the run result's own `sql`.
  fetchSql?: (block: DashboardBlock) => Promise<BlockSqlInfo>;
  onExportApi?: (blockId: string, api: ChartExportApi | null) => void;
  className?: string;
  // The page is being edited (see the note at the top of this file).
  editor?: DashboardEditor | null;
};

// A data block (or a SQL cell) that was added but never built.
export function isBlockEmpty(block: DashboardBlock, run: Pick<DashboardRun, "emptyBlockIds">): boolean {
  if (!isDataBlock(block) && block.type !== "sql") return false;
  return isEmptyBlock(block) || (run.emptyBlockIds || []).includes(block.id);
}

// The block title while editing: the text itself is the rename target (and
// still part of the card's drag handle - a press that turns into a drag is
// not a click).
function EditableTitle({ text, renaming, onStart, onCommit, onCancel, placeholder }: { text: string; renaming: boolean; onStart: () => void; onCommit: (v: string) => void; onCancel: () => void; placeholder: string }) {
  const [draft, setDraft] = useState(text);
  const down = useRef<{ x: number; y: number } | null>(null);
  const done = useRef(false);
  useEffect(() => {
    if (renaming) {
      setDraft(text);
      done.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming]);
  if (renaming) {
    const commit = () => {
      if (done.current) return;
      done.current = true;
      onCommit(draft);
    };
    return (
      <input
        autoFocus
        data-no-drag=""
        data-title-input=""
        aria-label="Block title"
        value={draft}
        maxLength={200}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done.current = true; onCancel(); }
        }}
        className="ui-focus-inset block h-[22px] w-full min-w-[120px] rounded-[4px] border-0 bg-subtle px-1 text-body font-semibold text-text"
      />
    );
  }
  return (
    <button
      type="button"
      data-drag-title=""
      data-block-title=""
      title="Click to rename"
      onMouseDown={(e) => { down.current = { x: e.clientX, y: e.clientY }; }}
      onClick={(e) => {
        const d = down.current;
        down.current = null;
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return; // that was a drag
        onStart();
      }}
      className="ui-focus-inset block max-w-full cursor-[inherit] truncate rounded-[4px] text-left font-semibold decoration-border-strong decoration-dashed underline-offset-4 hover:underline"
    >
      {text}
    </button>
  );
}

export function SqlSheet({ open, onClose, block, info, loading, error }: { open: boolean; onClose: () => void; block: DashboardBlock; info: BlockSqlInfo | null; loading: boolean; error: string | null }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!info?.sql) return;
    try {
      await navigator.clipboard.writeText(info.sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be refused; the text is selectable either way.
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Show SQL"
      subtitle={<span className="truncate">{block.title || "Block"}{info?.dialect ? ` · ${info.dialect}` : ""}</span>}
      size="md"
      id={`sql-${block.id}`}
      footer={
        <Button variant="secondary" icon={<CopyIcon size={14} />} onClick={copy} disabled={!info?.sql}>
          {copied ? "Copied" : "Copy"}
        </Button>
      }
    >
      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {[90, 70, 80, 50].map((w, i) => <div key={i} className="ui-shimmer h-3.5" style={{ width: `${w}%` }} />)}
        </div>
      ) : error ? (
        <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-ui text-danger">{error}</div>
      ) : (
        <div className="flex flex-col gap-4">
          <pre data-block-sql="" className="overflow-x-auto whitespace-pre-wrap break-words rounded-ctl border border-border bg-subtle p-3 font-mono text-[12.5px] leading-relaxed text-text">{info?.sql || ""}</pre>
          {info?.prior_sql && (
            <details>
              <summary className="cursor-pointer text-caption font-medium uppercase tracking-caps text-muted">Prior period</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-ctl border border-border bg-subtle p-3 font-mono text-[12.5px] leading-relaxed text-text">{info.prior_sql}</pre>
            </details>
          )}
          {info?.sparkline_sql && (
            <details>
              <summary className="cursor-pointer text-caption font-medium uppercase tracking-caps text-muted">Sparkline</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-ctl border border-border bg-subtle p-3 font-mono text-[12.5px] leading-relaxed text-text">{info.sparkline_sql}</pre>
            </details>
          )}
        </div>
      )}
    </Sheet>
  );
}

export function BlockCard({
  block, run, source, mode, parameters, owner, fetchSql, onExportApi, heightPx, editor = null, stacked = false,
}: {
  block: DashboardBlock;
  run: DashboardRun;
  source: RunSource;
  mode: "warehouse" | "file";
  parameters?: DashboardParameter[];
  owner?: BlockOwnerActions | null;
  fetchSql?: (block: DashboardBlock) => Promise<BlockSqlInfo>;
  onExportApi?: (blockId: string, api: ChartExportApi | null) => void;
  heightPx?: number;
  editor?: DashboardEditor | null;
  // Narrow, stacked layout: no dragging, no positions.
  stacked?: boolean;
}) {
  const result: BlockResult | undefined = run.results[block.id];
  const override: FilteredBlock | undefined = run.overrides[block.id];
  const exportApi = useRef<ChartExportApi | null>(null);
  const handleExportApi = useCallback(
    (api: ChartExportApi | null) => {
      exportApi.current = api;
      onExportApi?.(block.id, api);
    },
    [block.id, onExportApi]
  );
  const [sqlOpen, setSqlOpen] = useState(false);
  const [sqlInfo, setSqlInfo] = useState<BlockSqlInfo | null>(null);
  const [sqlLoading, setSqlLoading] = useState(false);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // 2026-10-07 (chart-types round): "View as table" - every chart has its
  // table twin, one click away for anyone who can see the card (this
  // viewer's own choice; nothing is stored).
  const [asTable, setAsTable] = useState(false);

  const layoutOnly = block.type === "text" || block.type === "heading" || block.type === "divider" || block.type === "input";
  const empty = isBlockEmpty(block, run);
  const legacy = mode === "warehouse" && isLegacyBlock(block) && !empty;
  const dragClass = editor && !stacked ? "block-drag-handle" : undefined;
  const spec = block.config?.spec;
  const crossColumn = resultOk(result) ? crossFilterColumn(result, block) : null;
  const selected: CrossFilter | null = crossColumn ? run.state.crossFilters[crossColumn] || null : null;
  // The form on screen (a chart GD360 chose is confirmed against the rows).
  const noun = markNoun(block.type, resultOk(result) ? effectiveChartType(block.config, result, block.type).chartType : block.config?.chart_type);
  const filtered = run.activeFilterCount > 0 || (run.state.blockFilters[block.id]?.length || 0) > 0;
  const canCrossFilter = Boolean(crossColumn) && !layoutOnly && mode === "warehouse";
  // A file block described the way a warehouse block's spec describes it
  // ("Bookings by month · Bookings export") - fileData's adapter (round 9).
  const fileSpec = useMemo(
    () => (mode === "file" && !layoutOnly ? fileBlockSpec(block, override, { sourceName: source.name }) : null),
    [mode, layoutOnly, block, override, source.name]
  );

  const subtitle: ReactNode = useMemo(() => {
    if (layoutOnly) return undefined;
    if (selected) {
      return (
        <span data-crossfilter-subtitle="" className="inline-flex flex-wrap items-center gap-x-1.5">
          <span>Click a {noun} to filter the page</span>
          <span aria-hidden="true">·</span>
          <span className="font-medium text-brand-ink">{selected.value === null ? "(Blanks)" : String(selected.value)} selected</span>
          <span aria-hidden="true">·</span>
          <button type="button" className="ui-focus rounded px-0.5 font-medium text-brand-ink hover:underline" onClick={() => run.setCrossFilter(null, crossColumn!)}>
            Clear
          </button>
        </span>
      );
    }
    // What the block shows, in the reader's words: humanised measure names,
    // the grain, the table ("Total revenue, Total bookings by month ·
    // Hotel_data"). The query-level sentence (describeSpec: "sum of adr *
    // (...) from Hotel_data by ...") is the second line of the tooltip.
    const exact = mode === "warehouse" && spec && block.type !== "sql" ? describeSpec(spec) : "";
    const base = mode === "warehouse" ? (block.type === "sql" ? "SQL cell" : spec ? describeSpecShort(spec, resultOk(result) ? result.period : null) : legacy ? "Built before warehouse-native dashboards" : "") : fileSpec ? describeSpecShort(fileSpec) : "";
    const parts = [base, canCrossFilter ? `click a ${noun} to filter` : "", filtered ? "filtered" : ""].filter(Boolean);
    if (!parts.length) return undefined;
    // One line, always (a long description must never push the chart down
    // or make two cards in a row start their plots at different heights);
    // the full text is the tooltip.
    const text = parts.join(" · ");
    return <span data-block-subtitle="" className="block truncate" title={exact && exact !== base ? `${text}\n${exact}` : text}>{text}</span>;
  }, [layoutOnly, selected, mode, block, spec, legacy, canCrossFilter, filtered, run, crossColumn, result, fileSpec, noun]);

  const openSql = async () => {
    setSqlOpen(true);
    setSqlError(null);
    if (fetchSql) {
      setSqlLoading(true);
      try {
        setSqlInfo(await fetchSql(block));
      } catch (e: any) {
        setSqlError(e?.response?.data?.detail || "Couldn't load this block's SQL.");
      } finally {
        setSqlLoading(false);
      }
    } else if (result?.sql) {
      setSqlInfo({ sql: result.sql, prior_sql: result.prior?.sql, sparkline_sql: result.sparkline?.sql, dialect: result.computed_in });
    } else {
      setSqlInfo({ sql: block.query_sql || "", dialect: block.config?.computed_in });
    }
  };

  const downloadCsv = () => {
    if (mode === "warehouse" && resultOk(result)) {
      downloadText(`${safeFilename(block.title)}.csv`, rowsToCsv(result.columns.map((c) => c.name), result.rows));
      return;
    }
    const cfg = override?.config ?? block.config ?? {};
    const columns: string[] = Array.isArray(cfg.columns) ? cfg.columns : Array.isArray(cfg.result_columns) ? cfg.result_columns.map((c: any) => (typeof c === "string" ? c : c.name)) : [];
    const rows: Record<string, any>[] = Array.isArray(cfg.rows) ? cfg.rows : Array.isArray(cfg.result_rows) ? cfg.result_rows : [];
    if (columns.length) downloadText(`${safeFilename(block.title)}.csv`, rowsToCsv(columns, rows));
  };

  const columns = owner?.columnsFor?.(block);
  const showFilterButton = !layoutOnly && mode === "warehouse" ? Boolean(owner && (columns?.length || owner.datasourceId)) : Boolean(owner?.datasourceId && (block.config?.recipe || block.config?.result_columns));
  const comments = owner?.commentCounts?.[block.id];
  // "· N rows" in the footer is how many rows the number was computed
  // OVER (the table's count). 2026-10-07 (real end-to-end run): when the
  // backend had no such count it used to fall back to the result's own
  // row count, so the same footer read "119,386 rows" one minute and
  // "2 rows" the next for a two-bar chart. For a spec block it is now the
  // table's count or nothing; a SQL cell's result keeps its row count.
  const computed =
    mode === "warehouse" && resultOk(result)
      ? { provider: result.computed_in || run.computedIn || undefined, rows: result.exact_total_rows ?? (result.spec ? undefined : result.row_count), durationMs: result.duration_ms ?? undefined, cached: Boolean(result.cached) }
      : mode === "file"
        ? { provider: "GD360", rows: typeof run.matchedRows === "number" ? run.matchedRows : (Array.isArray((override?.config ?? block.config)?.rows) ? (override?.config ?? block.config).rows.length : undefined), cached: false }
        : null;

  const firstLoad = mode === "warehouse" && !run.ready && !result && !legacy && !empty;
  const blockError = mode === "warehouse" && !empty && result && result.status !== "ok" ? result.error || "This block couldn't be computed." : null;
  // The chart is drawn to the body's real height. In the grid the card has
  // a definite height, so the body is measured (a two-line subtitle or a
  // wrapped footer no longer pushes the plot over the card's edge); a
  // stacked card sizes to its content and keeps the estimate.
  // (The body only mounts once the card's first-load shimmer is gone, so
  // the element is tracked in state, not a ref.)
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const [measuredBody, setMeasuredBody] = useState<number | null>(null);
  const measureBody = Boolean(heightPx) && !stacked;
  useLayoutEffect(() => {
    const el = bodyEl;
    if (!measureBody || !el) {
      setMeasuredBody(null);
      return;
    }
    const measure = () => {
      const h = el.clientHeight;
      setMeasuredBody((prev) => (h > 0 && (prev === null || Math.abs(prev - h) > 1) ? h : prev));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureBody, heightPx, bodyEl]);
  const bodyHeight = measuredBody ?? (heightPx ? Math.max(120, heightPx - 56 - (computed ? 34 : 0)) : undefined);

  const editMenu = editor ? (
    <BlockMenu editor={editor} block={block} variant="grid" stacked={stacked} onRename={() => setRenaming(true)} onOpenChange={setMenuOpen} />
  ) : null;

  const toolbar = layoutOnly ? undefined : empty && editor ? editMenu : (
    <>
      {showFilterButton && !empty && (
        <span title="Filter this chart" className="inline-flex">
          <BlockFilterButton
            datasourceId={owner?.datasourceId || null}
            columns={columns}
            criteria={run.state.blockFilters[block.id] || []}
            onChange={(c) => run.setBlockFilters(block.id, c)}
          />
        </span>
      )}
      {hasTableView(block.type) && !empty && !legacy && block.config?.chart_type !== "pivot" && (mode === "file" || resultOk(result)) && (
        <IconButton
          size="sm"
          aria-label={asTable ? "View as chart" : "View as table"}
          title={asTable ? "View as chart" : "View as table"}
          aria-pressed={asTable}
          data-view-as-table-toggle=""
          icon={asTable ? <BarChartIcon size={15} /> : <TableIcon size={15} />}
          onClick={() => setAsTable((v) => !v)}
        />
      )}
      {/* Never on a published link: the statement names tables and columns. */}
      {mode === "warehouse" && !legacy && !empty && !source.hideSql && (
        <IconButton size="sm" aria-label="Show SQL" title="Show SQL" icon={<SqlIcon size={15} />} onClick={openSql} />
      )}
      {editMenu || (
      <Popover
        portal
        align="end"
        width={220}
        haspopup="menu"
        role="menu"
        ariaLabel="Block options"
        trigger={(api) => (
          <span className="relative inline-flex">
            <IconButton size="sm" aria-label="More options" title="More options" icon={<MoreIcon size={15} />} data-popover-trigger="" {...api.props} />
            {comments && comments.open > 0 && (
              <span className="pointer-events-none absolute -right-0.5 -top-0.5 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-primary px-1 text-[9.5px] font-semibold text-white tabular-nums">
                {comments.open}
              </span>
            )}
          </span>
        )}
      >
        {({ close }) => (
          <div className="py-1">
            {owner && (comments || owner.onComments) && (
              owner.onComments ? (
                <MenuRow icon={<CommentIcon size={14} />} onClick={() => { close(); owner.onComments!(block); }}>
                  {comments && comments.total > 0 ? `${comments.total} comment${comments.total === 1 ? "" : "s"} · ${comments.open} open` : "Comment"}
                </MenuRow>
              ) : (
                <div className="flex items-center gap-2.5 px-3 py-2 text-caption text-muted">
                  <CommentIcon size={14} />
                  {comments!.total} comment{comments!.total === 1 ? "" : "s"} · {comments!.open} open
                </div>
              )
            )}
            {exportApi.current && (
              <MenuRow icon={<DownloadIcon size={14} />} onClick={() => { close(); exportApi.current?.download("png"); }}>Export PNG</MenuRow>
            )}
            <MenuRow icon={<DownloadIcon size={14} />} onClick={() => { close(); downloadCsv(); }} disabled={mode === "warehouse" ? !resultOk(result) : false}>
              Download CSV
            </MenuRow>
            {mode === "warehouse" && !legacy && (
              <MenuRow icon={<RefreshIcon size={14} />} onClick={() => { close(); run.rerunBlock(block.id); }}>Recompute</MenuRow>
            )}
            {owner && (
              <>
                <div className="my-1 border-t border-subtle" />
                {owner.onEdit && <MenuRow icon={<EditIcon size={14} />} onClick={() => { close(); owner.onEdit!(block); }}>Edit dashboard</MenuRow>}
                {owner.onSwap && (spec || block.config?.source_block_id) && (
                  <div className="pt-2">
                    <div className="mb-1 px-3 text-caption font-medium uppercase tracking-caps text-muted">Swap to</div>
                    {/* Only the forms this block's data can be drawn as; the rest say what they need. */}
                    <SwapChips block={block} result={result} busy={busy} onSwap={async (payload) => { setBusy(true); try { await owner.onSwap!(block, payload); } finally { setBusy(false); close(); } }} />
                  </div>
                )}
                {owner.onRemove && (
                  <MenuRow
                    danger
                    icon={<TrashIcon size={14} />}
                    disabled={busy}
                    onClick={() => { close(); setConfirmRemove(true); }}
                  >
                    Remove
                  </MenuRow>
                )}
              </>
            )}
          </div>
        )}
      </Popover>
      )}
    </>
  );

  const removeDialog = owner?.onRemove ? (
    <ConfirmDialog
      open={confirmRemove}
      title={`Remove "${block.title || "this block"}"?`}
      busy={busy}
      onCancel={() => setConfirmRemove(false)}
      onConfirm={async () => {
        setBusy(true);
        try { await owner.onRemove!(block); } finally { setBusy(false); setConfirmRemove(false); }
      }}
    >
      The block is deleted from this page. Its data stays where it is.
    </ConfirmDialog>
  ) : null;

  if (layoutOnly) {
    const body = (
      <BlockRenderer
        block={block}
        mode={mode}
        parameters={parameters}
        paramValue={run.state.paramValues[parameters?.find((p) => p.id === block.config?.parameter_id)?.id || ""]}
        onParamChange={(id, v) => run.setParamValue(id, v)}
        source={source}
        dateBounds={run.dateBounds}
        editing={editor ? { onSaveText: (text) => editor.updateConfig(block, { text }) } : undefined}
      />
    );
    if (!editor) {
      return (
        <div className="h-full" data-block-id={block.id} data-block-type={block.type}>
          {body}
        </div>
      );
    }
    // Editing: the block is typed into in place; a small chrome (grip +
    // menu) appears on its top edge on hover or focus, clear of the words.
    return (
      <div className="gd-edit-card group relative h-full rounded-card" data-block-id={block.id} data-block-type={block.type}>
        {body}
        <div
          className={cn(
            "absolute -top-5 right-2 z-[2] flex items-center rounded-ctl border border-border bg-surface shadow-card transition-opacity duration-100",
            menuOpen ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"
          )}
          data-edit-chrome=""
        >
          {!stacked && (
            <span className="block-drag-handle inline-flex h-7 w-6 items-center justify-center rounded-[6px] text-muted hover:bg-subtle hover:text-text" title="Drag to move" aria-hidden="true">
              <GripIcon size={14} />
            </span>
          )}
          <BlockMenu editor={editor} block={block} variant="grid" stacked={stacked} onOpenChange={setMenuOpen} />
        </div>
      </div>
    );
  }

  const titleText = block.title || (spec ? describeSpecShort(spec) : block.type === "sql" && block.config?.name ? String(block.config.name) : "Untitled block");
  const showEmptyState = empty && Boolean(editor);

  return (
    <>
      <ChartCard
        id={`block-${block.id}`}
        title={
          editor ? (
            <EditableTitle
              text={titleText}
              renaming={renaming}
              placeholder={`Name this ${BLOCK_NOUN[block.type] || "block"}`}
              onStart={() => setRenaming(true)}
              onCancel={() => setRenaming(false)}
              onCommit={(v) => { setRenaming(false); editor.renameBlock(block, v); }}
            />
          ) : (
            titleText
          )
        }
        subtitle={showEmptyState ? undefined : subtitle}
        toolbar={toolbar}
        computed={showEmptyState ? null : computed}
        loading={firstLoad}
        error={blockError}
        onRetry={blockError ? () => run.rerunBlock(block.id) : undefined}
        flush={!showEmptyState && (block.type === "table" || block.type === "sql" || (asTable && hasTableView(block.type)))}
        className={cn("h-full", selected && "ring-1 ring-tint-border", editor && "gd-edit-card")}
        headerClassName={dragClass}
        bodyClassName="flex flex-col"
      >
        <div ref={setBodyEl} className="relative min-h-0 flex-1" data-block-id={block.id} data-block-type={block.type}>
          {showEmptyState ? (
            <EmptyBlockBody editor={editor!} block={block} />
          ) : legacy ? (
            <div className="flex h-full flex-col">
              <BlockRenderer block={block} mode="file" override={override} onExportApi={block.type === "chart" ? handleExportApi : undefined} bodyHeight={bodyHeight} sourceName={source.name} />
            </div>
          ) : (
            <BlockRenderer
              block={block}
              mode={mode}
              result={result}
              override={override}
              selected={selected}
              onCrossFilter={canCrossFilter ? (cf) => run.setCrossFilter(cf) : undefined}
              onExportApi={block.type === "chart" ? handleExportApi : undefined}
              parameters={parameters}
              source={source}
              sourceName={source.name}
              bodyHeight={bodyHeight}
              growToContent={stacked}
              viewAsTable={asTable}
            />
          )}
          {run.loading && run.ready && !firstLoad && (
            <div aria-hidden="true" data-refilter-shimmer="" className="ui-shimmer pointer-events-none absolute inset-0 rounded-ctl opacity-30" />
          )}
        </div>
      </ChartCard>
      {sqlOpen && <SqlSheet open={sqlOpen} onClose={() => setSqlOpen(false)} block={block} info={sqlInfo} loading={sqlLoading} error={sqlError} />}
      {removeDialog}
    </>
  );
}

// Collapses the rows KPI blocks (shown in the strip) and any empty bands
// occupied, keeping every other block's relative placement.
export function compactLayout(blocks: DashboardBlock[]): { block: DashboardBlock; y: number }[] {
  const occupied = new Set<number>();
  for (const b of blocks) for (let r = b.y; r < b.y + Math.max(1, b.h); r++) occupied.add(r);
  const rows = Array.from(occupied).sort((a, b) => a - b);
  const map = new Map<number, number>();
  rows.forEach((r, i) => map.set(r, i));
  return blocks.map((b) => ({ block: b, y: map.get(b.y) ?? 0 }));
}

// What the page's grid area says when it has nothing to lay out.
function EmptyGrid({ editor, owner, hasKpis }: { editor: DashboardEditor | null; owner?: BlockOwnerActions | null; hasKpis: boolean }) {
  if (!editor) {
    return (
      <div className="py-10 text-center text-ui text-muted">
        This page has no blocks yet.
        {owner?.onEdit && (
          <>
            {" "}
            <button type="button" className="ui-focus rounded px-0.5 font-medium text-brand-ink hover:underline" onClick={() => owner.onEdit!()}>Edit dashboard</button> to add one.
          </>
        )}
      </div>
    );
  }
  const quick: { type: DashboardBlockType; label: string; icon: ReactNode }[] = [
    ...(hasKpis ? [] : [{ type: "kpi" as DashboardBlockType, label: "KPI", icon: <HashIcon size={15} /> }]),
    { type: "chart", label: "Chart", icon: <BarChartIcon size={15} /> },
    { type: "table", label: "Table", icon: <TableIcon size={15} /> },
  ];
  return (
    <div data-empty-page="" className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border-strong px-6 py-12 text-center">
      <div className="text-section font-semibold text-text">{hasKpis ? "Add a chart or a table under the numbers" : "Start with a block"}</div>
      <div className="max-w-[440px] text-ui text-muted">Add a block, describe what it should show, and it is built from your data. You can move and resize it afterwards.</div>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        {quick.map((q) => (
          <Button key={q.type} variant="secondary" icon={q.icon} disabled={editor.adding} onClick={() => editor.addBlock(q.type)} data-quick-add={q.type}>
            {q.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function BlockGrid({ page, run, source, mode, parameters, owner, fetchSql, onExportApi, className, editor = null }: BlockGridProps) {
  const narrow = useIsNarrow();
  // Row height and gap for the dashboard's density - the editor's grid
  // (EditGrid) reads the same two numbers.
  const metrics = useGridMetrics();
  const all = useMemo(() => page.blocks.filter(isGridBlock), [page.blocks]);
  // A block that was never built: full size with its "Describe..." state
  // in the editor, a slim placeholder for the owner, nothing for a viewer.
  const emptyIds = useMemo(() => new Set(all.filter((b) => isBlockEmpty(b, run)).map((b) => b.id)), [all, run]);
  const blocks = useMemo(() => (editor || owner ? all : all.filter((b) => !emptyIds.has(b.id))), [all, editor, owner, emptyIds]);
  const layout = useMemo(() => {
    if (editor) return editor.gridLayout;
    const slim: Record<string, number> = {};
    emptyIds.forEach((id) => { slim[id] = 1; });
    return viewLayout(blocks, slim);
  }, [editor, blocks, emptyIds]);
  const byId = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);

  // Register/unregister chart export APIs by block id (the header's
  // Export menu reads them).
  useEffect(() => () => { blocks.forEach((b) => onExportApi?.(b.id, null)); }, [blocks, onExportApi]);

  if (blocks.length === 0) {
    return <EmptyGrid editor={editor} owner={owner} hasKpis={page.blocks.some((b) => b.type === "kpi")} />;
  }

  const card = (block: DashboardBlock, heightPx: number, stacked: boolean) =>
    !editor && emptyIds.has(block.id) ? (
      <EmptyBlockPlaceholder onEdit={owner?.onEdit ? () => owner.onEdit!(block) : undefined} />
    ) : (
      <BlockCard block={block} run={run} source={source} mode={mode} parameters={parameters} owner={owner} fetchSql={fetchSql} onExportApi={onExportApi} heightPx={heightPx} editor={editor} stacked={stacked} />
    );

  if (narrow) {
    const ordered = [...layout].sort((a, b) => a.y - b.y || a.x - b.x).map((it) => byId.get(it.i)).filter((b): b is DashboardBlock => Boolean(b));
    return (
      <div className={cn("flex flex-col", className)} style={{ gap: metrics.gap }} data-block-stack="">
        {editor && (
          <div className="text-caption text-muted" data-stack-note="">
            Blocks are stacked on this screen. Dragging and resizing need a wider one — everything else works here.
          </div>
        )}
        {ordered.map((block) => {
          const slim = !editor && emptyIds.has(block.id);
          const h = slim ? metrics.rowUnit : STACK_HEIGHT[block.type] ?? 240;
          return (
            <div key={block.id} style={{ minHeight: h }}>
              {card(block, h, true)}
            </div>
          );
        })}
      </div>
    );
  }

  if (editor) {
    return <EditGrid className={className} blocks={blocks} layout={layout} onLayoutCommit={editor.commitLayout} renderBlock={(block, heightPx) => card(block, heightPx, false)} />;
  }

  return (
    <div
      data-block-grid=""
      className={cn("grid", className)}
      style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gridAutoRows: `${metrics.rowUnit}px`, gap: `${metrics.gap}px` }}
    >
      {layout.map((it) => {
        const block = byId.get(it.i);
        if (!block) return null;
        return (
          <div key={block.id} className="min-w-0" style={{ gridColumn: `${it.x + 1} / span ${it.w}`, gridRow: `${it.y + 1} / span ${it.h}` }}>
            {card(block, blockHeightPx(it.h, metrics), false)}
          </div>
        );
      })}
    </div>
  );
}
