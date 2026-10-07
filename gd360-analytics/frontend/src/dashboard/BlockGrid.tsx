import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BlockResult, DashboardBlock, DashboardBlockType, DashboardParameter, FilteredBlock } from "../api/client";
import type { ChartExportApi } from "../components/ChartCanvas";
import { BlockFilterButton, useIsNarrow } from "../components/DashboardBlocks";
import {
  Button, ChartCard, CommentIcon, CopyIcon, DownloadIcon, EditIcon, FilterIcon, IconButton, MoreIcon, Popover, RefreshIcon, Sheet, SqlIcon, TrashIcon, cn,
} from "../ui";
import { downloadText, isLegacyBlock, resultOk, rowsToCsv, safeFilename } from "./blockData";
import { BlockRenderer } from "./BlockRenderer";
import { type CrossFilter, describeSpec, type ParamValue } from "./runState";
import type { DashboardRun, RunSource } from "./useDashboardRun";

// 2026-10-07 (Option A dashboard view): the 12-column block grid under
// the KPI strip. Every block sits in a kit ChartCard - title, a subtitle
// that says what it is and whether a filter narrows it, a quiet toolbar
// ("Filter this chart", "Show SQL", "..."), the block body from
// BlockRenderer, and the "Computed in BigQuery · 119,386 rows · 0.8 s"
// footer. KPI blocks live in KpiStrip, so the rows they occupied are
// collapsed here; otherwise each block keeps its stored x/y/w/h.

export const ROW_UNIT_PX = 48;
const GRID_GAP_PX = 16;
const STACK_HEIGHT: Partial<Record<DashboardBlockType, number>> = { table: 360, chart: 340, sql: 360, donut: 320, avatar_list: 300, gauge: 260, sparkline: 220, text: 160, heading: 64, divider: 40, input: 96 };

export type BlockSqlInfo = { sql: string; prior_sql?: string | null; sparkline_sql?: string | null; dialect?: string | null };

export type BlockOwnerActions = {
  onEdit?: (block: DashboardBlock) => void;
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
};

export const SWAP_OPTIONS: { label: string; payload: { chart_type?: string; type?: DashboardBlockType } }[] = [
  { label: "Bar chart", payload: { type: "chart", chart_type: "bar" } },
  { label: "Horizontal bars", payload: { type: "chart", chart_type: "horizontal_bar" } },
  { label: "Line chart", payload: { type: "chart", chart_type: "line" } },
  { label: "Area chart", payload: { type: "chart", chart_type: "area" } },
  { label: "Stacked bars", payload: { type: "chart", chart_type: "stacked_bar" } },
  { label: "Pie chart", payload: { type: "chart", chart_type: "pie" } },
  { label: "Donut", payload: { type: "donut" } },
  { label: "Table", payload: { type: "table" } },
  { label: "Top list", payload: { type: "avatar_list" } },
  { label: "KPI tile", payload: { type: "kpi" } },
];

