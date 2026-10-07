import { useMemo, useRef, useState, type ReactNode } from "react";
import type { BlockResult, DashboardBlock } from "../api/client";
import { useIsNarrow } from "../components/DashboardBlocks";
import { GripIcon, KpiTile, PlusIcon, Skeleton, cn } from "../ui";
import { ALL_ROWS_WORDING, isDataBlock, isEmptyBlock, kpiDisplay, type KpiDeltaWording, PRIOR_PERIOD_WORDING, resultOk } from "./blockData";
import { kpiForecastLine } from "./charts/model";
import { BlockMenu } from "./edit/BlockMenu";
import { EmptyBlockBody, EmptyBlockPlaceholder } from "./edit/EmptyBlock";
import type { DashboardEditor } from "./edit/useDashboardEditor";
import { adaptFileBlock } from "./fileData";
import { humanize } from "./format";
import { useChartTheme, useGridMetrics } from "./theme/ChartThemeContext";
import type { DashboardRun } from "./useDashboardRun";

// 2026-10-07 (Option A dashboard view): the KPI strip across the top of
// the page (Main.dc.html: Revenue · Bookings · Cancellation rate · ...).
// One KpiTile per kpi block, in grid order: the value (in the block's
// number format - format.ts), one line with the worded delta vs the prior
// period whose good/bad comes from the block's own config.good_direction
// ("down" = lower is better, e.g. a cancellation rate; default "up"), and
// the run's sparkline. Skeleton tiles on the
// first load; on a refilter the old numbers stay and shimmer.
//
// 2026-10-07 (dashboard edit mode): with an `editor` the same strip, on
// the same columns, is editable - each tile gets a quiet control cluster
// on hover / focus (a grip to drag it to a new place, and a "..." menu:
// rename, change with AI, edit query, number format, lower-is-better,
// move left / right, duplicate, remove), its label is click-to-rename, and
// an "Add KPI" control hangs off the strip's lower edge while there are
// fewer than five. A tile that was never built shows its "Describe..."
// state while editing, a slim placeholder for the owner, nothing for a
// viewer.
//
// 2026-10-07 (round 9): a FILE dashboard's KPI is the same tile. Its
// stored number (and the filtered copy, while a filter is on) goes through
// fileData.adaptFileBlock and is drawn by the tile below with the same
// anatomy - label, value, one delta row, sparkline. The delta row compares
// the filtered number with the unfiltered one ("vs all rows") and is
// reserved, empty, when nothing is filtered. The old tile's pastel icon,
// coloured top stripe and accent swatch are no longer drawn (the stored
// config.accent_color is left alone).

export const MAX_KPIS_FOR_ADD = 5;

export function kpiBlocksOf(blocks: DashboardBlock[]): DashboardBlock[] {
  return blocks.filter((b) => b.type === "kpi").sort((a, b) => a.y - b.y || a.x - b.x);
}

function isKpiEmpty(b: DashboardBlock, run: DashboardRun): boolean {
  return isDataBlock(b) && (isEmptyBlock(b) || (run.emptyBlockIds || []).includes(b.id));
}

function LabelInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(draft);
  };
  return (
    <input
      autoFocus
      data-kpi-title-input=""
      aria-label="KPI name"
      value={draft}
      maxLength={200}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done.current = true; onCancel(); }
      }}
      className="ui-focus-inset block h-[18px] w-full rounded-[4px] border-0 bg-subtle px-1 text-caption font-medium uppercase tracking-caps text-text"
    />
  );
}

