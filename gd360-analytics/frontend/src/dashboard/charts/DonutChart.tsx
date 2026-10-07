import { useMemo, useState } from "react";
import { formatValue, PLAIN_FORMAT, type ValueFormat } from "../format";
import { fitText, makeMeasure } from "./geometry";
import { OTHER_COLOR, SERIES_COLORS, seriesSlots } from "./model";
import { useBox } from "./useBox";

// 2026-10-07 (dashboard polish round): the part-to-whole chart. A donut is
// the one place a single measure is coloured by category, because here the
// category IS the identity of each mark - so the hues come in the
// palette's fixed order, stay with their category, and a legend names
// every one of them with its value and share.
//
//   - at most 7 slices: more fold into a neutral "Other"
//   - only slices of 4% or more are labelled on the ring (a 0.6% sliver's
//     label used to land on its neighbour's); the legend carries the rest
//   - two labels that would touch: the smaller slice's is dropped
//   - 2 px of surface between slices, no outline

export const DONUT_MAX_SLICES = 7;
export const DONUT_LABEL_MIN_SHARE = 0.04;
const LEGEND_ROW = 22;

export type DonutItem = { label: string; value: number };
export type DonutSlice = { label: string; value: number; share: number; color: string; other: boolean; start: number; end: number };

/** Items -> at most seven slices, largest first, "Other" last. */
export function donutSlices(items: DonutItem[], scope?: string | null): DonutSlice[] {
  const clean = items.filter((it) => typeof it.value === "number" && Number.isFinite(it.value) && it.value > 0);
  const sorted = [...clean].sort((a, b) => b.value - a.value);
  let kept = sorted, other = 0;
  if (sorted.length > DONUT_MAX_SLICES) {
    kept = sorted.slice(0, DONUT_MAX_SLICES - 1);
    other = sorted.slice(DONUT_MAX_SLICES - 1).reduce((s, it) => s + it.value, 0);
  }
  const total = kept.reduce((s, it) => s + it.value, 0) + other;
  if (total <= 0) return [];
  const slots = seriesSlots(scope, kept.map((it) => it.label), DONUT_MAX_SLICES);
  const all = [
    ...kept.map((it, i) => ({ label: it.label, value: it.value, color: SERIES_COLORS[slots[i]], other: false })),
    ...(other > 0 ? [{ label: "Other", value: other, color: OTHER_COLOR, other: true }] : []),
  ];
  let cursor = -90;
  return all.map((s) => {
    const share = s.value / total;
    const start = cursor;
    cursor += share * 360;
    return { ...s, share, start, end: cursor };
  });
}

