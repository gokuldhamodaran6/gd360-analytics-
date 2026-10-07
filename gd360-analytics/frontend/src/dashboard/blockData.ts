import type { BlockResult, DashboardBlock, DashboardBlockType } from "../api/client";
import { applyChartStyle, type ChartStyle, defaultChartStyle } from "../lib/chartStyle";
import { buildExploreFigure, type ExploreConfig, normalizeChartType, type ResultColumn } from "../lib/exploreEngine";
import type { CrossFilter } from "./runState";

// 2026-10-07 (Option A dashboard view): BlockResult -> what each renderer
// needs. A warehouse block never stores rows, so every shape the existing
// block components read (chart_spec, donut items, sparkline series, gauge
// value, leaderboard items) is derived here on the client from the run's
// rows + the block's own config - the same reshaping backend
// _block_result_to_filtered does for the legacy preview-filtered path,
// kept in one place so every surface agrees.

export const DATA_BLOCK_TYPES: DashboardBlockType[] = ["chart", "table", "kpi", "gauge", "donut", "sparkline", "avatar_list"];

export function isDataBlock(b: DashboardBlock): boolean {
  return DATA_BLOCK_TYPES.includes(b.type);
}

// A warehouse block that runs: it has a spec, is bound to a cell, or is a cell.
export function isRunnable(b: DashboardBlock): boolean {
  if (b.type === "sql") return true;
  if (!isDataBlock(b)) return false;
  const cfg = b.config || {};
  return Boolean(cfg.source_block_id) || Boolean(cfg.spec && typeof cfg.spec === "object" && cfg.spec.table);
}

// Legacy: a data block on a warehouse dashboard with nothing to run.
export function isLegacyBlock(b: DashboardBlock): boolean {
  return isDataBlock(b) && !isRunnable(b);
}

export function resultOk(r: BlockResult | undefined | null): r is BlockResult {
  return Boolean(r && r.status === "ok");
}

export function firstMeasure(r: BlockResult): string | null {
  if (r.measures && r.measures.length) return r.measures[0];
  const cols = r.columns || [];
  const dims = new Set([...(r.dimensions || []), ...(r.time_column ? [r.time_column] : [])]);
  const numeric = cols.find((c) => !dims.has(c.name) && typeof r.rows?.[0]?.[c.name] === "number");
  return numeric?.name ?? cols.find((c) => !dims.has(c.name))?.name ?? null;
}

export function firstDimension(r: BlockResult): string | null {
  if (r.time_column) return r.time_column;
  if (r.dimensions && r.dimensions.length) return r.dimensions[0];
  const measure = firstMeasure(r);
  return (r.columns || []).find((c) => c.name !== measure)?.name ?? null;
}

// The column a click on this block's bar/slice/row filters the page by -
// the first real dimension (a time bucket is a derived "period", not a
// column the rail can filter on).
export function crossFilterColumn(r: BlockResult | undefined, block: DashboardBlock): string | null {
  if (!r || !resultOk(r)) return null;
  const dims = r.dimensions || [];
  if (dims.length) return dims[0];
  const spec = block.config?.spec;
  if (spec?.group_by?.length) return spec.group_by[0];
  return null;
}

export function kpiValue(r: BlockResult): unknown {
  const m = firstMeasure(r);
  if (!m || !r.rows?.length) return null;
  return r.rows[0][m];
}

export type KpiDeltaInfo = { pct: number | null; abs: number | null; prior: number | null; direction: "up" | "down" | "flat"; good: boolean | undefined };

export function kpiDelta(r: BlockResult, goodDirection: "up" | "down" = "up"): KpiDeltaInfo | null {
  const m = firstMeasure(r);
  if (!m || !r.delta || !r.delta[m]) return null;
  const d = r.delta[m];
  if (typeof d.current !== "number" || typeof d.prior !== "number") return null;
  const abs = typeof d.abs === "number" ? d.abs : d.current - d.prior;
  const direction: "up" | "down" | "flat" = abs > 0 ? "up" : abs < 0 ? "down" : "flat";
  const good = direction === "flat" ? undefined : direction === goodDirection;
  return { pct: typeof d.pct === "number" ? d.pct : null, abs, prior: d.prior, direction, good };
}

