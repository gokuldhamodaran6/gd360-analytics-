import { getCompactor, moveElement } from "react-grid-layout/core";
import type { BlockLayoutItem, DashboardBlock, DashboardBlockType } from "../../api/client";

// 2026-10-07 (dashboard edit mode): the one place the block grid's
// geometry is decided, shared by the VIEW (BlockGrid's CSS grid) and the
// EDITOR (react-grid-layout) so the two can never disagree - toggling
// Edit / Done moves nothing.
//
// The grid shows every block except the KPI tiles (they live in the KPI
// strip) and the legacy rail-only "filter" blocks. Their stored x/y/w/h are
// clamped to the 12 columns and then compacted upwards with
// react-grid-layout's OWN vertical compactor - the exact function the
// editor runs after every drag - so what the editor starts from is what
// the view already drew.
//
// Stored coordinates keep the KPI band: a grid block is saved at
// `y = compactedY + kpiBand`, where kpiBand is the bottom edge of the
// page's KPI blocks, so the KPI rows stay "above" every other block for
// anything that reads the raw order (the canvas, an export).

export const GRID_COLS = 12;
export const ROW_UNIT_PX = 48;
export const GRID_GAP_PX = 16;

export type GridItem = { i: string; x: number; y: number; w: number; h: number };

const compactor = getCompactor("vertical", false, false);

export function isGridBlock(b: DashboardBlock): boolean {
  return b.type !== "kpi" && b.type !== "filter";
}

function int(n: unknown, fallback: number): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? v : fallback;
}

export function compact(items: GridItem[]): GridItem[] {
  return compactor.compact(items.map((it) => ({ ...it })), GRID_COLS).map((it) => ({ i: it.i, x: it.x, y: it.y, w: it.w, h: it.h }));
}

// Stored blocks -> the layout both renderings draw. `heights` overrides a
// block's stored height (the owner's slim "Empty block" placeholder).
export function viewLayout(blocks: DashboardBlock[], heights?: Record<string, number>): GridItem[] {
  const items = blocks.map((b) => {
    const w = Math.min(GRID_COLS, Math.max(1, int(b.w, 6)));
    const x = Math.min(GRID_COLS - w, Math.max(0, int(b.x, 0)));
    const h = Math.max(1, heights?.[b.id] ?? int(b.h, 4));
    return { i: b.id, x, y: Math.max(0, int(b.y, 0)), w, h };
  });
  return compact(items);
}

// `metrics`: the grid's row height and gap for the dashboard's density
// (theme/appearance GRID_METRICS, read through useGridMetrics by the view
// AND the editor - the two must use the same numbers).
export function blockHeightPx(h: number, metrics: { rowUnit: number; gap: number } = { rowUnit: ROW_UNIT_PX, gap: GRID_GAP_PX }): number {
  return h * metrics.rowUnit + (h - 1) * metrics.gap;
}

// The bottom edge of the page's KPI blocks (0 when it has none).
export function kpiBand(blocks: DashboardBlock[]): number {
  return blocks.filter((b) => b.type === "kpi").reduce((m, b) => Math.max(m, int(b.y, 0) + Math.max(1, int(b.h, 1))), 0);
}

export function kpiBlocksInOrder(blocks: DashboardBlock[]): DashboardBlock[] {
  return blocks.filter((b) => b.type === "kpi").sort((a, b) => a.y - b.y || a.x - b.x || a.position - b.position);
}

// KPI tiles in strip order -> their stored placement: one row of equal
// tiles from x = 0 (w = floor(12 / count), never under 2; a seventh tile
// starts a second row).
export function kpiLayoutItems(ordered: DashboardBlock[]): BlockLayoutItem[] {
  const n = ordered.length;
  if (n === 0) return [];
  const w = Math.max(2, Math.floor(GRID_COLS / n));
  const perRow = Math.max(1, Math.floor(GRID_COLS / w));
  // A tile keeps its stored height, within what a tile can be (a chart
  // that was swapped to a KPI does not keep a chart's seven rows).
  const tileH = (b: DashboardBlock) => Math.min(4, Math.max(2, int(b.h, 3)));
  const rowH = ordered.reduce((m, b) => Math.max(m, tileH(b)), 2);
  return ordered.map((b, i) => ({ id: b.id, x: (i % perRow) * w, y: Math.floor(i / perRow) * rowH, w, h: tileH(b) }));
}

export function toStoredItems(items: GridItem[], band: number): BlockLayoutItem[] {
  return items.map((it) => ({ id: it.i, x: it.x, y: it.y + band, w: it.w, h: it.h }));
}

// Only the placements that differ from what the server already has.
export function changedItems(items: BlockLayoutItem[], blocks: DashboardBlock[]): BlockLayoutItem[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  return items.filter((it) => {
    const b = byId.get(it.id);
    return Boolean(b) && (b!.x !== it.x || b!.y !== it.y || b!.w !== it.w || b!.h !== it.h);
  });
}

export function sameLayout(a: GridItem[], b: GridItem[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((it) => [it.i, it]));
  return a.every((it) => {
    const o = byId.get(it.i);
    return Boolean(o) && o!.x === it.x && o!.y === it.y && o!.w === it.w && o!.h === it.h;
  });
}

// An optimistic layout carried across a change to the block list: known
// blocks keep their pending placement, new ones take the server's.
export function reconcileLayout(pending: GridItem[], blocks: DashboardBlock[]): GridItem[] {
  const want = new Map(pending.map((it) => [it.i, it]));
  const fromServer = new Map(viewLayout(blocks).map((it) => [it.i, it]));
  return compact(blocks.map((b) => want.get(b.id) ?? fromServer.get(b.id)!));
}

