import { useMemo, useState } from "react";
import type { BlockResult, BlockSpec, DashboardBlock } from "../../api/client";
import type { ChartExportApi } from "../../components/ChartCanvas";
import { formatValue, humanize, measureFormats, PLAIN_FORMAT, type ValueFormat } from "../format";
import { blockColorMode, blockSingleColor, valueKey, type ChartTheme } from "../theme/chartTheme";
import { dimInfo, valueId } from "./dimensions";
import { shareText } from "./DonutChart";
import { fitText } from "./geometry";
import { ChartMessage, ChartTip, cssColor, INK, layoutLegend, LegendRow, MUTED, ON_DARK, ON_LIGHT, SURFACE, TICK_SIZE, TITLE_SIZE, useChartFrame, type LegendEntry } from "./kit";
import { seriesSlots } from "./model";
import { needsLightText } from "./scale";

// 2026-10-07 (chart-types round): the treemap - part-to-whole for MORE
// categories than a donut reads (one level, or two: a group and its parts).
//
//   area     each tile its share of the total (squarified, so tiles stay
//            close to square and comparable by eye);
//   fold     past 24 tiles the smallest are one neutral "Other" tile (the
//            table has them all);
//   colour   one level: the dimension's identity colours when colour is
//            "by value" and the column is known, else the single colour
//            (never a ramp by value - area already says how much);
//            two levels: each GROUP one colour, named in the legend;
//   labels   a name (and the value under it) only on a tile it fits in,
//            in white or ink by the tile's own luminance;
//   hover    name, value, share - and the group's, on two levels.

export const TREEMAP_MAX_TILES = 24;

export type TreemapLeaf = { key: string; label: string; value: number; share: number; color: string; raw: unknown; group: string | null; groupRaw: unknown; other: boolean };
export type TreemapGroup = { key: string; label: string; value: number; share: number; color: string; raw: unknown; leaves: TreemapLeaf[] };

export type TreemapModel = {
  levels: 1 | 2;
  dim: string;
  measure: string;
  measureName: string;
  format: ValueFormat;
  groups: TreemapGroup[];
  total: number;
  legend: LegendEntry[] | null;
  note: string | null;
  dropped: number;
  summary: string;
};

