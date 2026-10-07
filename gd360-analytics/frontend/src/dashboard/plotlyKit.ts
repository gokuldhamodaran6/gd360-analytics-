// 2026-10-07 (round 9): the ONE restyle every Plotly figure drawn inside a
// dashboard goes through (BlockRenderer hands its result to ChartCanvas
// with `kit`, which then adds nothing of its own).
//
// Most dashboard charts are drawn natively (charts/). What still reaches
// Plotly is what has no rows-by-category form: a scatter, a histogram, a
// box plot, a heatmap, a funnel, a chart carrying a forecast overlay. Those
// figures were built elsewhere - by the backend's chart builder, or by an
// AI answer - with their own fonts, their own palette (one colour per bar
// for a single measure), 7 px value labels and a modebar. Here they are
// brought into the kit so they sit beside a native chart without clashing:
//
//   surface   transparent paper and plot (the card is the surface)
//   type      the kit font, ink-token text, 11-12 px, never shrunk below 10
//   grid      recessive: the subtle-border token, no axis lines, no frame
//   colour    ONE series = the brand colour; several series = the fixed
//             series palette, in order; a pie's slices = the same palette;
//             a heatmap = a single-hue ramp of the brand colour
//   margins   axes size themselves (automargin) so labels stay in the card
//   chrome    no title (the card has one), no modebar
//   notes     a sentence pinned inside the plot is taken out of the figure
//             and printed under it, where it can wrap (figureNotes)
//
// Analysis overlays (meta.role: forecast_line, forecast_band, trend_line,
// trend_band, anomaly_markers) keep their dash / fill and take the colour
// of the series they describe, or the warning tone for flagged points.

export type KitTokens = {
  font: string;
  text: string;
  muted: string;
  faint: string;
  grid: string;
  border: string;
  surface: string;
  primary: string;
  warning: string;
  series: string[];
};

// What the kit's tokens resolve to when there is no stylesheet to read
// (tests, server rendering) - the light theme's values.
export const FALLBACK_TOKENS: KitTokens = {
  font: 'Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  text: "rgb(22, 22, 21)",
  muted: "rgb(111, 111, 106)",
  faint: "rgb(168, 168, 164)",
  grid: "rgb(241, 241, 237)",
  border: "rgb(227, 227, 222)",
  surface: "rgb(255, 255, 255)",
  primary: "rgb(15, 92, 70)",
  warning: "rgb(180, 83, 9)",
  series: ["rgb(57, 135, 229)", "rgb(217, 89, 38)", "rgb(25, 158, 112)", "rgb(201, 133, 0)", "rgb(213, 81, 129)", "rgb(0, 131, 0)"],
};

function triplet(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const raw = style.getPropertyValue(name).trim();
  const m = /^(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})$/.exec(raw);
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : fallback;
}

/** The kit's colour and type tokens as concrete values (Plotly cannot
 *  read a CSS variable). Read at call time, so call it again when the
 *  theme changes. */
export function readKitTokens(root?: Element | null): KitTokens {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function" || typeof document === "undefined") return FALLBACK_TOKENS;
  const el = root || document.documentElement;
  let style: CSSStyleDeclaration;
  try {
    style = getComputedStyle(el);
  } catch {
    return FALLBACK_TOKENS;
  }
  const bodyFont = document.body ? getComputedStyle(document.body).fontFamily : "";
  return {
    font: bodyFont || FALLBACK_TOKENS.font,
    text: triplet(style, "--color-text", FALLBACK_TOKENS.text),
    muted: triplet(style, "--color-muted", FALLBACK_TOKENS.muted),
    faint: triplet(style, "--color-faint", FALLBACK_TOKENS.faint),
    grid: triplet(style, "--color-subtle", FALLBACK_TOKENS.grid),
    border: triplet(style, "--color-border", FALLBACK_TOKENS.border),
    surface: triplet(style, "--color-surface", FALLBACK_TOKENS.surface),
    primary: triplet(style, "--color-primary", FALLBACK_TOKENS.primary),
    warning: triplet(style, "--color-warning", FALLBACK_TOKENS.warning),
    series: [1, 2, 3, 4, 5, 6].map((i) => triplet(style, `--color-series-${i}`, FALLBACK_TOKENS.series[i - 1])),
  };
}

