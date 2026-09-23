// Client-side chart styling. The AI backend returns a plain Plotly figure
// spec (data + layout) as JSON. Rather than teaching the backend/LLM about
// user styling preferences, we treat that spec as the raw source and apply
// a styling layer entirely in the browser: colors, titles, axis labels,
// series names, font size and display options. This means every style
// change is instant (no round trip to the AI, no separate "Apply" step)
// and the final, styled spec can simply be saved as-is onto a dashboard
// chart with no backend changes needed.
//
// This file is also where every chart gets its premium default look,
// applied automatically before the person ever opens the Style panel -
// distinct, colorblind-safe brand colors instead of one flat AI-picked
// hue, rounded bar ends, sensible breathing room, a clean hover readout,
// and a legend that only shows up when it is actually telling the person
// something (a single-series chart names itself in the title - a legend
// box with one swatch just repeats that). Genuinely theme-dependent colors
// (text/grid/hover-card colors for dark vs light mode) are deliberately
// NOT decided here - see components/ChartCanvas.tsx, which applies those
// on top of whatever this file returns.
 
export type PaletteId = "original" | "aurora" | "sunset" | "forest" | "mono" | "vibrant" | "single" | "custom";
export type FontSize = "small" | "medium" | "large";
 
export type ChartStyle = {
  paletteId: PaletteId;
  customColors: string[];
  // The one color used for every bar/slice/line when paletteId is "single" -
  // for a person who wants their own brand color everywhere rather than a
  // multi-hue palette. Falls back to SIGNATURE_COLORS[0] wherever it's
  // missing (older saved styles, from before this field existed).
  singleColor: string;
  // Per-role color overrides for a chart's decorative, non-series traces -
  // right now just a scatter plot's regression trend line (role
  // "trend_line" - see isDecorativeTrace below). Keyed by role rather than
  // trace index so it survives every re-render even though the trace itself
  // is rebuilt from scratch each time. Missing/empty means "use whatever
  // color the backend chose" (chart_builder.py's TREND_COLOR).
  accentColors: Record<string, string>;
  title: string;
  xAxisLabel: string;
  yAxisLabel: string;
  seriesNames: string[];
  showGrid: boolean;
  // The legend, when on, always docks in its own reserved strip to the
  // right of the plot - never above or below it - so it can never land on
  // top of the title or the bars. See the "Legend" section of
  // applyChartStyle for why a top/bottom band used to overlap the title.
  showLegend: boolean;
  dataLabels: boolean;
  xAxisTilt: "none" | "slight" | "diagonal" | "vertical";
  fontSize: FontSize;
};
 
export const PALETTES: { id: Exclude<PaletteId, "original" | "custom">; name: string; colors: string[] }[] = [
  { id: "aurora", name: "Aurora", colors: ["#6366F1", "#06B6D4", "#EC4899", "#F59E0B", "#10B981", "#F97316"] },
  { id: "sunset", name: "Sunset", colors: ["#F97316", "#EF4444", "#EC4899", "#A855F7", "#6366F1", "#38BDF8"] },
  { id: "forest", name: "Forest", colors: ["#16A34A", "#84CC16", "#CA8A04", "#0D9488", "#15803D", "#059669"] },
  { id: "mono", name: "Mono", colors: ["#94A3B8", "#64748B", "#334155", "#CBD5E1", "#475569", "#1E293B"] },
  { id: "vibrant", name: "Vibrant", colors: ["#EF4444", "#F59E0B", "#22C55E", "#3B82F6", "#A855F7", "#06B6D4"] },
];
 
// GD360's own default palette - what "Signature, GD360 default" (the first
// option in the Style panel, id "original") actually paints instead of
// leaving whatever flat, single AI-picked color came back untouched. Led
// by our brand violet and teal, then widened with six more hues chosen and
// ordered specifically so every ADJACENT pair (how colors actually sit next
// to each other on a bar/line/pie chart) stays tell-apart for colorblind
// readers, not just pleasant to a typical eye - validated with the
// data-viz skill's palette checker rather than picked by eye. Three of the
// eight (aqua, magenta, yellow) run a little low-contrast on a plain white
// surface by themselves, which is exactly why every chart that uses this
// palette also gets a direct value label and a legend (see below) - the
// color is never the only way to read the chart.
// Exported (not just used locally) so any other screen that needs GD360's
// own validated categorical order - e.g. the admin dashboard's breakdown
// charts - can reuse the exact same fixed hue sequence instead of a second
// hardcoded copy that could drift out of sync with this one.
export const SIGNATURE_COLORS = [
  "#4A3AA7", // violet - brand primary family
  "#1BAF7A", // aqua/teal - brand accent family
  "#EB6834", // orange
  "#2A78D6", // blue
  "#E87BA4", // magenta
  "#EDA100", // amber
  "#1F8A3C", // green
  "#E34948", // red
];
 
// Exposed so the Style panel can use the same brand violet as the default
// swatch for "Single color, one shade for all" and as the fallback trend-
// line swatch, instead of a second hardcoded copy of the hex value drifting
// out of sync with this one.
export const DEFAULT_ACCENT_COLOR = SIGNATURE_COLORS[0];
 
// chart_builder.py's own TREND_COLOR constant (backend/app/services/
// chart_builder.py) - the shade a scatter chart's regression trend line and
// confidence band start out as before anyone picks a custom one. Kept here,
// duplicated rather than fetched, since this is the one place on the
// frontend that needs to recognize "this is still the backend's original
// color" (see the annotation-recoloring note in applyChartStyle below).
const BACKEND_TREND_COLOR = "#E24C4C";
 
/** Parses a "#rrggbb" (or "#rgb") hex string into 0-255 RGB components.
 * Returns black for anything that isn't recognizably hex (defensive only -
 * every color this file hands out, and every color a browser's native
 * <input type="color"> can produce, is always "#rrggbb"). */