export function shareText(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct.toLocaleString(undefined, { maximumFractionDigits: pct >= 10 ? 0 : 1 })}%`;
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arc(cx: number, cy: number, rOuter: number, rInner: number, start: number, end: number): string {
  const sweep = Math.min(359.99, end - start);
  const e = start + sweep;
  const large = sweep > 180 ? 1 : 0;
  const f = (n: number) => n.toFixed(2);
  const [x0, y0] = polar(cx, cy, rOuter, start), [x1, y1] = polar(cx, cy, rOuter, e);
  if (rInner <= 0) return `M${f(cx)} ${f(cy)}L${f(x0)} ${f(y0)}A${rOuter} ${rOuter} 0 ${large} 1 ${f(x1)} ${f(y1)}Z`;
  const [ix1, iy1] = polar(cx, cy, rInner, e), [ix0, iy0] = polar(cx, cy, rInner, start);
  return `M${f(x0)} ${f(y0)}A${rOuter} ${rOuter} 0 ${large} 1 ${f(x1)} ${f(y1)}L${f(ix1)} ${f(iy1)}A${rInner} ${rInner} 0 ${large} 0 ${f(ix0)} ${f(iy0)}Z`;
}

export type RingLabel = { slice: number; x: number; y: number; anchor: "start" | "end"; name: string; share: string; leader: string };

/** Direct labels for the slices big enough to carry one, placed outside
 *  the ring, none overlapping another, none leaving the box. */
export function ringLabels(slices: DonutSlice[], cx: number, cy: number, r: number, width: number, height: number, measure: ReturnType<typeof makeMeasure>): RingLabel[] {
  const build = (named: boolean): { labels: (RingLabel & { shareValue: number })[]; cramped: boolean } => {
    const labels: (RingLabel & { shareValue: number })[] = [];
    let cramped = false;
    slices.forEach((s, i) => {
      if (s.share < DONUT_LABEL_MIN_SHARE) return;
      const mid = (s.start + s.end) / 2;
      const [ax, ay] = polar(cx, cy, r + 3, mid);
      const [bx, by] = polar(cx, cy, r + 12, mid);
      const right = Math.cos((mid * Math.PI) / 180) >= 0;
      const tx = bx + (right ? 10 : -10);
      const y = Math.min(Math.max(by, 9), height - 5);
      const share = shareText(s.share);
      const shareW = measure(named ? ` ${share}` : share, 11);
      const room = (right ? width - tx : tx) - 2 - shareW;
      if (room < 0) return;
      let name = "";
      if (named) {
        const fit = fitText(s.label, room, measure, 11, 500);
        // "O… 47%" names nothing.
        if (fit.cut && Array.from(fit.text).length < 7) cramped = true;
        name = fit.text;
      }
      labels.push({ slice: i, x: tx, y, anchor: right ? "start" : "end", name, share, shareValue: s.share, leader: `M${ax.toFixed(1)} ${ay.toFixed(1)}L${bx.toFixed(1)} ${by.toFixed(1)}H${(tx + (right ? -3 : 3)).toFixed(1)}` });
    });
    return { labels, cramped };
  };
  // Name + share where every name has room; where even one would be cut
  // to a stub, every label is the share alone (the legend, right beside
  // the ring, names the colours) - one treatment per chart, never a mix.
  let { labels: out, cramped } = build(true);
  if (cramped) out = build(false).labels;
  // Same side, closer than a line of text: the smaller slice gives way.
  const keep = new Set(out.map((l) => l.slice));
  for (const side of ["start", "end"] as const) {
    let again = true;
    while (again) {
      again = false;
      const col = out.filter((l) => l.anchor === side && keep.has(l.slice)).sort((a, b) => a.y - b.y);
      for (let i = 1; i < col.length; i++) {
        if (col[i].y - col[i - 1].y < 15) {
          keep.delete(col[i].shareValue < col[i - 1].shareValue ? col[i].slice : col[i - 1].slice);
          again = true;
          break;
        }
      }
    }
  }
  return out.filter((l) => keep.has(l.slice)).map(({ shareValue: _drop, ...l }) => l);
}

export type DonutChartProps = {
  items: DonutItem[];
  format?: ValueFormat;
  // Keeps each category on its colour while the page is open (block id).
  scope?: string | null;
  pie?: boolean;
  title?: string | null;
  onItemClick?: (label: string) => void;
  selectedLabel?: string | null;
  minHeight?: number;
};

export function DonutChart({ items, format = PLAIN_FORMAT, scope, pie = false, title, onItemClick, selectedLabel, minHeight }: DonutChartProps) {
  const [setRoot, root, size] = useBox({ w: 520, h: 260 });
  const [hover, setHover] = useState<string | null>(null);
  const slices = useMemo(() => donutSlices(items, scope), [items, scope]);
  const family = useMemo(() => (root && typeof getComputedStyle === "function" ? getComputedStyle(root).fontFamily || undefined : undefined), [root]);
  const measure = useMemo(() => makeMeasure(family), [family]);
  const total = slices.reduce((s, it) => s + it.value, 0);

  if (!slices.length) {
    return <div className="flex h-full min-h-[96px] items-center justify-center text-caption text-muted" style={{ minHeight }}>No data yet.</div>;
  }

  // Ring beside the legend when there is room for both, above it otherwise.
  // Stacked, the legend is sized first (two columns when the card is wide
  // enough for them) and the ring takes what is left - every slice is in
  // the legend, so the legend is the part that must never be cut off.
  const side = size.w >= 440;
  const legendCols = !side && size.w >= 380 ? 2 : 1;
  const legendRows = Math.ceil(slices.length / legendCols);
  const legendH = legendRows * LEGEND_ROW;
  const areaW = side ? Math.round(Math.min(size.w * 0.54, 340)) : size.w;
  const areaH = side ? size.h : Math.round(Math.max(96, Math.min(size.h - legendH - 8, 220)));
  const cx = areaW / 2, cy = areaH / 2;
  let r = Math.min(areaH / 2 - 18, areaW / 2 - 78);
  const labelled = r >= 38;
  if (!labelled) r = Math.max(24, Math.min(areaH / 2 - 6, areaW / 2 - 6));
  const inner = pie ? 0 : r * 0.62;
  const labels = labelled ? ringLabels(slices, cx, cy, r, areaW, areaH, measure) : [];
  const totalText = [formatValue(total, format, "auto"), formatValue(total, format, "compact")].find((t) => measure(t, 18, 600) <= inner * 2 - 14);
  const showTotal = !pie && format.format !== "percent" && inner >= 30 && Boolean(totalText);
  const faded = (label: string) => (selectedLabel ? selectedLabel !== label : hover !== null && hover !== label);

  return (
    <div ref={setRoot} data-chart="donut" className={`relative flex h-full w-full ${side ? "flex-row items-center gap-3" : "flex-col gap-2"}`} data-donut-layout={side ? "side" : "stacked"} style={{ minHeight }}>
      <svg width={areaW} height={areaH} viewBox={`0 0 ${areaW} ${areaH}`} role="img" aria-label={`${title || "Breakdown"}: ${slices.map((s) => `${s.label} ${shareText(s.share)}`).join(", ")}`} className="block shrink-0" style={{ fontFamily: "inherit", fontVariantNumeric: "tabular-nums" }}>
        {slices.map((s) => {
          const clickable = Boolean(onItemClick) && !s.other;
          return (
            <path
              key={s.label}
              d={arc(cx, cy, r, inner, s.start, s.end)}
              data-donut-slice={s.label}
              strokeWidth={slices.length > 1 ? 2 : 0}
              strokeLinejoin="round"
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={clickable ? `${s.label}: ${shareText(s.share)}` : undefined}
              style={{ fill: s.color, stroke: "rgb(var(--color-surface))", opacity: faded(s.label) ? 0.35 : 1, cursor: clickable ? "pointer" : undefined, outlineOffset: 2 }}
              onMouseEnter={() => setHover(s.label)}
              onMouseLeave={() => setHover(null)}
              onClick={clickable ? () => onItemClick!(s.label) : undefined}
              onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onItemClick!(s.label); } } : undefined}
            >
              <title>{`${s.label}: ${formatValue(s.value, format, "full")} (${shareText(s.share)})`}</title>
            </path>
          );
        })}
        {showTotal && (
          <>
            <text x={cx} y={cy + 2} textAnchor="middle" fontSize={18} fontWeight={600} style={{ fill: "rgb(var(--color-text))" }}>{totalText}</text>
            <text x={cx} y={cy + 17} textAnchor="middle" fontSize={11} style={{ fill: "rgb(var(--color-muted))" }}>Total</text>
          </>
        )}
        {labels.map((l) => (
          <g key={l.slice} data-donut-label={slices[l.slice].label} style={{ opacity: faded(slices[l.slice].label) ? 0.45 : 1 }}>
            <path d={l.leader} fill="none" strokeWidth={1} style={{ stroke: "rgb(var(--chart-axis))" }} />
            <text x={l.x} y={l.y + 4} textAnchor={l.anchor} fontSize={11}>
              {l.name && <tspan fontWeight={500} style={{ fill: "rgb(var(--color-text))" }}>{l.name}</tspan>}
              <tspan style={{ fill: l.name ? "rgb(var(--color-muted))" : "rgb(var(--color-secondary))" }}>{l.name ? ` ${l.share}` : l.share}</tspan>
              {l.name !== slices[l.slice].label && <title>{`${slices[l.slice].label} ${l.share}`}</title>}
            </text>
          </g>
        ))}
      </svg>
      <ul
        data-donut-legend=""
        className={`m-0 min-h-0 min-w-0 list-none overflow-y-auto p-0 ${side ? "max-h-full flex-1 self-center" : "grid w-full flex-1 content-start gap-x-3"}`}
        style={side ? undefined : { gridTemplateColumns: `repeat(${legendCols}, minmax(0, 1fr))`, gridAutoFlow: legendCols > 1 ? "column" : undefined, gridTemplateRows: legendCols > 1 ? `repeat(${legendRows}, ${LEGEND_ROW}px)` : undefined }}
      >
        {slices.map((s) => {
          const clickable = Boolean(onItemClick) && !s.other;
          const row = (
            <>
              <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate text-left text-secondary" title={s.label}>{s.label}</span>
              <span className="shrink-0 font-medium tabular-nums text-text">{formatValue(s.value, format, size.w < 300 ? "compact" : "full")}</span>
              <span className="w-[38px] shrink-0 text-right tabular-nums text-muted">{shareText(s.share)}</span>
            </>
          );
          const cls = `flex h-[22px] w-full items-center gap-1.5 rounded-[6px] px-1 text-caption ${faded(s.label) ? "opacity-50" : ""}`;
          return (
            <li key={s.label} data-donut-legend-item={s.label} onMouseEnter={() => setHover(s.label)} onMouseLeave={() => setHover(null)}>
              {clickable ? (
                <button type="button" className={`ui-focus ${cls} hover:bg-subtle`} aria-label={`${s.label}: ${formatValue(s.value, format, "full")}, ${shareText(s.share)}`} aria-pressed={selectedLabel === s.label} onClick={() => onItemClick!(s.label)}>{row}</button>
              ) : (
                <div className={cls} role="group" aria-label={`${s.label}: ${formatValue(s.value, format, "full")}, ${shareText(s.share)}`}>{row}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