export function MenuRow({ children, onClick, disabled, danger, icon }: { children: ReactNode; onClick?: () => void; disabled?: boolean; danger?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "ui-focus-inset flex w-full items-center gap-2.5 px-3 py-2 text-left text-ui hover:bg-subtle disabled:cursor-default disabled:text-faint disabled:hover:bg-transparent",
        danger ? "text-danger hover:bg-danger-fill" : "text-text"
      )}
    >
      {icon && <span className="inline-flex shrink-0 text-muted [&>svg]:block">{icon}</span>}
      {children}
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
  block, run, source, mode, parameters, owner, fetchSql, onExportApi, heightPx,
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

  const layoutOnly = block.type === "text" || block.type === "heading" || block.type === "divider" || block.type === "input";
  const legacy = mode === "warehouse" && isLegacyBlock(block);
  const spec = block.config?.spec;
  const crossColumn = resultOk(result) ? result.dimensions?.[0] || null : null;
  const selected: CrossFilter | null = crossColumn ? run.state.crossFilters[crossColumn] || null : null;
  const filtered = run.activeFilterCount > 0 || (run.state.blockFilters[block.id]?.length || 0) > 0;
  const canCrossFilter = Boolean(crossColumn) && !layoutOnly && mode === "warehouse";

  const subtitle: ReactNode = useMemo(() => {
    if (layoutOnly) return undefined;
    if (selected) {
      return (
        <span data-crossfilter-subtitle="" className="inline-flex flex-wrap items-center gap-x-1.5">
          <span>Click a bar to filter the page</span>
          <span aria-hidden="true">·</span>
          <span className="font-medium text-brand-ink">{selected.value === null ? "(Blanks)" : String(selected.value)} selected</span>
          <span aria-hidden="true">·</span>
          <button type="button" className="ui-focus rounded px-0.5 font-medium text-brand-ink hover:underline" onClick={() => run.setCrossFilter(null, crossColumn!)}>
            Clear
          </button>
        </span>
      );
    }
    const base = mode === "warehouse" ? (block.type === "sql" ? "SQL cell" : spec ? describeSpec(spec) : legacy ? "Built before warehouse-native dashboards" : "") : block.config?.recipe ? `${block.config.recipe.agg} of ${block.config.recipe.metric_column}${block.config.recipe.group_by_column ? ` by ${block.config.recipe.group_by_column}` : ""}` : "";
    const parts = [base, canCrossFilter ? "click a bar to filter" : "", filtered ? "filtered" : ""].filter(Boolean);
    return parts.length ? parts.join(" · ") : undefined;
  }, [layoutOnly, selected, mode, block, spec, legacy, canCrossFilter, filtered, run, crossColumn]);

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
  const computed =
    mode === "warehouse" && resultOk(result)
      ? { provider: result.computed_in || run.computedIn || undefined, rows: result.exact_total_rows ?? result.row_count, durationMs: result.duration_ms ?? undefined, cached: Boolean(result.cached) }
      : mode === "file"
        ? { provider: "GD360", rows: typeof run.matchedRows === "number" ? run.matchedRows : (Array.isArray((override?.config ?? block.config)?.rows) ? (override?.config ?? block.config).rows.length : undefined), cached: false }
        : null;

  const firstLoad = mode === "warehouse" && !run.ready && !result && !legacy;
  const blockError = mode === "warehouse" && result && result.status !== "ok" ? result.error || "This block couldn't be computed." : null;
  const bodyHeight = heightPx ? Math.max(120, heightPx - 56 - (computed ? 34 : 0)) : undefined;

  const toolbar = layoutOnly ? undefined : (
    <>
      {showFilterButton && (
        <span title="Filter this chart" className="inline-flex">
          <BlockFilterButton
            datasourceId={owner?.datasourceId || null}
            columns={columns}
            criteria={run.state.blockFilters[block.id] || []}
            onChange={(c) => run.setBlockFilters(block.id, c)}
          />
        </span>
      )}
      {mode === "warehouse" && !legacy && (
        <IconButton size="sm" aria-label="Show SQL" title="Show SQL" icon={<SqlIcon size={15} />} onClick={openSql} />
      )}
      <Popover
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
                {owner.onEdit && <MenuRow icon={<EditIcon size={14} />} onClick={() => { close(); owner.onEdit!(block); }}>Edit in canvas</MenuRow>}
                {owner.onSwap && (spec || block.config?.source_block_id) && (
                  <div className="px-3 pb-1 pt-2">
                    <div className="mb-1 text-caption font-medium uppercase tracking-caps text-muted">Swap to</div>
                    <div className="flex flex-wrap gap-1">
                      {SWAP_OPTIONS.filter((o) => !(o.payload.type === block.type && (o.payload.chart_type || null) === (block.config?.chart_type || null))).map((o) => (
                        <button
                          key={o.label}
                          type="button"
                          disabled={busy}
                          className="ui-focus rounded-full border border-border bg-surface px-2 py-[2px] text-caption text-secondary hover:border-border-strong hover:bg-subtle hover:text-text disabled:opacity-60"
                          onClick={async () => { setBusy(true); try { await owner.onSwap!(block, o.payload); } finally { setBusy(false); close(); } }}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {owner.onRemove && (
                  <MenuRow
                    danger
                    icon={<TrashIcon size={14} />}
                    disabled={busy}
                    onClick={async () => {
                      if (!window.confirm(`Remove "${block.title || "this block"}" from the page?`)) return;
                      setBusy(true);
                      try { await owner.onRemove!(block); } finally { setBusy(false); close(); }
                    }}
                  >
                    Remove
                  </MenuRow>
                )}
              </>
            )}
          </div>
        )}
      </Popover>
    </>
  );

  if (layoutOnly) {
    return (
      <div className="h-full" data-block-id={block.id} data-block-type={block.type}>
        <BlockRenderer block={block} mode={mode} parameters={parameters} paramValue={run.state.paramValues[parameters?.find((p) => p.id === block.config?.parameter_id)?.id || ""]} onParamChange={(id, v) => run.setParamValue(id, v)} source={source} />
      </div>
    );
  }

  return (
    <>
      <ChartCard
        id={`block-${block.id}`}
        title={block.title || (spec ? describeSpec(spec) : "Untitled block")}
        subtitle={subtitle}
        toolbar={toolbar}
        computed={computed}
        loading={firstLoad}
        error={blockError}
        onRetry={blockError ? () => run.rerunBlock(block.id) : undefined}
        flush={block.type === "table" || block.type === "sql"}
        className={cn("h-full", selected && "ring-1 ring-tint-border")}
        bodyClassName="flex flex-col"
      >
        <div className="relative min-h-0 flex-1" data-block-id={block.id} data-block-type={block.type}>
          {legacy ? (
            <div className="flex h-full flex-col">
              <BlockRenderer block={block} mode="file" override={override} onExportApi={block.type === "chart" ? handleExportApi : undefined} />
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
              bodyHeight={bodyHeight}
            />
          )}
          {run.loading && run.ready && !firstLoad && (
            <div aria-hidden="true" data-refilter-shimmer="" className="ui-shimmer pointer-events-none absolute inset-0 rounded-ctl opacity-30" />
          )}
        </div>
      </ChartCard>
      {sqlOpen && <SqlSheet open={sqlOpen} onClose={() => setSqlOpen(false)} block={block} info={sqlInfo} loading={sqlLoading} error={sqlError} />}
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

export function BlockGrid({ page, run, source, mode, parameters, owner, fetchSql, onExportApi, className }: BlockGridProps) {
  const narrow = useIsNarrow();
  const blocks = useMemo(() => page.blocks.filter((b) => b.type !== "kpi" && b.type !== "filter"), [page.blocks]);
  const laidOut = useMemo(() => compactLayout(blocks), [blocks]);

  // Register/unregister chart export APIs by block id (the header's
  // Export menu reads them).
  useEffect(() => () => { blocks.forEach((b) => onExportApi?.(b.id, null)); }, [blocks, onExportApi]);

  if (blocks.length === 0) {
    return <div className="py-10 text-center text-ui text-muted">This page has no blocks yet.</div>;
  }

  if (narrow) {
    const ordered = [...laidOut].sort((a, b) => a.y - b.y || a.block.x - b.block.x);
    return (
      <div className={cn("flex flex-col gap-4", className)}>
        {ordered.map(({ block }) => (
          <div key={block.id} style={{ minHeight: STACK_HEIGHT[block.type] ?? 240 }}>
            <BlockCard block={block} run={run} source={source} mode={mode} parameters={parameters} owner={owner} fetchSql={fetchSql} onExportApi={onExportApi} heightPx={STACK_HEIGHT[block.type] ?? 240} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      data-block-grid=""
      className={cn("grid", className)}
      style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gridAutoRows: `${ROW_UNIT_PX}px`, gap: `${GRID_GAP_PX}px` }}
    >
      {laidOut.map(({ block, y }) => {
        const h = Math.max(1, block.h);
        const heightPx = h * ROW_UNIT_PX + (h - 1) * GRID_GAP_PX;
        return (
          <div key={block.id} className="min-w-0" style={{ gridColumn: `${block.x + 1} / span ${Math.min(12, Math.max(1, block.w))}`, gridRow: `${y + 1} / span ${h}` }}>
            <BlockCard block={block} run={run} source={source} mode={mode} parameters={parameters} owner={owner} fetchSql={fetchSql} onExportApi={onExportApi} heightPx={heightPx} />
          </div>
        );
      })}
    </div>
  );
}
