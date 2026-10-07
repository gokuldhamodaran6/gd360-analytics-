import type { BlockResult, BlockSpec, DashboardBlock } from "../../api/client";
import { formatValue, humanize, measureFormats, PLAIN_FORMAT, type ValueFormat } from "../format";
import type { ChartTheme } from "../theme/chartTheme";
import { valueScale, type ValueScale } from "./scale";
import { countryName, resolveCountry, WORLD_POINTS, WORLD_SHAPES, WORLD_VIEWBOX } from "./worldMap";

// 2026-10-07 (chart-types round): rows (country, measure) -> what the map
// draws. Pure; MapChart.tsx is the renderer.
//
//   countries   one entry per ISO3 the values resolve to (worldMap.ts
//               resolveCountry: ISO3 / ISO2 / numeric / names / aliases),
//               largest first, each with its value, share of the total (an
//               additive measure only), rank and colour class. Two raw
//               values that name one country ("UK", "GBR") are added
//               together when the measure can be added, else the larger
//               one stands and the model says so.
//   unplaced    every value that names no country, with its number - shown
//               as an honest line under the map, never dropped silently.
//   scale       the classed colour scale (scale.ts): sequential, or
//               diverging when the measure runs both sides of zero.
//   focus       the viewBox that frames the countries that have values,
//               when they sit in a small part of the world (a Europe-only
//               dataset is not drawn as a speck on a world map).

export type MapCountry = {
  iso3: string;
  name: string;
  value: number;
  share: number | null;
  rank: number;
  // The raw dimension value a click filters the page by.
  raw: unknown;
  // Drawn as a filled shape (false: a small territory, drawn as a dot).
  shape: boolean;
  color: string;
};

export type MapModel = {
  column: string;
  columnName: string;
  measure: string;
  measureName: string;
  format: ValueFormat;
  additive: boolean;
  countries: MapCountry[];
  byIso: Map<string, MapCountry>;
  total: number | null;
  unplaced: { labels: string[]; count: number; total: number | null };
  merged: number;
  scale: ValueScale;
  focus: { x: number; y: number; w: number; h: number } | null;
  summary: string;
};

const ADDITIVE = new Set(["sum", "count", "count_distinct"]);

type Bounds = { x0: number; y0: number; x1: number; y1: number };
let boundsCache: Map<string, Bounds> | null = null;

/** Bounding box of one SVG path (M / m / L / l / H / h / V / v / Z). */
export function pathBounds(d: string): Bounds {
  const re = /([MmLlHhVvZz])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g;
  let x = 0, y = 0, sx = 0, sy = 0, cmd = "";
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const nums: number[] = [];
  const mark = () => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  const flush = () => {
    let i = 0;
    const need = cmd === "H" || cmd === "h" || cmd === "V" || cmd === "v" ? 1 : 2;
    let first = true;
    while (i + need <= nums.length) {
      const a = nums[i], b = nums[i + 1];
      if (cmd === "M" || cmd === "m") {
        if (first) {
          if (cmd === "M") { x = a; y = b; } else { x += a; y += b; }
          sx = x; sy = y;
        } else if (cmd === "M") { x = a; y = b; } else { x += a; y += b; }
      } else if (cmd === "L") { x = a; y = b; }
      else if (cmd === "l") { x += a; y += b; }
      else if (cmd === "H") x = a;
      else if (cmd === "h") x += a;
      else if (cmd === "V") y = a;
      else if (cmd === "v") y += a;
      mark();
      first = false;
      i += need;
    }
    nums.length = 0;
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    if (m[1]) {
      flush();
      cmd = m[1];
      if (cmd === "Z" || cmd === "z") { x = sx; y = sy; }
    } else {
      nums.push(Number(m[2]));
    }
  }
  flush();
  return { x0, y0, x1, y1 };
}

function shapeBounds(): Map<string, Bounds> {
  if (boundsCache) return boundsCache;
  const out = new Map<string, Bounds>();
  for (const s of WORLD_SHAPES) out.set(s.iso3, pathBounds(s.d));
  for (const p of WORLD_POINTS) out.set(p.iso3, { x0: p.cx - 2, y0: p.cy - 2, x1: p.cx + 2, y1: p.cy + 2 });
  boundsCache = out;
  return out;
}

const SHAPE_SET = new Set(WORLD_SHAPES.map((s) => s.iso3));

// Russia, the USA (Alaska), France, Norway ... span far more of the map
// than the place their data is "about"; the frame is fitted to anchors
// for the very large ones so one of them does not veto every zoom.
const ANCHORS = new Map<string, { cx: number; cy: number; area: number }>([...WORLD_SHAPES.map((s) => [s.iso3, { cx: s.cx, cy: s.cy, area: s.area }] as const), ...WORLD_POINTS.map((p) => [p.iso3, { cx: p.cx, cy: p.cy, area: 0 }] as const)]);

/** The viewBox that frames `isos`, or null when they span most of the
 *  world (more than 45% of its width or 60% of its height). */
