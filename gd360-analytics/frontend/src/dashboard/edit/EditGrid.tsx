import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "react-grid-layout/css/styles.css";
import { ReactGridLayout } from "react-grid-layout/legacy";
import type { DashboardBlock } from "../../api/client";
import { cn } from "../../ui";
import { blockHeightPx, GRID_COLS, GRID_GAP_PX, type GridItem, MAX_ROWS_PER_BLOCK, minSizeOf, ROW_UNIT_PX } from "./layout";

// 2026-10-07 (dashboard edit mode): the block grid while editing -
// react-grid-layout with EXACTLY the view's geometry (12 columns, 48 px
// rows, 16 px gaps, no container padding), so a block sits on the same
// pixels whether the page is being viewed or edited. Vertical compaction,
// no overlap. A block is dragged by its header (`.block-drag-handle`) and
// resized from the south-east corner; buttons, inputs, menus and a chart's
// own plot never start a drag. The layout itself lives in the editor hook
// (optimistic + debounced bulk save) - this component only reports where
// a drag or a resize ended.

// The handle is the card header; everything interactive inside a card is
// excluded so a click on a menu or a bar is never read as a drag. The
// title itself stays draggable (it is marked data-drag-title).
const DRAG_CANCEL =
  "button:not([data-drag-title]), input, textarea, select, a, label, [role='menu'], [role='dialog'], [role='listbox'], [data-no-drag], .js-plotly-plot, .react-resizable-handle";

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width || el.offsetWidth || 0;
      setWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return [ref, width];
}

export type EditGridProps = {
  blocks: DashboardBlock[];
  layout: GridItem[];
  onLayoutCommit: (items: GridItem[]) => void;
  renderBlock: (block: DashboardBlock, heightPx: number) => ReactNode;
  className?: string;
};

export function EditGrid({ blocks, layout, onLayoutCommit, renderBlock, className }: EditGridProps) {
  const [ref, measured] = useElementWidth<HTMLDivElement>();
  // No layout engine (a test DOM): fall back to a desktop content width.
  const width = measured > 0 ? measured : 1200;
  const byId = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);
  const rglLayout = useMemo(
    () =>
      layout
        .filter((it) => byId.has(it.i))
        .map((it) => {
          const min = minSizeOf(byId.get(it.i)!.type, it);
          return { i: it.i, x: it.x, y: it.y, w: it.w, h: it.h, minW: min.w, minH: min.h, maxW: GRID_COLS, maxH: MAX_ROWS_PER_BLOCK };
        }),
    [layout, byId]
  );
  const heights = useMemo(() => new Map(layout.map((it) => [it.i, it.h])), [layout]);
  // While a block is dragged or resized the grid suppresses text selection
  // and the cards' hover chrome.
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!busy) return;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => { document.body.style.userSelect = prev; };
  }, [busy]);

  const report = (next: readonly { i: string; x: number; y: number; w: number; h: number }[]) => {
    setBusy(false);
    onLayoutCommit(next.map((it) => ({ i: it.i, x: it.x, y: it.y, w: it.w, h: it.h })));
  };

  return (
    <div ref={ref} data-block-grid="" data-edit-grid="" className={cn("gd-edit-grid", busy && "gd-edit-grid--busy", className)}>
      <ReactGridLayout
        width={width}
        layout={rglLayout}
        cols={GRID_COLS}
        rowHeight={ROW_UNIT_PX}
        margin={[GRID_GAP_PX, GRID_GAP_PX]}
        containerPadding={[0, 0]}
        compactType="vertical"
        allowOverlap={false}
        preventCollision={false}
        isDraggable
        isResizable
        resizeHandles={["se"]}
        resizeHandle={(axis, handleRef) => (
          <span ref={handleRef as React.Ref<HTMLSpanElement>} aria-hidden="true" data-resize-handle="" className={`react-resizable-handle react-resizable-handle-${axis} gd-resize-handle`} />
        )}
        draggableHandle=".block-drag-handle"
        draggableCancel={DRAG_CANCEL}
        onDragStart={() => setBusy(true)}
        onResizeStart={() => setBusy(true)}
        onDragStop={(next) => report(next)}
        onResizeStop={(next) => report(next)}
      >
        {blocks.filter((b) => heights.has(b.id)).map((b) => (
          <div key={b.id} className="gd-grid-item" data-grid-block={b.id}>
            {renderBlock(b, blockHeightPx(heights.get(b.id) || b.h))}
          </div>
        ))}
      </ReactGridLayout>
    </div>
  );
}