// One tile's editing frame: the control cluster, the drop target, the
// rename state. `children(label)` renders the tile with the label node.
function EditableKpi({ editor, block, index, label, children }: { editor: DashboardEditor; block: DashboardBlock; index: number; label: string; children: (labelNode: ReactNode) => ReactNode }) {
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [over, setOver] = useState<"before" | "after" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const input = <LabelInput initial={block.title || ""} onCancel={() => setRenaming(false)} onCommit={(v) => { setRenaming(false); editor.renameBlock(block, v); }} />;
  const labelNode = renaming ? (
    input
  ) : (
    <button type="button" data-kpi-title="" title="Click to rename" onClick={() => setRenaming(true)} className="ui-focus-inset block max-w-full truncate rounded-[4px] text-left font-medium uppercase tracking-caps decoration-border-strong decoration-dashed underline-offset-4 hover:underline">
      {label}
    </button>
  );
  return (
    <div
      ref={ref}
      data-kpi-block={block.id}
      data-kpi-editing=""
      className={cn("gd-edit-card group relative rounded-card", over === "before" && "gd-drop-before", over === "after" && "gd-drop-after")}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types || []).includes(KPI_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const r = ref.current?.getBoundingClientRect();
        setOver(r && e.clientX > r.left + r.width / 2 ? "after" : "before");
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(KPI_DRAG_TYPE);
        const side = over;
        setOver(null);
        if (!id || id === block.id) return;
        e.preventDefault();
        const from = editor.kpis.findIndex((b) => b.id === id);
        if (from < 0) return;
        let to = side === "after" ? index + 1 : index;
        if (from < to) to -= 1;
        editor.moveKpi(id, to);
      }}
    >
      {children(labelNode)}
      {/* The control cluster sits on the tile's top edge, so it never
          covers the label or the number. */}
      <div
        data-edit-chrome=""
        className={cn(
          "absolute -top-5 right-2 z-[2] flex items-center rounded-ctl border border-border bg-surface shadow-card transition-opacity duration-100",
          menuOpen ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"
        )}
      >
        {editor.kpis.length > 1 && (
          <span
            draggable
            data-kpi-grip=""
            aria-hidden="true"
            title="Drag to reorder"
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData(KPI_DRAG_TYPE, block.id);
              e.dataTransfer.setData("text/plain", label);
              if (ref.current && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(ref.current, 24, 24);
            }}
            className="inline-flex h-7 w-6 cursor-grab items-center justify-center rounded-[6px] text-muted hover:bg-subtle hover:text-text active:cursor-grabbing"
          >
            <GripIcon size={14} />
          </span>
        )}
        <BlockMenu editor={editor} block={block} variant="kpi" onRename={() => setRenaming(true)} onOpenChange={setMenuOpen} />
      </div>
    </div>
  );
}

const KPI_DRAG_TYPE = "application/x-gd360-kpi";

export type KpiStripProps = {
  blocks: DashboardBlock[];
  run: DashboardRun;
  mode: "warehouse" | "file";
  className?: string;
  editor?: DashboardEditor | null;
  // File dashboards: the file's name (the adapter's description of a block).
  sourceName?: string | null;
  // The owner looking at the finished page ("Edit dashboard" on an empty tile).
  onEdit?: () => void;
  // A viewer never sees a tile that was not built.
  canEdit?: boolean;
};

// The tile for one KPI block (`labelNode` replaces the plain label while
// editing): `result` is the warehouse run's BlockResult, or a file block's
// adapted one - the tile does not know which.
function KpiBlockTile({ block: b, result: r, run, labelNode, wording = PRIOR_PERIOD_WORDING }: { block: DashboardBlock; result: BlockResult | undefined; run: DashboardRun; labelNode?: ReactNode; wording?: KpiDeltaWording }) {
  const label = b.title || humanize(b.config?.label || r?.measures?.[0]) || "Value";
  // A KPI's sparkline is the palette's primary - never an identity colour.
  const theme = useChartTheme();
  if (!r || !resultOk(r)) {
    return (
      <KpiTile
        label={labelNode ?? label}
        value={<span className="text-section font-medium text-danger">{r?.error ? "Couldn't compute" : "No result"}</span>}
        caption={r?.error || (run.skippedBlockIds.includes(b.id) ? "Not built for the warehouse yet" : undefined)}
        className={labelNode ? "h-full" : undefined}
      />
    );
  }
  // Every tile has the same anatomy: label, value, ONE delta line ("↑ +8.1%
  // vs prior period"), sparkline. With no prior period (date range "All
  // time") the delta line is simply empty - its height stays reserved so
  // the sparklines line up across the strip, and nothing is printed in its
  // place.
  const kpi = kpiDisplay(r, b, wording);
  const spark = kpi.sparkline;
  // 2026-10-07 (chart-types round): a tile with a forecast says where the
  // number is heading - "Next month ≈ 4,120 (3,700-4,560)".
  const forecastLine = kpiForecastLine(r, b);
  return (
    <>
      <KpiTile
        label={labelNode ?? label}
        value={kpi.value}
        unit={b.config?.unit}
        delta={kpi.delta ?? undefined}
        reserveDeltaRow
        sparkline={spark.length > 1 ? spark : undefined}
        sparklineLabel={spark.length > 1 ? `${label} trend` : undefined}
        sparklineColor={theme.tokens ? undefined : theme.primary}
        caption={forecastLine ? <span data-kpi-forecast="" title={forecastLine}>{forecastLine}</span> : undefined}
        className={cn("h-full", run.loading && "opacity-80")}
      />
      {run.loading && <div aria-hidden="true" className="ui-shimmer pointer-events-none absolute inset-0 rounded-card opacity-30" />}
    </>
  );
}