export function treemapModel(result: BlockResult, block: Pick<DashboardBlock, "id" | "config" | "title">, theme: ChartTheme): TreemapModel | null {
  const dims = result.dimensions || [];
  const measure = (result.measures || [])[0];
  if (!dims.length || !measure) return null;
  const cfg = block.config || {};
  const spec: BlockSpec | null = (cfg.spec && typeof cfg.spec === "object" ? cfg.spec : null) || result.spec || null;
  void spec;
  const format = measureFormats(block, result)[measure] || PLAIN_FORMAT;
  const mode = blockColorMode(theme, cfg);
  const single = blockSingleColor(theme, cfg);
  const d0 = dimInfo(result, dims[0]);
  const d1 = dims.length >= 2 ? dimInfo(result, dims[1]) : null;
  let dropped = 0;
  type Raw = { g: unknown; c: unknown; v: number };
  const raws: Raw[] = [];
  for (const row of result.rows || []) {
    const v = row[measure];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) { if (typeof v === "number" && v < 0) dropped++; continue; }
    raws.push({ g: row[dims[0]] ?? null, c: d1 ? row[dims[1]] ?? null : null, v });
  }
  const total = raws.reduce((s, r) => s + r.v, 0);
  if (!(total > 0)) return null;
  const measureName = humanize(measure);
  let note: string | null = dropped ? `${dropped} negative ${dropped === 1 ? "value is" : "values are"} left out (an area cannot be negative).` : null;

  if (!d1) {
    const acc = new Map<string, { raw: unknown; v: number }>();
    for (const r of raws) { const id = valueId(r.g); const e = acc.get(id); if (e) e.v += r.v; else acc.set(id, { raw: r.g, v: r.v }); }
    let items = [...acc.values()].sort((a, b) => b.v - a.v);
    theme.observe(dims[0], items.map((it) => it.raw));
    const known = d0.kind === "category" && theme.column(dims[0]).known;
    const colored = known && mode === "by_value" && !theme.column(dims[0]).overflow;
    let other = 0;
    if (items.length > TREEMAP_MAX_TILES) {
      const rest = items.slice(TREEMAP_MAX_TILES - 1);
      other = rest.reduce((s, it) => s + it.v, 0);
      note = `${rest.length} smaller ${humanize(dims[0]).toLowerCase()} values are grouped as "Other".${note ? ` ${note}` : ""}`;
      items = items.slice(0, TREEMAP_MAX_TILES - 1);
    }
    const leaves: TreemapLeaf[] = items.map((it) => ({
      key: valueId(it.raw), label: d0.label(it.raw), value: it.v, share: it.v / total, raw: it.raw, group: null, groupRaw: null, other: false,
      color: colored ? theme.colorFor(dims[0], it.raw) : single,
    }));
    if (other > 0) leaves.push({ key: "\u0000other", label: "Other", value: other, share: other / total, raw: null, group: null, groupRaw: null, other: true, color: theme.other });
    return {
      levels: 1, dim: dims[0], measure, measureName, format, total, note, dropped,
      groups: [{ key: "all", label: "", value: total, share: 1, color: single, raw: null, leaves }],
      legend: null,
      summary: `${measureName} by ${humanize(dims[0]).toLowerCase()} as a treemap`,
    };
  }

  // Two levels: groups, largest first, each with its parts.
  const gAcc = new Map<string, { raw: unknown; v: number; kids: Map<string, { raw: unknown; v: number }> }>();
  for (const r of raws) {
    const gid = valueId(r.g);
    let g = gAcc.get(gid);
    if (!g) { g = { raw: r.g, v: 0, kids: new Map() }; gAcc.set(gid, g); }
    g.v += r.v;
    const cid = valueId(r.c);
    const k = g.kids.get(cid);
    if (k) k.v += r.v; else g.kids.set(cid, { raw: r.c, v: r.v });
  }
  const gs = [...gAcc.values()].sort((a, b) => b.v - a.v);
  theme.observe(dims[0], gs.map((g) => g.raw));
  const known = d0.kind === "category" && theme.column(dims[0]).known;
  const slots = known ? [] : seriesSlots(`${block.id}:${dims[0]}`, gs.map((g) => d0.label(g.raw)), theme.slots.length);
  const groupColor = (g: { raw: unknown }, i: number) => (gs.length === 1 || mode === "single" ? single : known ? theme.colorFor(dims[0], g.raw) : theme.slot(slots[i]));
  const perGroup = Math.max(3, Math.floor((TREEMAP_MAX_TILES * 2) / Math.max(1, gs.length)));
  let folded = 0;
  const groups: TreemapGroup[] = gs.map((g, i) => {
    const color = groupColor(g, i);
    let kids = [...g.kids.values()].sort((a, b) => b.v - a.v);
    let other = 0;
    if (kids.length > perGroup) { const rest = kids.slice(perGroup - 1); other = rest.reduce((s, k) => s + k.v, 0); folded += rest.length; kids = kids.slice(0, perGroup - 1); }
    const leaves: TreemapLeaf[] = kids.map((k) => ({ key: `${valueId(g.raw)}|${valueId(k.raw)}`, label: d1.label(k.raw), value: k.v, share: k.v / total, raw: k.raw, group: d0.label(g.raw), groupRaw: g.raw, other: false, color }));
    if (other > 0) leaves.push({ key: `${valueId(g.raw)}|\u0000other`, label: "Other", value: other, share: other / total, raw: null, group: d0.label(g.raw), groupRaw: g.raw, other: true, color });
    return { key: valueId(g.raw), label: d0.label(g.raw), value: g.v, share: g.v / total, color, raw: g.raw, leaves };
  });
  if (folded) note = `${folded} smaller ${humanize(dims[1]).toLowerCase()} values are grouped as "Other" inside their ${humanize(dims[0]).toLowerCase()}.${note ? ` ${note}` : ""}`;
  return {
    levels: 2, dim: dims[0], measure, measureName, format, total, note, dropped, groups,
    // (One colour for every group - single-colour mode - needs no legend: the group headers name them.)
    legend: groups.length > 1 && new Set(groups.map((g) => g.color)).size > 1 ? groups.map((g) => ({ name: g.label, color: g.color, identity: known ? { column: dims[0], value: valueKey(g.raw) } : undefined })) : null,
    summary: `${measureName} by ${humanize(dims[0]).toLowerCase()} and ${humanize(dims[1]).toLowerCase()} as a treemap`,
  };
}

