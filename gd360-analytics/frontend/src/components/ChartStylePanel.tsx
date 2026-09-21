import { useEffect, useMemo, useState } from "react";
import {
  ChartStyle,
  FontSize,
  PALETTES,
  DEFAULT_ACCENT_COLOR,
  hasCartesianAxes,
  isHeatmapSpec,
  seriesLabels,
  colorableLabels,
  detectChartType,
} from "../lib/chartStyle";

// How many custom-color swatches show at once - past this, the picker pages
// through them instead of cramming an ever-growing grid onto the screen (see
// the pagination controls below the swatch grid).
const COLORS_PER_PAGE = 12;

// A scatter plot's automatic regression trend line and its shaded confidence
// band (chart_builder.py's _add_trend_overlay) - the fallback color shown in
// the "Trend line color" swatch before anyone picks their own, matching
// chart_builder.py's own TREND_COLOR default exactly so the swatch never
// starts out looking wrong.
const DEFAULT_TREND_COLOR = "#E24C4C";

// Normalizes anything a person might type into a hex color box - with or
// without a leading "#", 3-digit shorthand (e.g. "0BF" -> "#00BBFF") or the
// full 6-digit form - into a canonical "#RRGGBB" string Plotly and the
// native <input type="color"> both understand. Returns null for anything
// that isn't a valid hex color, so a bad keystroke never corrupts a saved
// style.
function normalizeHex(value: string): string | null {
  let s = value.trim();
  if (!s) return null;
  if (!s.startsWith("#")) s = `#${s}`;
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const [r, g, b] = s.slice(1).split("");
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return null;
}