function hexToRgb(hex: string): [number, number, number] {
  let h = (hex || "").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
 
/** Formats a hex color as an rgba() string at the given opacity - used to
 * recolor a trend line's shaded confidence band to match a person's chosen
 * trend-line color while keeping the same soft, translucent feel the
 * backend's own band already has (see chart_builder.py's _add_trend_overlay,
 * which shades its band at 0.15 alpha of the same hue as the line). */
function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
 
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s * 100, l * 100];
}
 
function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.min(100, Math.max(0, s)) / 100;
  l = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}
 
/** A palette (named or custom) only ever ships 6-8 hand-picked colors - fine
 * for a typical chart, not enough once a bar chart has 10+ categories (the
 * old behavior just silently repeated colors every N bars, which is exactly
 * what made two unrelated bars look like "the same series"). This extends
 * ANY palette to an arbitrary length on demand: the first `base.length`
 * colors are the palette exactly as designed, and every color after that is
 * a lightness/hue-shifted variant of an earlier one (alternating lighter/
 * darker, nudging the hue a little further each pass) - so a 24-bar chart
 * still gets 24 visibly distinct colors instead of the same 6-8 repeating
 * four times over. */
function extendedColorAt(base: string[], i: number): string {
  if (base.length === 0) return "#4A3AA7";
  if (i < base.length) return base[i];
  const cycle = Math.floor(i / base.length);
  const within = i % base.length;
  const [r, g, b] = hexToRgb(base[within]);
  const [h, s, l] = rgbToHsl(r, g, b);
  const step = Math.ceil(cycle / 2);
  const direction = cycle % 2 === 1 ? 1 : -1;
  const newL = Math.min(85, Math.max(15, l + direction * step * 11));
  const newH = (h + step * 19) % 360;
  return hslToHex(newH, Math.min(100, Math.max(35, s)), newL);
}
 
const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';
 
const TILT_ANGLES: Record<ChartStyle["xAxisTilt"], number> = {
  none: 0,
  slight: -30,
  diagonal: -45,
  vertical: -90,
};
 
const FONT_SIZES: Record<FontSize, number> = {
  small: 11,
  medium: 13,
  large: 16,
};
 
function isPieLikeSpec(data: any[]): boolean {
  return data.length >= 1 && data.every((t) => Array.isArray(t?.labels));
}
 
function isSingleCategoricalSpec(data: any[]): boolean {
  if (data.length !== 1) return false;
  const t = data[0];
  return ["bar", "funnel", "waterfall", "histogram"].includes(t?.type) && !Array.isArray(t?.labels);
}
 
// Bar-family types that support Plotly's rounded-corner marker and benefit
// from the same "not touching" spacing treatment - the shared premium bar
// look every chart type below draws from.
const BAR_LIKE_TYPES = new Set(["bar", "histogram", "waterfall", "funnel"]);
 
// A trace added purely as visual/analytical context - a regression trend
// line or its shaded confidence band on a scatter plot (see
// chart_builder.py's _add_trend_overlay on the backend) - rather than a
// real, independently meaningful data series. The backend tags these with
// meta.role so this file can recognize and protect them: never recolor
// them from the palette, never offer them up to rename like a real series,
// and never let them count toward "how many series does this chart really
// have" (which is what decides showLegend/showLegend defaults and the
// hover box format below).
function isDecorativeTrace(t: any): boolean {
  return t?.meta?.role === "trend_line" || t?.meta?.role === "trend_band";
}
 
// One panel's bars in a faceted/small-multiples grid (see chart_builder.py's
// _build_faceted_bar - "X by Y in each Z" requests, one horizontal-bar panel
// per distinct value of Z, all sharing one figure). Tagged the same way a
// scatter trend line is (meta.role), but unlike a trend line these ARE real,
// independently colorable data - only excluded from the "how many series
// does this chart have" count (realSeriesCount) below, since a facet grid's
// panels are already labeled by their own subplot titles, not a legend.
function isFacetPanelTrace(t: any): boolean {
  return t?.meta?.role === "facet_panel";
}
 
export function isFacetedSpec(spec: any): boolean {
  const data: any[] = Array.isArray(spec?.data) ? spec.data : Array.isArray(spec) ? spec : [];
  return data.length > 0 && data.every((t) => isFacetPanelTrace(t));
}
 
function realSeriesCount(data: any[]): number {
  return data.filter((t) => !isDecorativeTrace(t) && !isFacetPanelTrace(t)).length;
}
 
// A bar-plus-line chart with its own right-hand axis (see chart_builder.py's
// _build_dual_axis_combo) - two metrics with very different scales shown
// against the same categories, each getting its own axis so neither one
// goes flat next to the other. Detected structurally (a bar trace, plus a
// trace pinned to yaxis2) rather than by a chart_type label of its own,
// since the backend builds this automatically whenever the data shape
// calls for it - there is nothing for the person to pick to get it.
function isDualAxisComboSpec(data: any[]): boolean {
  return data.length === 2 && data.some((t) => t?.type === "bar") && data.some((t) => t?.yaxis === "y2");
}
 
function categoryCount(t: any): number {
  const arr = Array.isArray(t?.x) ? t.x : Array.isArray(t?.y) ? t.y : null;
  return arr ? arr.length : 1;
}
 
/** Picks a sensible starting X-axis tilt for a brand new chart, so long or
 * numerous category labels (a wide correlation heatmap, a bar chart with
 * many long names) do not overlap by default. The person can still change
 * it in the Style panel afterwards. */
function smartDefaultTilt(spec: any): ChartStyle["xAxisTilt"] {
  const data = Array.isArray(spec?.data) ? spec.data : [];
  const t = data[0];
  const cats: any[] = Array.isArray(t?.x) ? t.x : [];
  if (cats.length > 6 && cats.some((c) => String(c).length > 6)) return "diagonal";
  return "none";
}
 
