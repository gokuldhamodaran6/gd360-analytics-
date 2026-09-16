import { ChartStyle, PALETTES, hasCartesianAxes, seriesLabels, detectChartType } from "../lib/chartStyle";

const CHART_TYPES = [
  "bar", "line", "area", "pie", "scatter", "histogram", "box", "heatmap", "waterfall", "funnel", "treemap",
];

const TILT_OPTIONS: { value: ChartStyle["xAxisTilt"]; label: string }[] = [
  { value: "none", label: "None" },
  { value: "slight", label: "Slight" },
  { value: "diagonal", label: "Diagonal" },
  { value: "vertical", label: "Vertical" },
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

  return (
    <div className="card p-4 space-y-5 overflow-y-auto">
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
          {CHART_TYPES.map((t) => (
            <button
              key={t}
              disabled={disabled}
              className={`text-xs px-2 py-1.5 rounded-lg capitalize transition ${
                activeType === t ? "bg-primary text-white" : "btn-secondary"
              }`}
              onClick={() => onChartTypeChange(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* ---- Color palette ---- */}
      <div>
        <div className="text-xs font-semibold tracking-wide text-muted mb-2">COLOR PALETTE</div>
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
