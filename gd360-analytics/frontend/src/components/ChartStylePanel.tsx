import { useMemo, useState } from "react";
import { ChartStyle, FontSize, PALETTES, hasCartesianAxes, isHeatmapSpec, seriesLabels, detectChartType } from "../lib/chartStyle";

type ChartTypeDef = { id: string; label: string };

// The handful of chart types shown up front - the ones almost every prompt
// ends up using. Everything else lives behind "More chart types" below, so
// the panel stays quick to scan without leaving any analyst chart out.
const MAIN_CHART_TYPES: ChartTypeDef[] = [
  { id: "bar", label: "Bar" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "pie", label: "Pie" },
  { id: "scatter", label: "Scatter" },
  { id: "histogram", label: "Histogram" },
  { id: "box", label: "Box plot" },
  { id: "heatmap", label: "Heatmap" },
];

// The full catalog a working data analyst reaches for, grouped the way a
// chart-picker in a proper BI tool would group them. Searchable below.
const CHART_CATALOG: { category: string; types: ChartTypeDef[] }[] = [
  {
    category: "Comparison",
    types: [
      { id: "bar", label: "Bar" },
      { id: "horizontal_bar", label: "Horizontal bar" },
      { id: "grouped_bar", label: "Grouped bar" },
      { id: "stacked_bar", label: "Stacked bar" },
      { id: "radar", label: "Radar" },
      { id: "polar_bar", label: "Polar bar" },
    ],
  },
  {
    category: "Trend over time",
    types: [
      { id: "line", label: "Line" },
      { id: "area", label: "Area" },
      { id: "stacked_area", label: "Stacked area" },
      { id: "step_line", label: "Step line" },
      { id: "candlestick", label: "Candlestick" },
      { id: "ohlc", label: "OHLC" },
    ],
  },
  {
    category: "Distribution",
    types: [
      { id: "histogram", label: "Histogram" },
      { id: "box", label: "Box plot" },
      { id: "violin", label: "Violin" },
      { id: "dot_plot", label: "Dot plot" },
      { id: "density_heatmap", label: "Density heatmap" },
    ],
  },
  {
    category: "Relationship",
    types: [
      { id: "scatter", label: "Scatter" },
      { id: "bubble", label: "Bubble" },
      { id: "heatmap", label: "Heatmap" },
      { id: "contour", label: "Contour" },
      { id: "scatter_3d", label: "3D scatter" },
      { id: "error_bar", label: "Error bar" },
    ],
  },
  {
    category: "Part-to-whole",
    types: [
      { id: "pie", label: "Pie" },
      { id: "donut", label: "Donut" },
      { id: "treemap", label: "Treemap" },
      { id: "sunburst", label: "Sunburst" },
      { id: "icicle", label: "Icicle" },
      { id: "funnel_area", label: "Funnel area" },
    ],
  },
  {
    category: "Flow & process",
    types: [
      { id: "funnel", label: "Funnel" },
      { id: "waterfall", label: "Waterfall" },
      { id: "sankey", label: "Sankey" },
    ],
  },
  {
    category: "Specialized",
    types: [
      { id: "gauge", label: "Gauge" },
      { id: "parallel_coordinates", label: "Parallel coordinates" },
      { id: "choropleth", label: "Choropleth map" },
    ],
  },
];

const TOTAL_CHART_COUNT = new Set(CHART_CATALOG.flatMap((g) => g.types.map((t) => t.id))).size;

const TILT_OPTIONS: { value: ChartStyle["xAxisTilt"]; label: string }[] = [
  { value: "none", label: "None" },
  { value: "slight", label: "Slight" },
  { value: "diagonal", label: "Diagonal" },
  { value: "vertical", label: "Vertical" },
];

