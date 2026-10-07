import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { DashboardBlock, DashboardBuilderDetail, DashboardBuilderPage, DashboardParameter } from "../../api/client";
import { cn } from "../../ui";
import type { BlockSqlInfo } from "../BlockGrid";
import { NO_COMMENTS, type CommentsApi } from "../comments/useComments";
import type { DashboardRun, RunSource } from "../useDashboardRun";
import { AddCellRow, type AddCellKind } from "./AddCellRow";
import { Cell } from "./Cell";
import { type CanvasOwnerActions, type CellInfo, orderCells, slimConfig, uniqueCellName } from "./cells";
import { OutlinePanel } from "./OutlinePanel";
import { ParametersStrip } from "./ParametersStrip";

// 2026-10-07 (analyst canvas round, OptionC.dc.html): the "Canvas"
// rendering of a dashboard page - the SAME blocks the Option A grid shows,
// read top-to-bottom as numbered cells in one column (max 1100 px), under
// a parameters strip that drives every cell, with the Outline +
// Dependencies panel on the right. One run engine (useDashboardRun) feeds
// both renderings; the canvas never keeps its own block state - every
// owner action goes through the existing block endpoints and the parent's
// setDash.
//
// Keyboard: ↑/↓ move cell focus, Enter edits the focused cell (owner),
// Esc leaves editing, ⌘/Ctrl+Enter runs the focused SQL cell.

export type CanvasViewProps = {
  dashboard: { parameters?: DashboardParameter[] | null; datasource_kind?: string | null };
  page: DashboardBuilderPage | undefined;
  run: DashboardRun;
  source: RunSource;
  mode: "warehouse" | "file";
  parameters?: DashboardParameter[];
  owner?: CanvasOwnerActions | null;
  comments?: CommentsApi | null;
  fetchSql?: (block: DashboardBlock) => Promise<BlockSqlInfo>;
  // Per-block comment counts for a view with no live comments hook (the
  // owner's dash.comment_counts before the hook loads).
  commentCounts?: Record<string, { open: number; total: number }>;
  beforeCells?: ReactNode;
  className?: string;
};

const INTERACTIVE = /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/;