/** A brand-new chart's starting style, tuned to the shape of its data so it
 * already looks considered before the person ever opens the Style panel:
 * a single-series bar/line/scatter chart needs no legend (its title already
 * says what is plotted - a box with one swatch would just repeat that), and
 * a short bar-comparison chart (few categories) gets its values labeled
 * directly, the way a headline stat comparison should read at a glance. Any
 * of this can still be switched off per chart in the Style panel - this
 * only decides what a chart looks like the moment it is first drawn. */
export function defaultChartStyle(spec?: any): ChartStyle {
  const data: any[] = Array.isArray(spec?.data) ? spec.data : [];
  const pieLike = isPieLikeSpec(data);
  const singleCategorical = isSingleCategoricalSpec(data);
  // A scatter plot's regression trend line and confidence band (see
  // isDecorativeTrace) are not a second and third "series" - a scatter
  // plot with an automatic trend line still reads, and defaults, exactly
  // like the single-series scatter it visually is.
  const multiSeries = realSeriesCount(data) > 1 && !pieLike;
 
  return {
    paletteId: "original",
    customColors: [],
    singleColor: DEFAULT_ACCENT_COLOR,
    accentColors: {},
    title: "",
    xAxisLabel: "",
    yAxisLabel: "",
    seriesNames: [],
    showGrid: true,
    // A legend box only earns its space once there is more than one
    // series to tell apart - a lone bar/line/scatter trace is already
    // named by the chart's own title.
    showLegend: pieLike || multiSeries,
    // A short headline bar comparison (few categories, one series) reads
    // best with its values right on the bars, the way every reference
    // "premium" chart shows a number above each bar. Longer series
    // (histograms, many categories) stay uncluttered by default. A
    // dual-axis combo (see isDualAxisComboSpec) always gets its values
    // labeled too - the whole point of giving the second metric its own
    // axis is to make its numbers readable, not just its shape.
    dataLabels:
      (singleCategorical && categoryCount(data[0]) > 0 && categoryCount(data[0]) <= 12) || isDualAxisComboSpec(data),
    xAxisTilt: smartDefaultTilt(spec),
    fontSize: "medium",
  };
}
 
/** Returns the labels shown in the "rename" UI: per-slice labels for a
 * pie-like chart, or per-trace (legend) names for a multi-series chart.
 * Returns an empty list for a single-series cartesian chart or a heatmap,
 * where there is nothing meaningful to rename beyond the axis labels/title -
 * and a scatter plot's automatic trend line/confidence band (see
 * isDecorativeTrace) is filtered out here too, so a scatter chart with a
 * trend line still offers nothing to rename, exactly like a plain one. */
export function seriesLabels(spec: any): string[] {
  const data = Array.isArray(spec?.data) ? spec.data : [];
  if (data.length === 0) return [];
  // A facet grid's panels are already labeled by their own subplot titles
  // (baked into the figure by chart_builder.py) - a "rename this series"
  // box here would have no visible effect, since renaming a trace's name
  // does not touch its subplot title, so it is deliberately left out.
  if (isFacetedSpec(data)) return [];
  if (isPieLikeSpec(data)) return (data[0].labels || []).map((l: any) => String(l));
  const real = data.filter((t) => !isDecorativeTrace(t));
  if (real.length > 1) return real.map((t: any, i: number) => t.name || `Series ${i + 1}`);
  return [];
}
 
/** Returns the real name behind EVERY colorable thing on a chart - every pie
 * slice, every bar in a single-trace bar chart, or every series in a
 * multi-series chart - used to size and label the custom-color picker in the
 * Style panel. Deliberately broader than seriesLabels above: seriesLabels is
 * about what's worth offering a rename box for (and single-categorical bars
 * don't get one, since "Sales"/"HR"/"R&D" are already their real names, not
 * an AI-assigned "trace 0"), while this is about how many distinct colors a
 * chart actually needs and what each one is really called - which a
 * single-categorical bar chart very much does have one of per bar. This is
 * also what fixes the old bug where a 10-bar chart's custom-color picker
 * only ever showed 6 swatches: that picker used to size itself off
 * seriesLabels, which returns nothing at all for this exact chart shape. */
export function colorableLabels(spec: any): string[] {
  const data = Array.isArray(spec?.data) ? spec.data : [];
  if (data.length === 0) return [];
  if (isPieLikeSpec(data)) return (data[0].labels || []).map((l: any) => String(l));
  if (isSingleCategoricalSpec(data)) {
    const t = data[0];
    const arr = t?.orientation === "h" ? t?.y : t?.x;
    return Array.isArray(arr) ? arr.map((v: any) => String(v)) : [];
  }
  const real = data.filter((t) => !isDecorativeTrace(t));
  if (real.length > 1) return real.map((t: any, i: number) => t.name || `Series ${i + 1}`);
  // A single real trace (a plain line/scatter/histogram with no pie and no
  // per-category bars) still has exactly one colorable thing - its own
  // line/marker color - so this always offers that one real swatch rather
  // than zero, and never a padded-out fake count either way.
  if (real.length === 1) return [real[0].name || "Series 1"];
  return [];
}
 
// Chart types with no 2D x/y cartesian axes at all - a polar chart (radar,
// polar bar), a flow diagram (sankey), a single-number indicator (gauge), a
// parallel-coordinates plot, a geo map (choropleth) or a 3D scatter. The
// Style panel skips axis labels/gridlines/tilt for these, the same way it
// already skips them for pie-like charts.
const NON_CARTESIAN_TYPES = new Set(["scatterpolar", "barpolar", "sankey", "indicator", "parcoords", "choropleth", "scatter3d"]);
 
