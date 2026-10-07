import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ChartExportApi } from "../../components/ChartCanvas";
import { downloadSvg } from "./exportSvg";
import { clearMeasureCache, fitText, makeMeasure, type Measure } from "./geometry";
import { useBox } from "./useBox";

// 2026-10-07 (chart-types round): what every native chart shares, so the
// set reads as one product:
//   ink tokens      text / secondary / muted / grid / axis / surface - the
//                   SAME constants in every renderer (text never wears a
//                   series colour);
//   type sizes      re-exported from layout.ts (ticks 11, labels 11, titles
//                   12, legends 12) - one typography for every chart;
//   useChartFrame   the box the chart is drawn in, a text-measuring
//                   function bound to its font (re-measured when the web
//                   font arrives), the svg ref and the PNG export;
//   ChartTip        the ONE tooltip: a title, value rows keyed by a short
//                   colour mark, an optional note; placed from its own
//                   measured size so it never leaves the chart; the same
//                   element on hover and on keyboard focus;
//   ChartMessage    the empty / cannot-draw line;
//   ChartCaption    the small-print line under a plot.
// Nothing here names a colour of its own.

export const INK = "rgb(var(--color-text))";
export const SECONDARY = "rgb(var(--color-secondary))";
export const MUTED = "rgb(var(--color-muted))";
export const FAINT = "rgb(var(--color-faint))";
export const SURFACE = "rgb(var(--color-surface))";
export const SUBTLE = "rgb(var(--color-subtle))";
export const GRID = "rgb(var(--chart-grid))";
export const AXIS = "rgb(var(--chart-axis))";
export const BORDER = "rgb(var(--color-border))";
// Text set INSIDE a coloured fill: white or near-black, by the fill's own
// luminance (scale.ts needsLightText) - never the page's ink, which flips
// with the theme while the fill does not.
export const ON_DARK = "rgb(255 255 255)";
export const ON_LIGHT = "rgb(24 24 27)";

export { LABEL_SIZE, LEGEND_SIZE, TICK_SIZE, TITLE_SIZE } from "./layout";

export type ChartFrame = {
  setRoot: (el: HTMLDivElement | null) => void;
  root: HTMLDivElement | null;
  size: { w: number; h: number };
  measure: Measure;
  svgRef: RefObject<SVGSVGElement>;
  // Bumps when the web font has loaded (a layout memo's dependency).
  fontTick: number;
};

/** The frame of a native chart: its measured box, a width-measuring
 *  function in its own font, and "Export PNG" wired to its <svg>. */