export function dataFocus(isos: string[]): MapModel["focus"] {
  if (!isos.length) return null;
  const bounds = shapeBounds();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const iso of isos) {
    const b = bounds.get(iso);
    const a = ANCHORS.get(iso);
    if (!b || !a) continue;
    // A very large country contributes the 60 units around its anchor.
    const big = b.x1 - b.x0 > 140 || b.y1 - b.y0 > 110;
    const bx0 = big ? Math.max(b.x0, a.cx - 60) : b.x0, bx1 = big ? Math.min(b.x1, a.cx + 60) : b.x1;
    const by0 = big ? Math.max(b.y0, a.cy - 45) : b.y0, by1 = big ? Math.min(b.y1, a.cy + 45) : b.y1;
    if (bx0 < x0) x0 = bx0;
    if (bx1 > x1) x1 = bx1;
    if (by0 < y0) y0 = by0;
    if (by1 > y1) y1 = by1;
  }
  if (!Number.isFinite(x0)) return null;
  const W = WORLD_VIEWBOX.width, H = WORLD_VIEWBOX.height;
  if ((x1 - x0) / W > 0.45 || (y1 - y0) / H > 0.6) return null;
  // Room around the data, and never a keyhole: at least a sixth of the world.
  const padX = Math.max(12, (x1 - x0) * 0.12), padY = Math.max(10, (y1 - y0) * 0.12);
  let w = Math.max(x1 - x0 + padX * 2, W / 6), h = Math.max(y1 - y0 + padY * 2, H / 6);
  // Keep the world's 2:1 aspect so the frame fills the plot it is given.
  if (w / h < 2) w = h * 2; else h = w / 2;
  let x = (x0 + x1) / 2 - w / 2, y = (y0 + y1) / 2 - h / 2;
  x = Math.min(Math.max(0, x), W - w);
  y = Math.min(Math.max(0, y), H - h);
  if (w >= W * 0.9) return null;
  return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), w: Number(w.toFixed(1)), h: Number(h.toFixed(1)) };
}

function labelOf(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(Blanks)";
  return String(v);
}

/** The map model of a (country column, measure) result, or null when the
 *  result has no dimension / measure to draw. */
export function mapModel(result: BlockResult, block: Pick<DashboardBlock, "config" | "title">, theme: ChartTheme): MapModel | null {
  const column = (result.dimensions || [])[0];
  const measure = (result.measures || [])[0];
  if (!column || !measure) return null;
  const spec: BlockSpec | null = (block.config?.spec && typeof block.config.spec === "object" ? block.config.spec : null) || result.spec || null;
  const agg = String(spec?.measures?.find((m) => m.alias === measure)?.agg || "sum").toLowerCase();
  const additive = ADDITIVE.has(agg);
  const format = measureFormats(block, result)[measure] || PLAIN_FORMAT;

  const acc = new Map<string, { value: number; raw: unknown; rawValue: number; hits: number }>();
  const unplaced: { label: string; value: number }[] = [];
  let merged = 0;
  for (const row of result.rows || []) {
    const v = row[measure];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const iso = resolveCountry(row[column]);
    if (!iso) {
      unplaced.push({ label: labelOf(row[column]), value: v });
      continue;
    }
    const prev = acc.get(iso);
    if (!prev) {
      acc.set(iso, { value: v, raw: row[column], rawValue: v, hits: 1 });
    } else {
      merged++;
      prev.hits++;
      if (additive) prev.value += v;
      else if (Math.abs(v) > Math.abs(prev.value)) prev.value = v;
      if (Math.abs(v) > Math.abs(prev.rawValue)) { prev.raw = row[column]; prev.rawValue = v; }
    }
  }
  const entries = [...acc.entries()].sort((a, b) => b[1].value - a[1].value || a[0].localeCompare(b[0]));
  const allPositive = entries.every(([, e]) => e.value >= 0) && unplaced.every((u) => u.value >= 0);
  const placedTotal = entries.reduce((s, [, e]) => s + e.value, 0);
  const unplacedTotal = unplaced.reduce((s, u) => s + u.value, 0);
  const total = additive ? placedTotal + unplacedTotal : null;
  const scale = valueScale(entries.map(([, e]) => e.value), { sequential: theme.sequential(), diverging: theme.diverging(), marks: "countries" });
  const countries: MapCountry[] = entries.map(([iso3, e], i) => ({
    iso3,
    name: countryName(iso3) || iso3,
    value: e.value,
    share: additive && allPositive && total && total > 0 ? e.value / total : null,
    rank: i + 1,
    raw: e.raw,
    shape: SHAPE_SET.has(iso3),
    color: scale.colorOf(e.value) || theme.other,
  }));
  unplaced.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const measureName = humanize(measure);
  const columnName = humanize(column);
  return {
    column, columnName, measure, measureName, format, additive, countries,
    byIso: new Map(countries.map((c) => [c.iso3, c])),
    total,
    unplaced: { labels: unplaced.map((u) => u.label), count: unplaced.length, total: additive && unplaced.length ? unplacedTotal : null },
    merged,
    scale,
    focus: dataFocus(countries.map((c) => c.iso3)),
    summary: `${measureName} by ${columnName.toLowerCase()} on a map, ${countries.length} ${countries.length === 1 ? "country" : "countries"}`,
  };
}

/** "3 values (1,240 bookings) could not be placed: CN?, Unknown, ..." */
export function unplacedLine(model: MapModel): string | null {
  const u = model.unplaced;
  if (!u.count) return null;
  const shown = u.labels.slice(0, 3).join(", ");
  const more = u.count > 3 ? ", …" : "";
  const amount = u.total !== null ? ` (${formatValue(u.total, model.format, "full")} ${model.measureName.toLowerCase()})` : "";
  return `${u.count.toLocaleString()} ${u.count === 1 ? "value" : "values"}${amount} could not be placed: ${shown}${more}`;
}