// The smallest a block may be resized to - a chart can never be made
// unreadably small. A block that is already smaller keeps its size as its
// own minimum (nothing is ever force-grown on open).
const MIN_SIZE: Record<DashboardBlockType, { w: number; h: number }> = {
  chart: { w: 3, h: 4 },
  table: { w: 3, h: 4 },
  sql: { w: 3, h: 4 },
  donut: { w: 3, h: 5 },
  avatar_list: { w: 3, h: 4 },
  gauge: { w: 2, h: 4 },
  sparkline: { w: 2, h: 3 },
  kpi: { w: 2, h: 2 },
  text: { w: 2, h: 2 },
  heading: { w: 2, h: 1 },
  divider: { w: 2, h: 1 },
  input: { w: 2, h: 2 },
  filter: { w: 2, h: 2 },
};
export const MAX_ROWS_PER_BLOCK = 24;

export function minSizeOf(type: DashboardBlockType, current?: { w: number; h: number }): { w: number; h: number } {
  const m = MIN_SIZE[type] || { w: 2, h: 2 };
  if (!current) return m;
  return { w: Math.min(m.w, Math.max(1, current.w)), h: Math.min(m.h, Math.max(1, current.h)) };
}

function overlapsX(a: GridItem, b: GridItem): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w;
}

export type MoveDir = "up" | "down" | "left" | "right";
export type SizeDir = "wider" | "narrower" | "taller" | "shorter";

function neighbour(layout: GridItem[], item: GridItem, dir: "up" | "down"): GridItem | null {
  const candidates = layout.filter((o) => o.i !== item.i && overlapsX(o, item) && (dir === "up" ? o.y + o.h <= item.y : o.y >= item.y + item.h));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => (dir === "up" ? b.y + b.h - (a.y + a.h) || a.x - b.x : a.y - b.y || a.x - b.x))[0];
}

export function canMove(layout: GridItem[], id: string, dir: MoveDir): boolean {
  const item = layout.find((it) => it.i === id);
  if (!item) return false;
  if (dir === "left") return item.x > 0;
  if (dir === "right") return item.x + item.w < GRID_COLS;
  return neighbour(layout, item, dir) !== null;
}

// The keyboard alternative to dragging: one step in a direction. Up / down
// swap the block with the one above / below it; left / right slide it one
// column, pushing whatever is in the way down (the same resolution a drag
// gets). Returns null when the block cannot move that way.
export function moveItem(layout: GridItem[], id: string, dir: MoveDir): GridItem[] | null {
  const item = layout.find((it) => it.i === id);
  if (!item || !canMove(layout, id, dir)) return null;
  if (dir === "left" || dir === "right") {
    const working = layout.map((it) => ({ ...it }));
    const target = working.find((it) => it.i === id)!;
    const moved = moveElement(working, target, item.x + (dir === "left" ? -1 : 1), undefined, true, false, "vertical", GRID_COLS, false);
    return compact(moved.map((it) => ({ i: it.i, x: it.x, y: it.y, w: it.w, h: it.h })));
  }
  const other = neighbour(layout, item, dir)!;
  const [first, second] = dir === "up" ? [item, other] : [other, item];
  // `first` takes the upper slot, `second` goes right under it.
  const top = Math.min(item.y, other.y);
  const next = layout.map((it) => {
    if (it.i === first.i) return { ...it, y: top };
    if (it.i === second.i) return { ...it, y: top + first.h };
    // Everything that sat below the pair is pushed out of the way; the
    // compactor pulls it back up as far as it fits.
    return it.y >= top && it.i !== first.i && it.i !== second.i ? { ...it, y: it.y + first.h + second.h } : it;
  });
  const out = compact(next);
  return sameLayout(out, layout) ? null : out;
}

export function canResize(layout: GridItem[], id: string, dir: SizeDir, min: { w: number; h: number }): boolean {
  const item = layout.find((it) => it.i === id);
  if (!item) return false;
  if (dir === "wider") return item.x + item.w < GRID_COLS || item.x > 0;
  if (dir === "narrower") return item.w > min.w;
  if (dir === "taller") return item.h < MAX_ROWS_PER_BLOCK;
  return item.h > min.h;
}

// The keyboard alternative to the corner handle: one column / one row.
export function resizeItem(layout: GridItem[], id: string, dir: SizeDir, min: { w: number; h: number }): GridItem[] | null {
  const item = layout.find((it) => it.i === id);
  if (!item || !canResize(layout, id, dir, min)) return null;
  const next = layout.map((it) => {
    if (it.i !== id) return { ...it };
    if (dir === "wider") return it.x + it.w < GRID_COLS ? { ...it, w: it.w + 1 } : { ...it, x: it.x - 1, w: it.w + 1 };
    if (dir === "narrower") return { ...it, w: it.w - 1 };
    if (dir === "taller") return { ...it, h: it.h + 1 };
    return { ...it, h: it.h - 1 };
  });
  // Growing into a neighbour: the neighbour gives way (it moves down), the
  // resized block keeps its place - list it first for the compactor.
  const grown = next.find((it) => it.i === id)!;
  const pushed = next.map((it) => (it.i !== id && it.y >= grown.y && overlapsX(it, grown) && it.y < grown.y + grown.h ? { ...it, y: grown.y + grown.h } : it));
  return compact(pushed);
}