function isNonCartesianSpec(data: any[]): boolean {
  return data.some((t) => NON_CARTESIAN_TYPES.has(t?.type));
}
 
export function hasCartesianAxes(spec: any): boolean {
  const data = Array.isArray(spec?.data) ? spec.data : [];
  // A faceted grid has a whole GRID of axis pairs (xaxis/yaxis, xaxis2/
  // yaxis2, ...), not the single shared pair every control gated on this
  // flag assumes (the Style panel's X/Y axis label boxes and tilt picker,
  // and applyChartStyle's single-axis-pair styling block below) - so it is
  // treated the same as a non-cartesian chart here, even though it
  // genuinely does have axes. Its own outer axis captions are instead set
  // once, server-side, from the AI's x_label/y_label (see
  // chart_builder.py's build_figure faceted_bar branch).
  return data.length > 0 && !isPieLikeSpec(data) && !isNonCartesianSpec(data) && !isFacetedSpec(data);
}
 
export function isHeatmapSpec(spec: any): boolean {
  const data = Array.isArray(spec?.data) ? spec.data : [];
  return data.some((t) => t?.type === "heatmap");
}
 
// Chart types that render as one continuous color gradient rather than
// discrete per-item colors - a palette here becomes a colorscale, same idea
// as a heatmap, instead of per-series marker colors.
export function isGradientSpec(spec: any): boolean {
  const data = Array.isArray(spec?.data) ? spec.data : [];
  return data.some((t) => ["heatmap", "contour", "histogram2d", "choropleth"].includes(t?.type));
}
 
/** Best-effort guess at which of our supported chart types the current spec
 * represents, purely so the Style panel can highlight the matching "Chart
 * type" button. Never affects rendering. */
export function detectChartType(spec: any): string {
  const data = Array.isArray(spec?.data) ? spec.data : [];
  const t = data[0];
  if (!t) return "";
  const layout = spec?.layout || {};
 
  if (isFacetedSpec(data)) return "faceted_bar";
 
  switch (t.type) {
    case "scatter": {
      if (Array.isArray(t.marker?.size)) return "bubble";
      if (t.error_y) return "error_bar";
      if (t.stackgroup) return "stacked_area";
      if (t.fill && t.fill !== "none") return "area";
      if ((t.mode || "").includes("lines")) return t.line?.shape === "hv" ? "step_line" : "line";
      return "scatter";
    }
    case "bar":
      if (t.orientation === "h") return "horizontal_bar";
      if (data.length > 1) return layout.barmode === "stack" ? "stacked_bar" : "grouped_bar";
      return "bar";
    case "pie":
      return (t.hole || 0) >= 0.55 ? "donut" : "pie";
    case "scatterpolar":
      return "radar";
    case "barpolar":
      return "polar_bar";
    case "histogram2d":
      return "density_heatmap";
    case "scatter3d":
      return "scatter_3d";
    case "parcoords":
      return "parallel_coordinates";
    case "funnelarea":
      return "funnel_area";
    case "indicator":
      return "gauge";
    default:
      return t.type || "";
  }
}
 
function paletteColors(style: ChartStyle, count: number): string[] {
  // "Single color" paints every bar/slice/line the one color the person
  // picked, for a brand look rather than a rainbow of series - the only
  // palette mode where every item is deliberately NOT distinct from the
  // others, since that's the whole point of choosing it.
  if (style.paletteId === "single") {
    const c = style.singleColor || DEFAULT_ACCENT_COLOR;
    return Array.from({ length: count }, () => c);
  }
  const base =
    style.paletteId === "custom"
      ? style.customColors.length
        ? style.customColors
        : PALETTES[0].colors
      : style.paletteId === "original"
      ? SIGNATURE_COLORS
      : PALETTES.find((p) => p.id === style.paletteId)?.colors || PALETTES[0].colors;
  // Every palette here has 6-8 hand-picked colors; extendedColorAt keeps
  // generating fresh, visibly distinct shades past that point instead of
  // silently repeating the same 6-8 colors once a chart has more bars than
  // that (see extendedColorAt's own note for why/how).
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(extendedColorAt(base, i));
  return out;
}
 
/** The colors this style paints onto a chart's bars/slices/series. Every
 * distinct thing on a chart - each bar, each pie slice, each line in a
 * multi-line comparison - always gets its own distinct, colorblind-safe
 * color, never left to whatever the AI's plotting code happened to pick
 * (which is how the old default ended up as one flat hue with a
 * meaningless "trace 0" legend). "Signature, GD360 default" (paletteId
 * "original") means our own validated brand palette; a person-picked
 * palette from the Style panel simply swaps which set of colors is used -
 * the "always distinct, always meaningful" rule itself never turns off. */
function colorsForStyle(style: ChartStyle, count: number): string[] {
  return paletteColors(style, count);
}
 
function titleTextOf(value: any): string {
  return typeof value === "string" ? value : value?.text || "";
}
 
/** Formats a value with thousand separators and up to 2 decimal places,
 * trimming insignificant trailing zeros (9164 -> "9,164", 8851.36 ->
 * "8,851.36") - used for the on-bar value labels and hover readout so a
 * premium chart never shows an unrounded float like "9164.399999999998". */
const VALUE_FORMAT = ",.2~f";
 
/** Formats a single bar's value the same way VALUE_FORMAT does for every
 * everyday magnitude (9164 -> "9,164", 8851.36 -> "8,851.36", -0.57 ->
 * "-0.57"), but switches to scientific notation for a genuinely tiny
 * nonzero value (a regression p-value like 0.0000000000000000000000000000
 * 000000000000000000000000000000000128, i.e. 1.28e-62) that would
 * otherwise round straight to "0" under fixed 2-decimal formatting -
 * which, on a bar chart, also means the bar itself renders at an
 * imperceptible sub-pixel height, indistinguishable from an empty one.
 * Showing the real magnitude in the label is what still lets someone read
 * the true result off a bar that is, visually, empty. Used for both the
 * on-bar label and the hover readout (see the bar/histogram branches
 * below) so the two always agree with each other. */