export function withAlpha(color: string, alpha: number): string {
  const m = /^rgb\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*\)$/.exec(color);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
  const h = /^#([0-9a-f]{6})$/i.exec(color);
  if (h) {
    const n = parseInt(h[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return color;
}

const OVERLAY_ROLES = new Set(["forecast_line", "forecast_band", "trend_line", "trend_band", "anomaly_markers"]);
const AXIS_KEY = /^(x|y)axis(\d*)$/;
const SCALE_TYPES = new Set(["heatmap", "histogram2d", "histogram2dcontour", "contour", "densitymapbox", "choropleth"]);
const SLICE_TYPES = new Set(["pie", "sunburst", "treemap", "icicle", "funnelarea"]);
const NO_RECOLOR = new Set(["sankey", "parcoords", "parcats", "indicator", "table", "candlestick", "ohlc", "scatter3d", "surface", "mesh3d"]);

function roleOf(trace: any): string | null {
  const role = trace?.meta?.role;
  return typeof role === "string" ? role : null;
}

function isNumberArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" || x === null);
}

// A sentence the figure's builder pinned inside the plot ("Trend: weak
// positive relationship (r = 0.16, not statistically significant at this
// sample size)"). Plotly cannot wrap it, so on a card narrower than the
// sentence it was cut off at the card's edge and ran through the points.
// The kit takes such notes OUT of the figure; ChartCanvas prints them
// under the plot as ordinary text that wraps.
const NOTE_MIN_CHARS = 40;
function isNote(a: any): boolean {
  return Boolean(a) && typeof a === "object" && a.xref === "paper" && a.yref === "paper" && a.showarrow === false && !a.textangle && typeof a.text === "string" && plainText(a.text).length > NOTE_MIN_CHARS;
}
function plainText(html: string): string {
  return html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** The notes of a figure, as plain sentences (see isNote). */
export function figureNotes(figure: any): string[] {
  const list: any[] = Array.isArray(figure?.layout?.annotations) ? figure.layout.annotations : [];
  return list.filter(isNote).map((a) => plainText(a.text));
}

/** The series (non-overlay) traces of a figure, in order. */
export function seriesTraces(data: any[]): any[] {
  return (data || []).filter((t) => t && typeof t === "object" && !OVERLAY_ROLES.has(roleOf(t) || ""));
}

/** A Plotly figure restyled through the kit's tokens. Pure: the input is
 *  not mutated. `figure` may be null (returned as is). */
export function kitPlotlyFigure(figure: any, tokens: KitTokens = FALLBACK_TOKENS): any {
  if (!figure || typeof figure !== "object") return figure;
  const data: any[] = Array.isArray(figure.data) ? figure.data.map((t: any) => (t && typeof t === "object" ? { ...t } : t)) : [];
  const layoutIn: Record<string, any> = figure.layout && typeof figure.layout === "object" ? figure.layout : {};
  const series = seriesTraces(data);
  const single = series.length <= 1;
  const colorOf = new Map<any, string>();
  series.forEach((t, i) => colorOf.set(t, single ? tokens.primary : tokens.series[i % tokens.series.length]));
  const primaryColor = series.length ? colorOf.get(series[0])! : tokens.primary;

  for (const t of data) {
    if (!t || typeof t !== "object") continue;
    const type: string = t.type || "scatter";
    const role = roleOf(t);
    // Text on or beside a mark: ink, 11 px, and never clipped at the axis.
    if (t.textfont || t.text || t.texttemplate) t.textfont = { ...(t.textfont || {}), family: tokens.font, color: tokens.text, size: 11 };
    if (type === "bar" && (t.textposition === "outside" || t.textposition === "auto")) t.cliponaxis = false;
    t.hoverlabel = { ...(t.hoverlabel || {}), font: { family: tokens.font, color: tokens.text, size: 12 } };

    if (role && OVERLAY_ROLES.has(role)) {
      const base = role === "anomaly_markers" ? tokens.warning : primaryColor;
      if (role.endsWith("_band")) {
        t.fillcolor = withAlpha(base, 0.12);
        t.line = { ...(t.line || {}), color: "rgba(0,0,0,0)", width: 0 };
      } else if (role === "anomaly_markers") {
        t.marker = { ...(t.marker || {}), color: base, line: { color: tokens.surface, width: 1.5 } };
      } else {
        t.line = { ...(t.line || {}), color: base, dash: t.line?.dash || "dash" };
      }
      continue;
    }
    if (NO_RECOLOR.has(type)) continue;
    if (SCALE_TYPES.has(type)) {
      t.colorscale = [[0, withAlpha(tokens.primary, 0.06)], [1, tokens.primary]];
      if (t.colorbar || t.showscale !== false) t.colorbar = { ...(t.colorbar || {}), outlinewidth: 0, thickness: 10, tickfont: { family: tokens.font, color: tokens.muted, size: 11 } };
      continue;
    }
    if (SLICE_TYPES.has(type)) {
      // Part-to-whole: the category IS the identity of each mark.
      const n = Array.isArray(t.labels) ? t.labels.length : Array.isArray(t.values) ? t.values.length : tokens.series.length;
      t.marker = { ...(t.marker || {}), colors: Array.from({ length: n }, (_, i) => tokens.series[i % tokens.series.length]), line: { color: tokens.surface, width: 2 } };
      continue;
    }
    const color = colorOf.get(t) || tokens.primary;
    const marker = { ...(t.marker || {}) };
    // A numeric colour array is a real encoding (a bubble's third value):
    // it keeps its numbers and gets the brand ramp. A list of colour
    // names is one hue per bar for ONE measure - that becomes one colour.
    if (isNumberArray(marker.color)) {
      marker.colorscale = [[0, withAlpha(tokens.primary, 0.15)], [1, tokens.primary]];
    } else {
      marker.color = color;
    }
    if (marker.line) marker.line = { ...marker.line, color: type === "bar" ? "rgba(0,0,0,0)" : tokens.surface };
    if (type === "bar" || type === "histogram" || type === "funnel" || type === "waterfall") marker.line = { ...(marker.line || {}), width: 0 };
    t.marker = marker;
    if (type === "scatter" || type === "scattergl" || type === "scatterpolar") {
      if (t.line || String(t.mode || "").includes("lines")) t.line = { ...(t.line || {}), color };
      if (t.fill && t.fill !== "none") t.fillcolor = withAlpha(color, 0.16);
    }
    if (type === "box" || type === "violin") {
      t.line = { ...(t.line || {}), color };
      t.fillcolor = withAlpha(color, 0.16);
    }
    if (type === "waterfall") {
      t.increasing = { marker: { color: tokens.primary } };
      t.decreasing = { marker: { color: tokens.series[1] } };
      t.totals = { marker: { color: tokens.muted } };
      t.connector = { line: { color: tokens.border, width: 1 } };
    }
  }

  const axisStyle = (existing: any) => {
    const title = existing?.title;
    const titleText = typeof title === "string" ? title : title?.text;
    return {
      ...(existing || {}),
      automargin: true,
      gridcolor: tokens.grid,
      gridwidth: 1,
      zerolinecolor: tokens.border,
      zerolinewidth: 1,
      showline: false,
      linecolor: tokens.border,
      ticks: "",
      tickfont: { ...(existing?.tickfont || {}), family: tokens.font, color: tokens.muted, size: 11 },
      title: titleText ? { ...(typeof title === "object" ? title : {}), text: titleText, standoff: 8, font: { family: tokens.font, color: tokens.muted, size: 11.5 } } : undefined,
    };
  };
  const layout: Record<string, any> = { ...layoutIn };
  let hasAxis = false;
  for (const key of Object.keys(layoutIn)) {
    if (!AXIS_KEY.test(key)) continue;
    hasAxis = true;
    layout[key] = axisStyle(layoutIn[key]);
  }
  const cartesian = data.some((t) => t && !SLICE_TYPES.has(t.type) && !NO_RECOLOR.has(t.type) && !["scatterpolar", "barpolar", "choropleth", "scattergeo"].includes(t.type));
  if (cartesian && !hasAxis) {
    layout.xaxis = axisStyle(undefined);
    layout.yaxis = axisStyle(undefined);
  } else if (cartesian) {
    if (!layout.xaxis) layout.xaxis = axisStyle(undefined);
    if (!layout.yaxis) layout.yaxis = axisStyle(undefined);
  }
  // A category axis shows its gridlines on the value axis only.
  const horizontal = data.some((t) => t?.type === "bar" && t.orientation === "h");
  const categoryAxis = horizontal ? "yaxis" : "xaxis";
  if (layout[categoryAxis] && data.some((t) => t?.type === "bar" || t?.type === "box" || t?.type === "violin")) layout[categoryAxis] = { ...layout[categoryAxis], showgrid: false };
  if (layout.polar) {
    layout.polar = {
      ...layout.polar,
      bgcolor: "rgba(0,0,0,0)",
      radialaxis: { ...(layout.polar.radialaxis || {}), gridcolor: tokens.grid, linecolor: tokens.border, tickfont: { family: tokens.font, color: tokens.muted, size: 11 } },
      angularaxis: { ...(layout.polar.angularaxis || {}), gridcolor: tokens.grid, linecolor: tokens.border, tickfont: { family: tokens.font, color: tokens.muted, size: 11 } },
    };
  }

  const legendShown = layoutIn.showlegend !== false && (series.length > 1 || data.some((t) => t && SLICE_TYPES.has(t.type)));
  Object.assign(layout, {
    template: undefined,
    title: { text: "" },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: tokens.font, color: tokens.text, size: 12 },
    colorway: tokens.series,
    // Labels the figure cannot fit at 10 px are hidden, never shrunk.
    uniformtext: { minsize: 10, mode: "hide" },
    margin: { t: legendShown ? 28 : 8, r: 12, b: 8, l: 8, pad: 2 },
    showlegend: legendShown,
    legend: {
      ...(layoutIn.legend || {}),
      orientation: "h",
      x: 0,
      xanchor: "left",
      y: 1.02,
      yanchor: "bottom",
      bgcolor: "rgba(0,0,0,0)",
      borderwidth: 0,
      font: { family: tokens.font, color: tokens.muted, size: 11.5 },
      title: undefined,
    },
    hoverlabel: { bgcolor: tokens.surface, bordercolor: tokens.border, font: { family: tokens.font, color: tokens.text, size: 12 } },
    bargap: typeof layoutIn.bargap === "number" ? layoutIn.bargap : 0.32,
    modebar: { remove: ["all"] },
  });
  if (Array.isArray(layoutIn.annotations)) {
    layout.annotations = layoutIn.annotations.filter((a: any) => !isNote(a)).map((a: any) => (a && typeof a === "object" ? { ...a, font: { ...(a.font || {}), family: tokens.font, color: tokens.muted, size: Math.max(10, Math.min(12, a.font?.size || 11)) } } : a));
  }
  return { ...figure, data, layout };
}