// A file KPI: adapted, then the same tile.
function FileKpiTile({ block, run, labelNode, sourceName }: { block: DashboardBlock; run: DashboardRun; labelNode?: ReactNode; sourceName?: string | null }) {
  const override = run.overrides[block.id];
  const adapted = useMemo(() => adaptFileBlock(block, override, { sourceName }), [block, override, sourceName]);
  if (adapted.kind !== "result") {
    return <KpiTile label={labelNode ?? (block.title || "Value")} value="—" reserveDeltaRow className="h-full" />;
  }
  return <KpiBlockTile block={adapted.block} result={adapted.result} run={run} labelNode={labelNode} wording={ALL_ROWS_WORDING} />;
}

export function KpiStrip({ blocks, run, mode, className, editor = null, onEdit, canEdit = false, sourceName = null }: KpiStripProps) {
  const narrow = useIsNarrow();
  const metrics = useGridMetrics();
  const all = editor ? editor.kpis : kpiBlocksOf(blocks);
  const kpis = editor || canEdit ? all : all.filter((b) => !isKpiEmpty(b, run));
  if (kpis.length === 0) return null;
  // Up to five across; two across on a phone (four tiles side by side
  // there were unreadable slivers that pushed the page sideways).
  const cols = Math.min(kpis.length, narrow ? 2 : 5);
  // The strip's gap is the grid's (density), so tiles and blocks line up.
  const gridStyle = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: `${metrics.gap}px` };

  if (!editor) {
    return (
      <div data-kpi-strip="" aria-busy={run.loading || undefined} className={cn("grid gap-4", className)} style={gridStyle}>
        {kpis.map((b) => {
          if (isKpiEmpty(b, run)) return <EmptyBlockPlaceholder key={b.id} noun="KPI" onEdit={onEdit} className="min-h-[96px]" />;
          if (mode === "file") {
            return (
              <div key={b.id} className="relative" data-kpi-block={b.id}>
                <FileKpiTile block={b} run={run} sourceName={sourceName} />
              </div>
            );
          }
          const r = run.results[b.id];
          if (!run.ready && !r) return <Skeleton key={b.id} variant="tile" />;
          if (!r || !resultOk(r)) return <KpiBlockTile key={b.id} block={b} result={r} run={run} />;
          return (
            <div key={b.id} className="relative" data-kpi-block={b.id}>
              <KpiBlockTile block={b} result={r} run={run} />
            </div>
          );
        })}
      </div>
    );
  }

  // Editing: the same grid on the same columns. The "Add KPI" control hangs
  // off the strip's lower edge and never takes a column, so the tiles stay
  // exactly where the view draws them.
  return (
    <div className={cn("relative", className)} data-kpi-strip-wrap="">
      <div data-kpi-strip="" aria-busy={run.loading || undefined} className="grid gap-4" style={gridStyle}>
        {kpis.map((b, i) => {
          const empty = isKpiEmpty(b, run);
          const r = run.results[b.id];
          const label = b.title || humanize(b.config?.label || r?.measures?.[0]) || (empty ? "Untitled KPI" : "Value");
          return (
            <EditableKpi key={b.id} editor={editor} block={b} index={i} label={label}>
              {(labelNode) => {
                if (empty) {
                  return (
                    <div className="flex h-full min-h-[132px] flex-col gap-1.5 rounded-card border border-border bg-surface px-[18px] py-4 shadow-card" data-kpi-empty="">
                      <div className="text-caption text-muted">{labelNode}</div>
                      <EmptyBlockBody editor={editor} block={b} compact />
                    </div>
                  );
                }
                if (mode === "file") return <FileKpiTile block={b} run={run} labelNode={labelNode} sourceName={sourceName} />;
                if (!run.ready && !r) return <Skeleton variant="tile" />;
                return <KpiBlockTile block={b} result={r} run={run} labelNode={labelNode} />;
              }}
            </EditableKpi>
          );
        })}
      </div>
      {all.length < MAX_KPIS_FOR_ADD && (
        <button
          type="button"
          data-add-kpi=""
          disabled={editor.adding}
          onClick={() => editor.addBlock("kpi")}
          className="ui-focus absolute -bottom-3 right-4 z-[2] inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border-strong bg-surface px-2.5 text-caption font-medium text-secondary hover:border-primary hover:text-brand-ink disabled:opacity-60"
        >
          <PlusIcon size={12} />
          Add KPI
        </button>
      )}
    </div>
  );
}