export function useChartFrame(fallback: { w: number; h: number }, title?: string | null, onExportApi?: (api: ChartExportApi | null) => void): ChartFrame {
  const [setRoot, root, size] = useBox(fallback);
  const svgRef = useRef<SVGSVGElement>(null);
  const [fontTick, setFontTick] = useState(0);
  const family = useMemo(() => (root && typeof getComputedStyle === "function" ? getComputedStyle(root).fontFamily || undefined : undefined), [root]);
  useEffect(() => {
    const fonts = typeof document !== "undefined" ? (document as any).fonts : null;
    if (!fonts?.ready?.then) return;
    let live = true;
    fonts.ready.then(() => { if (live) { clearMeasureCache(); setFontTick((n) => n + 1); } }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const measure = useMemo(() => makeMeasure(family), [family, fontTick]);
  useEffect(() => {
    if (!onExportApi) return;
    onExportApi({ download: async (format) => { if (svgRef.current) await downloadSvg(svgRef.current, format, title || "chart"); } });
    return () => onExportApi(null);
  }, [onExportApi, title]);
  return { setRoot, root, size, measure, svgRef, fontTick };
}

export type TipRow = { key: string; name: string; value: string; color?: string | null; mark?: "line" | "square" | "dot" | "ring" | "dash" | "band"; muted?: boolean };
export type TipContent = { title: string; rows: TipRow[]; note?: string | null };

function TipMark({ color, mark = "square" }: { color: string; mark?: TipRow["mark"] }) {
  if (mark === "line") return <span aria-hidden="true" className="inline-block shrink-0 rounded-full" style={{ width: 10, height: 2, background: color }} />;
  if (mark === "dash") return <span aria-hidden="true" className="inline-block shrink-0" style={{ width: 10, height: 0, borderTop: `2px dashed ${color}` }} />;
  if (mark === "band") return <span aria-hidden="true" className="inline-block shrink-0 rounded-[2px]" style={{ width: 10, height: 8, background: color, opacity: 0.3 }} />;
  if (mark === "ring") return <span aria-hidden="true" className="inline-block shrink-0 rounded-full" style={{ width: 8, height: 8, border: `2px solid ${color}` }} />;
  return <span aria-hidden="true" className="inline-block shrink-0" style={{ width: 8, height: 8, borderRadius: mark === "dot" ? 999 : 2, background: color }} />;
}

/** The chart tooltip. `x` / `y` are the anchor inside a box of `width` x
 *  `height`; the tooltip sits beside the anchor where there is room and
 *  never leaves the box. Values lead (strong ink), names follow. */
export function ChartTip({ x, y, width, height, content, side = "auto" }: { x: number; y: number; width: number; height: number; content: TipContent; side?: "auto" | "above" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
  });
  let left = x + 12;
  let top = y - box.h / 2;
  if (side === "above") {
    left = x - box.w / 2;
    top = y - box.h - 10;
    if (top < 0) top = y + 14;
  } else if (left + box.w > width) {
    left = x - 12 - box.w;
  }
  if (left < 0) left = Math.min(Math.max(x - box.w / 2, 0), Math.max(0, width - box.w));
  left = Math.min(Math.max(left, 0), Math.max(0, width - box.w));
  top = Math.min(Math.max(top, 0), Math.max(0, height - box.h));
  return (
    <div
      ref={ref}
      role="status"
      data-chart-tooltip=""
      className="pointer-events-none absolute z-10 rounded-ctl border border-border bg-surface px-2.5 py-2 text-caption shadow-pop"
      style={{ left, top, maxWidth: Math.max(140, Math.min(300, width - 8)), visibility: box.w ? "visible" : "hidden" }}
    >
      <div className="mb-1 truncate font-medium text-text" data-tip-title="">{content.title}</div>
      {content.rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2 whitespace-nowrap leading-[1.5]" data-tip-row={r.name}>
          {r.color && <TipMark color={r.color} mark={r.mark} />}
          <span className={`min-w-0 truncate ${r.muted ? "text-muted" : "text-secondary"}`}>{r.name}</span>
          <span className={`ml-auto pl-3 tabular-nums ${r.muted ? "text-secondary" : "font-semibold text-text"}`}>{r.value}</span>
        </div>
      ))}
      {content.note && <div className="mt-1 max-w-[260px] whitespace-normal text-muted" data-tip-note="">{content.note}</div>}
    </div>
  );
}

/** "No rows to chart." and every "this cannot be drawn as ..." line. */
export function ChartMessage({ children, minHeight, kind }: { children: ReactNode; minHeight?: number; kind?: string }) {
  return (
    <div data-chart-message={kind || ""} className="flex h-full min-h-[96px] items-center justify-center px-4 text-center text-caption text-muted" style={{ minHeight }}>
      <span className="max-w-[440px]">{children}</span>
    </div>
  );
}

/** One line of small print under a plot, cut to the width with the full
 *  text as its tooltip. Drawn inside the svg so an exported PNG has it. */
export function captionMark(text: string, width: number, measure: Measure, size = 11): { text: string; full: string } {
  const fit = fitText(text, width, measure, size);
  return { text: fit.text, full: text };
}

/** Wraps `text` into at most `maxLines` lines of `width` px (word wrap;
 *  the last line ends in an ellipsis when the text is longer). */
export function wrapText(text: string, width: number, measure: Measure, size = 11, maxLines = 2, weight = 400): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (measure(next, size, weight) <= width || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = words[i];
    if (lines.length === maxLines - 1) {
      const rest = [line, ...words.slice(i + 1)].join(" ");
      lines.push(fitText(rest, width, measure, size, weight).text);
      return lines;
    }
  }
  if (line) lines.push(measure(line, size, weight) <= width ? line : fitText(line, width, measure, size, weight).text);
  return lines;
}

export type KeyNav = { onKeyDown: (e: React.KeyboardEvent) => void };

/** Arrow keys move through `count` marks; Enter / Space picks; Escape
 *  clears. Returns the handler for the chart's focusable <svg>. */
export function markNavigation(count: number, active: number | null, setActive: (i: number | null) => void, onPick?: (i: number) => void, horizontal = true): KeyNav["onKeyDown"] {
  return (e) => {
    const next = horizontal ? ["ArrowRight", "ArrowDown"] : ["ArrowDown", "ArrowRight"];
    const prev = horizontal ? ["ArrowLeft", "ArrowUp"] : ["ArrowUp", "ArrowLeft"];
    if (next.includes(e.key) || prev.includes(e.key)) {
      if (!count) return;
      e.preventDefault();
      const dir = next.includes(e.key) ? 1 : -1;
      setActive(active === null ? (dir > 0 ? 0 : count - 1) : Math.min(count - 1, Math.max(0, active + dir)));
    } else if ((e.key === "Enter" || e.key === " ") && active !== null && onPick) {
      e.preventDefault();
      onPick(active);
    } else if (e.key === "Escape" && active !== null) {
      setActive(null);
    }
  };
}