export function CanvasView({ dashboard, page, run, source, mode, parameters, owner = null, comments, fetchSql, commentCounts, beforeCells, className }: CanvasViewProps) {
  const params = parameters ?? run.parameters;
  const cells = useMemo(() => orderCells(page?.blocks || []), [page?.blocks]);
  const commentsApi = comments ?? NO_COMMENTS;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const refs = useRef<Record<string, HTMLElement | null>>({});
  const columnRef = useRef<HTMLDivElement>(null);

  // A deleted cell cannot stay focused.
  useEffect(() => {
    if (focusedId && !cells.some((c) => c.id === focusedId)) setFocusedId(null);
    if (editingId && !cells.some((c) => c.id === editingId)) setEditingId(null);
  }, [cells, focusedId, editingId]);

  const focusCell = useCallback((id: string, opts: { scroll?: boolean } = {}) => {
    setFocusedId(id);
    const el = refs.current[id];
    if (!el) return;
    if (opts.scroll) el.scrollIntoView?.({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: !opts.scroll });
  }, []);

  const rerunWithDependents = useCallback((blockId: string) => {
    run.rerunBlocks([blockId, ...run.dependentsOf(blockId)]);
  }, [run]);

  // ---- owner actions ----
  const pageId = page?.id;
  const newestBlock = (before: CellInfo[], detail: DashboardBuilderDetail | void): DashboardBlock | null => {
    if (!detail || !pageId) return null;
    const p = detail.pages.find((x) => x.id === pageId);
    if (!p) return null;
    const known = new Set(before.map((c) => c.id));
    const fresh = p.blocks.filter((b) => !known.has(b.id));
    return fresh.sort((a, b) => b.position - a.position)[0] || null;
  };
  const addCell = async (kind: AddCellKind) => {
    if (!owner) return;
    let detail: DashboardBuilderDetail | void;
    if (kind === "sql") detail = await owner.createBlock("sql", undefined, { sql: "", name: uniqueCellName(cells) });
    else if (kind === "input") detail = await owner.createBlock("input", undefined, { parameter_id: params[0]?.id ?? null });
    else if (kind === "text") detail = await owner.createBlock("text", undefined, { text: "" });
    else detail = await owner.createBlock(kind, kind === "chart" ? "Untitled chart" : "Untitled table");
    const created = newestBlock(cells, detail);
    if (created) {
      // The new article mounts on the next render.
      setTimeout(() => { focusCell(created.id, { scroll: true }); setEditingId(created.id); }, 0);
    }
  };
  const moveCell = async (cell: CellInfo, dir: "up" | "down") => {
    if (!owner) return;
    const i = cells.findIndex((c) => c.id === cell.id);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= cells.length) return;
    const other = cells[j];
    const a = cell.block, b = other.block;
    // Swap grid placements so the grid and the canvas agree on the order.
    // Identical placements (an older, overlapping layout) are nudged apart.
    const sameSpot = a.x === b.x && a.y === b.y;
    await owner.updateBlock(a.id, { x: b.x, y: sameSpot ? (dir === "up" ? Math.max(0, b.y - 1) : b.y + 1) : b.y });
    await owner.updateBlock(b.id, { x: a.x, y: a.y });
    setTimeout(() => focusCell(a.id, { scroll: true }), 0);
  };
  const duplicateCell = async (cell: CellInfo) => {
    if (!owner) return;
    const b = cell.block;
    const config = slimConfig(b.config);
    if (b.type === "sql") config.name = uniqueCellName(cells, `${cell.name || "query"}_copy`);
    const detail = await owner.createBlock(b.type, b.title ? `${b.title} (copy)` : undefined, Object.keys(config).length ? config : undefined);
    const created = newestBlock(cells, detail);
    if (created) {
      if (b.type === "sql" || config.source_block_id || config.spec) setTimeout(() => rerunWithDependents(created.id), 0);
      setTimeout(() => focusCell(created.id, { scroll: true }), 0);
    }
  };
  const deleteCell = async (cell: CellInfo) => {
    if (!owner) return;
    const i = cells.findIndex((c) => c.id === cell.id);
    await owner.deleteBlock(cell.id);
    const next = cells[i + 1] || cells[i - 1];
    if (next) setTimeout(() => focusCell(next.id), 0);
  };

  // ---- keyboard ----
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const inControl = INTERACTIVE.test(target.tagName) || target.isContentEditable;
    if (e.key === "Escape") {
      if (editingId) {
        e.preventDefault();
        const id = editingId;
        setEditingId(null);
        focusCell(id);
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      const cell = cells.find((c) => c.id === focusedId);
      if (cell && cell.kind === "sql" && !inControl) {
        e.preventDefault();
        rerunWithDependents(cell.id);
      }
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    // A control that uses the arrows itself (a segmented control, an open
    // menu or listbox, a popover trigger, a text field) keeps them.
    if (e.defaultPrevented || (inControl && target.tagName !== "BUTTON")) return;
    if (target.closest('[role="radiogroup"], [role="menu"], [role="listbox"], [aria-expanded="true"], [data-popover-trigger]')) return;
    if (cells.length === 0) return;
    e.preventDefault();
    const i = cells.findIndex((c) => c.id === focusedId);
    const next = e.key === "ArrowDown" ? (i < 0 ? 0 : Math.min(cells.length - 1, i + 1)) : i < 0 ? cells.length - 1 : Math.max(0, i - 1);
    if (editingId) setEditingId(null);
    focusCell(cells[next].id, { scroll: true });
  };

  // ---- layout: consecutive KPI cells share a row ----
  const groups = useMemo(() => {
    const out: { key: string; cells: CellInfo[]; row: boolean }[] = [];
    let i = 0;
    while (i < cells.length) {
      if (cells[i].kind === "kpi") {
        let j = i;
        while (j + 1 < cells.length && cells[j + 1].kind === "kpi") j++;
        const slice = cells.slice(i, j + 1);
        out.push({ key: slice.map((c) => c.id).join("+"), cells: slice, row: slice.length > 1 });
        i = j + 1;
      } else {
        out.push({ key: cells[i].id, cells: [cells[i]], row: false });
        i++;
      }
    }
    return out;
  }, [cells]);

  const renderCell = (cell: CellInfo, compact: boolean) => {
    const i = cells.findIndex((c) => c.id === cell.id);
    return (
      <Cell
        key={cell.id}
        ref={(el) => { refs.current[cell.id] = el; }}
        cell={cell}
        cells={cells}
        run={run}
        source={source}
        mode={mode}
        parameters={params}
        owner={owner}
        comments={commentsApi}
        fetchSql={fetchSql}
        focused={focusedId === cell.id}
        editing={editingId === cell.id}
        onFocus={() => setFocusedId(cell.id)}
        onStartEdit={() => { if (owner) { setFocusedId(cell.id); setEditingId(cell.id); } }}
        onStopEdit={() => { if (editingId === cell.id) { setEditingId(null); focusCell(cell.id); } }}
        rerunWithDependents={rerunWithDependents}
        onMove={owner ? (dir) => moveCell(cell, dir) : undefined}
        onDuplicate={owner ? () => duplicateCell(cell) : undefined}
        onDelete={owner ? () => deleteCell(cell) : undefined}
        canMoveUp={i > 0}
        canMoveDown={i < cells.length - 1}
        compact={compact}
        commentCount={!commentsApi.enabled && commentCounts ? commentCounts[cell.id] : undefined}
      />
    );
  };

  return (
    <div className={cn("flex items-start gap-6", className)} data-canvas-view="" onKeyDown={onKeyDown} ref={columnRef}>
      <div className="mx-auto flex w-full min-w-0 max-w-[1100px] flex-col gap-4" data-cell-column="">
        {beforeCells}
        <ParametersStrip run={run} source={source} />
        {run.error && <div role="alert" className="rounded-card border border-danger-border bg-danger-fill px-4 py-2.5 text-ui text-danger">{run.error}</div>}
        {!page ? (
          <div className="py-10 text-center text-ui text-muted">This dashboard has no pages yet.</div>
        ) : cells.length === 0 ? (
          <div className="rounded-card border border-dashed border-border-strong px-4 py-8 text-center text-ui text-muted">
            {owner ? "No cells yet - add a SQL cell to start." : "This page has no cells yet."}
          </div>
        ) : (
          groups.map((g) =>
            g.row ? (
              <div key={g.key} className="flex flex-wrap gap-3" data-kpi-row="">
                {g.cells.map((c) => renderCell(c, true))}
              </div>
            ) : (
              renderCell(g.cells[0], false)
            )
          )
        )}
        {owner && page && <AddCellRow onAdd={addCell} className="ml-11" />}
      </div>
      <div className="sticky top-4 hidden w-[232px] shrink-0 lg:block" data-outline-column="">
        <OutlinePanel cells={cells} run={run} focusedId={focusedId} onSelect={(id) => focusCell(id, { scroll: true })} />
      </div>
    </div>
  );
}
