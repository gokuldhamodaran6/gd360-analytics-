import { useRef, useState } from "react";
import Plot, { Plotly } from "../lib/plotly";
import { useTheme } from "../api/ThemeContext";

const EXPORT_FORMATS: { value: "png" | "jpeg" | "svg" | "webp"; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPG" },
  { value: "svg", label: "SVG" },
  { value: "webp", label: "WEBP" },
];

// The only colors that genuinely depend on light vs. dark mode - everything
// else about a chart's premium look (palette, rounded bars, spacing, hover
// content, title style) is decided once in lib/chartStyle.ts, the same for
// both themes. This is deliberately kept separate from that file: it has
// no way to know which theme the viewer is in, and this component is the
// one place both the live Workspace chart and a saved dashboard chart
// (DashboardView) both render through, so a theme fix made here reaches
// every chart in the app at once.
const THEME_CHROME = {
  dark: {
    text: "#E8E8F0",
    muted: "rgba(232, 232, 240, 0.62)",
    grid: "rgba(232, 232, 240, 0.10)",
    axisLine: "rgba(232, 232, 240, 0.18)",
    hoverBg: "#1D1D33",
    hoverBorder: "rgba(232, 232, 240, 0.14)",
  },
  light: {
    text: "#171725",
    muted: "rgba(23, 23, 37, 0.60)",
    grid: "rgba(23, 23, 37, 0.08)",
    axisLine: "rgba(23, 23, 37, 0.16)",
    hoverBg: "#FFFFFF",
    hoverBorder: "rgba(23, 23, 37, 0.12)",
  },
} as const;

export default function ChartCanvas({ chartSpec, title }: { chartSpec: any; title?: string }) {
  const graphDivRef = useRef<any>(null);
  const [downloading, setDownloading] = useState("");
  const { theme } = useTheme();

  if (!chartSpec) {
    return (
      <div className="card h-full flex flex-col items-center justify-center text-center p-10 gap-3">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center text-2xl">
          📊
        </div>
        <div className="font-semibold">No chart yet</div>
        <div className="text-muted text-sm max-w-xs leading-relaxed">
          Ask GD360 something about your data (left panel) and your chart will appear here, interactive
          and ready to export.
        </div>
      </div>
    );
  }

  const download = async (format: "png" | "jpeg" | "svg" | "webp") => {
    if (!graphDivRef.current) return;
    setDownloading(format);
    try {
      const safeName = (title || "chart").replace(/[^a-zA-Z0-9-_]+/g, "_").slice(0, 60) || "chart";
      await (Plotly as any).downloadImage(graphDivRef.current, {
        format,
        filename: safeName,
        width: 1200,
        height: 800,
      });
    } catch {
      // Non-fatal - the chart is still on screen either way.
    } finally {
      setDownloading("");
    }
  };

  // lib/chartStyle.ts already bakes a fully resolved, sized, left-aligned
  // title into chartSpec.layout.title for anything that has passed through
  // it (every chart drawn in the Workspace, and every chart already saved
  // to a dashboard from there). The title prop below only fills in for
  // genuinely legacy saved charts from before that existed, so we never
  // clobber a title that is already there.
  const existingTitleText =
    typeof chartSpec.layout?.title === "string" ? chartSpec.layout.title : chartSpec.layout?.title?.text;
  const resolvedTitle = existingTitleText
    ? chartSpec.layout?.title
    : title
    ? { text: title, x: 0.01, xanchor: "left" as const }
    : undefined;

  const c = THEME_CHROME[theme];

  // Every chart renders on a fully transparent surface so it sits directly
  // on the card - no separate white/gray rectangle behind it in either
  // theme - with hand-set text, grid and hover-card colors layered on top
  // of whatever lib/chartStyle.ts already built, rather than relying on a
  // named Plotly theme (that is what produced the generic look this
  // replaces: default indigo bars, "trace 0" legend, a flat white panel).
  const themedLayout = {
    ...chartSpec.layout,
    template: undefined,
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { ...(chartSpec.layout?.font || {}), color: c.text },
    xaxis: {
      ...(chartSpec.layout?.xaxis || {}),
      gridcolor: c.grid,
      zerolinecolor: c.axisLine,
      linecolor: c.axisLine,
      tickfont: { ...(chartSpec.layout?.xaxis?.tickfont || {}), color: c.muted },
      title: chartSpec.layout?.xaxis?.title
        ? { ...chartSpec.layout.xaxis.title, font: { ...(chartSpec.layout.xaxis.title.font || {}), color: c.muted } }
        : undefined,
    },
    yaxis: {
      ...(chartSpec.layout?.yaxis || {}),
      gridcolor: c.grid,
      zerolinecolor: c.axisLine,
      linecolor: c.axisLine,
      tickfont: { ...(chartSpec.layout?.yaxis?.tickfont || {}), color: c.muted },
      title: chartSpec.layout?.yaxis?.title
        ? { ...chartSpec.layout.yaxis.title, font: { ...(chartSpec.layout.yaxis.title.font || {}), color: c.muted } }
        : undefined,
    },
    // A dual-axis combo chart's right-hand axis (see chartStyle.ts's
    // isDualAxisComboSpec) - only present at all on that one chart shape,
    // so this is a no-op spread of `{}` for every other chart. Always kept
    // grid-free (chart_builder.py already sets showgrid:false there too) -
    // two overlapping axes each drawing their own gridlines is exactly the
    // visual clutter a second axis is meant to avoid.
    ...(chartSpec.layout?.yaxis2
      ? {
          yaxis2: {
            ...chartSpec.layout.yaxis2,
            showgrid: false,
            zerolinecolor: c.axisLine,
            linecolor: c.axisLine,
            tickfont: { ...(chartSpec.layout.yaxis2.tickfont || {}), color: c.muted },
            title: chartSpec.layout.yaxis2.title
              ? { ...chartSpec.layout.yaxis2.title, font: { ...(chartSpec.layout.yaxis2.title.font || {}), color: c.muted } }
              : undefined,
          },
        }
      : {}),
    legend: {
      ...(chartSpec.layout?.legend || {}),
      bgcolor: "rgba(0,0,0,0)",
      bordercolor: "rgba(0,0,0,0)",
      font: { ...(chartSpec.layout?.legend?.font || {}), color: c.muted },
    },
    hoverlabel: {
      bgcolor: c.hoverBg,
      bordercolor: c.hoverBorder,
      font: { color: c.text, size: 12.5 },
    },
  };

  return (
    <div className="card p-4 h-full flex flex-col overflow-hidden transition-shadow hover:shadow-glow">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="text-xs font-semibold tracking-wide text-muted uppercase">Export chart as</div>
        <div className="flex gap-1.5">
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.value}
              disabled={!!downloading}
              className="text-xs btn-secondary px-2.5 py-1 disabled:opacity-50"
              onClick={() => download(f.value)}
            >
              {downloading === f.value ? "..." : f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 rounded-xl overflow-hidden">
        <Plot
          data={chartSpec.data}
          layout={{ ...themedLayout, autosize: true, title: resolvedTitle }}
          style={{ width: "100%", height: "100%", minHeight: 380 }}
          useResizeHandler
          config={{ displaylogo: false, responsive: true }}
          onInitialized={(_figure: any, graphDiv: any) => {
            graphDivRef.current = graphDiv;
          }}
          onUpdate={(_figure: any, graphDiv: any) => {
            graphDivRef.current = graphDiv;
          }}
        />
      </div>
    </div>
  );
}