// ---- a legend row --------------------------------------------------------------

export type LegendEntry = { name: string; color: string; mark?: "square" | "line" | "dot" | "dash" | "band" | "ring"; identity?: { column: string; value: string } };
export type LegendMark = LegendEntry & { x: number; y: number; text: string; cut: boolean; more?: string };

/** Legend keys laid out left to right in at most two rows (the same rule
 *  as the cartesian chart's legend): a name too long is cut with an
 *  ellipsis, and what does not fit ends in "+N more" (the tooltip and the
 *  table view still name every one). */
export function layoutLegend(entries: LegendEntry[], width: number, measure: Measure, maxRows = 2): { items: LegendMark[]; height: number } {
  if (!entries.length) return { items: [], height: 0 };
  const rowH = 18, key = 16, gap = 16;
  const size = 12;
  const items: LegendMark[] = [];
  let x = 0, row = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const fit = fitText(e.name, Math.max(40, Math.min(width - key, 180)), measure, size);
    const w = key + fit.width;
    if (x > 0 && x + w > width) { row++; x = 0; }
    if (row >= maxRows) {
      const rest = entries.length - i;
      const more = `+${rest} more`;
      const mw = measure(more, size);
      const lastY = (maxRows - 1) * rowH;
      while (items.length && items[items.length - 1].y === lastY && items[items.length - 1].x + key + measure(items[items.length - 1].text, size) + gap + mw > width) items.pop();
      const last = items[items.length - 1];
      const mx = last && last.y === lastY ? last.x + key + measure(last.text, size) + gap : 0;
      items.push({ name: more, color: "", x: mx, y: lastY, text: more, cut: false, more: entries.slice(i).map((l) => l.name).join(", ") });
      row = maxRows - 1;
      break;
    }
    items.push({ ...e, x, y: row * rowH, text: fit.text, cut: fit.cut });
    x += w + gap;
  }
  return { items, height: (Math.min(row, maxRows - 1) + 1) * rowH + 6 };
}

/** The drawn legend (inside an <svg>): a key mark and the name in
 *  secondary ink. */
export function LegendRow({ items, y = 0 }: { items: LegendMark[]; y?: number }) {
  if (!items.length) return null;
  return (
    <g data-chart-legend="" transform={`translate(0 ${y})`}>
      {items.map((it) => (
        <g key={`${it.name}-${it.x}-${it.y}`} transform={`translate(${it.x} ${it.y})`} data-legend-item={it.more ? undefined : it.name}>
          {!it.more && it.mark === "line" && <line x1={0} y1={8} x2={11} y2={8} strokeWidth={2} strokeLinecap="round" style={{ stroke: it.color }} />}
          {!it.more && it.mark === "dash" && <line x1={0} y1={8} x2={11} y2={8} strokeWidth={2} strokeDasharray="4 3" style={{ stroke: it.color }} />}
          {!it.more && it.mark === "dot" && <circle cx={5} cy={8} r={4} style={{ fill: it.color }} />}
          {!it.more && it.mark === "ring" && <circle cx={5} cy={8} r={3.5} fill="none" strokeWidth={2} style={{ stroke: it.color }} />}
          {!it.more && it.mark === "band" && <rect x={0} y={3} width={11} height={10} rx={2} style={{ fill: it.color, fillOpacity: 0.28 }} />}
          {!it.more && (!it.mark || it.mark === "square") && <rect x={0} y={3} width={10} height={10} rx={2} style={{ fill: it.color }} />}
          <text x={it.more ? 0 : 16} y={12} fontSize={12} style={{ fill: SECONDARY }}>
            {it.text}
            {(it.cut || it.more) && <title>{it.more || it.name}</title>}
          </text>
        </g>
      ))}
    </g>
  );
}

/** A colour as the browser resolves it ("rgb(15, 92, 70)") - for a fill
 *  given as a CSS variable (the token theme), so the text set on it can be
 *  chosen by its luminance. Returns the input where it cannot be resolved
 *  (no layout: tests, server render). */
export function cssColor(root: HTMLElement | null, color: string): string {
  if (!root || !color.includes("var(") || typeof getComputedStyle !== "function") return color;
  try {
    const probe = document.createElement("span");
    probe.style.color = color;
    probe.style.display = "none";
    root.appendChild(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out && !out.includes("var(") ? out : color;
  } catch {
    return color;
  }
}
