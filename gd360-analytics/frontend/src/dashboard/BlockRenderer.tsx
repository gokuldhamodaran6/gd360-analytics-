import { useEffect, useMemo, useState } from "react";
import type { BlockResult, DashboardBlock, DashboardParameter, FilteredBlock } from "../api/client";
import ChartCanvas, { type ChartExportApi } from "../components/ChartCanvas";
import {
  AvatarListBlock, BlockChart, BlockTable, DividerBlock, DonutBlock, GaugeBlock, HeadingBlock, KpiTile as LegacyKpiTile, SparklineBlock, TextBlock,
} from "../components/DashboardBlocks";
import { KpiTile, TableFooter, TableFrame, type DataTableColumn } from "../ui";
import {
  avatarListItems, buildChartSpec, crossFilterColumn, donutItems, gaugeConfig, kpiDelta, kpiSparkline, kpiValue, resultOk, sparklineConfig,
} from "./blockData";
import { ParameterField } from "./FilterRailPanel";
import { type CrossFilter, formatCell, formatNumber, type ParamValue } from "./runState";
import type { RunSource } from "./useDashboardRun";

// 2026-10-07 (Option A dashboard view): routes one block to its renderer.
//   warehouse mode - a BlockResult (rows computed in the warehouse) drives
//     a Plotly chart (rows + chart_type through lib/exploreEngine +
//     lib/chartStyle's palette, drawn by the existing ChartCanvas in bare
//     mode), a KpiTile, a paged TableFrame, or the native donut /
//     sparkline / gauge / leaderboard components.
//   file mode - today's components rendering the block's own stored config
//     (or the preview-filtered override), unchanged under the new skin.
// Clicking a bar / slice / row hands the page a cross-filter on the
// block's first dimension.

export const TABLE_PAGE_SIZE = 50;

export type BlockRendererProps = {
  block: DashboardBlock;
  mode: "warehouse" | "file";
  result?: BlockResult;
  override?: FilteredBlock;
  selected?: CrossFilter | null;
  onCrossFilter?: (cf: CrossFilter) => void;
  onExportApi?: (api: ChartExportApi | null) => void;
  // "input" cells: the parameter they are bound to.
  parameters?: DashboardParameter[];
  paramValue?: ParamValue;
  onParamChange?: (paramId: string, v: ParamValue) => void;
  source?: RunSource;
  // Height hint (px) for the chart body.
  bodyHeight?: number;
};

function ResultTable({ result, selected, column, onCrossFilter, block }: { result: BlockResult; selected?: CrossFilter | null; column: string | null; onCrossFilter?: (cf: CrossFilter) => void; block: DashboardBlock }) {
  const [shown, setShown] = useState(TABLE_PAGE_SIZE);
  useEffect(() => setShown(TABLE_PAGE_SIZE), [result]);
  const columns = useMemo<DataTableColumn<Record<string, any>>[]>(
    () =>
      (result.columns || []).map((c) => {
        const numeric = result.rows?.some((r) => typeof r[c.name] === "number") ?? false;
        return { key: c.name, header: c.name, mono: true, numeric, render: (row) => formatCell(row[c.name]) };
      }),
    [result]
  );
  const rows = result.rows || [];
  const visible = rows.slice(0, shown);
  const total = typeof result.exact_total_rows === "number" && block.type === "table" && result.truncated ? result.exact_total_rows : rows.length;
  return (
    <TableFrame
      bare
      dense
      columns={columns}
      rows={visible}
      rowKey={(_r, i) => i}
      ariaLabel={block.title || "Rows"}
      maxHeight="100%"
      onRowClick={column && onCrossFilter ? (row) => onCrossFilter({ column, value: row[column] ?? null, blockId: block.id }) : undefined}
      selectedKey={column && selected ? visible.findIndex((r) => String(r[column]) === String(selected.value)) : null}
      className="h-full"
      footer={
        <TableFooter
          start={rows.length ? 1 : 0}
          end={Math.min(shown, rows.length)}
          total={total}
          pageSize={TABLE_PAGE_SIZE}
          onLoadMore={shown < rows.length ? () => setShown((n) => n + TABLE_PAGE_SIZE) : undefined}
          approximate={total !== rows.length}
        />
      }
    />
  );
}

