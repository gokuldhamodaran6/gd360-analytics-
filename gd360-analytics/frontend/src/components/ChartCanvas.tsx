import { useRef, useState } from "react";
import Plot, { Plotly } from "../lib/plotly";
import { useTheme } from "../api/ThemeContext";
import { suggestedChartMinHeight } from "../lib/chartStyle";

const EXPORT_FORMATS: { value: "png" | "jpeg" | "svg" | "webp"; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPG" },
  { value: "svg", label: "SVG" },
  { value: "webp", label: "WEBP" },
];

// 2026-09-25b (elite pass): a plain "..." glyph for the dashPremium chart
// card's collapsed export menu (see the header below) - kept as its own
// tiny component the same way every other icon in this app is, rather than
// inlining the three <circle>s at the call site.
function KebabIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="12" cy="19" r="1.9" />
    </svg>
  );
}

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

export default function ChartCanvas({
  chartSpec,
  title,
  dashPremium,
}: {
  chartSpec: any;
  title?: string;
  // 2026-09-25 (naming fix + premium light theme foundation round): when
  // true, renders on the new `.dash-card` treatment (index.css) instead of
  // the plain `.card` every other chart in the app still uses - passed
  // only by DashboardBlocks.tsx's BlockChart, so this is a no-op for the
  // live Workspace chat chart and the old v1 DashboardView, both of which
  // never pass it.
  dashPremium?: boolean;
}) {
  const graphDivRef = useRef<any>(null);
  const [downloading, setDownloading] = useState("");
  // 2026-09-25b (elite pass): only ever read for a dashPremium chart - see
  // the header below. A plain Workspace/legacy chart keeps its permanent
  // "Export chart as" row exactly as it always has, so this stays unused
  // (and harmless) there.
  const [menuOpen, setMenuOpen] = useState(false);
  const { theme } = useTheme();
  const cardClass = dashPremium ? "dash-card" : "card";

  if (!chartSpec) {
    return (
      <div className={`${cardClass} h-full flex flex-col items-center justify-center text-center p-10 gap-3`}>
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
    setMenuOpen(false);
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

  // Every axis key present on the spec - just "xaxis"/"yaxis" for almost
  // every chart, but a faceted/small-multiples grid (chart_builder.py's
  // build_figure "faceted_bar" branch, via Plotly's make_subplots) carries
  // a whole family of them: xaxis/yaxis for panel 1, xaxis2/yaxis2 for
  // panel 2, xaxis3/yaxis3 for panel 3, and so on. Theming is built by
  // looping over every one actually on the spec, rather than three
  // hardcoded keys, so EVERY panel of a facet grid gets the same dark/
  // light-aware grid, axis-line and tick colors as a plain chart's single
  // axis pair - not just the first one. This is a pure generalization of
  // the previous fixed xaxis/yaxis/yaxis2 handling: for every chart that
  // only ever had those three keys, the result is identical to before.
  const axisKeyPattern = /^(x|y)axis(\d*)$/;
  const isDualAxisCombo =
    chartSpec.layout?.yaxis2 && (chartSpec.data || []).some((t: any) => t?.yaxis === "y2");
  const themedAxes: Record<string, any> = {};
  Object.keys(chartSpec.layout || {}).forEach((key) => {
    if (!axisKeyPattern.test(key)) return;
    const existing = chartSpec.layout[key] || {};
    themedAxes[key] = {
      ...existing,
      // A dual-axis combo chart's right-hand axis (see chartStyle.ts's
      // isDualAxisComboSpec) is always kept grid-free (chart_builder.py
      // already sets showgrid:false there too) - two overlapping axes each
      // drawing their own gridlines is exactly the visual clutter a second
      // axis is meant to avoid. This only ever applies to that one real
      // "yaxis2" case, never to a facet grid's own second panel, which
      // just happens to share that same key name.
      ...(key === "yaxis2" && isDualAxisCombo ? { showgrid: false } : {}),
      gridcolor: c.grid,
      zerolinecolor: c.axisLine,
      linecolor: c.axisLine,
      tickfont: { ...(existing.tickfont || {}), color: c.muted },
      title: existing.title
        ? { ...existing.title, font: { ...(existing.title.font || {}), color: c.muted } }
        : undefined,
    };
  });
  // A bare figure with no explicit layout.xaxis/yaxis of its own (rare, but
  // not impossible) still gets a themed pair, same guarantee the old fixed
  // xaxis/yaxis keys always gave.
  if (!themedAxes.xaxis) {
    themedAxes.xaxis = { gridcolor: c.grid, zerolinecolor: c.axisLine, linecolor: c.axisLine, tickfont: { color: c.muted } };
  }
  if (!themedAxes.yaxis) {
    themedAxes.yaxis = { gridcolor: c.grid, zerolinecolor: c.axisLine, linecolor: c.axisLine, tickfont: { color: c.muted } };
  }

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
    ...themedAxes,
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
    <div className={`${cardClass} p-4 h-full flex flex-col overflow-hidden transition-shadow hover:shadow-glow`}>
      {dashPremium ? (
        // 2026-09-25b (elite pass): a dashboard chart card no longer has a
        // permanent "Export chart as" label + 4-button row sitting above
        // every single chart (the concrete "unwanted header options"
        // clutter a side-by-side against a competitor dashboard called
        // out) - the same 4 formats are one click behind a small "..."
        // menu instead, same downloadImage() call underneath.
        <div className="flex items-center justify-end mb-1 shrink-0 relative">
          <button
            type="button"
            className="dash-chart-menu-btn"
            aria-label="Chart options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <KebabIcon />
          </button>
          {menuOpen && (
            <div role="menu" className="absolute right-0 top-full mt-1 w-36 card bg-surface shadow-2xl border border-border p-1.5 z-20">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted px-2 py-1">Export as</div>
              {EXPORT_FORMATS.map((f) => (
                <button
                  key={f.value}
                  role="menuitem"
                  disabled={!!downloading}
                  className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors disabled:opacity-50 flex items-center justify-between"
                  onClick={() => download(f.value)}
                >
                  <span>{f.label}</span>
                  {downloading === f.value && <span className="text-[10px] text-muted">…</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
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
      )}
      <div className="flex-1 min-h-0 rounded-xl overflow-hidden">
        <Plot
          data={chartSpec.data}
          layout={{ ...themedLayout, autosize: true, title: resolvedTitle }}
          // A many-entry legend needs real vertical room to grow downward
          // from the title without ever reaching the x-axis labels below it
          // - see chartStyle.ts's suggestedChartMinHeight. A plain chart
          // with no legend (or a short one) still gets the same 380px floor
          // this always used, so nothing changes for the common case.
          style={{ width: "100%", height: "100%", minHeight: suggestedChartMinHeight(chartSpec) }}
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
