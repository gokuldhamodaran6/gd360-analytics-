import type { BlockAnomaly, BlockForecast, BlockResult, BlockSpec, DashboardBlock, ForecastSeries, PartialPeriods } from "../../api/client";
import { normalizeChartType } from "../../lib/exploreEngine";
import { blockFormat, chartArrangement, formatValue, humanize, MAX_SERIES, measureAliases, measureFormats, PLAIN_FORMAT, titleMentions, type ChartArrangement, type ValueFormat } from "../format";
import { BY_VALUE_MAX_BARS, DEFAULT_CHART_THEME, MEASURES_KEY, blockColorMode, blockSingleColor, valueKey, type ChartTheme } from "../theme/chartTheme";
import { normalizeGrain, parseDateParts, periodLabel, periodTick, type DateParts, type Grain } from "./geometry";
import { calendarPosition, dimInfo } from "./dimensions";
import { normalizeChartTypeKey } from "./recommend";

// 2026-10-07 (dashboard polish round): BlockResult -> what the native
// chart draws. This is where the chart decisions are made, once, for the
// dashboard grid, the canvas cells and the published view alike:
//
//   colour   every colour comes from the ChartTheme handed in
//            (theme/chartTheme.ts - the rule is written at its top):
//            - a series dimension (time x segment): each series wears its
//              VALUE's colour, the same one on every chart of the dashboard;
//            - several measures on one axis: each wears its measure's colour;
//            - small multiples: every panel the single colour;
//            - one measure across a category: the single colour - or, when
//              colour is "by value" and the category is an identity (hotel,
//              market segment; never a period, a year or a bucket), each
//              BAR its value's colour. A column with more values than the
//              palette has slots is coloured only as a "top N" list
//              (BY_VALUE_MAX_BARS); a line over categories stays one colour.
//            A column the registry does not know keeps the palette's fixed
//            order, held per block by seriesSlots (what was drawn before
//            identity colour existed, and what a chart outside a dashboard
//            still gets).
//   axes     never two y scales. Measures of different kinds or more than
//            8x apart get one panel each (format.ts chartArrangement).
//   names    SQL aliases are humanised for display; a title that only
//            repeats what the card title says is left out.
//
// 2026-10-07 (chart-types round) - what the planner also decides now:
//   shares   "100% stacked" bars / areas: every category's series are
//            divided by that category's total, the axis is 0-100%, and the
//            tooltip still has the real numbers (series.raw);
//   combo    "bars and a line" for two measures is NEVER two y axes: it is
//            aligned panels on one x axis, the first drawn as bars, the
//            rest as lines (panel.kind);
//   bins     a histogram (result.bins): one touching bar per bin, the x
//            axis ticked at the bin EDGES;
//   partial  a period the data only partly covers (result.partial): its
//            segment is drawn dashed, its point hollow, and a note says so
//            - a half-finished month is not a collapse;
//   forecast result.forecast (services/forecast.py): the periods ahead are
//            added to the axis, with the dashed forecast line, the 80% and
//            95% bands, the "last complete period" divider and the caption
//            that says how it was made and how well it backtested; a
//            refusal is its plain reason, as a note;
//   anomalies result.anomalies: ringed markers in the theme's status colour;
//   other forms  a map, a heatmap, a scatter ... are not cartesian: the
//            plan says which (`special`) and BlockRenderer hands the
//            result to that chart's own model builder.

// What a chart drawn with NO theme uses (DEFAULT_CHART_THEME: the kit's
// tokens). Kept as names for the planner's callers and tests; no renderer
// reads them - they read the theme.
export const SINGLE_COLOR = DEFAULT_CHART_THEME.primary;
export const OTHER_COLOR = DEFAULT_CHART_THEME.other;
export const SERIES_COLORS: readonly string[] = DEFAULT_CHART_THEME.slots.slice(0, 7);

/** The colour of series slot `slot` when there are `count` series. */
export function seriesColor(slot: number, count: number, theme: ChartTheme = DEFAULT_CHART_THEME): string {
  if (count <= 1) return theme.primary;
  return theme.slot(Math.min(Math.max(0, slot), theme.slots.length - 1));
}

// A column the colour registry does not know (see the note above): the
// first time a block shows a series it takes the lowest free slot and
// keeps it for as long as the page is open, so filtering "Groups" away
// does not repaint "Direct".
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

export type ChartSeries = {
  key: string;
  name: string;
  values: (number | null)[];
  // The real numbers when `values` are shares of a 100% stack.
  raw?: (number | null)[];
  color: string;
  // One colour per category (bars coloured by value); absent = `color`.
  colors?: string[];
  // What this series IS, for the colour registry: a value of a column, or
  // a measure (column MEASURES_KEY). Absent for the folded "Other".
  identity?: { column: string; value: string };
};