export function BlockRenderer(props: BlockRendererProps) {
  const { block, mode, result, override, selected, onCrossFilter, onExportApi, parameters, paramValue, onParamChange, source, bodyHeight } = props;
  const type = override?.type ?? block.type;
  const cfg = override?.config ?? block.config ?? {};

  // Layout-only blocks render the same everywhere.
  if (type === "text") return <TextBlock title={null} config={cfg} />;
  if (type === "heading") return <HeadingBlock title={block.title} config={cfg} />;
  if (type === "divider") return <DividerBlock />;
  if (type === "filter") return null;
  if (type === "input") {
    const param = parameters?.find((p) => p.id === cfg.parameter_id || p.name === cfg.parameter_name);
    if (!param) return <div className="text-caption text-muted">This input is not bound to a filter yet.</div>;
    if (!source || !onParamChange) return <div className="text-caption text-muted">{param.label}</div>;
    return <ParameterField param={param} value={paramValue} onChange={(v) => onParamChange(param.id, v)} source={source} />;
  }

  if (mode === "file") {
    // Today's renderers, today's config shapes (see components/DashboardBlocks.tsx).
    const config = { ...cfg, accent_color: block.config?.accent_color };
    if (type === "kpi") return <LegacyKpiTile title={block.title} config={config} compareValue={override ? block.config?.value : undefined} />;
    if (type === "table") return <BlockTable title={null} config={config} />;
    if (type === "chart") return <BlockChart title={block.title} config={cfg} bare onExportApi={onExportApi} />;
    if (type === "gauge") return <GaugeBlock title={block.title} config={config} bare />;
    if (type === "donut") return <DonutBlock title={block.title} config={cfg} bare />;
    if (type === "sparkline") return <SparklineBlock title={block.title} config={config} bare />;
    if (type === "avatar_list") return <AvatarListBlock title={block.title} config={cfg} bare />;
    return null;
  }

  if (!result) return null;
  if (result.status !== "ok") {
    return (
      <div role="alert" className="flex h-full min-h-[96px] items-center justify-center rounded-ctl border border-danger-border bg-danger-fill px-4 py-3 text-center text-ui text-danger">
        {result.error || "This block couldn't be computed."}
      </div>
    );
  }
  const column = crossFilterColumn(result, block);
  const pick = (value: unknown) => {
    if (column && onCrossFilter) onCrossFilter({ column, value: (value === undefined ? null : value) as CrossFilter["value"], blockId: block.id });
  };

  if (type === "kpi") {
    const delta = kpiDelta(result, block.config?.good_direction === "down" ? "down" : "up");
    return (
      <KpiTile
        label={block.title || block.config?.label || result.measures?.[0] || "Value"}
        value={formatNumber(kpiValue(result))}
        delta={delta ? { pct: delta.pct ?? undefined, abs: delta.pct === null ? delta.abs ?? undefined : undefined, direction: delta.direction, good: delta.good, caption: "vs prior period" } : undefined}
        sparkline={kpiSparkline(result)}
        className="h-full border-0 shadow-none"
      />
    );
  }
  if (type === "table" || type === "sql") {
    return <ResultTable result={result} selected={selected} column={column} onCrossFilter={onCrossFilter} block={block} />;
  }
  if (type === "chart") {
    const spec = buildChartSpec(result, block, selected);
    if (!spec) return <div className="flex h-full min-h-[96px] items-center justify-center text-caption text-muted">No rows to chart.</div>;
    return (
      <ChartCanvas
        chartSpec={spec}
        title={block.title || undefined}
        bare
        minHeight={bodyHeight ? Math.max(120, bodyHeight - 8) : 160}
        onPointClick={column && onCrossFilter ? (p) => pick(p.x) : undefined}
        onExportApi={onExportApi}
      />
    );
  }
  if (type === "donut") {
    return (
      <DonutBlock
        title={block.title}
        config={{ items: donutItems(result) }}
        bare
        onItemClick={column && onCrossFilter ? (label) => pick(label === "(Blanks)" ? null : label) : undefined}
        selectedLabel={selected ? String(selected.value ?? "(Blanks)") : null}
      />
    );
  }
  if (type === "sparkline") return <SparklineBlock title={block.title} config={sparklineConfig(result, block)} bare />;
  if (type === "gauge") return <GaugeBlock title={block.title} config={gaugeConfig(result, block)} bare />;
  if (type === "avatar_list") {
    return (
      <AvatarListBlock
        title={block.title}
        config={{ items: avatarListItems(result) }}
        bare
        onItemClick={column && onCrossFilter ? (name) => pick(name === "(Blanks)" ? null : name) : undefined}
        selectedName={selected ? String(selected.value ?? "(Blanks)") : null}
      />
    );
  }
  return null;
}