export function kpiSparkline(r: BlockResult): number[] {
  const m = firstMeasure(r);
  if (!m || !r.sparkline?.rows?.length) return [];
  return r.sparkline.rows.map((row) => row[m]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

export function resultColumns(r: BlockResult): ResultColumn[] {
  const dims = new Set(r.dimensions || []);
  const time = r.time_column;
  return (r.columns || []).map((c) => {
    const sample = r.rows?.find((row) => row[c.name] !== null && row[c.name] !== undefined)?.[c.name];
    const t = String(c.type || "").toLowerCase();
    const dtype: ResultColumn["dtype"] =
      c.name === time || /date|time/.test(t)
        ? "date"
        : typeof sample === "number" || /int|float|numeric|decimal|double|real|number/.test(t)
          ? "number"
          : typeof sample === "boolean" || /bool/.test(t)
            ? "boolean"
            : "string";
    const role: ResultColumn["role"] = dims.has(c.name) || c.name === time ? "dimension" : (r.measures || []).includes(c.name) ? "measure" : dtype === "number" ? "measure" : "dimension";
    return { name: c.name, dtype, role };
  });
}

// Rows + chart_type -> a styled Plotly figure. Mirrors the backend's
// legacy rebuild: time x group -> one series per group; else first
// dimension x every measure.
export function buildChartSpec(r: BlockResult, block: DashboardBlock, selected?: CrossFilter | null): any {
  const cfg = block.config || {};
  const columns = resultColumns(r);
  const measures = (r.measures && r.measures.length ? r.measures : columns.filter((c) => c.role === "measure").map((c) => c.name)) as string[];
  const dims = [...(r.time_column ? [r.time_column] : []), ...(r.dimensions || [])];
  const xField = dims[0] || columns.find((c) => c.role === "dimension")?.name || null;
  if (!xField || !measures.length || !r.rows?.length) return null;
  const colorField = dims.length >= 2 ? dims[1] : null;
  let chartType = normalizeChartType(cfg.chart_type || (r.time_column ? "line" : "bar"));
  if (colorField && (chartType === "bar" || chartType === "horizontal_bar")) chartType = "grouped_bar";
  const config: ExploreConfig = {
    chartType,
    xField,
    yFields: (colorField ? measures.slice(0, 1) : measures).map((m) => ({ field: m, agg: "sum" })),
    colorField: chartType === "pie" || chartType === "donut" || chartType === "scatter" ? null : colorField,
    sortDir: "none",
    limit: null,
    filters: [],
  };
  const figure = buildExploreFigure(columns, r.rows, config);
  if (!figure) return null;
  const style: ChartStyle = { ...defaultChartStyle(figure), ...(cfg.chart_style || {}) };
  const styled = applyChartStyle(figure, style, block.title || undefined);
  if (styled?.layout) {
    styled.layout.title = { text: "" };
    styled.layout.margin = { ...(styled.layout.margin || {}), t: 12, l: 48, r: 12, b: 44 };
  }
  if (selected && Array.isArray(styled?.data)) highlightSelection(styled.data, selected.value, r.dimensions?.[0] === xField);
  return styled;
}

// Dim every mark that is not the selected category (colour never carries
// the meaning alone - the subtitle says "<value> selected" too).
function highlightSelection(traces: any[], value: unknown, xIsCrossColumn: boolean) {
  if (!xIsCrossColumn) return;
  const key = String(value);
  for (const t of traces) {
    if (t.type === "pie") {
      const labels: any[] = t.labels || [];
      t.marker = { ...(t.marker || {}), opacity: undefined };
      t.pull = labels.map((l) => (String(l) === key ? 0.06 : 0));
      t.opacity = 1;
      continue;
    }
    const cats: any[] = (t.orientation === "h" ? t.y : t.x) || [];
    if (cats.length === 1) {
      // Per-bar traces (applyChartStyle splits a legend'd bar chart).
      t.opacity = String(cats[0]) === key ? 1 : 0.35;
    } else if (cats.length > 1 && t.type === "bar") {
      t.marker = { ...(t.marker || {}), opacity: cats.map((c) => (String(c) === key ? 1 : 0.35)) };
    }
  }
}

export function donutItems(r: BlockResult): { label: string; value: number }[] {
  const dim = firstDimension(r), m = firstMeasure(r);
  if (!dim || !m) return [];
  const items = (r.rows || [])
    .map((row) => ({ label: row[dim] === null || row[dim] === undefined ? "(Blanks)" : String(row[dim]), value: typeof row[m] === "number" ? row[m] : Number(row[m]) || 0 }))
    .filter((it) => Number.isFinite(it.value));
  items.sort((a, b) => b.value - a.value);
  if (items.length <= 7) return items;
  const top = items.slice(0, 6);
  const other = items.slice(6).reduce((s, it) => s + it.value, 0);
  return [...top, { label: "Other", value: other }];
}

export function sparklineConfig(r: BlockResult, block: DashboardBlock): any {
  const dim = firstDimension(r), m = firstMeasure(r);
  const rows = r.rows || [];
  const series = dim && m ? rows.slice(-30).map((row) => row[m]).filter((v) => typeof v === "number") : [];
  const spark = kpiSparkline(r);
  const values = series.length > 1 ? series : spark;
  const value = typeof kpiValue(r) === "number" ? (kpiValue(r) as number) : values[values.length - 1];
  const first = values[0], last = values[values.length - 1];
  const deltaPct = values.length > 1 && typeof first === "number" && first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null;
  return { ...block.config, value, series: values, categories: dim ? rows.slice(-30).map((row) => row[dim]) : [], delta_pct: deltaPct, label: block.config?.label || m };
}

export function gaugeConfig(r: BlockResult, block: DashboardBlock): any {
  const cfg = block.config || {};
  const value = kpiValue(r);
  const v = typeof value === "number" ? value : Number(value) || 0;
  const target = typeof cfg.target === "number" ? cfg.target : typeof cfg.target_value === "number" ? cfg.target_value : null;
  const explicitMax = typeof cfg.max === "number" ? cfg.max : typeof cfg.max_value === "number" ? cfg.max_value : null;
  const max = explicitMax ?? (target ? Math.max(target * 1.25, v) : Math.max(v * 1.25, 1));
  return { ...cfg, value: v, min: typeof cfg.min === "number" ? cfg.min : 0, max, target: target ?? max, label: cfg.label || firstMeasure(r) };
}

export function avatarListItems(r: BlockResult): { rank: number; name: string; value: number }[] {
  const dim = firstDimension(r), m = firstMeasure(r);
  if (!dim || !m) return [];
  const items = (r.rows || [])
    .map((row) => ({ name: row[dim] === null || row[dim] === undefined ? "(Blanks)" : String(row[dim]), value: typeof row[m] === "number" ? row[m] : Number(row[m]) || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
  return items.map((it, i) => ({ rank: i + 1, ...it }));
}

export function rowsToCsv(columns: string[], rows: Record<string, any>[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(","), ...rows.map((row) => columns.map((c) => esc(row[c])).join(","))].join("\r\n");
}

export function downloadText(filename: string, text: string, mime = "text/csv;charset=utf-8") {
  if (typeof document === "undefined") return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(name: string | null | undefined, fallback = "block"): string {
  return (name || fallback).replace(/[^a-zA-Z0-9-_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || fallback;
}