export type ChartPanel = {
  key: string;
  // Shown above the panel: the measure's name (small multiples, or a
  // single measure the card title does not already name).
  title: string | null;
  series: ChartSeries[];
  format: ValueFormat;
  // This panel's own mark (a combo's bar panel beside its line panels);
  // absent = the model's.
  kind?: ChartKind;
  // The format of the real numbers behind a 100% stack (tooltip).
  rawFormat?: ValueFormat;
};

// `future`: a period that has not happened (a forecast's axis).
export type ChartCategory = { value: unknown; label: string; date: DateParts | null; future?: boolean };

export type LegendMark = "line" | "square" | "dash" | "band80" | "band95" | "ring";
export type ChartLegendItem = { name: string; color: string; identity?: { column: string; value: string }; mark?: LegendMark };

// One series' forecast, aligned to the model's categories: null before the
// anchor, the last fitted value AT the anchor (so the dashed line and the
// bands start on the history line), the forecast after it.
export type ForecastSeriesOverlay = {
  panel: number;
  series: number;
  color: string;
  values: (number | null)[];
  lo80: (number | null)[] | null;
  hi80: (number | null)[] | null;
  lo95: (number | null)[] | null;
  hi95: (number | null)[] | null;
};
export type ForecastOverlay = {
  // Index of the last period the model was fitted on, and of the first
  // forecast period.
  anchor: number;
  start: number;
  series: ForecastSeriesOverlay[];
  dividerLabel: string;
  interval: "80" | "95" | "both";
};
export type AnomalyMark = { category: number; panel: number; series: number; value: number; expected: number; lo: number; hi: number; direction: "up" | "down" };
export type HistogramAxis = { edges: number[]; underflow: boolean; overflow: boolean; integer: boolean; column: string };

export type ChartModel = {
  kind: ChartKind;
  step: boolean;
  stacked: boolean;
  time: boolean;
  grain: Grain;
  categories: ChartCategory[];
  panels: ChartPanel[];
  // Two or more series on one panel: the legend. Null for one series.
  legend: ChartLegendItem[] | null;
  // Bars coloured by the value of this column (one measure across an
  // identity category); null otherwise.
  colorBy: string | null;
  xTitle: string | null;
  note: string | null;
  // What the chart is, in a sentence (the svg's accessible name).
  summary: string;
  // ---- 2026-10-07 (chart-types round); every one optional ----
  // A 100% stack: values are shares, the axis runs 0-100%.
  normalized?: boolean;
  // A histogram: the numeric edges the x axis is ticked at.
  histogram?: HistogramAxis | null;
  // Categories the data only partly covers (dashed segment, hollow point).
  partial?: { first: number | null; last: number | null } | null;
  forecast?: ForecastOverlay | null;
  anomalies?: AnomalyMark[] | null;
  // Small-print lines under the plot, after `note`: the forecast's
  // caption (or its refusal), the partial-period note.
  captions?: string[];
};

// The forms that are not drawn by the cartesian renderer.
export type SpecialChartType = "map" | "heatmap" | "pivot" | "scatter" | "bubble" | "treemap" | "funnel" | "waterfall" | "bullet";
const SPECIAL = new Set<string>(["map", "heatmap", "pivot", "scatter", "bubble", "treemap", "funnel", "waterfall", "bullet"]);

export type ChartPlan =
  | { kind: "chart"; model: ChartModel; arrangement: ChartArrangement }
  | { kind: "table"; reason: string }
  | { kind: "donut"; pie: boolean }
  | { kind: "special"; type: SpecialChartType }
  | { kind: "plotly" }
  | { kind: "empty" };

/** The chart type a block's config names, as the planner understands it:
 *  the new native forms by their own key (charts/recommend.ts), everything
 *  else through the chat's vocabulary (lib/exploreEngine). */
export function plannedChartType(raw: unknown, fallback: string): string {
  const key = normalizeChartTypeKey(raw);
  if (key && (SPECIAL.has(key) || key === "stacked_bar_100" || key === "stacked_area_100" || key === "stacked_area" || key === "combo" || key === "histogram")) return key;
  return normalizeChartType(typeof raw === "string" && raw ? raw : fallback);
}

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

/** Decide how a chart block is drawn and build the model for it. `theme`
 *  supplies every colour (default: the kit's tokens, one colour a measure). */
