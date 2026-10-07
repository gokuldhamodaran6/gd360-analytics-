import type { BlockResult, BlockSpec, DashboardBlock } from "../../api/client";
import { SIGNATURE_COLORS } from "../../lib/chartStyle";
import { normalizeChartType } from "../../lib/exploreEngine";
import { chartArrangement, humanize, MAX_SERIES, measureAliases, measureFormats, PLAIN_FORMAT, titleMentions, type ChartArrangement, type ValueFormat } from "../format";
import { normalizeGrain, parseDateParts, periodLabel, type DateParts, type Grain } from "./geometry";

// 2026-10-07 (dashboard polish round): BlockResult -> what the native
// chart draws. This is where the chart decisions are made, once, for the
// dashboard grid, the canvas cells and the published view alike:
//
//   colour   one measure by category is ONE colour (the brand green). Hue
//            only appears when it carries identity: a series dimension
//            (time x segment), several measures on one axis, a donut. Then
//            the hues come in the palette's fixed order and stay with the
//            entity (see seriesSlots).
//   axes     never two y scales. Measures of different kinds or more than
//            8x apart get one panel each (format.ts chartArrangement).
//   names    SQL aliases are humanised for display; a title that only
//            repeats what the card title says is left out.

export const SINGLE_COLOR = "rgb(var(--color-primary))";
export const OTHER_COLOR = "rgb(var(--color-faint))";
// Slots 1-6 are the kit's --color-series-N; slot 7 is the next validated
// hue of the same palette (lib/chartStyle SIGNATURE_COLORS), used only by
// a seven-slice donut.
export const SERIES_COLORS: readonly string[] = [1, 2, 3, 4, 5, 6].map((i) => `rgb(var(--color-series-${i}))`).concat(SIGNATURE_COLORS[6]);

/** The colour of series slot `slot` when there are `count` series. */
export function seriesColor(slot: number, count: number): string {
  if (count <= 1) return SINGLE_COLOR;
  return SERIES_COLORS[Math.min(Math.max(0, slot), SERIES_COLORS.length - 1)];
}

// Colour follows the entity, never its rank: the first time a block shows
// a series it takes the lowest free slot and keeps it for as long as the
// page is open, so filtering "Groups" away does not repaint "Direct".
const slotMemo = new Map<string, Map<string, number>>();
export function seriesSlots(scope: string | null | undefined, names: string[], max = MAX_SERIES): number[] {
  if (!scope) return names.map((_, i) => Math.min(i, max - 1));
  let memo = slotMemo.get(scope);
  if (!memo) {
    memo = new Map();
    slotMemo.set(scope, memo);
    if (slotMemo.size > 400) slotMemo.delete(slotMemo.keys().next().value as string);
  }
  const taken = new Set<number>();
  const out: number[] = new Array(names.length).fill(-1);
  names.forEach((name, i) => {
    const slot = memo!.get(name);
    if (slot !== undefined && slot < max && !taken.has(slot)) {
      out[i] = slot;
      taken.add(slot);
    }
  });
  names.forEach((name, i) => {
    if (out[i] >= 0) return;
    let slot = 0;
    while (taken.has(slot) && slot < max - 1) slot++;
    out[i] = slot;
    taken.add(slot);
    memo!.set(name, slot);
  });
  return out;
}

export type ChartKind = "bar" | "hbar" | "line" | "area";

export type ChartSeries = { key: string; name: string; values: (number | null)[]; color: string };

export type ChartPanel = {
  key: string;
  // Shown above the panel: the measure's name (small multiples, or a
  // single measure the card title does not already name).
  title: string | null;
  series: ChartSeries[];
  format: ValueFormat;
};

export type ChartCategory = { value: unknown; label: string; date: DateParts | null };

export type ChartModel = {
  kind: ChartKind;
  step: boolean;
  stacked: boolean;
  time: boolean;
  grain: Grain;
  categories: ChartCategory[];
  panels: ChartPanel[];
  // Two or more series on one panel: the legend. Null for one series.
  legend: { name: string; color: string }[] | null;
  xTitle: string | null;
  note: string | null;
  // What the chart is, in a sentence (the svg's accessible name).
  summary: string;
};

