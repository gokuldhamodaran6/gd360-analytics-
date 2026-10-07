import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChartCanvas, { type ChartExportApi } from "./ChartCanvas";
import { CartesianChart } from "../dashboard/charts/CartesianChart";
import { DonutChart } from "../dashboard/charts/DonutChart";
import { SpecialChart } from "../dashboard/charts/SpecialChart";
import { dashboardBuilderApi, type BlockForecast } from "../api/client";
import { useChartTheme } from "../dashboard/theme/ChartThemeContext";
import { downloadSvg } from "../dashboard/charts/exportSvg";
import { downloadText, rowsToCsv, safeFilename } from "../dashboard/blockData";
import { columnFormat, formatValue, humanize, PLAIN_FORMAT } from "../dashboard/format";
import { KpiTile, TableFooter, TableFrame, type DataTableColumn } from "../ui";
import { classifyColumns } from "../lib/chartModel";
import type { ChartStyle } from "../lib/chartStyle";
import type { ExploreConfig, ResultColumn } from "../lib/exploreEngine";
import { useExclusiveOpen } from "../lib/useExclusiveOpen";
import { describePath, FORECAST_MAX_SERIES, forecastRequest, resolveWorkspaceChart, withForecast, type ResolvedWorkspaceChart } from "../lib/workspaceChart";

// 2026-10-07 (chart-integrity round): the chart of ONE chat answer - on the
// workspace's Chart tab, on each card of a multi-result answer, and as the
// small preview in "Save chart" / "Add to dashboard".
//
// What is drawn is decided by lib/workspaceChart.resolveWorkspaceChart (see
// its module comment): the answer's ROWS decide, the app's own SVG renderer
// (src/dashboard/charts) draws every chart the chart model can express,
// Plotly draws only what it cannot (a scatter with its regression, a
// histogram, a heatmap ... or a standard chart with a Style option only
// Plotly honours), and rows that cannot be drawn honestly are shown as
// their table with the sentence that says why.
//
// 2026-10-07 (identity-colour round): the colours are the chart theme's
// (useChartTheme) - in the chat workspace that is the workspace brand
// kit's palette with this data source's own colour memory, so "City
// Hotel" is the same colour in every answer about it. A palette the
// person picks in the Style panel still wins for that one chart.
//
// 2026-10-07 (chart-types round): a scatter / heatmap / treemap / funnel /
// waterfall / map answer whose rows have that form's shape is drawn by the
// dashboard's own renderer for it (SpecialChart). And a native line / bar
// over time has "Add forecast" on its card: the series already on the page
// is forecast by the server's forecaster (nothing is queried) and drawn by
// the same code as a dashboard block's - dashed line, 80% / 95% bands, the
// method and backtest error in the caption; a series that cannot be
// forecast says why instead.
//
// There is no Plotly modebar on either path: export lives in the one "..."
// menu at the card's top right (PNG / JPG / SVG / WEBP for a chart, CSV for
// a table), for the native renderer and for Plotly alike.

const EXPORT_FORMATS: { value: "png" | "jpeg" | "svg" | "webp"; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPG" },
  { value: "svg", label: "SVG" },
  { value: "webp", label: "WEBP" },
];

const TABLE_PAGE = 50;

function KebabIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="12" cy="19" r="1.9" />
    </svg>
  );
}

export type WorkspaceChartProps = {
  columns?: ResultColumn[] | null;
  rows?: Record<string, any>[] | null;
  truncated?: boolean;
  chartType?: string | null;
  // The stored / backend Plotly figure (drawn only when there are no rows,
  // or the chart type is one the chart model does not describe).
  chartSpec?: any;
  explore?: ExploreConfig | null;
  // Only the Style options the person has set (see lib/workspaceChart).
  styleOverrides?: Partial<ChartStyle> | null;
  title?: string | null;
  // The message id: colour memory, the audit log line, export file name.
  id?: string | null;
  // "full": the Chart tab's card, with the "..." export menu.
  // "bare": only the drawing (a result card in the chat, a menu preview).
  variant?: "full" | "bare";
  // Reports the height the drawing needs (the Chart tab sizes its slot).
  onMinHeight?: (px: number) => void;
  // A resolved chart computed by the caller (the Chart tab resolves once
  // and shares it with "Save chart" / "Add to dashboard").
  resolved?: ResolvedWorkspaceChart;
  minHeight?: number;
};

