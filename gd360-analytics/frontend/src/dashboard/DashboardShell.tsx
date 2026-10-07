import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DashboardBlock, DashboardBuilderPage, DashboardParameter, DashboardPeriod, UpgradeBlocksResult, WarehouseDashboardFields } from "../api/client";
import type { ChartExportApi } from "../components/ChartCanvas";
import { useIsNarrow } from "../components/DashboardBlocks";
import {
  Button, CheckIcon, ConfirmDialog, DateRangePicker, DownloadIcon, EditIcon, FilterIcon, IconButton, Popover, ProviderBadge, RefreshIcon, SavedViewSelect, SegmentedControl, Sheet, StatusPill, WarningIcon, cn,
  providerDisplayName,
} from "../ui";
import { downloadText, isDataBlock, isLegacyBlock, resultOk, rowsToCsv, safeFilename } from "./blockData";
import { BlockGrid, type BlockGridProps } from "./BlockGrid";
import { EditSheets } from "./edit/EditSheets";
import { CONTEXT_ROW_CLASS, EditToolbar } from "./edit/EditToolbar";
import type { DashboardEditor } from "./edit/useDashboardEditor";
import { FilterRailPanel } from "./FilterRailPanel";
import { KpiStrip } from "./KpiStrip";
import { PERIOD_LABEL, PERIODS, relativeTime } from "./runState";
import type { DashboardRun, RunSource } from "./useDashboardRun";
import { CanvasView } from "./canvas/CanvasView";
import type { CanvasOwnerActions } from "./canvas/cells";
import type { DashboardViewMode } from "./canvas/useViewMode";
import { CommentsSheet } from "./comments/CommentThread";
import type { CommentsApi } from "./comments/useComments";
import { completeAppearance, type DashboardAppearance } from "./theme/appearance";
import { ChartThemeProvider, useDashboardScope } from "./theme/ChartThemeContext";
import type { ChartTheme } from "./theme/chartTheme";

// 2026-10-07 (Option A dashboard view, Main.dc.html): the page a dashboard
// is VIEWED through - the owner's view/preview mode and the published
// link render this same tree. Header row (title, "Hotel_data · BigQuery ·
// refreshed 4 min ago · 119,386 rows", saved views, Day/Week/Month/Year,
// date range, Export, "Edit dashboard" for the owner), the 260 px filter
// rail, the KPI strip and the block grid.
//
// 2026-10-07 (dashboard edit mode): the same shell IS the editor. With an
// `editing` prop the dashboard name becomes click-to-rename, an "Editing"
// pill carries the save state, "Edit dashboard" becomes "Done", the
// context row turns into the edit toolbar (Add block · Filters · hint ·
// page tabs), and the KPI strip and block grid take the editor - same
// chrome, same rail, same live numbers, same geometry as the view.
//
// 2026-10-07 (identity-colour round): the shell is where a dashboard's
// APPEARANCE takes hold, for the owner and the published link alike. It
// wraps everything in a ChartThemeProvider built from dashboard.appearance
// and the run's colour registry (so every chart, table dot, rail chip and
// canvas cell reads the same colours and number settings), applies the
// corner radius and font to its root, hands the density's grid metrics to
// the grid and the editor, and prints the footer note under the page.

export type DashboardShellProps = {
  // `appearance` (WarehouseDashboardFields) is the dashboard's resolved
  // look; absent = the product defaults.
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
  // The row between the header and the KPI strip: what the view shows on
  // its left (a back link, a freshness badge) and the page tabs on its
  // right. While editing the left side becomes the edit toolbar; the row
  // keeps its height either way so nothing below it moves.
  contextRow?: { left?: ReactNode; tabs?: ReactNode };
  // A small link in the subtitle row (the owner's "Built from ..." source).
  subtitleExtra?: ReactNode;
  // The page is being edited (the owner pressed "Edit dashboard").
  editing?: {
    editor: DashboardEditor;
    onDone: () => void;
    onRename: (name: string) => Promise<void>;
  } | null;
  // Editing only: pins (or with null unpins) a value's colour. A legend
  // key, a donut key and a rail chip's dot become buttons for it.
  onPinColor?: ChartTheme["pin"];
  // The edit toolbar's "Appearance" button.
  onOpenAppearance?: () => void;
};

