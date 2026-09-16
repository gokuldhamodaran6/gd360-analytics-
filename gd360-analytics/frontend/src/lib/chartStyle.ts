// Client-side chart styling. The AI backend returns a plain Plotly figure
// spec (data + layout) as JSON. Rather than teaching the backend/LLM about
// user styling preferences, we treat that spec as the raw source and apply
// a styling layer entirely in the browser: colors, titles, axis labels,
// series names, font size and display options. This means every style
// change is instant (no round trip to the AI, no separate "Apply" step)
// and the final, styled spec can simply be saved as-is onto a dashboard
// chart with no backend changes needed.

export type PaletteId = "original" | "aurora" | "sunset" | "forest" | "mono" | "vibrant" | "custom";
export type FontSize = "small" | "medium" | "large";

export type ChartStyle = {
  paletteId: PaletteId;
  customColors: string[];
  title: string;
  xAxisLabel: string;
  yAxisLabel: string;
  seriesNames: string[];
  showGrid: boolean;
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

export function defaultChartStyle(spec?: any): ChartStyle {
  return {
    paletteId: "original",
    customColors: [],
    title: "",
    xAxisLabel: "",
    yAxisLabel: "",
    seriesNames: [],
    showGrid: true,
    showLegend: true,
    dataLabels: false,
    xAxisTilt: smartDefaultTilt(spec),
    fontSize: "medium",
  };
}

/** Returns the labels shown in the "rename" UI: per-slice labels for a
 * pie-like chart, or per-trace (legend) names for a multi-series chart.
 * Returns an empty list for a single-series cartesian chart or a heatmap,
 * where there is nothing meaningful to rename beyond the axis labels/title. */
export function seriesLabels(spec: any): string[] {
  const data = Array.isArray(spec?.data) ? spec.data : [];
  if (data.length === 0) return [];
  if (isPieLikeSpec(data)) return (data[0].labels || []).map((l: any) => String(l));
  if (data.length > 1) return data.map((t: any, i: number) => t.name || `Series ${i + 1}`);
  return [];
}

export function hasCartesianAxes(spec: any): boolean {
  const data = Array.isArray(spec?.data) ? spec.data : [];
  return data.length > 0 && !isPieLikeSpec(data);
}

export function isHeatmapSpec(spec: any): boolean {
  const data = Array.isArray(spec?.data) ? spec.data : [];
  return data.some((t) => t?.type === "heatmap");
}

/** Best-effort guess at which of our 11 supported chart types the current
 * spec represents, purely so the Style panel can highlight the matching
 * "Chart type" button. Never affects rendering. */
export function detectChartType(spec: any): string {
  const t = Array.isArray(spec?.data) ? spec.data[0] : null;
  if (!t) return "";
  if (t.type === "scatter") {
    if (t.fill && t.fill !== "none") return "area";
    if ((t.mode || "").includes("lines")) return "line";
    return "scatter";
  }
  return t.type || "";
}

function paletteColors(style: ChartStyle, count: number): string[] {
  const base =
    style.paletteId === "custom"
      ? style.customColors.length
        ? style.customColors
        : PALETTES[0].colors
      : PALETTES.find((p) => p.id === style.paletteId)?.colors || PALETTES[0].colors;
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(base[i % base.length]);
  return out;
}

function colorsForStyle(style: ChartStyle, count: number): string[] | null {
  if (style.paletteId === "original") return null;
  return paletteColors(style, count);
}

function titleTextOf(value: any): string {
  return typeof value === "string" ? value : value?.text || "";
}

/** Applies the given style on top of the AI-generated Plotly spec, without
 * mutating the original. Safe to call repeatedly (e.g. on every render) -
 * always starts fresh from the raw spec so switching palettes, font size or
 * resetting never compounds. `fallbackTitle` (e.g. the chat prompt that
 * produced this chart) is only used when neither the person nor the AI
 * spec itself already supplied title text. */
export function applyChartStyle(rawSpec: any, style: ChartStyle, fallbackTitle?: string): any {
  if (!rawSpec) return rawSpec;
  const spec = JSON.parse(JSON.stringify(rawSpec));
  const data: any[] = Array.isArray(spec.data) ? spec.data : [];
  const layout = spec.layout || (spec.layout = {});

  const pieLike = isPieLikeSpec(data);
  const singleCategorical = isSingleCategoricalSpec(data);
  const hasHeatmap = data.some((t) => t.type === "heatmap");
  const baseSize = FONT_SIZES[style.fontSize];

  layout.font = { ...(layout.font || {}), size: baseSize };

  // ---- Colors ----
  if (hasHeatmap) {
    // A heatmap has no discrete series to color - it is one continuous
    // gradient - so a palette here becomes a multi-stop colorscale built
    // from that palette colors, instead of per-item colors.
    if (style.paletteId !== "original") {
      const stops = paletteColors(style, 6);
      const colorscale = stops.map((c, i): [number, string] => [i / (stops.length - 1), c]);
      data.forEach((t) => {
        if (t.type === "heatmap") t.colorscale = colorscale;
      });
    }
  } else if (pieLike) {
    const count = data[0]?.labels?.length || 0;
    const colors = colorsForStyle(style, count);
    if (colors) data[0].marker = { ...(data[0].marker || {}), colors };
  } else if (singleCategorical) {
    const count = categoryCount(data[0]);
    const colors = colorsForStyle(style, count);
    if (colors) data[0].marker = { ...(data[0].marker || {}), color: colors };
  } else {
    const colors = colorsForStyle(style, data.length);
    if (colors) {
      data.forEach((t, i) => {
        const c = colors[i];
        t.marker = { ...(t.marker || {}), color: c };
        if (t.line || t.type === "scatter") t.line = { ...(t.line || {}), color: c };
      });
    }
  }

  // ---- Series / category names ----
  if (pieLike && style.seriesNames.length) {
    data[0].labels = (data[0].labels || []).map((l: any, i: number) => style.seriesNames[i] || l);
  } else if (!pieLike && data.length > 1 && style.seriesNames.length) {
    data.forEach((t, i) => {
      if (style.seriesNames[i]) t.name = style.seriesNames[i];
    });
  }

  // ---- Title (always resolved + sized, even if the person never opens Style) ----
  const titleText = style.title || titleTextOf(layout.title) || fallbackTitle || "";
  layout.title = { text: titleText, font: { size: Math.round(baseSize * 1.45) } };

  // ---- Axes (labels, grid, tilt, font, and auto margin so long or many
  // category labels - like a wide correlation heatmap - never get clipped
  // or overlap each other) ----
  if (!pieLike) {
    layout.xaxis = { ...(layout.xaxis || {}) };
    layout.yaxis = { ...(layout.yaxis || {}) };

    const xText = style.xAxisLabel || titleTextOf(layout.xaxis.title);
    if (xText) layout.xaxis.title = { text: xText, font: { size: Math.round(baseSize * 1.1) } };
    const yText = style.yAxisLabel || titleTextOf(layout.yaxis.title);
    if (yText) layout.yaxis.title = { text: yText, font: { size: Math.round(baseSize * 1.1) } };

    layout.xaxis.showgrid = style.showGrid;
    layout.yaxis.showgrid = style.showGrid;
    layout.xaxis.tickangle = TILT_ANGLES[style.xAxisTilt];
    layout.xaxis.automargin = true;
    layout.yaxis.automargin = true;
    layout.xaxis.tickfont = { size: baseSize };
    layout.yaxis.tickfont = { size: baseSize };
  }

  // ---- Legend ----
  layout.showlegend = style.showLegend;
  layout.legend = { ...(layout.legend || {}), font: { ...(layout.legend?.font || {}), size: baseSize } };

  // ---- Data labels ----
  data.forEach((t) => {
    const type = t.type;
    if (type === "pie") {
      t.textinfo = style.dataLabels ? "label+percent" : "label";
    } else if (type === "funnel") {
      t.textinfo = style.dataLabels ? "value+percent initial" : "none";
    } else if (type === "treemap" || type === "sunburst") {
      t.textinfo = style.dataLabels ? "label+value" : "label";
    } else if (type === "heatmap") {
      t.texttemplate = style.dataLabels ? "%{z}" : undefined;
    } else if (type === "waterfall") {
      t.texttemplate = style.dataLabels ? (t.orientation === "h" ? "%{x}" : "%{y}") : undefined;
      t.textposition = "outside";
    } else if (type === "bar" || type === "histogram") {
      t.texttemplate = style.dataLabels ? (t.orientation === "h" ? "%{x}" : "%{y}") : undefined;
      t.textposition = "auto";
    } else if (type === "scatter" || type === undefined) {
      const baseMode = (t.mode || "lines+markers").replace("+text", "");
      t.mode = style.dataLabels ? `${baseMode}+text` : baseMode;
      t.text = style.dataLabels ? t.y || t.x : undefined;
      t.textposition = "top center";
    }
  });

  return spec;
}