function ResultRowsTable({ columns, rows, reason, title, truncated, dense = false }: { columns: ResultColumn[]; rows: Record<string, any>[]; reason: string | null; title?: string | null; truncated?: boolean; dense?: boolean }) {
  const [shown, setShown] = useState(TABLE_PAGE);
  useEffect(() => setShown(TABLE_PAGE), [rows]);
  const tableColumns = useMemo<DataTableColumn<Record<string, any>>[]>(() => {
    const roles = classifyColumns(columns, rows);
    return columns.map((c, i) => {
      const values = rows.map((r) => r[c.name]);
      const isMeasure = roles[i]?.role === "measure";
      const numeric = values.some((v) => typeof v === "number");
      const fmt = isMeasure ? columnFormat(PLAIN_FORMAT, values) : null;
      const header = humanize(c.name);
      return {
        key: c.name,
        header: <span title={header === c.name ? undefined : c.name}>{header}</span>,
        numeric,
        render: (row) => {
          const v = row[c.name];
          if (v === null || v === undefined || v === "") return "";
          if (fmt && typeof v === "number") return formatValue(v, fmt, "full");
          // A number that labels something (a year, an id) is written plainly.
          if (typeof v === "number") return String(v);
          return String(v);
        },
      };
    });
  }, [columns, rows]);
  const visible = rows.slice(0, shown);
  return (
    <div className="flex h-full min-h-0 flex-col" data-chart-as-table="">
      {reason && <div data-table-reason="" className="px-1 pb-2 text-caption text-muted">{reason}</div>}
      <div className="min-h-0 flex-1">
        <TableFrame
          bare
          dense={dense}
          columns={tableColumns}
          rows={visible}
          rowKey={(_r, i) => i}
          ariaLabel={title || "Result rows"}
          maxHeight="100%"
          className="h-full"
          footer={
            <>
              <TableFooter start={rows.length ? 1 : 0} end={Math.min(shown, rows.length)} total={rows.length} pageSize={TABLE_PAGE} onLoadMore={shown < rows.length ? () => setShown((n) => n + TABLE_PAGE) : undefined} />
              {truncated && <div className="px-4 pb-2 text-caption text-muted">Only the first {rows.length.toLocaleString()} rows of this result are kept.</div>}
            </>
          }
        />
      </div>
    </div>
  );
}

// A chat chart's title is the question that was asked, which can run to a
// paragraph. The native chart prints its title on the exported image (and
// reads it out as its accessible name): cut at a word so the image never
// ends mid-letter at its right edge. The full question stays on the page.
function headline(title: string | null | undefined): string | null {
  const t = (title || "").trim();
  if (!t) return null;
  if (t.length <= 84) return t;
  const cut = t.slice(0, 84);
  const at = cut.lastIndexOf(" ");
  return `${(at > 48 ? cut.slice(0, at) : cut).replace(/[\s,;:.\-]+$/, "")}\u2026`;
}