// The dashboard name while editing: click it (or press Enter on it) to
// rename in place - Enter saves, Escape cancels.
function InlineTitle({ name, onRename }: { name: string; onRename: (name: string) => Promise<void> }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    setRenaming(false);
    const clean = draft.trim();
    if (clean && clean !== name) onRename(clean).catch(() => undefined);
  };
  if (renaming) {
    return (
      <input
        autoFocus
        data-dashboard-name-input=""
        aria-label="Dashboard name"
        value={draft}
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Escape") { e.preventDefault(); done.current = true; setRenaming(false); }
        }}
        className="ui-focus -my-px h-[28px] w-[min(520px,100%)] min-w-0 rounded-[6px] border border-border bg-surface px-1.5 text-title font-semibold text-text"
      />
    );
  }
  return (
    <h1 className="-mx-1.5 min-w-0 text-title font-semibold text-text">
      <button
        type="button"
        data-dashboard-name=""
        title="Click to rename"
        onClick={() => { done.current = false; setDraft(name); setRenaming(true); }}
        className="ui-focus block max-w-full truncate rounded-[6px] px-1.5 text-left font-semibold decoration-border-strong decoration-dashed underline-offset-4 hover:underline"
      >
        {name}
      </button>
    </h1>
  );
}

function SaveState({ editor }: { editor: DashboardEditor }) {
  if (editor.saveState === "saving") {
    return (
      <span data-save-state="saving" role="status" className="inline-flex items-center gap-1.5 text-caption text-muted">
        <span className="ui-spinner !h-3 !w-3 !border-[1.5px]" aria-hidden="true" /> Saving…
      </span>
    );
  }
  if (editor.saveState === "error") {
    return (
      <span data-save-state="error" role="alert" title={editor.saveError || undefined} className="inline-flex min-w-0 items-center gap-1 text-caption text-danger">
        <WarningIcon size={12} className="shrink-0" />
        <span className="truncate">Couldn't save —</span>
        <button type="button" className="ui-focus rounded px-0.5 font-medium underline underline-offset-2 hover:no-underline" onClick={editor.retrySave}>Retry</button>
      </span>
    );
  }
  if (editor.saveState === "saved") {
    return (
      <span data-save-state="saved" role="status" className="inline-flex items-center gap-1 text-caption text-muted">
        <CheckIcon size={12} /> Saved
      </span>
    );
  }
  return null;
}

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

export function DashboardShell(props: DashboardShellProps) {
  const appearance = useMemo(() => completeAppearance(props.dashboard.appearance), [props.dashboard.appearance]);
  return (
    <ChartThemeProvider appearance={appearance} registry={props.run.colors} onPin={props.editing ? props.onPinColor : undefined}>
      <ShellBody {...props} appearance={appearance} />
    </ChartThemeProvider>
  );
}