export type Tile = { x: number; y: number; w: number; h: number };

/** Squarified treemap (Bruls, Huizing, van Wijk): `values` (largest first)
 *  laid into `box`, each rectangle's area proportional to its value. */
export function squarify(values: number[], box: Tile): Tile[] {
  const out: Tile[] = new Array(values.length);
  const total = values.reduce((s, v) => s + v, 0);
  if (!(total > 0) || box.w <= 0 || box.h <= 0) return values.map(() => ({ x: box.x, y: box.y, w: 0, h: 0 }));
  const scale = (box.w * box.h) / total;
  const areas = values.map((v) => v * scale);
  let { x, y, w, h } = box;
  let i = 0;
  const worst = (row: number[], side: number) => {
    const sum = row.reduce((s, v) => s + v, 0);
    const mx = Math.max(...row), mn = Math.min(...row);
    return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
  };
  while (i < areas.length) {
    const side = Math.min(w, h);
    const row = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) { row.push(areas[j]); j++; }
    const sum = row.reduce((s, v) => s + v, 0);
    const thick = sum / side;
    let off = 0;
    row.forEach((a, k) => {
      const len = a / thick;
      out[i + k] = w >= h ? { x, y: y + off, w: thick, h: len } : { x: x + off, y, w: len, h: thick };
      off += len;
    });
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    i = j;
  }
  return out;
}

export type TreemapChartProps = {
  model: TreemapModel;
  title?: string | null;
  selectedValue?: unknown;
  hasSelection?: boolean;
  onPick?: (value: unknown) => void;
  onExportApi?: (api: ChartExportApi | null) => void;
  minHeight?: number;
  compact?: boolean;
};

const GAP = 2;

