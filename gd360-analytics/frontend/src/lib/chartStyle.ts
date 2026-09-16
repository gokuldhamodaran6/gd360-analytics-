// Client-side chart styling. The AI backend returns a plain Plotly figure
// spec (data + layout) as JSON. Rather than teaching the backend/LLM about
// user styling preferences, we treat that spec as the raw source and apply
// a styling layer entirely in the browser: colors, titles, axis labels,
// series names, and display options. This means every style change is
// instant (no round trip to the AI) and the final, styled spec can simply
// be saved as-is onto a dashboard chart with no backend changes needed.

export type PaletteId = "original" | "aurora" | "sunset" | "forest" | "mono" | "vibrant" | "custom";

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
};

export function defaultChartStyle(): ChartStyle {
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
    xAxisTilt: "none",
  };
}

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

/** Returns the labels shown in the "rename" UI: per-slice labels for a
 * pie-like chart, or per-trace (legend) names for a multi-series chart.
 * Returns an empty list for a single-series cartesian chart, where there
 * is nothing meaningful to rename beyond the axis labels/title. */
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

function colorsForStyle(style: ChartStyle, count: number): string[] | null {
  if (style.paletteId === "original") return null;
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

/** Applies the given style on top of the AI-generated Plotly spec, without
 * mutating the original. Safe to call repeatedly (e.g. on every render) -
 * always starts fresh from the raw spec so switching palettes or resetting
 * never compounds. */
export function applyChartStyle(rawSpec: any, style: ChartStyle): any {
  if (!rawSpec) return rawSpec;
  const spec = JSON.parse(JSON.stringify(rawSpec));
  const data: any[] = Array.isArray(spec.data) ? spec.data : [];
  const layout = spec.layout || (spec.layout = {});

  const pieLike = isPieLikeSpec(data);
  const singleCategorical = isSingleCategoricalSpec(data);
  const hasHeatmap = data.some((t) => t.type === "heatmap");

  // ---- Colors ----
  if (!hasHeatmap) {
    if (pieLike) {
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
  }

  // ---- Series / category names ----
  if (pieLike && style.seriesNames.length) {
    data[0].labels = (data[0].labels || []).map((l: any, i: number) => style.seriesNames[i] || l);
  } else if (!pieLike && data.length > 1 && style.seriesNames.length) {
    data.forEach((t, i) => {
      if (style.seriesNames[i]) t.name = style.seriesNames[i];
    });
  }

  // ---- Title ----
  if (style.title) layout.title = { text: style.title };

  // ---- Axes (grid, labels, tilt) ----
  if (!pieLike) {
    layout.xaxis = { ...(layout.xaxis || {}) };
    layout.yaxis = { ...(layout.yaxis || {}) };
    if (style.xAxisLabel) layout.xaxis.title = { text: style.xAxisLabel };
    if (style.yAxisLabel) layout.yaxis.title = { text: style.yAxisLabel };
    layout.xaxis.showgrid = style.showGrid;
    layout.yaxis.showgrid = style.showGrid;
    layout.xaxis.tickangle = TILT_ANGLES[style.xAxisTilt];
  }

  // ---- Legend ----
  layout.showlegend = style.showLegend;

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