function ShellBody({
  dashboard, page, run, source, mode, parameters, owner, fetchSql, onEditDashboard, headerExtra, onUpgradeBlocks, beforeContent, afterContent, hideRail = false, className, style,
  view = "dashboard", onViewChange, canvasOwner = null, comments = null, contextRow, subtitleExtra, editing = null, appearance, onOpenAppearance,
}: DashboardShellProps & { appearance: DashboardAppearance }) {
  const scope = useDashboardScope(appearance);
  const canvas = view === "canvas";
  const narrow = useIsNarrow();
  // Layout editing belongs to the Dashboard rendering; the canvas keeps
  // its own owner editing (the Done button stays either way).
  const editor = editing && !canvas ? editing.editor : null;
  const [railOpen, setRailOpen] = useState(false);
  const [viewAction, setViewAction] = useState<{ kind: "rename" | "delete"; id: string; name: string } | null>(null);
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
  const [renameViewId, setRenameViewId] = useState<string | null>(null);
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

  const hasRail = !hideRail && !canvas;
  const showRail = hasRail && !narrow;
  const rail = (variant: "rail" | "embedded") => (
    <FilterRailPanel
      run={run}
      source={source}
      page={page}
      onPinToUrl={pinToUrl}
      pinned={pinned}
      variant={variant}
      // The edit toolbar is sticky above the rail: the rail sticks under it.
      className={variant === "rail" ? cn("print:hidden", editor && "!top-[68px] !max-h-[calc(100vh-68px)]") : undefined}
      onEditFilters={editor ? () => { setRailOpen(false); editor.openSheet({ kind: "filters" }); } : undefined}
      onRemoveFilterBlock={editor ? (b) => editor.requestRemove(b) : undefined}
    />
  );

  // The page's own actions (owner): Publish and Edit dashboard, or More,
  // Publish and Done while editing. A viewer has none.
  const pageActions = headerExtra || editing || onEditDashboard ? (
    <div className="flex shrink-0 flex-wrap items-center gap-2 print:hidden" data-dashboard-page-actions="">
              {headerExtra}
              {editing ? (
                <Button variant="primary" icon={<CheckIcon size={15} />} onClick={editing.onDone} data-edit-done="">
                  Done
                </Button>
              ) : (
                onEditDashboard && (
                  <Button variant="primary" icon={<EditIcon size={15} />} onClick={onEditDashboard}>
                    Edit dashboard
                  </Button>
                )
              )}
            </div>
  ) : null;
  // The controls that drive the data.
  const headerControls = (
    <div className="flex max-w-full flex-wrap items-center gap-2 print:hidden" data-dashboard-actions="">
          {hasRail && narrow && (
            <span className="relative inline-flex">
              <IconButton variant="secondary" aria-label="Show filters" title="Show filters" icon={<FilterIcon size={15} />} onClick={() => setRailOpen(true)} data-open-rail="" />
              {run.activeFilterCount > 0 && (
                <span className="pointer-events-none absolute -right-1 -top-1 inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-white tabular-nums">{run.activeFilterCount}</span>
              )}
            </span>
          )}
          {(run.savedViews.length > 0 || run.canSaveViews) && (
            <SavedViewSelect
              views={run.savedViews.map((v) => ({ id: v.id, name: v.name }))}
              value={run.state.viewId}
              onChange={run.applyView}
              dirty={run.viewDirty}
              onSaveCurrent={run.canSaveViews ? () => { setRenameViewId(null); setViewName(""); setViewError(null); setSavePrompt(true); } : undefined}
              onRename={run.canSaveViews ? (id) => { const v = run.savedViews.find((x) => x.id === id); setRenameViewId(id); setViewName(v?.name || ""); setViewError(null); setSavePrompt(true); } : undefined}
              onDelete={run.canSaveViews ? (id) => { const v = run.savedViews.find((x) => x.id === id); setViewAction({ kind: "delete", id, name: v?.name || "" }); } : undefined}
              width={240}
              align="start"
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
              // Over the page and kept inside the viewport: on a phone this
              // trigger sits at the left of a wrapped toolbar and an
              // end-aligned panel opened off the left edge of the screen.
              portal
              ariaLabel={dashboard.date_column ? `Date range on ${dashboard.date_column}` : "Date range"}
              label={dashboard.date_column || "Date range"}
              disabled={!dashboard.date_column}
              // The column's real first and last date (the run carries
              // them): the calendar opens on the data, not on today.
              minDate={dashboard.date_column ? run.dateBounds[dashboard.date_column]?.min : undefined}
              maxDate={dashboard.date_column ? run.dateBounds[dashboard.date_column]?.max : undefined}
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
        </div>
  );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)} style={{ ...scope.style, ...style }} data-dashboard-shell="" data-editing={editing ? "" : undefined} {...scope.attrs}>
      {/* Two rows, the same in view and edit so nothing below moves when
          the page switches: (1) the name with what it is built on, and the
          page's own actions (Publish, Edit dashboard / More, Publish,
          Done) on the right; (2) the controls that drive the data - saved
          view, period, date range, Dashboard · Canvas, Export, Refresh.
          A viewer has no page actions, so the controls take that place. */}
      <header className="flex flex-col gap-3 px-4 pb-4 pt-5 sm:px-6 print:px-0">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-[1_1_280px]">
            {editing ? (
              <div className="flex min-w-0 items-center gap-x-2.5">
                <InlineTitle name={dashboard.name} onRename={editing.onRename} />
                <span data-editing-pill="" className="inline-flex shrink-0"><StatusPill tone="neutral">Editing</StatusPill></span>
                <span className="shrink-0"><SaveState editor={editing.editor} /></span>
              </div>
            ) : (
              <h1 className="truncate text-title font-semibold text-text">{dashboard.name}</h1>
            )}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-ui text-muted" data-dashboard-subtitle="">
              {subtitleParts.map((p, i) => (
                <span key={i} className="inline-flex items-center gap-1.5">
                  {i > 0 && <span aria-hidden="true">·</span>}
                  {p}
                </span>
              ))}
              {subtitleExtra && (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  {subtitleParts.length > 0 && <span aria-hidden="true">·</span>}
                  {subtitleExtra}
                </span>
              )}
              {run.error && (
                <span role="alert" className="inline-flex items-center gap-1 text-danger">
                  <WarningIcon size={13} /> {run.error}
                </span>
              )}
            </div>
          </div>
          {pageActions ?? headerControls}
        </div>
        {pageActions && headerControls}
      </header>

      {savePrompt && (
        <form
          className="mx-4 mb-3 flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface px-4 py-3 sm:mx-6 print:hidden"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!viewName.trim()) return;
            try {
              if (renameViewId) await run.renameView(renameViewId, viewName);
              else await run.saveCurrentView(viewName);
              setSavePrompt(false);
            } catch (err: any) {
              setViewError(err?.response?.data?.detail || "Couldn't save this view.");
            }
          }}
        >
          <label className="text-ui text-secondary" htmlFor="saved-view-name">{renameViewId ? "Rename this view to" : "Save the current filters as"}</label>
          <input id="saved-view-name" autoFocus value={viewName} onChange={(e) => setViewName(e.target.value)} maxLength={80} placeholder="e.g. Revenue focus" className="ui-focus h-9 min-w-[200px] rounded-ctl border border-border bg-surface px-2.5 text-ui text-text" />
          <Button type="submit" variant="primary" size="sm" disabled={!viewName.trim()}>{renameViewId ? "Rename" : "Save view"}</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSavePrompt(false)}>Cancel</Button>
          {viewError && <span className="text-caption text-danger">{viewError}</span>}
        </form>
      )}

      {/* The context row spans the page, above the rail: the edit toolbar
          while editing, the back link + freshness + page tabs otherwise -
          one fixed height either way. */}
      {editor ? (
        <EditToolbar editor={editor} trailing={contextRow?.tabs} compact={narrow} className="mx-4 sm:mx-6" onAppearance={onOpenAppearance} />
      ) : (
        contextRow && (
          <div className={cn(CONTEXT_ROW_CLASS, "justify-between px-4 sm:px-6 print:hidden")} data-context-row="">
            <div className="flex min-w-0 flex-wrap items-center gap-3">{contextRow.left}</div>
            {contextRow.tabs}
          </div>
        )
      )}
      <div className="flex min-h-0 flex-1 items-stretch">
        {showRail && rail("rail")}
        <main className="min-w-0 flex-1 px-4 pb-10 pt-1 sm:px-6 print:px-0">
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
              <KpiStrip blocks={page.blocks} run={run} mode={mode} className="mb-4" editor={editor} canEdit={Boolean(owner)} onEdit={owner?.onEdit ? () => owner.onEdit!() : undefined} sourceName={source.name} />
              <BlockGrid page={page} run={run} source={source} mode={mode} parameters={parameters ?? run.parameters} owner={ownerWithComments} fetchSql={fetchSql} onExportApi={onExportApi} editor={editor} />
            </>
          ) : (
            <div className="py-10 text-center text-ui text-muted">This dashboard has no pages yet.</div>
          )}
          {afterContent}
          {appearance.footer_note && (
            <footer data-dashboard-footer-note="" className="mt-8 border-t border-border pt-3 text-caption text-muted">
              {appearance.footer_note}
            </footer>
          )}
        </main>
      </div>
      {comments?.enabled && (
        <CommentsSheet open={commentsFor !== null} onClose={() => setCommentsFor(null)} blockId={commentsFor?.id || null} title={commentsFor?.title || "Block"} comments={comments} />
      )}
      {hasRail && narrow && (
        <Sheet open={railOpen} onClose={() => setRailOpen(false)} title="Filters" side="left" size="sm" id="filter-rail-sheet">
          {rail("embedded")}
        </Sheet>
      )}
      {editing && <EditSheets editor={editing.editor} source={source} />}
      <ConfirmDialog
        open={viewAction?.kind === "delete"}
        title={`Delete the view "${viewAction?.name || ""}"?`}
        confirmLabel="Delete"
        onCancel={() => setViewAction(null)}
        onConfirm={() => { const id = viewAction?.id; setViewAction(null); if (id) run.deleteView(id).catch(() => undefined); }}
      >
        The saved filters are removed. The dashboard itself does not change.
      </ConfirmDialog>
    </div>
  );
}
