import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DashboardBlock, DashboardBuilderPage, DashboardParameter, DashboardPeriod, UpgradeBlocksResult, WarehouseDashboardFields } from "../api/client";
import type { ChartExportApi } from "../components/ChartCanvas";
import {
  Button, DateRangePicker, DownloadIcon, EditIcon, FilterIcon, Popover, ProviderBadge, RefreshIcon, SavedViewSelect, SegmentedControl, WarningIcon, cn, providerDisplayName,
} from "../ui";
import { downloadText, isDataBlock, isLegacyBlock, resultOk, rowsToCsv, safeFilename } from "./blockData";
import { BlockGrid, type BlockGridProps } from "./BlockGrid";
import { FilterRailPanel } from "./FilterRailPanel";
import { KpiStrip } from "./KpiStrip";
import { PERIOD_LABEL, PERIODS, relativeTime } from "./runState";
import type { DashboardRun, RunSource } from "./useDashboardRun";
import { CanvasView } from "./canvas/CanvasView";
import type { CanvasOwnerActions } from "./canvas/cells";
import type { DashboardViewMode } from "./canvas/useViewMode";
import { CommentsSheet } from "./comments/CommentThread";
import type { CommentsApi } from "./comments/useComments";

// 2026-10-07 (Option A dashboard view, Main.dc.html): the page a dashboard
// is VIEWED through - the owner's view/preview mode and the published
// link render this same tree. Header row (title, "Hotel_data · BigQuery ·
// refreshed 4 min ago · 119,386 rows", saved views, Day/Week/Month/Year,
// date range, Export, "Edit dashboard" for the owner), the 260 px filter
// rail, the KPI strip and the block grid.

export type DashboardShellProps = {
  dashboard: WarehouseDashboardFields & { name: string; datasource_name?: string | null };
  page: DashboardBuilderPage | undefined;
  run: DashboardRun;
  source: RunSource;
  mode: "warehouse" | "file";
  parameters?: DashboardParameter[];
  owner?: BlockGridProps["owner"];
  fetchSql?: BlockGridProps["fetchSql"];
  // Header slots.
  onEditDashboard?: () => void;
  headerExtra?: ReactNode;
  // Legacy blocks: "Upgrade them" (owner of a warehouse dashboard).
  onUpgradeBlocks?: () => Promise<UpgradeBlocksResult>;
  // Above the grid (page tabs, notices).
  beforeContent?: ReactNode;
  afterContent?: ReactNode;
  // Hide the rail entirely (a page with nothing to filter still shows it
  // by default, with its honest "No filters" note).
  hideRail?: boolean;
  className?: string;
  // A page's own background tint (the owner's per-page colour).
  style?: React.CSSProperties;
  // 2026-10-07 (analyst canvas round): which rendering of the same blocks
  // - the grid ("dashboard") or the numbered-cell canvas ("canvas"). The
  // header shows the Dashboard · Canvas toggle whenever onViewChange is
  // given; the canvas's owner actions and the comments hook are optional
  // (the published view passes neither and gets a read-only canvas).
  view?: DashboardViewMode;
  onViewChange?: (v: DashboardViewMode) => void;
  canvasOwner?: CanvasOwnerActions | null;
  comments?: CommentsApi | null;
};

function nowIso() {
  return new Date().toISOString();
}