export function planChart(r: BlockResult, block: Pick<DashboardBlock, "id" | "title" | "config">, theme: ChartTheme = DEFAULT_CHART_THEME): ChartPlan {
  const cfg = block.config || {};
  const colorMode = blockColorMode(theme, cfg);
  const single = blockSingleColor(theme, cfg);
  const spec: BlockSpec | null = (cfg.spec && typeof cfg.spec === "object" ? cfg.spec : null) || r.spec || null;
  const measures = measureColumns(r);
  const dims = [...(r.time_column ? [r.time_column] : []), ...(r.dimensions || [])];
  const xField = dims[0] || (r.columns || []).find((c) => !measures.includes(c.name))?.name || null;
  const type = plannedChartType(cfg.chart_type, r.time_column ? "line" : "bar");
  // A funnel of measures and a bullet are drawn from a one-row result.
  if ((type === "funnel" || type === "bullet") && measures.length && r.rows?.length) return { kind: "special", type };
  if (!xField || !measures.length || !r.rows?.length) return { kind: "empty" };
  if (type === "pie" || type === "donut") return { kind: "donut", pie: type === "pie" };
  if (SPECIAL.has(type)) return { kind: "special", type: type as SpecialChartType };
  if (type === "histogram" && !r.bins) return { kind: "plotly" };
  if (type === "histogram" && r.bins) return planHistogram(r, block, theme, single);

  const combo = type === "combo";
  const normalized = type === "stacked_bar_100" || type === "stacked_area_100";
  let kind: ChartKind = type === "horizontal_bar" ? "hbar" : type === "bar" || type === "grouped_bar" || type === "stacked_bar" || type === "stacked_bar_100" || combo ? "bar" : type === "area" || type === "stacked_area" || type === "stacked_area_100" ? "area" : "line";
  const stackedType = type === "stacked_bar" || type === "stacked_area" || normalized;
  // A forecast continues a LINE: bars over time are drawn as one.
  const forecastOk = Boolean(r.forecast && r.forecast.status === "ok" && r.time_column && r.forecast.series?.some((f) => f.status === "ok" && f.points?.length));
  if (forecastOk && kind === "bar" && !stackedType && !combo) kind = "line";
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
  // 2026-10-07 (chart-types round): an axis that is a CALENDAR scale reads
  // in calendar order, whatever order the rows came back in - a date part
  // from the warehouse (weekday 1-7, labelled Mon..Sun), month or weekday
  // names, quarters, years. A ranking (horizontal bars) and an order the
  // query itself asks for are left alone.
  const xPart = !isTime && r.date_parts ? r.date_parts[xField] : undefined;
  const xInfo = xPart ? dimInfo(r, xField) : null;
  const askedOrder = Boolean(spec?.order_by?.length);
  if (!isTime && (xPart || (type !== "horizontal_bar" && !askedOrder))) {
    const pos = (v: unknown) => (xPart ? (typeof v === "number" ? v : Number(v)) : calendarPosition(v));
    const present = rows.filter((row) => row[xField] !== null && row[xField] !== undefined && row[xField] !== "");
    if (present.length > 1 && present.every((row) => { const p = pos(row[xField]); return p !== null && Number.isFinite(p); })) {
      rows = [...rows].sort((a, b) => {
        const pa = pos(a[xField]), pb = pos(b[xField]);
        const blankA = pa === null || !Number.isFinite(pa), blankB = pb === null || !Number.isFinite(pb);
        return blankA ? (blankB ? 0 : 1) : blankB ? -1 : (pa as number) - (pb as number);
      });
    }
  }
  const categories: ChartCategory[] = [];
  const index = new Map<string, number>();
  for (const row of rows) {
    const key = String(row[xField]);
    if (index.has(key)) continue;
    index.set(key, categories.length);
    const date = isTime ? parseDateParts(row[xField]) : null;
    categories.push({ value: row[xField] ?? null, label: date ? periodLabel(date, grain) : xInfo ? xInfo.short(row[xField]) : categoryLabel(row[xField]), date });
  }
  if (!categories.length) return { kind: "empty" };

  const xName = humanize(xField);
  const xTitle = isTime || titleMentions(block.title, xField) ? null : xName;
  const colorField = dims.length >= 2 ? dims[1] : null;
  const base = { kind, step: type === "step_line", time: isTime, grain, categories, xTitle, colorBy: null as string | null };
  const byWhat = isTime ? `by ${grain}` : `by ${xName.toLowerCase()}`;

  // ---- a series dimension: one series per value, on one axis ----
  if (colorField) {
    const m = measures[0];
    const order: string[] = [];
    const cells = new Map<string, (number | null)[]>();
    // The registry key of each series (its raw value's, not its label's).
    const keyOf = new Map<string, string>();
    // A series dimension that is a date part (weekday 1-7) is named and
    // ordered as one: Mon .. Sun.
    const seriesPart = r.date_parts && r.date_parts[colorField] ? dimInfo(r, colorField) : null;
    const seriesRows = seriesPart ? [...rows].sort((x, y) => Number(x[colorField]) - Number(y[colorField])) : rows;
    for (const row of seriesRows) {
      const name = seriesPart ? seriesPart.short(row[colorField]) : categoryLabel(row[colorField]);
      let arr = cells.get(name);
      if (!arr) {
        arr = new Array(categories.length).fill(null);
        cells.set(name, arr);
        order.push(name);
        keyOf.set(name, valueKey(row[colorField]));
      }
      const i = index.get(String(row[xField]));
      const v = num(row[m]);
      if (i !== undefined && v !== null) arr[i] = (arr[i] ?? 0) + v;
    }
    let names = order;
    let note: string | null = null;
    // The label of the folded tail (never one a real value already uses).
    let fold: string | null = null;
    const total = (name: string) => cells.get(name)!.reduce((s: number, v) => s + Math.abs(v ?? 0), 0);
    // A browser-side registry (the chat workspace) meets the values here,
    // largest first; a dashboard's registry is the server's and ignores it.
    theme.observe(colorField, [...order].sort((a, b) => total(b) - total(a) || a.localeCompare(b)).map((n) => keyOf.get(n)!));
    if (names.length > MAX_SERIES) {
      // More series than a chart reads well with: the largest keep a
      // colour, the tail folds into "Other" when the measure can be added up.
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
    // An identity column: each series wears its value's colour, on this
    // chart as on every other. A column the registry does not know: the
    // palette's fixed order, held per block.
    const known = theme.column(colorField).known;
    const slots = known ? [] : seriesSlots(`${block.id}:${colorField}`, real);
    const series: ChartSeries[] = names.map((name) => {
      const i = real.indexOf(name);
      if (i < 0) return { key: name, name, values: cells.get(name)!, color: theme.other };
      const key = keyOf.get(name)!;
      const color = known
        ? names.length > 1 || colorMode === "by_value" ? theme.colorFor(colorField, key) : single
        : names.length > 1 ? seriesColor(slots[i], names.length, theme) : single;
      return { key: name, name, values: cells.get(name)!, color, identity: { column: colorField, value: key } };
    });
    const mName = humanize(m);
    const panel: ChartPanel = { key: m, title: normalized ? `Share of ${mName.toLowerCase()}` : titleMentions(block.title, m) ? null : mName, series, format: fmtOf(m) };
    if (normalized) toShares(panel, categories.length);
    return {
      kind: "chart",
      arrangement: "single",
      model: withTimeAnalysis({
        ...base,
        kind,
        stacked: stackedType,
        normalized: normalized || undefined,
        panels: [panel],
        legend: series.length > 1 ? series.map((s) => ({ name: s.name, color: s.color, identity: s.identity })) : null,
        note,
        summary: `${normalized ? "Share of " : ""}${mName} ${byWhat}, one series per ${humanize(colorField).toLowerCase()}`,
      }, r, theme, single, [{ panel: 0, measure: m, bySeries: true }]),
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
  let arrangement = chartArrangement(cols.map((c) => ({ maxAbs: c.values.reduce((mx: number, v) => Math.max(mx, Math.abs(v ?? 0)), 0), format: c.format.format })), Boolean(cfg.shared_axis));
  const names = measures.map((m) => humanize(m));
  // A combo is aligned panels by definition (bars, then lines) - never two
  // y axes; a stack of measures shares one axis by definition.
  if (combo && cols.length >= 2 && cols.length <= 4) arrangement = "multiples";
  if (stackedType && cols.length >= 2 && cols.length <= MAX_SERIES && new Set(cols.map((c) => c.format.format)).size === 1) arrangement = "single";
  if (arrangement === "table") {
    return { kind: "table", reason: `${measures.length} measures on different scales read best as a table.` };
  }
  if (arrangement === "multiples") {
    return {
      kind: "chart",
      arrangement,
      model: withTimeAnalysis({
        ...base,
        kind,
        stacked: false,
        // One panel per measure, each named above its own plot, each in the
        // single-series colour: the title says which is which, so colour
        // has nothing to add.
        panels: cols.map((c, i) => ({
          key: c.m, title: names[i], series: [{ key: c.m, name: names[i], values: c.values, color: single }], format: c.format,
          ...(combo ? { kind: (i === 0 ? "bar" : "line") as ChartKind } : {}),
        })),
        legend: null,
        note: null,
        summary: combo ? `${names[0]} as bars and ${names.slice(1).join(", ")} as ${names.length > 2 ? "lines" : "a line"} ${byWhat}, in aligned panels` : `${names.join(" and ")} ${byWhat}, one panel each`,
      }, r, theme, single, combo ? [] : cols.map((c, i) => ({ panel: i, measure: c.m, bySeries: false }))),
    };
  }
  const one = cols.length === 1;
  if (!one) {
    // Several measures on one axis: coloured by measure, the same colour
    // for the same measure on every chart of the dashboard.
    theme.observe(MEASURES_KEY, measures);
    const series: ChartSeries[] = cols.map((c, i) => ({
      key: c.m, name: names[i], values: c.values,
      color: theme.measureColor(c.m, aliases.indexOf(c.m) >= 0 ? aliases.indexOf(c.m) : i),
      identity: { column: MEASURES_KEY, value: c.m },
    }));
    const panel: ChartPanel = { key: measures[0], title: null, series, format: cols[0].format };
    if (normalized) toShares(panel, categories.length);
    return {
      kind: "chart",
      arrangement,
      model: withTimeAnalysis({
        ...base,
        kind,
        stacked: stackedType,
        normalized: normalized || undefined,
        panels: [panel],
        legend: series.map((s) => ({ name: s.name, color: s.color, identity: s.identity })),
        note: null,
        summary: `${normalized ? "Share of " : ""}${names.join(", ")} ${byWhat}`,
      }, r, theme, single, cols.map((c) => ({ panel: 0, measure: c.m, bySeries: false }))),
    };
  }
  // One measure. Bars across an identity category take each value's colour
  // when colour is "by value"; everything else is the single colour.
  const isBar = kind === "bar" || kind === "hbar";
  let colors: string[] | undefined;
  if (isBar && !isTime) {
    const ranked = categories.map((c, i) => ({ c, v: Math.abs(cols[0].values[i] ?? 0) })).sort((a, b) => b.v - a.v || a.c.label.localeCompare(b.c.label));
    theme.observe(xField, ranked.map((x) => x.c.value));
    const info = theme.column(xField);
    // "Top N" is read off the block's own definition (its limit), never off
    // how many bars a filter happens to leave - filtering must not repaint.
    // The chat's answers have no definition to read: there it is the rows.
    const ownLimit = [spec?.limit, cfg.row_limit].find((n) => typeof n === "number" && n > 0) as number | undefined;
    const limit = ownLimit ?? (theme.local ? categories.length : Infinity);
    if (colorMode === "by_value" && info.known && (!info.overflow || limit <= BY_VALUE_MAX_BARS)) {
      colors = categories.map((c) => theme.colorFor(xField, c.value));
    }
  }
  const series: ChartSeries[] = [{ key: cols[0].m, name: names[0], values: cols[0].values, color: single, colors }];
  return {
    kind: "chart",
    arrangement,
    model: withTimeAnalysis({
      ...base,
      kind,
      colorBy: colors ? xField : null,
      stacked: false,
      panels: [{ key: measures[0], title: !titleMentions(block.title, measures[0]) ? names[0] : null, series, format: cols[0].format }],
      legend: null,
      note: null,
      summary: `${names.join(", ")} ${byWhat}`,
    }, r, theme, single, [{ panel: 0, measure: measures[0], bySeries: false }]),
  };
}

// ---- 100% stacks ---------------------------------------------------------------

const SHARE_FORMAT: ValueFormat = { format: "percent", decimals: null, inferred: true, currency: "" };

/** Turns a panel's series into shares of each category's total (the real
 *  numbers stay on series.raw for the tooltip and the table). */
function toShares(panel: ChartPanel, n: number): void {
  const totals = new Array(n).fill(0);
  for (const s of panel.series) for (let c = 0; c < n; c++) totals[c] += Math.abs(s.values[c] ?? 0);
  for (const s of panel.series) {
    s.raw = s.values;
    s.values = s.values.map((v, c) => (v === null || !(totals[c] > 0) ? null : Math.abs(v) / totals[c]));
  }
  panel.rawFormat = panel.format;
  panel.format = SHARE_FORMAT;
}

// ---- histogram --------------------------------------------------------------------

function binText(v: number, integer: boolean): string {
  if (integer) return Math.round(v).toLocaleString();
  return Number(v.toPrecision(6)).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/** A histogram result (one row per bin - see backend
 *  dashboard_engine.histogram_result) as touching bars over a numeric axis. */
function planHistogram(r: BlockResult, block: Pick<DashboardBlock, "id" | "title" | "config">, theme: ChartTheme, single: string): ChartPlan {
  const bins = r.bins!;
  const measure = (r.measures || [])[0] || "count";
  const rows = [...(r.rows || [])].sort((a, b) => Number(a.bin ?? 0) - Number(b.bin ?? 0));
  if (!rows.length) return { kind: "empty" };
  const integer = Boolean(bins.integer);
  const categories: ChartCategory[] = rows.map((row) => {
    const lo = row[bins.column], hi = row.bin_end;
    let label: string;
    if (row.bin === -1 || lo === null || lo === undefined) label = `Below ${binText(Number(hi), integer)}`;
    else if (row.bin === bins.count || hi === null || hi === undefined) label = `Above ${binText(Number(lo), integer)}`;
    else if (integer && bins.width === 1) label = binText(Number(lo), true);
    else if (integer) label = `${binText(Number(lo), true)} – ${binText(Number(hi) - 1, true)}`;
    else label = `${binText(Number(lo), false)} to ${binText(Number(hi), false)}`;
    return { value: lo ?? null, label, date: null };
  });
  const values = rows.map((row) => (typeof row[measure] === "number" ? (row[measure] as number) : null));
  const edges = Array.from({ length: bins.count + 1 }, (_, i) => Number((bins.start + i * bins.width).toPrecision(12)));
  const format = measureFormats(block, r)[measure] || PLAIN_FORMAT;
  const columnName = humanize(bins.column);
  const total = values.reduce((s: number, v) => s + (v ?? 0), 0);
  const outside = rows.filter((row) => row.bin === -1 || row.bin === bins.count).reduce((s, row) => s + (typeof row[measure] === "number" ? row[measure] : 0), 0);
  void theme;
  return {
    kind: "chart",
    arrangement: "single",
    model: {
      kind: "bar", step: false, stacked: false, time: false, grain: "month", categories, colorBy: null,
      xTitle: titleMentions(block.title, bins.column) ? null : columnName,
      panels: [{ key: measure, title: titleMentions(block.title, measure) || measure === "count" ? null : humanize(measure), series: [{ key: measure, name: measure === "count" ? "Rows" : humanize(measure), values, color: single }], format }],
      legend: null,
      note: outside > 0 && total > 0 ? `${formatValue(outside, format, "full")} of ${formatValue(total, format, "full")} fall outside ${binText(bins.start, integer)} to ${binText(bins.end, integer)} and are counted in the end ${rows.filter((row) => row.bin === -1 || row.bin === bins.count).length === 1 ? "bar" : "bars"}.` : null,
      summary: `Distribution of ${columnName.toLowerCase()} in ${bins.count} bins`,
      histogram: { edges, underflow: rows[0]?.bin === -1, overflow: rows[rows.length - 1]?.bin === bins.count, integer, column: bins.column },
    },
  };
}

// ---- partial periods, forecast, anomalies ---------------------------------------------

const GRAIN_WORDS: Record<string, [string, string]> = { day: ["day", "days"], week: ["week", "weeks"], month: ["month", "months"], quarter: ["quarter", "quarters"], year: ["year", "years"] };

function pct(v: number): string {
  const p = v * 100;
  return `${p.toLocaleString(undefined, { maximumFractionDigits: p >= 10 ? 1 : 2 })}%`;
}

/** "Forecast: damped Holt-Winters, 12-month season · backtest error 8.4%
 *  (MAPE) over 6 folds · next 6 months". */
export function forecastCaption(f: Pick<ForecastSeries, "method" | "season_length" | "backtest" | "points">, grain: string, seriesCount = 1): string {
  const [one, many] = GRAIN_WORDS[grain] || [grain, `${grain}s`];
  const parts: string[] = [`Forecast: ${f.method || "exponential smoothing"}${f.season_length ? `, ${f.season_length}-${one} season` : ""}`];
  const b = f.backtest;
  if (b && (b.mape !== null || b.smape !== null)) {
    const err = b.mape !== null ? `${pct(b.mape as number)} (MAPE)` : `${pct(b.smape as number)} (sMAPE)`;
    parts.push(`backtest error ${err} over ${b.folds} ${b.folds === 1 ? "fold" : "folds"}`);
  }
  const h = f.points?.length || 0;
  parts.push(`next ${h} ${h === 1 ? one : many}`);
  if (seriesCount > 1) parts.push(`${seriesCount} series`);
  return parts.join(" · ");
}

/** A KPI tile's forecast line: "Next month ≈ 4,120 (3,700-4,560)" - the
 *  next period's forecast with its 80% range (the 95% one when that is the
 *  only interval asked for). null when the tile has no forecast. */
export function kpiForecastLine(result: BlockResult | null | undefined, block: Pick<DashboardBlock, "config" | "title">): string | null {
  const f = result && result.status === "ok" ? result.forecast : null;
  if (!f || f.status !== "ok") return null;
  const head = (f.series || []).find((s) => s.status === "ok" && s.points?.length) || null;
  const pt = head?.points[0] || f.points?.[0];
  if (!pt || typeof pt.value !== "number") return null;
  const fmt = blockFormat(block, result);
  const lo = pt.lo80 ?? pt.lo95, hi = pt.hi80 ?? pt.hi95;
  const [one] = GRAIN_WORDS[f.grain] || [f.grain];
  const range = typeof lo === "number" && typeof hi === "number" ? ` (${formatValue(lo, fmt, "auto")}\u2013${formatValue(hi, fmt, "auto")})` : "";
  return `Next ${one} \u2248 ${formatValue(pt.value, fmt, "auto")}${range}`;
}

export function partialNote(partial: PartialPeriods | null | undefined, grain: Grain): string | null {
  if (!partial) return null;
  const bits: string[] = [];
  const say = (info: { period: string; through?: string; from?: string; days: number; of: number } | null, which: "first" | "last") => {
    if (!info) return;
    const d = parseDateParts(info.period);
    const name = d ? periodLabel(d, grain) : info.period;
    const edge = which === "last" ? info.through : info.from;
    const e = edge ? parseDateParts(edge) : null;
    const edgeText = e ? periodLabel(e, "day").replace(/, \d{4}$/, "") : null;
    bits.push(`${name} is a partial ${grain}${edgeText ? ` (data ${which === "last" ? "through" : "from"} ${edgeText})` : ""}`);
  };
  if (partial.first && partial.last) {
    // Both ends: one short line (it has to fit under a half-width card).
    const short = (info: { period: string; through?: string; from?: string }, which: "first" | "last") => {
      const d = parseDateParts(info.period);
      const name = d ? (grain === "week" || grain === "day" ? periodLabel(d, "day") : periodTick(d, grain, true)) : info.period;
      const edge = which === "last" ? info.through : info.from;
      const e = edge ? parseDateParts(edge) : null;
      return `${name}${e ? ` (${which === "last" ? "through" : "from"} ${periodLabel(e, "day").replace(/, \d{4}$/, "")})` : ""}`;
    };
    return `Partial ${GRAIN_WORDS[grain]?.[1] || `${grain}s`}, drawn dashed: ${short(partial.first, "first")} and ${short(partial.last, "last")}.`;
  }
  say(partial.last, "last");
  say(partial.first, "first");
  return bits.length ? `${bits.join("; ")} - drawn dashed.` : null;
}

type ForecastTarget = { panel: number; measure: string; bySeries: boolean };

/** Adds what a time series knows beyond its rows (see the note at the top
 *  of this file) to a planned model. A model that is not over time is
 *  returned as it is. */
function withTimeAnalysis(model: ChartModel, r: BlockResult, theme: ChartTheme, single: string, targets: ForecastTarget[]): ChartModel {
  if (!model.time || model.kind === "hbar") return model;
  void single;
  const captions: string[] = [];
  const indexOf = new Map(model.categories.map((c, i) => [String(c.value).slice(0, 10), i]));
  // Partial periods: only where the series is a line / area / bar over time.
  const partial = r.partial || r.forecast?.partial || null;
  if (partial && (partial.first || partial.last)) {
    const first = partial.first ? indexOf.get(String(partial.first.period).slice(0, 10)) : undefined;
    const last = partial.last ? indexOf.get(String(partial.last.period).slice(0, 10)) : undefined;
    if (first !== undefined || last !== undefined) {
      model.partial = { first: first === 0 ? 0 : null, last: last !== undefined && last === model.categories.length - 1 ? last : null };
      const note = partialNote({ first: model.partial.first !== null ? partial.first : null, last: model.partial.last !== null ? partial.last : null }, model.grain);
      if (note && (model.partial.first !== null || model.partial.last !== null)) captions.push(note);
    }
  }
  const f: BlockForecast | null | undefined = r.forecast;
  if (f && f.status === "refused") {
    captions.push(f.reason || "No forecast could be made for this series.");
  } else if (f && f.status === "ok" && targets.length && !model.stacked) {
    const overlays: ForecastSeriesOverlay[] = [];
    let anchor = -1, start = model.categories.length;
    const usable: ForecastSeries[] = [];
    const refused: ForecastSeries[] = [];
    for (const fs of f.series || []) {
      if (fs.status !== "ok" || !fs.points?.length) { refused.push(fs); continue; }
      // Which drawn series this forecast belongs to.
      let panelIndex = -1, seriesIndex = -1;
      for (const t of targets) {
        const p = model.panels[t.panel];
        if (!p) continue;
        if (t.bySeries) {
          const si = p.series.findIndex((s) => s.identity ? s.identity.value === fs.key || s.name === fs.key : s.name === fs.key);
          if (si >= 0 && fs.measure === t.measure) { panelIndex = t.panel; seriesIndex = si; }
        } else if (fs.measure === t.measure) {
          const si = p.series.findIndex((s) => s.key === t.measure);
          if (si >= 0) { panelIndex = t.panel; seriesIndex = si; }
        }
      }
      if (panelIndex < 0) continue;
      usable.push(fs);
      // The axis grows by the forecast's periods.
      for (const pt of fs.points) {
        const key = String(pt.period).slice(0, 10);
        if (!indexOf.has(key)) {
          const date = parseDateParts(pt.period);
          indexOf.set(key, model.categories.length);
          model.categories.push({ value: pt.period, label: date ? periodLabel(date, model.grain) : pt.period, date, future: true });
        }
      }
      const through = fs.fitted_through ? indexOf.get(String(fs.fitted_through).slice(0, 10)) : undefined;
      const firstIdx = indexOf.get(String(fs.points[0].period).slice(0, 10)) as number;
      const a = through !== undefined ? through : Math.max(0, firstIdx - 1);
      anchor = Math.max(anchor, a);
      start = Math.min(start, firstIdx);
      const series = model.panels[panelIndex].series[seriesIndex];
      const n = model.categories.length;
      const blank = () => new Array<number | null>(n).fill(null);
      const o: ForecastSeriesOverlay = { panel: panelIndex, series: seriesIndex, color: series.color, values: blank(), lo80: null, hi80: null, lo95: null, hi95: null };
      const at = series.values[a] ?? null;
      o.values[a] = at;
      const want80 = fs.points.some((p) => typeof p.lo80 === "number"), want95 = fs.points.some((p) => typeof p.lo95 === "number");
      if (want80) { o.lo80 = blank(); o.hi80 = blank(); o.lo80[a] = at; o.hi80[a] = at; }
      if (want95) { o.lo95 = blank(); o.hi95 = blank(); o.lo95[a] = at; o.hi95[a] = at; }
      for (const pt of fs.points) {
        const i = indexOf.get(String(pt.period).slice(0, 10)) as number;
        o.values[i] = pt.value;
        if (o.lo80 && o.hi80) { o.lo80[i] = pt.lo80 ?? null; o.hi80[i] = pt.hi80 ?? null; }
        if (o.lo95 && o.hi95) { o.lo95[i] = pt.lo95 ?? null; o.hi95[i] = pt.hi95 ?? null; }
      }
      overlays.push(o);
    }
    if (overlays.length) {
      // Every series' arrays reach the grown axis.
      const n = model.categories.length;
      for (const p of model.panels) for (const s of p.series) {
        while (s.values.length < n) s.values.push(null);
        if (s.raw) while (s.raw.length < n) s.raw.push(null);
        if (s.colors) while (s.colors.length < n) s.colors.push(s.color);
      }
      for (const o of overlays) for (const key of ["values", "lo80", "hi80", "lo95", "hi95"] as const) { const arr = o[key]; if (arr) while (arr.length < n) arr.push(null); }
      const [one] = GRAIN_WORDS[model.grain] || [model.grain];
      model.forecast = { anchor, start, series: overlays, dividerLabel: `Last complete ${one}`, interval: f.interval };
      const head = usable[0];
      captions.push(forecastCaption(head, model.grain, usable.length));
      const oneSeries = model.panels.length === 1 && model.panels[0].series.length === 1;
      const ink = "rgb(var(--color-secondary))";
      const base: ChartLegendItem[] = oneSeries
        ? [{ name: "History", color: model.panels[0].series[0].color, mark: "line" }]
        : (model.legend || model.panels.flatMap((p) => p.series.map((s) => ({ name: p.title || s.name, color: s.color, mark: "line" as LegendMark })))).map((l) => ({ ...l }));
      const keyColor = oneSeries ? model.panels[0].series[0].color : ink;
      base.push({ name: "Forecast", color: keyColor, mark: "dash" });
      if (overlays.some((o) => o.lo80)) base.push({ name: "80% interval", color: keyColor, mark: "band80" });
      if (overlays.some((o) => o.lo95)) base.push({ name: "95% interval", color: keyColor, mark: "band95" });
      model.legend = base;
      for (const fs of refused) if (fs.reason) captions.push(`${fs.key}: ${fs.reason}`);
      for (const noteText of (head.notes || []).slice(0, 1)) if (!/incomplete/.test(noteText)) captions.push(noteText);
    } else if (refused.length && refused[0].reason) {
      captions.push(refused[0].reason);
    }
  }
  const anomalies: BlockAnomaly[] = (r.anomalies || r.forecast?.anomalies || []) as BlockAnomaly[];
  if (anomalies.length && targets.length && !model.stacked) {
    const marks: AnomalyMark[] = [];
    for (const a of anomalies) {
      const category = indexOf.get(String(a.period).slice(0, 10));
      if (category === undefined) continue;
      for (const t of targets) {
        const p = model.panels[t.panel];
        if (!p || (a.measure && a.measure !== t.measure)) continue;
        const si = t.bySeries ? p.series.findIndex((s) => (s.identity ? s.identity.value === a.series || s.name === a.series : s.name === a.series)) : p.series.findIndex((s) => s.key === t.measure);
        if (si < 0) continue;
        marks.push({ category, panel: t.panel, series: si, value: a.value, expected: a.expected, lo: a.lo, hi: a.hi, direction: a.direction });
        break;
      }
    }
    if (marks.length) {
      model.anomalies = marks;
      const item: ChartLegendItem = { name: marks.length === 1 ? "Unusual value" : "Unusual values", color: theme.status.serious, mark: "ring" };
      if (model.legend) model.legend = [...model.legend, item];
      else model.legend = [{ name: model.panels[0].title || model.panels[0].series[0].name, color: model.panels[0].series[0].color, mark: "line" }, item];
    }
  }
  if (captions.length) model.captions = captions;
  return model;
}