// A small text box that sits next to every color swatch in this panel, so a
// person with a specific brand hex code (from a style guide, a design tool,
// anywhere) can type or paste it directly instead of hunting for the same
// shade in the browser's own color picker. Only commits a change once the
// typed text is a genuinely valid hex color (on blur or Enter) - an
// in-progress, invalid keystroke never touches the chart, and an invalid
// value left in the box snaps back to the last real color rather than
// silently accepting nonsense.
function HexInput({
  value, onChange, disabled, className,
}: {
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    const normalized = normalizeHex(draft);
    if (normalized) {
      setDraft(normalized);
      if (normalized !== value) onChange(normalized);
    } else {
      setDraft(value);
    }
  };

  return (
    <input
      type="text"
      inputMode="text"
      className={className}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder="#RRGGBB"
      maxLength={7}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      aria-label="Hex color code"
    />
  );
}

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
      { id: "faceted_bar", label: "Faceted bar (small multiples)" },
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
  const [colorPage, setColorPage] = useState(0);

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

  // Every distinct bar/slice/series this chart actually has, by its real
  // name - not just the ones seriesLabels considers "renameable" (see
  // colorableLabels' own note). This is what the custom-color picker below
  // sizes and labels itself off, which is the fix for the old bug where a
  // 10-bar chart's picker only ever showed 6 swatches: it used to size
  // itself off `names` above, which returns nothing at all for a
  // single-categorical bar chart.
  const colorLabels = useMemo(() => colorableLabels(chartSpec), [chartSpec]);
  // Exactly as many swatches as this chart actually has colorable things -
  // 2 bars gets 2 swatches, 10 unique bars gets 10, never a padded-out
  // fixed count of 6 generic "Bar N" placeholders that don't correspond to
  // anything real on the chart.
  const colorCount = Math.max(colorLabels.length, 1);
  const totalColorPages = Math.max(1, Math.ceil(colorCount / COLORS_PER_PAGE));
  const colorPageClamped = Math.min(colorPage, totalColorPages - 1);

  // A brand-new chart (or a chart-type switch) resets back to page 1 of its
  // color picker, so a person never lands on a now-empty page 3 left over
  // from a previous, much larger chart.
  useEffect(() => {
    setColorPage(0);
  }, [chartSpec]);

  // Does this chart have a scatter regression trend line (chart_builder.py's
  // _add_trend_overlay)? If so, the Style panel offers a swatch to recolor
  // it for branding purposes - see accentColors on ChartStyle.
  const hasTrendLine = useMemo(() => {
    const data = Array.isArray(chartSpec?.data) ? chartSpec.data : [];
    return data.some((t: any) => t?.meta?.role === "trend_line");
  }, [chartSpec]);

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

  const setAccentColor = (role: string, value: string) => {
    onStyleChange({ accentColors: { ...(style.accentColors || {}), [role]: value } });
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
              A few of these (sankey, candlestick, gauge, choropleth, faceted bar, 3D scatter and similar) only
              work when the underlying data has the right shape for them - GD360 will say so and try again if
              it does not fit.
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
              style.paletteId === "single" ? "border-primary bg-primary/10" : "border-border bg-surface2"
            }`}
            onClick={() => onStyleChange({ paletteId: "single" })}
          >
            <span
              className="w-4 h-4 rounded-full border border-border"
              style={{ background: style.singleColor || DEFAULT_ACCENT_COLOR }}
            />
            Single color, one shade for all
          </button>
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

        {style.paletteId === "single" && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-3">
              <input
                type="color"
                disabled={disabled}
                value={style.singleColor || DEFAULT_ACCENT_COLOR}
                onChange={(e) => onStyleChange({ paletteId: "single", singleColor: e.target.value })}
                className="w-10 h-10 rounded-lg border border-border bg-transparent cursor-pointer p-0"
              />
              <HexInput
                value={style.singleColor || DEFAULT_ACCENT_COLOR}
                disabled={disabled}
                onChange={(hex) => onStyleChange({ paletteId: "single", singleColor: hex })}
                className="input text-sm py-1.5 px-2 w-28 font-mono uppercase"
              />
            </div>
            <span className="text-[11px] text-muted leading-relaxed block">
              Every bar, slice or line on this chart uses this one color - good for a branded look
              instead of a multi-color palette. Pick with the swatch, or type a hex code like
              #4A3AA7.
            </span>
          </div>
        )}

        {style.paletteId === "custom" && (
          <div className="mt-3 space-y-2">
            <div className="grid grid-cols-3 gap-2">
              {Array.from({
                length: Math.min(COLORS_PER_PAGE, colorCount - colorPageClamped * COLORS_PER_PAGE),
              }).map((_, k) => {
                const i = colorPageClamped * COLORS_PER_PAGE + k;
                const label = colorLabels[i] || `Bar ${i + 1}`;
                const swatchValue = style.customColors[i] || PALETTES[0].colors[i % PALETTES[0].colors.length];
                return (
                  <div key={i} className="flex flex-col items-center gap-1 min-w-0">
                    <input
                      type="color"
                      disabled={disabled}
                      value={swatchValue}
                      onChange={(e) => setCustomColor(i, e.target.value)}
                      className="w-8 h-8 rounded-md border border-border bg-transparent cursor-pointer p-0"
                    />
                    <span className="text-[9px] text-muted text-center truncate w-full" title={label}>
                      {label}
                    </span>
                    <HexInput
                      value={swatchValue}
                      disabled={disabled}
                      onChange={(hex) => setCustomColor(i, hex)}
                      className="input text-[10px] py-0.5 px-1 w-full text-center font-mono"
                    />
                  </div>
                );
              })}
            </div>

            {totalColorPages > 1 && (
              <>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={disabled || colorPageClamped === 0}
                    className="text-xs btn-secondary px-2 py-1 disabled:opacity-40"
                    onClick={() => setColorPage((p) => Math.max(0, p - 1))}
                  >
                    ‹ Prev
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={totalColorPages - 1}
                    step={1}
                    value={colorPageClamped}
                    disabled={disabled}
                    onChange={(e) => setColorPage(Number(e.target.value))}
                    className="flex-1 accent-primary"
                    aria-label="Color swatch page"
                  />
                  <button
                    type="button"
                    disabled={disabled || colorPageClamped === totalColorPages - 1}
                    className="text-xs btn-secondary px-2 py-1 disabled:opacity-40"
                    onClick={() => setColorPage((p) => Math.min(totalColorPages - 1, p + 1))}
                  >
                    Next ›
                  </button>
                </div>
                <div className="text-[10px] text-muted text-center">
                  Colors {colorPageClamped * COLORS_PER_PAGE + 1}-
                  {Math.min(colorCount, (colorPageClamped + 1) * COLORS_PER_PAGE)} of {colorCount} · page{" "}
                  {colorPageClamped + 1} of {totalColorPages}
                </div>
              </>
            )}
          </div>
        )}

        {hasTrendLine && (
          <div className="mt-3 flex items-center justify-between">
            <span className="text-sm">Trend line color</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                disabled={disabled}
                value={style.accentColors?.trend_line || DEFAULT_TREND_COLOR}
                onChange={(e) => setAccentColor("trend_line", e.target.value)}
                className="w-8 h-8 rounded-md border border-border bg-transparent cursor-pointer p-0"
              />
              <HexInput
                value={style.accentColors?.trend_line || DEFAULT_TREND_COLOR}
                disabled={disabled}
                onChange={(hex) => setAccentColor("trend_line", hex)}
                className="input text-xs py-1 px-2 w-24 font-mono"
              />
            </div>
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
          {style.showLegend && (
            <p className="text-[11px] text-muted leading-relaxed -mt-1">
              The legend docks to the right of the chart, sized to fit your labels - it never covers
              the title or the bars, even while resizing.
            </p>
          )}
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