export default function WorkspaceChart({
  columns, rows, truncated, chartType, chartSpec, explore, styleOverrides, title, id, variant = "full", onMinHeight, resolved: given, minHeight,
}: WorkspaceChartProps) {
  const theme = useChartTheme();
  const base = useMemo(
    () => given ?? resolveWorkspaceChart({ columns, rows, truncated, chartType, storedSpec: chartSpec, explore, styleOverrides, title, id, theme }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [given, columns, rows, truncated, chartType, chartSpec, explore, styleOverrides, title, id, theme.key]
  );
  // "Add forecast": per chart on screen (it goes when the rows change).
  const request = useMemo(() => (variant === "full" ? forecastRequest(base) : null), [base, variant]);
  const [forecast, setForecast] = useState<{ status: "idle" | "loading" | "on" | "error"; data: BlockForecast | null; error: string | null }>({ status: "idle", data: null, error: null });
  const forecastKey = `${id || ""}|${base.rows.length}|${base.chartType || ""}|${request ? request.periods[request.periods.length - 1] : ""}`;
  useEffect(() => setForecast({ status: "idle", data: null, error: null }), [forecastKey]);
  const resolved = useMemo(() => (forecast.status === "on" && forecast.data ? withForecast(base, forecast.data) : base), [base, forecast]);
  const toggleForecast = async () => {
    if (!request || forecast.status === "loading") return;
    if (forecast.status === "on") { setForecast({ status: "idle", data: null, error: null }); return; }
    if (request.series.length > FORECAST_MAX_SERIES) {
      setForecast({ status: "error", data: null, error: `Forecasts are drawn for up to ${FORECAST_MAX_SERIES} series on one chart; this one has ${request.series.length}.` });
      return;
    }
    setForecast({ status: "loading", data: null, error: null });
    try {
      const data = await dashboardBuilderApi.forecastSeries({ ...request, interval: "both", anomalies: true });
      setForecast({ status: "on", data, error: null });
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setForecast({ status: "error", data: null, error: typeof detail === "string" && detail.trim() ? detail : "The forecast couldn't be computed." });
    }
  };
  const bodyRef = useRef<HTMLDivElement>(null);
  const exportApi = useRef<ChartExportApi | null>(null);
  // Stable, so the chart below does not re-register its export hook on
  // every render of this component.
  const setExportApi = useCallback((api: ChartExportApi | null) => { exportApi.current = api; }, []);
  const [menuOpen, setMenuOpen, menuSlotId] = useExclusiveOpen();
  const [downloading, setDownloading] = useState("");

  const native = resolved.path === "native" ? resolved.native : undefined;
  const panels = native?.kind === "cartesian" ? native.model.panels.length : 1;
  // What the drawing needs: a plain chart 300 px, small multiples about
  // 110 px a panel, a table or a tile whatever the page gives it.
  const needPx = resolved.path === "plotly" ? 340 : native?.kind === "cartesian" ? Math.max(300, panels * 110 + 48) + (native.model.captions?.length ? 18 * native.model.captions.length : 0) : native?.kind === "special" ? 340 : native?.kind === "donut" ? 280 : 200;
  useEffect(() => {
    onMinHeight?.(needPx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needPx]);

  const fileTitle = (title || "chart").trim() || "chart";
  const download = async (format: "png" | "jpeg" | "svg" | "webp") => {
    setMenuOpen(false);
    setDownloading(format);
    try {
      if (exportApi.current) await exportApi.current.download(format);
      else {
        // The donut has no export hook of its own: its <svg> is saved by the
        // same function the native cartesian chart uses.
        const svg = bodyRef.current?.querySelector("svg");
        if (svg) await downloadSvg(svg as SVGSVGElement, format, fileTitle);
      }
    } catch {
      // Non-fatal - the chart is still on screen either way.
    } finally {
      setDownloading("");
    }
  };
  const downloadCsv = () => {
    setMenuOpen(false);
    downloadText(`${safeFilename(fileTitle, "result")}.csv`, rowsToCsv(resolved.columns.map((c) => c.name), resolved.rows));
  };

  let body: JSX.Element;
  if (resolved.path === "empty") {
    body = <div className="flex h-full min-h-[120px] items-center justify-center text-caption text-muted">No chart yet</div>;
  } else if (resolved.path === "table") {
    body = <ResultRowsTable columns={resolved.columns} rows={resolved.rows} reason={resolved.table?.reason ?? null} title={title} truncated={truncated} dense={variant === "bare"} />;
  } else if (resolved.path === "plotly" && resolved.plotly) {
    body = (
      <div className="h-full" data-plotly-fallback="" data-plotly-mode={resolved.plotly.mode} title={`Drawn with Plotly: ${resolved.plotly.reason}.`}>
        <ChartCanvas
          chartSpec={resolved.plotly.figure}
          title={fileTitle}
          bare
          kit={resolved.plotly.mode === "kit"}
          minHeight={minHeight ?? (variant === "bare" ? 180 : needPx)}
          onExportApi={setExportApi}
        />
      </div>
    );
  } else if (native?.kind === "kpi") {
    body = (
      <div className="grid h-full content-center gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(native.tiles.length, 4)}, minmax(0, 1fr))` }} data-chart="kpi">
        {native.tiles.map((t) => (
          <KpiTile key={t.key} label={t.label} value={t.value} className="h-auto" />
        ))}
      </div>
    );
  } else if (native?.kind === "donut") {
    body = <DonutChart title={headline(title)} items={native.items} format={native.format} scope={native.scope} column={native.column} pie={native.pie} minHeight={minHeight ?? (variant === "bare" ? 180 : 240)} />;
  } else if (native?.kind === "special") {
    body = <SpecialChart type={native.type} result={native.result} block={{ ...native.block, title: headline(title) }} onExportApi={setExportApi} minHeight={minHeight ?? (variant === "bare" ? 180 : needPx)} compact={variant === "bare" && (minHeight ?? 200) < 180} />;
  } else if (native?.kind === "cartesian") {
    body = (
      <CartesianChart
        model={native.model}
        title={headline(title) || undefined}
        minHeight={minHeight ?? (variant === "bare" ? Math.max(180, panels * 100 + 40) : needPx)}
        onExportApi={setExportApi}
      />
    );
  } else {
    body = <div className="flex h-full min-h-[120px] items-center justify-center text-caption text-muted">No chart yet</div>;
  }

  const attrs = {
    "data-workspace-chart": resolved.path,
    "data-chart-renderer": resolved.path === "native" ? `native-${native?.kind}` : resolved.path === "plotly" ? `plotly-${resolved.plotly?.mode}` : resolved.path,
    "data-chart-audit": resolved.problems.length ? (resolved.rebuilt ? "rebuilt" : "mismatch") : "ok",
  };

  if (variant === "bare") {
    return (
      <div ref={bodyRef} className="h-full w-full min-h-0" {...attrs} title={resolved.path === "plotly" ? undefined : describePath(resolved)}>
        {body}
      </div>
    );
  }

  const isChart = resolved.path === "native" && native?.kind !== "kpi" || resolved.path === "plotly";
  const hasRows = resolved.rows.length > 0 && resolved.columns.length > 0;
  return (
    <div className="card p-4 h-full flex flex-col overflow-hidden transition-shadow hover:shadow-glow" {...attrs}>
      <div className="flex items-center justify-end gap-3 mb-1 shrink-0 relative">
        {/* What the chart leaves out, said on the chart: "Showing City
            Hotel. Resort Hotel is in the table." for a pie of a table with
            two measures. (The native cartesian chart prints its own note
            inside the plot, so it is not repeated here.) */}
        {resolved.note && resolved.path !== "table" && resolved.path !== "empty" && !(resolved.path === "native" && native?.kind === "cartesian") && (
          <span className="mr-auto min-w-0 truncate text-caption text-muted" data-chart-note="" title={resolved.note}>{resolved.note}</span>
        )}
        {forecast.status === "error" && forecast.error && (
          <span role="status" className={`${resolved.note ? "" : "mr-auto "}min-w-0 truncate text-caption text-muted`} data-forecast-error="" title={forecast.error}>{forecast.error}</span>
        )}
        {request && (
          <button
            type="button"
            data-add-forecast=""
            aria-pressed={forecast.status === "on"}
            disabled={forecast.status === "loading"}
            onClick={toggleForecast}
            className={`ui-focus shrink-0 rounded-full border px-2.5 py-[3px] text-caption ${forecast.status === "on" ? "border-tint-border bg-tint text-brand-ink" : "border-border bg-surface text-secondary hover:border-border-strong hover:text-text"} disabled:opacity-60`}
          >
            {forecast.status === "loading" ? "Forecasting…" : forecast.status === "on" ? "Remove forecast" : "Add forecast"}
          </button>
        )}
        <button
          type="button"
          className="dash-chart-menu-btn"
          aria-label="Chart options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-exclusive-id={menuSlotId}
          disabled={!isChart && !hasRows}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <KebabIcon />
        </button>
        {menuOpen && (
          <div role="menu" data-exclusive-id={menuSlotId} className="absolute right-0 top-full mt-1 w-40 card bg-surface shadow-2xl border border-border p-1.5 z-20">
            {isChart && (
              <>
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
              </>
            )}
            {hasRows && (
              <>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted px-2 py-1">{isChart ? "Data" : "Export as"}</div>
                <button role="menuitem" className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors" onClick={downloadCsv}>
                  CSV (the rows behind it)
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div ref={bodyRef} className="flex-1 min-h-0">
        {body}
      </div>
    </div>
  );
}