export function TreemapChart({ model, title, selectedValue, hasSelection = false, onPick, onExportApi, minHeight, compact = false }: TreemapChartProps) {
  const frame = useChartFrame({ w: 560, h: 280 }, title, onExportApi);
  const { size, measure, root } = frame;
  const [active, setActive] = useState<string | null>(null);
  const W = Math.max(120, Math.floor(size.w)), H = Math.max(96, Math.floor(size.h));

  const scene = useMemo(() => {
    const legend = compact || !model.legend ? { items: [], height: 0 } : layoutLegend(model.legend, W, measure);
    const noteFit = !compact && model.note ? fitText(model.note, W, measure, TICK_SIZE) : null;
    const top = legend.height, bottom = noteFit ? 18 : 0;
    const box: Tile = { x: 0, y: top, w: W, h: Math.max(24, H - top - bottom) };
    const tiles: { leaf: TreemapLeaf; rect: Tile; light: boolean }[] = [];
    const headers: { group: TreemapGroup; x: number; y: number; w: number; text: string; light: boolean }[] = [];
    const lightOf = new Map<string, boolean>();
    const isLight = (color: string) => {
      if (!lightOf.has(color)) lightOf.set(color, needsLightText(cssColor(root, color)));
      return lightOf.get(color) as boolean;
    };
    const groupRects = model.levels === 2 ? squarify(model.groups.map((g) => g.value), box) : [box];
    model.groups.forEach((g, gi) => {
      let r = groupRects[gi];
      if (model.levels === 2) {
        // 2 px of surface around a group; a header strip when it is big enough.
        r = { x: r.x + (gi ? 0 : 0), y: r.y, w: r.w, h: r.h };
        const headH = !compact && r.w >= 56 && r.h >= 44 ? 16 : 0;
        if (headH) {
          const fit = fitText(g.label, r.w - 12, measure, TICK_SIZE, 600);
          headers.push({ group: g, x: r.x + 5, y: r.y + 12, w: r.w, text: fit.text, light: isLight(g.color) });
        }
        const inner: Tile = { x: r.x, y: r.y + headH, w: r.w, h: Math.max(0, r.h - headH) };
        const rects = squarify(g.leaves.map((l) => l.value), inner);
        g.leaves.forEach((leaf, i) => tiles.push({ leaf, rect: rects[i], light: isLight(leaf.color) }));
        // The header sits on a tile-coloured strip.
        if (headH) tiles.push({ leaf: { key: `${g.key}|\u0000head`, label: g.label, value: g.value, share: g.share, color: g.color, raw: g.raw, group: null, groupRaw: g.raw, other: false }, rect: { x: r.x, y: r.y, w: r.w, h: headH }, light: isLight(g.color) });
      } else {
        const rects = squarify(g.leaves.map((l) => l.value), r);
        g.leaves.forEach((leaf, i) => tiles.push({ leaf, rect: rects[i], light: isLight(leaf.color) }));
      }
    });
    return { legend, noteFit, tiles, headers, groupRects };
  }, [model, W, H, measure, compact, root]);

  if (!model.groups.length) return <ChartMessage kind="treemap-empty" minHeight={minHeight}>No positive values to draw.</ChartMessage>;

  const { legend, noteFit, tiles, headers, groupRects } = scene;
  const leaves = tiles.filter((t) => !t.leaf.key.endsWith("\u0000head"));
  const order = leaves.map((t) => t.leaf.key);
  const live = active ? leaves.find((t) => t.leaf.key === active) || null : null;
  const selectedKey = hasSelection ? String(selectedValue) : null;
  const filterRaw = (leaf: TreemapLeaf) => (model.levels === 2 ? leaf.groupRaw : leaf.raw);
  const dim = (leaf: TreemapLeaf) => (selectedKey !== null ? String(filterRaw(leaf)) !== selectedKey : active !== null && active !== leaf.key);
  const onKey = (e: React.KeyboardEvent) => {
    const at = active ? order.indexOf(active) : -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); setActive(order[Math.min(order.length - 1, at + 1)]); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); setActive(order[Math.max(0, at < 0 ? 0 : at - 1)]); }
    else if ((e.key === "Enter" || e.key === " ") && live && onPick && !live.leaf.other) { e.preventDefault(); onPick(filterRaw(live.leaf)); }
    else if (e.key === "Escape") setActive(null);
  };
  const groupOf = (leaf: TreemapLeaf) => (model.levels === 2 ? model.groups.find((g) => String(g.raw) === String(leaf.groupRaw)) || null : null);
  // One number format a chart: every digit when each labelled tile has
  // room for it, else compact on all of them (never "48,697" beside "11.9K").
  const valueMode: "full" | "compact" = leaves.every((t) => {
    const w = t.rect.w - GAP, h = t.rect.h - GAP;
    return w < 44 || h < 36 || measure(formatValue(t.leaf.value, model.format, "full"), TICK_SIZE) <= w - 10;
  }) ? "full" : "compact";

  return (
    <div ref={frame.setRoot} data-chart="treemap" data-treemap-levels={model.levels} className="relative h-full w-full" style={{ minHeight }}>
      <svg
        ref={frame.svgRef}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title ? `${title}. ` : ""}${model.summary}. Largest: ${model.groups.flatMap((g) => g.leaves).sort((a, b) => b.value - a.value).slice(0, 3).map((l) => `${l.label} ${shareText(l.share)}`).join(", ")}.`}
        tabIndex={compact ? -1 : 0}
        className={`ui-focus absolute left-0 top-0 block select-none rounded-[6px] ${onPick ? "cursor-pointer" : "cursor-default"}`}
        style={{ fontFamily: "inherit", fontVariantNumeric: "tabular-nums" }}
        onKeyDown={compact ? undefined : onKey}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        <LegendRow items={legend.items} />
        {tiles.map(({ leaf, rect, light }) => {
          const head = leaf.key.endsWith("\u0000head");
          const w = Math.max(0, rect.w - GAP), h = Math.max(0, rect.h - GAP);
          if (w <= 0 || h <= 0) return null;
          const on = active === leaf.key;
          const name = !head && !compact && w >= 44 && h >= 20 ? fitText(leaf.label, w - 10, measure, TITLE_SIZE, 500) : null;
          // "Offl…" names nothing: a name is drawn whole or nearly so.
          const showName = name && (!name.cut || Array.from(name.text).length >= 5);
          const valueText = formatValue(leaf.value, model.format, valueMode);
          const showValue = showName && h >= 36 && measure(valueText, TICK_SIZE) <= w - 10;
          return (
            <g key={leaf.key} style={{ opacity: head ? 1 : dim(leaf) ? 0.4 : 1 }}>
              <rect
                x={rect.x} y={rect.y} width={w} height={h} rx={2}
                data-treemap-tile={head ? undefined : leaf.label}
                data-treemap-head={head ? leaf.label : undefined}
                data-tile-group={leaf.group || undefined}
                strokeWidth={on ? 1.5 : 0}
                style={{ fill: leaf.color, fillOpacity: head ? 1 : model.levels === 2 ? 0.86 : 1, stroke: on ? INK : "none" }}
                onPointerEnter={compact || head ? undefined : () => setActive(leaf.key)}
                onClick={onPick && !leaf.other ? () => onPick(head ? leaf.groupRaw : filterRaw(leaf)) : undefined}
              />
              {showName && <text x={rect.x + 6} y={rect.y + 15} fontSize={TITLE_SIZE} fontWeight={500} pointerEvents="none" data-treemap-label="" style={{ fill: light ? ON_DARK : ON_LIGHT }}>{name!.text}</text>}
              {showValue && <text x={rect.x + 6} y={rect.y + 30} fontSize={TICK_SIZE} pointerEvents="none" data-treemap-value="" style={{ fill: light ? ON_DARK : ON_LIGHT, opacity: 0.86 }}>{valueText}</text>}
            </g>
          );
        })}
        {headers.map((hd) => (
          <text key={hd.group.key} x={hd.x} y={hd.y} fontSize={TICK_SIZE} fontWeight={600} pointerEvents="none" data-treemap-group-label="" style={{ fill: hd.light ? ON_DARK : ON_LIGHT }}>{hd.text}</text>
        ))}
        {/* Two levels: a surface line around each group reads as the boundary. */}
        {model.levels === 2 && groupRects.map((r, i) => <rect key={i} x={r.x - 1} y={r.y - 1} width={Math.max(0, r.w)} height={Math.max(0, r.h)} fill="none" strokeWidth={2} pointerEvents="none" style={{ stroke: SURFACE }} />)}
        {noteFit && <text x={0} y={H - 4} fontSize={TICK_SIZE} data-chart-note="" style={{ fill: MUTED }}>{noteFit.text}{noteFit.cut && <title>{model.note}</title>}</text>}
      </svg>
      {live && !compact && (() => {
        const g = groupOf(live.leaf);
        return (
          <ChartTip
            x={live.rect.x + live.rect.w / 2}
            y={live.rect.y + live.rect.h / 2}
            width={W}
            height={H}
            content={{
              title: g ? `${g.label} · ${live.leaf.label}` : live.leaf.label,
              rows: [
                { key: "v", name: model.measureName, value: formatValue(live.leaf.value, model.format, "full"), color: live.leaf.color },
                { key: "s", name: "Share of total", value: shareText(live.leaf.share), muted: true },
                ...(g ? [{ key: "g", name: `${g.label} total`, value: `${formatValue(g.value, model.format, "full")} (${shareText(g.share)})`, muted: true }] : []),
              ],
            }}
          />
        );
      })()}
    </div>
  );
}