export type ChartPlan =
  | { kind: "chart"; model: ChartModel; arrangement: ChartArrangement }
  | { kind: "table"; reason: string }
  | { kind: "donut"; pie: boolean }
  | { kind: "plotly" }
  | { kind: "empty" };

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function categoryLabel(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(Blanks)";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

function measureColumns(r: BlockResult): string[] {
  if (r.measures?.length) return r.measures;
  const dims = new Set([...(r.dimensions || []), ...(r.time_column ? [r.time_column] : [])]);
  return (r.columns || []).filter((c) => !dims.has(c.name) && r.rows?.some((row) => typeof row[c.name] === "number")).map((c) => c.name);
}

const ADDITIVE = new Set(["sum", "count"]);

/** Decide how a chart block is drawn and build the model for it. */
export function planChart(r: BlockResult, block: Pick<DashboardBlock, "id" | "title" | "config">): ChartPlan {
  const cfg = block.config || {};
  const spec: BlockSpec | null = (cfg.spec && typeof cfg.spec === "object" ? cfg.spec : null) || r.spec || null;
  const measures = measureColumns(r);
  const dims = [...(r.time_column ? [r.time_column] : []), ...(r.dimensions || [])];
  const xField = dims[0] || (r.columns || []).find((c) => !measures.includes(c.name))?.name || null;
  if (!xField || !measures.length || !r.rows?.length) return { kind: "empty" };
  const type = normalizeChartType(cfg.chart_type || (r.time_column ? "line" : "bar"));
  if (type === "pie" || type === "donut") return { kind: "donut", pie: type === "pie" };
  if (type === "scatter" || type === "histogram") return { kind: "plotly" };

  const kind: ChartKind = type === "horizontal_bar" ? "hbar" : type === "bar" || type === "grouped_bar" || type === "stacked_bar" ? "bar" : type === "area" || type === "stacked_area" ? "area" : "line";
  const stackedType = type === "stacked_bar" || type === "stacked_area";
  const formats = measureFormats(block, r);
  const aliases = measureAliases(r, spec);
  const fmtOf = (m: string): ValueFormat => formats[m] || PLAIN_FORMAT;
  const grain = normalizeGrain(r.period || spec?.time?.grain);

  // Categories, in the order the rows came back (a period axis in time order).
  let rows = r.rows;
  const isTime = Boolean(r.time_column && xField === r.time_column) && rows.every((row) => row[xField] === null || parseDateParts(row[xField]) !== null);
  if (isTime) {
    rows = [...rows].filter((row) => row[xField] !== null && row[xField] !== undefined).sort((a, b) => String(a[xField]).localeCompare(String(b[xField])));
  }
  const categories: ChartCategory[] = [];
  const index = new Map<string, number>();
  for (const row of rows) {
    const key = String(row[xField]);
    if (index.has(key)) continue;
    index.set(key, categories.length);
    const date = isTime ? parseDateParts(row[xField]) : null;
    categories.push({ value: row[xField] ?? null, label: date ? periodLabel(date, grain) : categoryLabel(row[xField]), date });
  }
  if (!categories.length) return { kind: "empty" };

  const xName = humanize(xField);
  const xTitle = isTime || titleMentions(block.title, xField) ? null : xName;
  const colorField = dims.length >= 2 ? dims[1] : null;
  const base = { kind, step: type === "step_line", time: isTime, grain, categories, xTitle };
  const byWhat = isTime ? `by ${grain}` : `by ${xName.toLowerCase()}`;

  // ---- a series dimension: one series per value, on one axis ----
  if (colorField) {
    const m = measures[0];
    const order: string[] = [];
    const cells = new Map<string, (number | null)[]>();
    for (const row of rows) {
      const name = categoryLabel(row[colorField]);
      let arr = cells.get(name);
      if (!arr) {
        arr = new Array(categories.length).fill(null);
        cells.set(name, arr);
        order.push(name);
      }
      const i = index.get(String(row[xField]));
      const v = num(row[m]);
      if (i !== undefined && v !== null) arr[i] = (arr[i] ?? 0) + v;
    }
    let names = order;
    let note: string | null = null;
    // The label of the folded tail (never one a real value already uses).
    let fold: string | null = null;
    if (names.length > MAX_SERIES) {
      // More series than the palette has hues: the largest keep a colour,
      // the tail folds into "Other" when the measure can be added up.
      const total = (name: string) => cells.get(name)!.reduce((s: number, v) => s + Math.abs(v ?? 0), 0);
      const ranked = [...names].sort((a, b) => total(b) - total(a));
      const agg = String(spec?.measures?.find((x) => x.alias === m)?.agg || "").toLowerCase();
      if (ADDITIVE.has(agg)) {
        const keep = ranked.slice(0, MAX_SERIES - 1);
        const rest = ranked.slice(MAX_SERIES - 1);
        const other: (number | null)[] = new Array(categories.length).fill(null);
        for (const name of rest) cells.get(name)!.forEach((v, i) => { if (v !== null) other[i] = (other[i] ?? 0) + v; });
        fold = order.includes("Other") ? "All other" : "Other";
        cells.set(fold, other);
        names = [...names.filter((n) => keep.includes(n)), fold];
        note = `${rest.length} smaller ${humanize(colorField).toLowerCase()} values are grouped as "Other".`;
      } else {
        const keep = ranked.slice(0, MAX_SERIES);
        names = names.filter((n) => keep.includes(n));
        note = `Showing the ${MAX_SERIES} largest of ${order.length} ${humanize(colorField).toLowerCase()} values.`;
      }
    }
    const real = names.filter((n) => n !== fold);
    const slots = seriesSlots(`${block.id}:${colorField}`, real);
    const series: ChartSeries[] = names.map((name) => {
      const i = real.indexOf(name);
      return { key: name, name, values: cells.get(name)!, color: i < 0 ? OTHER_COLOR : names.length > 1 ? seriesColor(slots[i], names.length) : SINGLE_COLOR };
    });
    const mName = humanize(m);
    return {
      kind: "chart",
      arrangement: "single",
      model: {
        ...base,
        stacked: stackedType,
        panels: [{ key: m, title: titleMentions(block.title, m) ? null : mName, series, format: fmtOf(m) }],
        legend: series.length > 1 ? series.map((s) => ({ name: s.name, color: s.color })) : null,
        note,
        summary: `${mName} ${byWhat}, one series per ${humanize(colorField).toLowerCase()}`,
      },
    };
  }

  // ---- one series per measure ----
  const columnOf = (m: string): (number | null)[] => {
    const arr: (number | null)[] = new Array(categories.length).fill(null);
    for (const row of rows) {
      const i = index.get(String(row[xField]));
      const v = num(row[m]);
      if (i !== undefined && v !== null) arr[i] = (arr[i] ?? 0) + v;
    }
    return arr;
  };
  const cols = measures.map((m) => ({ m, values: columnOf(m), format: fmtOf(m) }));
  // config.shared_axis: the columns are series of ONE quantity (a stored
  // "stacked bars" answer: one column per segment), so they belong on one
  // axis whatever their sizes - fileData sets it, a warehouse spec never does.
  const arrangement = chartArrangement(cols.map((c) => ({ maxAbs: c.values.reduce((mx: number, v) => Math.max(mx, Math.abs(v ?? 0)), 0), format: c.format.format })), Boolean(cfg.shared_axis));
  const names = measures.map((m) => humanize(m));
  if (arrangement === "table") {
    return { kind: "table", reason: `${measures.length} measures on different scales read best as a table.` };
  }
  if (arrangement === "multiples") {
    return {
      kind: "chart",
      arrangement,
      model: {
        ...base,
        stacked: false,
        // One panel per measure, each named above its own plot, each in the
        // single-series colour: the title says which is which, so colour
        // has nothing to add.
        panels: cols.map((c, i) => ({ key: c.m, title: names[i], series: [{ key: c.m, name: names[i], values: c.values, color: SINGLE_COLOR }], format: c.format })),
        legend: null,
        note: null,
        summary: `${names.join(" and ")} ${byWhat}, one panel each`,
      },
    };
  }
  const series: ChartSeries[] = cols.map((c, i) => ({ key: c.m, name: names[i], values: c.values, color: seriesColor(aliases.indexOf(c.m) >= 0 ? aliases.indexOf(c.m) : i, cols.length) }));
  const single = cols.length === 1;
  return {
    kind: "chart",
    arrangement,
    model: {
      ...base,
      stacked: stackedType && !single,
      panels: [{ key: measures[0], title: single && !titleMentions(block.title, measures[0]) ? names[0] : null, series, format: cols[0].format }],
      legend: single ? null : series.map((s) => ({ name: s.name, color: s.color })),
      note: null,
      summary: `${names.join(", ")} ${byWhat}`,
    },
  };
}