function ExportMenu({ page, run, exportApis, mode }: { page: DashboardBuilderPage | undefined; run: DashboardRun; exportApis: React.MutableRefObject<Record<string, ChartExportApi | null>>; mode: "warehouse" | "file" }) {
  const blocks = (page?.blocks || []).filter((b) => isDataBlock(b) || b.type === "sql");
  const csvFor = (b: DashboardBlock) => {
    if (mode === "warehouse") {
      const r = run.results[b.id];
      if (!resultOk(r)) return;
      downloadText(`${safeFilename(b.title)}.csv`, rowsToCsv(r.columns.map((c) => c.name), r.rows));
      return;
    }
    const cfg = run.overrides[b.id]?.config ?? b.config ?? {};
    const columns: string[] = Array.isArray(cfg.columns) ? cfg.columns : Array.isArray(cfg.result_columns) ? cfg.result_columns.map((c: any) => (typeof c === "string" ? c : c.name)) : [];
    const rows: Record<string, any>[] = Array.isArray(cfg.rows) ? cfg.rows : Array.isArray(cfg.result_rows) ? cfg.result_rows : [];
    if (columns.length) downloadText(`${safeFilename(b.title)}.csv`, rowsToCsv(columns, rows));
  };
  return (
    <Popover
      align="end"
      width={300}
      haspopup="menu"
      role="menu"
      ariaLabel="Export"
      trigger={(api) => (
        <Button variant="secondary" icon={<DownloadIcon size={15} />} data-popover-trigger="" {...api.props}>
          Export
        </Button>
      )}
    >
      {({ close }) => (
        <div className="max-h-[70vh] overflow-y-auto py-1">
          <div className="px-3 pb-1 pt-2 text-caption font-medium uppercase tracking-caps text-muted">Blocks</div>
          {blocks.length === 0 && <div className="px-3 py-2 text-caption text-muted">Nothing to export on this page.</div>}
          {blocks.map((b) => {
            const api = exportApis.current[b.id];
            const hasRows = mode === "warehouse" ? resultOk(run.results[b.id]) : true;
            return (
              <div key={b.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                <span className="min-w-0 truncate text-ui text-text">{b.title || "Untitled block"}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {api && (
                    <button type="button" className="ui-focus rounded px-1 text-caption font-medium text-brand-ink hover:underline" onClick={() => { close(); api.download("png"); }}>PNG</button>
                  )}
                  <button type="button" disabled={!hasRows} className="ui-focus rounded px-1 text-caption font-medium text-brand-ink hover:underline disabled:text-faint disabled:no-underline" onClick={() => { close(); csvFor(b); }}>CSV</button>
                </span>
              </div>
            );
          })}
          <div className="my-1 border-t border-subtle" />
          <button type="button" role="menuitem" className="ui-focus-inset flex w-full items-center gap-2.5 px-3 py-2 text-left text-ui text-text hover:bg-subtle" onClick={() => { close(); if (typeof window !== "undefined") window.print(); }}>
            Print / Save as PDF
          </button>
        </div>
      )}
    </Popover>
  );
}

export function LegacyBlocksBanner({ count, onUpgrade }: { count: number; onUpgrade?: () => Promise<UpgradeBlocksResult> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UpgradeBlocksResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const failures = result?.results.filter((r) => r.status === "failed") || [];
  return (
    <div role="status" data-legacy-banner="" className="flex flex-col gap-2 rounded-card border border-warning-border bg-warning-fill px-4 py-3 text-ui text-warning">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <WarningIcon size={16} className="shrink-0" />
        <span className="min-w-0 flex-1">
          {result
            ? `${result.upgraded} upgraded, ${result.failed} failed, ${result.skipped} already warehouse-native.`
            : `${count === 1 ? "One block was" : "Some blocks were"} built before warehouse-native dashboards.`}
        </span>
        {!result && !onUpgrade && <span className="text-caption">They keep showing their last saved result. The dashboard's editor can upgrade them.</span>}
        {!result && onUpgrade && (
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setResult(await onUpgrade());
              } catch (e: any) {
                setError(e?.response?.data?.detail || "The upgrade couldn't run.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Upgrade them
          </Button>
        )}
        <button type="button" className="ui-focus rounded px-1 text-caption text-warning hover:underline" onClick={() => setDismissed(true)}>Dismiss</button>
      </div>
      {error && <div className="text-caption">{error}</div>}
      {failures.length > 0 && (
        <ul className="flex flex-col gap-1 text-caption">
          {failures.map((f) => (
            <li key={f.block_id}>
              <span className="font-medium">{f.title || f.block_id}:</span> {f.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DashboardShell({
  dashboard, page, run, source, mode, parameters, owner, fetchSql, onEditDashboard, headerExtra, onUpgradeBlocks, beforeContent, afterContent, hideRail = false, className, style,
  view = "dashboard", onViewChange, canvasOwner = null, comments = null,
}: DashboardShellProps) {
  const canvas = view === "canvas";
  // The grid's "N comments" menu row opens the same thread panel the
  // canvas pins to a cell.
  const [commentsFor, setCommentsFor] = useState<DashboardBlock | null>(null);
  const ownerWithComments = useMemo(() => {
    if (!owner) return owner;
    if (!comments?.enabled) return owner;
    // Until the threads have loaded once, keep the counts the dashboard
    // payload already carried (comment_counts) so the badge never blinks.
    const counts = comments.loading && comments.threads.length === 0 ? owner.commentCounts : comments.counts;
    return { ...owner, commentCounts: counts, onComments: (b: DashboardBlock) => setCommentsFor(b) };
  }, [owner, comments]);
  const exportApis = useRef<Record<string, ChartExportApi | null>>({});
  const onExportApi = useCallback((blockId: string, api: ChartExportApi | null) => {
    if (api) exportApis.current[blockId] = api;
    else delete exportApis.current[blockId];
  }, []);
  const [pinned, setPinned] = useState(false);
  const pinToUrl = async () => {
    const ok = await run.copyLink();
    setPinned(ok);
    if (ok) setTimeout(() => setPinned(false), 1800);
  };
  const [savePrompt, setSavePrompt] = useState(false);
  const [viewName, setViewName] = useState("");
  const [viewError, setViewError] = useState<string | null>(null);
  const [tick, setTick] = useState(() => nowIso());
  useEffect(() => {
    const id = window.setInterval(() => setTick(nowIso()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const legacyCount = useMemo(() => (mode === "warehouse" ? (page?.blocks || []).filter(isLegacyBlock).length : 0), [mode, page]);
  const provider = dashboard.datasource_kind ? providerDisplayName(dashboard.datasource_kind) : mode === "file" ? "GD360" : null;
  const refreshed = relativeTime(run.lastRunAt, new Date(tick).getTime());
  const totalRows = run.totalRows ?? (mode === "file" && run.activeFilterCount === 0 ? run.matchedRows : null);
  const subtitleParts: ReactNode[] = [];
  if (dashboard.datasource_name) subtitleParts.push(dashboard.datasource_name);
  if (dashboard.datasource_kind) subtitleParts.push(<ProviderBadge provider={dashboard.datasource_kind} />);
  else if (provider) subtitleParts.push(provider);
  if (refreshed) subtitleParts.push(`refreshed ${refreshed}`);
  else if (run.loading) subtitleParts.push("refreshing…");
  if (typeof totalRows === "number") subtitleParts.push(`${totalRows.toLocaleString()} rows`);

  const showRail = !hideRail && !canvas;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)} style={style} data-dashboard-shell="">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-6 pb-4 pt-5 print:px-0">
        <div className="min-w-0">
          <h1 className="truncate text-title font-semibold text-text">{dashboard.name}</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-ui text-muted" data-dashboard-subtitle="">
            {subtitleParts.map((p, i) => (
              <span key={i} className="inline-flex items-center gap-1.5">
                {i > 0 && <span aria-hidden="true">·</span>}
                {p}
              </span>
            ))}
            {run.error && (
              <span role="alert" className="inline-flex items-center gap-1 text-danger">
                <WarningIcon size={13} /> {run.error}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden" data-dashboard-actions="">
          {(run.savedViews.length > 0 || run.canSaveViews) && (
            <SavedViewSelect
              views={run.savedViews.map((v) => ({ id: v.id, name: v.name }))}
              value={run.state.viewId}
              onChange={run.applyView}
              dirty={run.viewDirty}
              onSaveCurrent={run.canSaveViews ? () => { setViewName(""); setViewError(null); setSavePrompt(true); } : undefined}
              onRename={run.canSaveViews ? (id) => { const v = run.savedViews.find((x) => x.id === id); const name = window.prompt("Rename this view", v?.name || ""); if (name && name.trim()) run.renameView(id, name).catch(() => undefined); } : undefined}
              onDelete={run.canSaveViews ? (id) => { const v = run.savedViews.find((x) => x.id === id); if (window.confirm(`Delete the view "${v?.name || ""}"?`)) run.deleteView(id).catch(() => undefined); } : undefined}
              width={240}
              align="end"
            />
          )}
          {mode === "warehouse" && (
            <SegmentedControl<DashboardPeriod>
              ariaLabel="Period"
              value={run.state.period}
              onChange={run.setPeriod}
              options={PERIODS.filter((p) => p !== "quarter" || run.state.period === "quarter").map((p) => ({ value: p, label: PERIOD_LABEL[p] }))}
            />
          )}
          {mode === "warehouse" && (
            <DateRangePicker
              value={run.state.dateRange}
              onChange={run.setDateRange}
              align="end"
              ariaLabel={dashboard.date_column ? `Date range on ${dashboard.date_column}` : "Date range"}
              label={dashboard.date_column || "Date range"}
              disabled={!dashboard.date_column}
            />
          )}
          {onViewChange && (
            <SegmentedControl<DashboardViewMode>
              ariaLabel="View as"
              value={view}
              onChange={onViewChange}
              options={[{ value: "dashboard", label: "Dashboard" }, { value: "canvas", label: "Canvas" }]}
            />
          )}
          <ExportMenu page={page} run={run} exportApis={exportApis} mode={mode} />
          {mode === "warehouse" && (
            <Button variant="ghost" iconOnly aria-label="Recompute every block" title="Recompute every block" icon={<RefreshIcon size={15} />} onClick={run.refresh} loading={run.loading && !run.ready}>
              Refresh
            </Button>
          )}
          {headerExtra}
          {onEditDashboard && (
            <Button variant="primary" icon={<EditIcon size={15} />} onClick={onEditDashboard}>
              Edit dashboard
            </Button>
          )}
        </div>
      </header>

      {savePrompt && (
        <form
          className="mx-6 mb-3 flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface px-4 py-3 print:hidden"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!viewName.trim()) return;
            try {
              await run.saveCurrentView(viewName);
              setSavePrompt(false);
            } catch (err: any) {
              setViewError(err?.response?.data?.detail || "Couldn't save this view.");
            }
          }}
        >
          <label className="text-ui text-secondary" htmlFor="saved-view-name">Save the current filters as</label>
          <input id="saved-view-name" autoFocus value={viewName} onChange={(e) => setViewName(e.target.value)} maxLength={80} placeholder="e.g. Revenue focus" className="ui-focus h-9 min-w-[200px] rounded-ctl border border-border bg-surface px-2.5 text-ui text-text" />
          <Button type="submit" variant="primary" size="sm" disabled={!viewName.trim()}>Save view</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSavePrompt(false)}>Cancel</Button>
          {viewError && <span className="text-caption text-danger">{viewError}</span>}
        </form>
      )}

      <div className="flex min-h-0 flex-1 items-stretch">
        {showRail && (
          <FilterRailPanel run={run} source={source} page={page} onPinToUrl={pinToUrl} pinned={pinned} className="print:hidden" />
        )}
        <main className="min-w-0 flex-1 px-6 pb-10 pt-1 print:px-0">
          {beforeContent}
          {legacyCount > 0 && (
            <div className="mb-4">
              <LegacyBlocksBanner count={legacyCount} onUpgrade={onUpgradeBlocks} />
            </div>
          )}
          {run.missingParameters.length > 0 && (
            <div className="mb-4 flex items-center gap-2 rounded-card border border-border bg-subtle px-4 py-2 text-caption text-secondary">
              <FilterIcon size={13} className="text-muted" />
              Waiting for a value: {run.missingParameters.join(", ")}
            </div>
          )}
          {canvas ? (
            <CanvasView
              dashboard={dashboard}
              page={page}
              run={run}
              source={source}
              mode={mode}
              parameters={parameters ?? run.parameters}
              owner={canvasOwner}
              comments={comments}
              fetchSql={fetchSql}
              commentCounts={owner?.commentCounts}
            />
          ) : page ? (
            <>
              <KpiStrip blocks={page.blocks} run={run} mode={mode} className="mb-4" />
              <BlockGrid page={page} run={run} source={source} mode={mode} parameters={parameters ?? run.parameters} owner={ownerWithComments} fetchSql={fetchSql} onExportApi={onExportApi} />
            </>
          ) : (
            <div className="py-10 text-center text-ui text-muted">This dashboard has no pages yet.</div>
          )}
          {afterContent}
        </main>
      </div>
      {comments?.enabled && (
        <CommentsSheet open={commentsFor !== null} onClose={() => setCommentsFor(null)} blockId={commentsFor?.id || null} title={commentsFor?.title || "Block"} comments={comments} />
      )}
    </div>
  );
}