const FONT_SIZE_OPTIONS: { value: FontSize; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

export default function ChartStylePanel({
  chartSpec, style, onStyleChange, onChartTypeChange, onReset, disabled,
}: {
  chartSpec: any;
  style: ChartStyle;
  onStyleChange: (next: Partial<ChartStyle>) => void;
  onChartTypeChange: (type: string) => void;
  onReset: () => void;
  disabled?: boolean;
}) {
  const [showAllCharts, setShowAllCharts] = useState(false);
  const [chartSearch, setChartSearch] = useState("");

  const filteredCatalog = useMemo(() => {
    const q = chartSearch.trim().toLowerCase();
    if (!q) return CHART_CATALOG;
    return CHART_CATALOG.map((group) => ({
      category: group.category,
      types: group.types.filter((t) => t.label.toLowerCase().includes(q) || group.category.toLowerCase().includes(q)),
    })).filter((group) => group.types.length > 0);
  }, [chartSearch]);

  if (!chartSpec) {
    return (
      <div className="card p-6 text-sm text-muted text-center">
        Ask GD360 for a chart first, then come back here to style it: colors, titles, labels and more.
      </div>
    );
  }

  const activeType = detectChartType(chartSpec);
  const names = seriesLabels(chartSpec);
  const showAxes = hasCartesianAxes(chartSpec);
  const isHeatmap = isHeatmapSpec(chartSpec);
  const cappedNames = names.slice(0, 20);
  const customCount = Math.max(cappedNames.length || 6, 6);

  const setSeriesName = (i: number, value: string) => {
    const next = [...style.seriesNames];
    next[i] = value;
    onStyleChange({ seriesNames: next });
  };

  const setCustomColor = (i: number, value: string) => {
    const base = style.customColors.length ? [...style.customColors] : PALETTES[0].colors.slice();
    while (base.length <= i) base.push(PALETTES[0].colors[base.length % PALETTES[0].colors.length]);
    base[i] = value;
    onStyleChange({ paletteId: "custom", customColors: base });
  };

  const pickType = (id: string) => {
    onChartTypeChange(id);
  };

  return (
    <div className="card p-4 space-y-5">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">Chart style</div>
        <button className="text-xs text-primary hover:underline" onClick={onReset} disabled={disabled}>
          Reset to AI default
        </button>
      </div>

      {/* ---- Chart type ---- */}
      <div>
        <div className="text-xs font-semibold tracking-wide text-muted mb-2">CHART TYPE</div>
        <div className="grid grid-cols-3 gap-1.5">
          {MAIN_CHART_TYPES.map((t) => (
            <button
              key={t.id}
              disabled={disabled}
              className={`text-xs px-2 py-1.5 rounded-lg transition ${
                activeType === t.id ? "bg-primary text-white" : "btn-secondary"
              }`}
              onClick={() => pickType(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="mt-2 w-full text-xs text-muted hover:text-text flex items-center justify-center gap-1 py-1.5 transition"
          onClick={() => setShowAllCharts((s) => !s)}
        >
          {showAllCharts ? "Hide other chart types" : `More chart types (${TOTAL_CHART_COUNT} total)`}
          <span className={`transition-transform ${showAllCharts ? "rotate-180" : ""}`}>▾</span>
        </button>

        {showAllCharts && (
          <div className="mt-2 border border-border rounded-xl p-2.5 bg-surface2/50 space-y-3">
            <input
              className="input text-sm py-1.5"
              placeholder="Search chart types, e.g. sankey, radar, candlestick"
              value={chartSearch}
              disabled={disabled}
              onChange={(e) => setChartSearch(e.target.value)}
              autoFocus
            />
            <div className="max-h-64 overflow-y-auto space-y-3 pr-1">
              {filteredCatalog.length === 0 && (
                <p className="text-xs text-muted text-center py-3">No chart type matches "{chartSearch}".</p>
              )}
              {filteredCatalog.map((group) => (
                <div key={group.category}>
                  <div className="text-[10px] font-semibold tracking-wide text-muted mb-1.5 uppercase">{group.category}</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {group.types.map((t) => (
                      <button
                        key={`${group.category}-${t.id}`}
                        disabled={disabled}
                        className={`text-xs px-2 py-1.5 rounded-lg transition ${
                          activeType === t.id ? "bg-primary text-white" : "btn-secondary"
                        }`}
                        onClick={() => pickType(t.id)}
                        title={t.label}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted leading-relaxed">
              A few of these (sankey, candlestick, gauge, choropleth, 3D scatter and similar) only work when the
              underlying data has the right shape for them - GD360 will say so and try again if it does not fit.
            </p>
          </div>
        )}
      </div>

      {/* ---- Color palette ---- */}
      <div>
        <div className="text-xs font-semibold tracking-wide text-muted mb-2">COLOR PALETTE</div>
        {isHeatmap && (
          <p className="text-[11px] text-muted mb-2 leading-relaxed">
            This is a heatmap, so a palette here blends into a smooth gradient instead of separate colors.
          </p>
        )}
        <div className="space-y-1.5">
          <button
            disabled={disabled}
            className={`w-full flex items-center gap-2 text-sm rounded-lg px-3 py-2 border transition ${
              style.paletteId === "original" ? "border-primary bg-primary/10" : "border-border bg-surface2"
            }`}
            onClick={() => onStyleChange({ paletteId: "original" })}
          >
            <span className="w-4 h-4 rounded-full border border-border bg-gradient-to-br from-primary to-accent" />
            Original, AI picked
          </button>
          {PALETTES.map((p) => (
            <button
              key={p.id}
              disabled={disabled}
              className={`w-full flex items-center gap-2 text-sm rounded-lg px-3 py-2 border transition ${
                style.paletteId === p.id ? "border-primary bg-primary/10" : "border-border bg-surface2"
              }`}
              onClick={() => onStyleChange({ paletteId: p.id })}
            >
              <span className="flex -space-x-0.5">
                {p.colors.map((c, i) => (
                  <span key={i} className="w-3 h-3 rounded-full border border-border" style={{ background: c }} />
                ))}
              </span>
              {p.name}
            </button>
          ))}
          <button
            disabled={disabled}
            className={`w-full flex items-center gap-2 text-sm rounded-lg px-3 py-2 border transition ${
              style.paletteId === "custom" ? "border-primary bg-primary/10" : "border-border bg-surface2"
            }`}
            onClick={() => onStyleChange({ paletteId: "custom" })}
          >
            <span
              className="w-4 h-4 rounded-full border border-border"
              style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}
            />
            Custom colors, pick your own
          </button>
        </div>

        {style.paletteId === "custom" && (
          <div className="mt-3 grid grid-cols-6 gap-2">
            {Array.from({ length: customCount }).map((_, i) => (
              <label key={i} className="flex flex-col items-center gap-1">
                <input
                  type="color"
                  disabled={disabled}
                  value={style.customColors[i] || PALETTES[0].colors[i % PALETTES[0].colors.length]}
                  onChange={(e) => setCustomColor(i, e.target.value)}
                  className="w-7 h-7 rounded-md border border-border bg-transparent cursor-pointer p-0"
                />
                <span className="text-[9px] text-muted">{i + 1}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* ---- Labels ---- */}
      <div>
        <div className="text-xs font-semibold tracking-wide text-muted mb-2">LABELS</div>
        <div className="space-y-2">
          <div>
            <label className="text-xs text-muted mb-1 block">Chart title</label>
            <input
              className="input text-sm py-1.5"
              placeholder="Chart title"
              value={style.title}
              disabled={disabled}
              onChange={(e) => onStyleChange({ title: e.target.value })}
            />
          </div>
          {showAxes && (
            <>
              <div>
                <label className="text-xs text-muted mb-1 block">X axis label</label>
                <input
                  className="input text-sm py-1.5"
                  placeholder="X axis label"
                  value={style.xAxisLabel}
                  disabled={disabled}
                  onChange={(e) => onStyleChange({ xAxisLabel: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs text-muted mb-1 block">Y axis label</label>
                <input
                  className="input text-sm py-1.5"
                  placeholder="Y axis label"
                  value={style.yAxisLabel}
                  disabled={disabled}
                  onChange={(e) => onStyleChange({ yAxisLabel: e.target.value })}
                />
              </div>
            </>
          )}
          {cappedNames.length > 0 && (
            <div>
              <label className="text-xs text-muted mb-1 block">
                {names.length === cappedNames.length
                  ? "Series and label names"
                  : `Series and label names, first ${cappedNames.length}`}
              </label>
              <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                {cappedNames.map((n, i) => (
                  <input
                    key={i}
                    className="input text-sm py-1.5"
                    placeholder={n}
                    value={style.seriesNames[i] || ""}
                    disabled={disabled}
                    onChange={(e) => setSeriesName(i, e.target.value)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---- Options ---- */}
      <div>
        <div className="text-xs font-semibold tracking-wide text-muted mb-2">OPTIONS</div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm">Show grid</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={style.showGrid}
                disabled={disabled}
                onChange={(e) => onStyleChange({ showGrid: e.target.checked })}
              />
              <span className="switch-track" />
            </label>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Show legend</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={style.showLegend}
                disabled={disabled}
                onChange={(e) => onStyleChange({ showLegend: e.target.checked })}
              />
              <span className="switch-track" />
            </label>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Data labels</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={style.dataLabels}
                disabled={disabled}
                onChange={(e) => onStyleChange({ dataLabels: e.target.checked })}
              />
              <span className="switch-track" />
            </label>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">Font size</span>
            <div className="flex gap-1">
              {FONT_SIZE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  disabled={disabled}
                  className={`text-xs px-2.5 py-1 rounded-lg transition ${
                    style.fontSize === o.value ? "bg-primary text-white" : "btn-secondary"
                  }`}
                  onClick={() => onStyleChange({ fontSize: o.value })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          {showAxes && (
            <div className="flex items-center justify-between">
              <span className="text-sm">X-axis tilt</span>
              <select
                className="input text-sm py-1.5 w-32"
                value={style.xAxisTilt}
                disabled={disabled}
                onChange={(e) => onStyleChange({ xAxisTilt: e.target.value as ChartStyle["xAxisTilt"] })}
              >
                {TILT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      <p className="text-[11px] text-muted leading-relaxed">
        Style changes apply instantly and are saved with the chart when you click Save chart to dashboard.
      </p>
    </div>
  );
}