function formatValueSmart(v: any): string {
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs < 0.01) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
 
/** Applies the given style on top of the AI-generated Plotly spec, without
 * mutating the original. Safe to call repeatedly (e.g. on every render) -
 * always starts fresh from the raw spec so switching palettes, font size or
 * resetting never compounds. `fallbackTitle` (e.g. the chat prompt that
 * produced this chart) is only used when neither the person nor the AI
 * spec itself already supplied title text.
 *
 * This also lays down the chart's structural "premium" chrome - rounded
 * bar ends, breathing room between bars, a clean hover readout, sensible
 * margins, a left-aligned title - the same for every palette and every
 * theme. Colors that genuinely depend on light vs. dark mode (text, grid,
 * hover-card background) are intentionally left for ChartCanvas.tsx to
 * apply on top of this, since this function has no idea which theme the
 * viewer is in. */
export function applyChartStyle(rawSpec: any, style: ChartStyle, fallbackTitle?: string): any {
  if (!rawSpec) return rawSpec;
  const spec = JSON.parse(JSON.stringify(rawSpec));
  const data: any[] = Array.isArray(spec.data) ? spec.data : [];
  const layout = spec.layout || (spec.layout = {});
 
  const pieLike = isPieLikeSpec(data);
  const singleCategorical = isSingleCategoricalSpec(data);
  const isGradient = isGradientSpec(spec);
  const isCartesian = hasCartesianAxes(spec);
  // A scatter plot's regression trend line/confidence band don't count as
  // extra series - see realSeriesCount - so a scatter chart with an
  // automatic trend line still behaves like the single-series chart it is
  // (no legend by default, no "<extra>name</extra>" hover box, nothing to
  // rename beyond the one real trace).
  const multiSeries = realSeriesCount(data) > 1 && !pieLike;
  const hasBarLike = data.some((t) => BAR_LIKE_TYPES.has(t?.type));
  const horizontal = data.some((t) => t?.orientation === "h");
  const isDualAxisCombo = isDualAxisComboSpec(data);
  const baseSize = FONT_SIZES[style.fontSize];
 
  layout.font = { ...(layout.font || {}), size: baseSize, family: FONT_FAMILY };
 
  // ---- Colors ----
  if (isGradient) {
    // A heatmap, contour, density heatmap or choropleth has no discrete
    // series to color - it is one continuous gradient - so a palette here
    // becomes a multi-stop colorscale built from that palette colors,
    // instead of per-item colors.
    if (style.paletteId !== "original") {
      const stops = paletteColors(style, 6);
      const colorscale = stops.map((c, i): [number, string] => [i / (stops.length - 1), c]);
      data.forEach((t) => {
        if (["heatmap", "contour", "histogram2d", "choropleth"].includes(t.type)) t.colorscale = colorscale;
      });
    }
  } else if (pieLike) {
    const count = data[0]?.labels?.length || 0;
    const colors = colorsForStyle(style, count);
    data[0].marker = { ...(data[0].marker || {}), colors };
  } else if (singleCategorical) {
    // A single bar/histogram/waterfall/funnel trace: every bar gets its
    // own distinct, colorblind-safe hue from the palette (in fixed order,
    // never re-cycled at random) instead of one flat color for the whole
    // trace - this is the single biggest visual upgrade over the AI's raw
    // default, and it is on even for "Signature, GD360 default".
    const count = categoryCount(data[0]);
    const colors = colorsForStyle(style, count);
    const t0 = data[0];
    // A plain bar chart (not histogram/waterfall/funnel, which don't have
    // one bar per independently-named category the same way) whose legend
    // is switched on gets split into one trace PER BAR, each carrying its
    // real category name and its own single color - this is what makes the
    // legend actually say "Sales" / "Human Resources" / "R&D" next to the
    // right color swatch, instead of Plotly's single meaningless "trace 0"
    // entry that a one-trace bar chart used to produce (a legend can only
    // ever show one entry per TRACE, and this chart used to be only one
    // trace no matter how many bars/colors it had). Left as a single trace
    // whenever the legend is off, since splitting has no visible benefit
    // there and keeps every other chart's spec exactly as before.
    if (t0?.type === "bar" && style.showLegend && count > 1) {
      const horizontalBar = t0.orientation === "h";
      const cats: any[] = (horizontalBar ? t0.y : t0.x) || [];
      const vals: any[] = (horizontalBar ? t0.x : t0.y) || [];
      const perBar = cats.map((cat, i) => {
        const one: any = {
          ...t0,
          name: cat != null && String(cat).trim() ? String(cat) : `Bar ${i + 1}`,
          showlegend: true,
          marker: { ...(t0.marker || {}), color: colors[i] },
        };
        if (horizontalBar) {
          one.y = [cat];
          one.x = [vals[i]];
        } else {
          one.x = [cat];
          one.y = [vals[i]];
        }
        if (Array.isArray(t0.text)) one.text = [t0.text[i]];
        return one;
      });
      data.splice(0, 1, ...perBar);
    } else {
      t0.marker = { ...(t0.marker || {}), color: colors };
    }
  } else {
    // Every other chart - a multi-series comparison (several bars or
    // lines, e.g. Revenue vs Expenses), a dual-axis combo (see
    // isDualAxisComboSpec), or a single trend line - always gets its own
    // distinct, colorblind-safe color per series too, the same rule as
    // above: color is never left to chance. Each series keeps whatever
    // real name the AI gave it (Revenue, Expenses...), so the legend still
    // reads correctly - only the color swatch next to that name changes,
    // and it is now always guaranteed to be tell-apart from every other
    // series on the chart, not just whatever the AI happened to pick. A
    // decorative trace (a scatter plot's regression trend line or its
    // confidence band - see isDecorativeTrace) is skipped here entirely:
    // its color is chosen deliberately by the backend to read as "analysis
    // drawn on the data", not as one more series competing for a palette
    // slot.
    const colorableIdx = data.map((_, i) => i).filter((i) => !isDecorativeTrace(data[i]));
    const colors = colorsForStyle(style, colorableIdx.length);
    colorableIdx.forEach((i, ci) => {
      const c = colors[ci];
      const t = data[i];
      t.marker = { ...(t.marker || {}), color: c };
      if (t.line || t.type === "scatter") t.line = { ...(t.line || {}), color: c };
    });
  }
 
  // ---- Accent colors: a decorative trace (right now just a scatter plot's
  // regression trend line - see isDecorativeTrace) is deliberately never
  // touched by the palette logic above, but a person can still give it its
  // own branded color here via style.accentColors.trend_line, independent
  // of whatever palette the real data series are using. The confidence band
  // that shades in behind the line (role "trend_band") isn't separately
  // pickable - it always follows the line's own color at the same soft 15%
  // opacity chart_builder.py already draws it at, so the two never drift
  // apart into mismatched colors. The little "Trend: strong positive
  // relationship..." annotation chart_builder.py prints in the corner is
  // recolored to match too, but ONLY if it's still wearing the backend's
  // original color unchanged - if a future backend change ever gives that
  // annotation a deliberately different color of its own, this leaves it
  // alone rather than assuming it's always the trend line's color. ----
  const trendOverride = style.accentColors?.trend_line;
  if (trendOverride) {
    data.forEach((t) => {
      if (!isDecorativeTrace(t)) return;
      const role = t?.meta?.role;
      if (role === "trend_line") t.line = { ...(t.line || {}), color: trendOverride };
      else if (role === "trend_band") t.fillcolor = hexToRgba(trendOverride, 0.15);
    });
    if (Array.isArray(layout.annotations)) {
      layout.annotations = layout.annotations.map((a: any) =>
        a?.font?.color && String(a.font.color).toUpperCase() === BACKEND_TREND_COLOR
          ? { ...a, font: { ...a.font, color: trendOverride } }
          : a
      );
    }
  }
 
  // ---- Bar-family shape: rounded ends + breathing room between bars, the
  // same on every palette/theme. Never fills the whole slot - a visible
  // surface gap between bars reads as separation, not a stroke around them. ----
  if (hasBarLike) {
    data.forEach((t) => {
      if (!BAR_LIKE_TYPES.has(t?.type)) return;
      t.marker = { ...(t.marker || {}), cornerradius: t.marker?.cornerradius ?? 6 };
    });
    if (layout.bargap === undefined) layout.bargap = multiSeries ? 0.28 : 0.42;
    if (layout.bargroupgap === undefined) layout.bargroupgap = 0.12;
  }
 
  // ---- Series / category names ----
  if (pieLike && style.seriesNames.length) {
    data[0].labels = (data[0].labels || []).map((l: any, i: number) => style.seriesNames[i] || l);
  } else if (!pieLike && data.length > 1 && style.seriesNames.length) {
    data.forEach((t, i) => {
      if (style.seriesNames[i]) t.name = style.seriesNames[i];
    });
  }
 
  // ---- Title (always resolved + sized, even if the person never opens
  // Style) - bold-weighted and left-aligned like a dashboard headline
  // rather than Plotly's small centered default. Plotly caps title.y at 1
  // (the very top edge of the whole canvas), so "yanchor: top" is what
  // keeps the text growing downward from just under that edge rather than
  // off it - the actual breathing room above the plot comes from the top
  // margin below, not from pushing y any further. ----
  const titleText = style.title || titleTextOf(layout.title) || fallbackTitle || "";
  layout.title = {
    text: titleText,
    font: { size: Math.round(baseSize * 1.5), family: FONT_FAMILY, weight: 650 },
    x: 0.01,
    xanchor: "left",
    y: 0.97,
    yanchor: "top",
  };
 
  // ---- Margins: generous breathing room by default, and ALWAYS applied
  // here (never left to whatever margin, if any, the raw AI/backend figure
  // happened to already set - the backend's own default margin is tight
  // enough on its own that it used to silently defeat this file's premium
  // margin entirely) - this file is the single source of truth for chart
  // structure, the same principle as everything else in it.
  //
  // How many entries the legend will actually have, counted AFTER the
  // colors section above (which may have just split a single-categorical
  // bar chart into one trace per bar - see singleCategorical above) so this
  // always reflects what will really be drawn, not what the raw AI spec
  // started out as.
  const legendEntryCount = pieLike
    ? data[0]?.labels?.length || 0
    : data.filter((t) => !isDecorativeTrace(t) && t.showlegend !== false).length;
  const legendWillShow = style.showLegend && (pieLike || legendEntryCount > 1);
 
  // The legend ALWAYS sits in its own dedicated strip to the right of the
  // plot - never above or below it - so it can never land on top of the
  // title or the bars, at any chart size and at any window width,
  // including while someone is actively resizing the browser. This
  // replaces an earlier top/bottom-band approach that had to estimate how
  // many rows a wrapping horizontal legend would take, and kept getting
  // that estimate wrong at real chart sizes - a vertical list in its own
  // margin column needs no such guess, since each entry is simply one more
  // row growing downward inside space reserved for it and nothing else.
  // The reserved width is sized to the longest real legend label (capped
  // both ways), so a short "Yes/No" legend gets a slim strip and a chart
  // with longer category names gets a little more room, without ever
  // crushing the plot area on a narrow screen.
  const legendLabelsForWidth: string[] = pieLike
    ? (data[0]?.labels || []).map((l: any) => String(l))
    : data.filter((t) => !isDecorativeTrace(t) && t.showlegend !== false).map((t) => String(t.name || ""));
  const longestLegendLabel = legendLabelsForWidth.reduce((m, l) => Math.max(m, l.length), 0);
  const legendWidthPx = legendWillShow
    ? Math.min(190, Math.max(84, 30 + Math.round(longestLegendLabel * baseSize * 0.58)))
    : 0;
  // 2026-09-23, round eight (Gokul's own explicit bug report: an opened
  // legend was "touching xaxis words or yaxis words"): the legend used to
  // be vertically CENTERED in the figure's own paper coordinates (y: 0.5,
  // yanchor: "middle"), which - Plotly's paper space spans the whole
  // figure, margins included, not just the inner plot rectangle - let a
  // tall, many-entry legend grow both upward past the title AND downward
  // past the x-axis tick labels on a shorter chart. It's now always
  // top-anchored (grows downward only, starting just under the title), and
  // this estimates how tall that legend column will actually be so the
  // plot area itself can be given enough real vertical room for it - never
  // just a fixed 380px regardless of how many rows the legend needs. See
  // suggestedChartMinHeight below, which ChartCanvas.tsx reads to size the
  // chart's own container instead of a single hardcoded minHeight.
  const legendRowPx = Math.max(18, Math.round(baseSize * 1.55));
  const legendHeightPx = legendWillShow ? legendEntryCount * legendRowPx + 24 : 0;
  // A tilted (diagonal/vertical) x-axis needs its own extra room below the
  // plot for the slanted tick labels - unconditional now, since the legend
  // never competes for that band anymore (it lives on the right instead).
  const tiltExtraPx = isCartesian && (style.xAxisTilt === "diagonal" || style.xAxisTilt === "vertical") ? 46 : 0;
  // A faceted grid carries its own shared outer axis captions as figure-
  // level annotations (see chart_builder.py's build_figure faceted_bar
  // branch) sitting just outside the plot area on the left and bottom -
  // without this extra room they can get clipped by the card edge.
  const isFaceted = isFacetedSpec(data);
  const facetExtraBottomPx = isFaceted ? 34 : 0;
  const facetExtraLeftPx = isFaceted ? 26 : 0;
 
  layout.margin = {
    t: 60,
    r: 28 + legendWidthPx,
    b: 52 + tiltExtraPx + facetExtraBottomPx,
    l: 60 + facetExtraLeftPx,
    pad: 6,
  };
 
  // ---- Axes (labels, grid, tilt, font, and auto margin so long or many
  // category labels - like a wide correlation heatmap - never get clipped
  // or overlap each other) ----
  if (isCartesian) {
    layout.xaxis = { ...(layout.xaxis || {}) };
    layout.yaxis = { ...(layout.yaxis || {}) };
 
    const xText = style.xAxisLabel || titleTextOf(layout.xaxis.title);
    if (xText) layout.xaxis.title = { text: xText, font: { size: Math.round(baseSize * 1.1) } };
    const yText = style.yAxisLabel || titleTextOf(layout.yaxis.title);
    if (yText) layout.yaxis.title = { text: yText, font: { size: Math.round(baseSize * 1.1) } };
 
    // Only the value axis carries gridlines by default - a premium chart
    // reads its categories off clean tick labels, not a grid crossing them
    // too. For a horizontal bar the value axis is X; everywhere else it's Y.
    layout.xaxis.showgrid = horizontal ? style.showGrid : false;
    layout.yaxis.showgrid = horizontal ? false : style.showGrid;
    layout.xaxis.tickangle = TILT_ANGLES[style.xAxisTilt];
    layout.xaxis.automargin = true;
    layout.yaxis.automargin = true;
    layout.xaxis.tickfont = { size: baseSize };
    layout.yaxis.tickfont = { size: baseSize };
    layout.xaxis.zeroline = false;
    layout.yaxis.zeroline = false;
  }
 
  // ---- Legend: a name for every real trace (never left blank, which is
  // what makes Plotly fall back to its own generic "trace 0"/"trace 1" -
  // the second half of the original bug report, alongside the legend
  // showing up somewhere unreadable). The singleCategorical branch above
  // already gives a split-for-legend bar chart its real per-bar names; this
  // is the catch-all for everything else - a lone line/scatter/histogram
  // trace with no name of its own falls back to the y-axis label or the
  // chart's own title, so if someone switches its legend on anyway it says
  // something real instead of "trace 0". ----
  data.forEach((t, i) => {
    if (isDecorativeTrace(t)) return;
    if (!t.name || !String(t.name).trim()) {
      t.name = style.yAxisLabel || titleTextOf(layout.title) || style.title || fallbackTitle || `Series ${i + 1}`;
    }
  });
 
  // ---- Legend: a vertical list docked in its own reserved strip on the
  // right (see the margin math above) - never a boxed sidebar overlapping
  // the plot, and never sharing space with the title, which stays pinned
  // at the top-left. Plotly's margins are absolute pixels, not a fraction
  // of the chart, so this stays correctly clear of both the title and the
  // bars at any window width or chart height, including while a person is
  // actively resizing the browser. Only styled - not toggled - here;
  // whether it shows at all is decided by style.showLegend (see
  // defaultChartStyle for the default). ----
  layout.showlegend = style.showLegend;
  layout.legend = {
    ...(layout.legend || {}),
    orientation: "v",
    x: 1,
    xanchor: "left",
    xref: "paper",
    // Top-anchored, not vertically centered - see the legendHeightPx note
    // above. Growing downward from just under the title is the only
    // direction that can never collide with either the title (above) or
    // the x-axis tick labels (below): a centered legend could grow both
    // ways at once, which is exactly what let a many-entry legend reach
    // past the plot's own edges and land on top of axis text.
    y: 0.98,
    yanchor: "top",
    yref: "paper",
    bgcolor: "rgba(0,0,0,0)",
    bordercolor: "rgba(0,0,0,0)",
    font: { ...(layout.legend?.font || {}), size: Math.max(11, baseSize - 1), family: FONT_FAMILY },
    tracegroupgap: 4,
    itemwidth: 30,
  };

  // Exposed so ChartCanvas.tsx can give the chart's own container enough
  // real height to fit a top-anchored legend with many entries end to end -
  // never just a fixed 380px regardless of how tall the legend actually
  // needs to be. See suggestedChartMinHeight below, the only reader of
  // this. Lives on the spec itself (a sibling of data/layout), never
  // inside layout - Plotly is only ever handed chartSpec.data and a
  // themed copy of chartSpec.layout (see ChartCanvas.tsx), so this can
  // never reach Plotly or affect rendering.
  spec._gd360SuggestedMinHeight = Math.max(380, layout.margin.t + legendHeightPx + layout.margin.b);
 
  // ---- Hover: one clean readout per mark, value bolded and leading, the
  // series name only shown when there is more than one series to tell
  // apart (otherwise the raw AI trace name is usually just "trace 0" noise,
  // and <extra></extra> removes the box that would otherwise show it). A
  // dual-axis combo always uses the unified box so hovering one category
  // shows both metrics together - the whole point of pairing them on the
  // same categories. A decorative trend line/confidence band is left
  // untouched (hoverinfo:"skip", set by the backend, already keeps it out
  // of the hover box entirely). ----
  layout.hovermode = isCartesian ? (hasBarLike && !isDualAxisCombo ? "closest" : "x unified") : layout.hovermode;
  data.forEach((t) => {
    if (isDecorativeTrace(t)) return;
    const type = t.type;
    const extra = multiSeries ? "<extra>%{fullData.name}</extra>" : "<extra></extra>";
    const h = t.orientation === "h";
    if (type === "bar" || type === "histogram") {
      // Reads the same precomputed, tiny-value-safe text the on-bar label
      // below is built from (see formatValueSmart) - so hovering a bar
      // always reports its real value, never a rounded "0.00" that
      // contradicts what the label (or a near-invisible sliver of a bar)
      // actually represents.
      t.hovertemplate = `${h ? "%{y}" : "%{x}"}<br><b>%{text}</b>${extra}`;
    } else if (BAR_LIKE_TYPES.has(type)) {
      t.hovertemplate = `${h ? "%{y}" : "%{x}"}<br><b>%{${h ? "x" : "y"}:${VALUE_FORMAT}}</b>${extra}`;
    } else if (type === "scatter" || type === undefined) {
      t.hovertemplate = `<b>%{y:${VALUE_FORMAT}}</b>${extra}`;
    }
  });
 
  // ---- Data labels ---- (a decorative trend line/confidence band is
  // skipped - toggling "Data labels" on should never scatter text along a
  // trend line or its band edges)
  data.forEach((t) => {
    if (isDecorativeTrace(t)) return;
    const type = t.type;
    if (type === "pie") {
      t.textinfo = style.dataLabels ? "label+percent" : "label";
    } else if (type === "funnel") {
      t.textinfo = style.dataLabels ? "value+percent initial" : "none";
    } else if (type === "treemap" || type === "sunburst" || type === "icicle" || type === "funnelarea") {
      t.textinfo = style.dataLabels ? "label+value" : "label";
    } else if (type === "heatmap") {
      t.texttemplate = style.dataLabels ? "%{z}" : undefined;
    } else if (type === "waterfall") {
      t.texttemplate = style.dataLabels ? `%{${t.orientation === "h" ? "x" : "y"}:${VALUE_FORMAT}}` : undefined;
      t.textposition = "outside";
    } else if (type === "bar" || type === "histogram") {
      // Precomputed text (not a Plotly texttemplate/d3-format string) so a
      // genuinely tiny nonzero value - a p-value like 1.28e-62 - always
      // shows its real magnitude instead of silently rounding to "0" and
      // vanishing (see formatValueSmart). "outside" (not "auto") guarantees
      // the label still renders even when the bar itself is an
      // imperceptible sliver - Plotly's own "auto" placement can otherwise
      // skip the label entirely once a bar's rendered height rounds to
      // zero pixels, which is exactly what was silently dropping the
      // P-value label on a regression-summary chart. cliponaxis:false
      // keeps that outside label from ever being clipped right at the
      // plot's edge.
      const vals: any[] = t.orientation === "h" ? t.x : t.y;
      t.text = Array.isArray(vals) ? vals.map(formatValueSmart) : undefined;
      delete t.texttemplate;
      t.textposition = style.dataLabels ? "outside" : "none";
      t.cliponaxis = false;
      t.textfont = { ...(t.textfont || {}), family: FONT_FAMILY, weight: 650 };
    } else if (type === "scatter" || type === undefined) {
      const baseMode = (t.mode || "lines+markers").replace("+text", "");
      t.mode = style.dataLabels ? `${baseMode}+text` : baseMode;
      t.text = style.dataLabels ? t.y || t.x : undefined;
      t.textposition = "top center";
    }
  });
 
  return spec;
}

/** How tall a chart's own container should be so its (possibly many-entry)
 * legend always has real room to finish growing downward from the title
 * without ever reaching into the x-axis tick-label band below the plot -
 * see the legendHeightPx note inside applyChartStyle, which computes and
 * stashes this. Call it on the STYLED spec (applyChartStyle's return
 * value), not the raw AI spec. Always at least 380px, this app's original
 * default for a plain chart with no legend or a short one. */
export function suggestedChartMinHeight(styledSpec: any): number {
  return styledSpec?._gd360SuggestedMinHeight || 380;
}
