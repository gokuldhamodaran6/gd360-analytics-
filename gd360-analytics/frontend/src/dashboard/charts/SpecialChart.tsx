import { useMemo } from "react";
import type { BlockResult, DashboardBlock } from "../../api/client";
import type { ChartExportApi } from "../../components/ChartCanvas";
import { useChartTheme } from "../theme/ChartThemeContext";
import { BulletChart, bulletModel } from "./BulletChart";
import { FunnelChart, funnelModel } from "./FunnelChart";
import { HeatmapChart } from "./HeatmapChart";
import { ChartMessage } from "./kit";
import { MapChart } from "./MapChart";
import { mapModel } from "./mapModel";
import { matrixModel } from "./matrixModel";
import type { SpecialChartType } from "./model";
import { PivotTable } from "./PivotTable";
import { CHART_TYPES } from "./recommend";
import { ScatterChart, scatterModel } from "./ScatterChart";
import { TreemapChart, treemapModel } from "./TreemapChart";
import { WaterfallChart, waterfallModel } from "./WaterfallChart";

// 2026-10-07 (chart-types round): one entry point for the chart forms that
// are not cartesian - a map, a heatmap, a pivot table, a scatter / bubble,
// a treemap, a funnel, a waterfall, a bullet. Given a block's result it
// builds that form's model (each from its own file, all pure) and draws
// it; when the result cannot be drawn as the form it says what the form
// needs, in the words the chart gallery uses, instead of drawing
// something else silently. Used by BlockRenderer (the dashboard grid, the
// canvas cells, the published view, file dashboards) and the chart
// gallery's thumbnails (`compact`).

export type SpecialChartProps = {
  type: SpecialChartType;
  result: BlockResult;
  block: Pick<DashboardBlock, "id" | "title" | "config">;
  // The cross-filter column of this block (the result's first dimension)
  // and the value the page is filtered to, if any.
  crossColumn?: string | null;
  selectedValue?: unknown;
  hasSelection?: boolean;
  onPick?: (value: unknown) => void;
  onExportApi?: (api: ChartExportApi | null) => void;
  minHeight?: number;
  compact?: boolean;
};

function needs(type: string): string {
  const info = CHART_TYPES.find((t) => t.type === type);
  return info ? `${info.label} ${info.needs}.` : "This result cannot be drawn as that chart.";
}

export function SpecialChart({ type, result, block, crossColumn = null, selectedValue, hasSelection = false, onPick, onExportApi, minHeight, compact = false }: SpecialChartProps) {
  const theme = useChartTheme();
  const title = block.title;
  const common = { title, selectedValue, hasSelection, onExportApi, minHeight, compact };
  const built = useMemo(() => {
    if (type === "map") return { kind: "map", model: mapModel(result, block, theme) } as const;
    if (type === "heatmap" || type === "pivot") return { kind: "matrix", model: matrixModel(result, block, theme) } as const;
    if (type === "scatter" || type === "bubble") return { kind: "scatter", model: scatterModel(result, block, theme, type === "bubble") } as const;
    if (type === "treemap") return { kind: "treemap", model: treemapModel(result, block, theme) } as const;
    if (type === "funnel") return { kind: "funnel", model: funnelModel(result, block, theme) } as const;
    if (type === "waterfall") return { kind: "waterfall", plan: waterfallModel(result, block, theme) } as const;
    return { kind: "bullet", model: bulletModel(result, block, theme) } as const;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, result, block, theme.key]);

  if (built.kind === "waterfall") {
    if (built.plan.kind === "message") return <ChartMessage kind="waterfall-needs" minHeight={minHeight}>{built.plan.text}</ChartMessage>;
    const m = built.plan.model;
    return <WaterfallChart model={m} {...common} onPick={onPick && m.column && m.column === crossColumn ? onPick : undefined} hasSelection={hasSelection && m.column === crossColumn} />;
  }
  if (!built.model) return <ChartMessage kind={`${type}-needs`} minHeight={minHeight}>{needs(type)}</ChartMessage>;
  if (built.kind === "map") return <MapChart model={built.model} {...common} onPick={onPick} />;
  if (built.kind === "matrix") {
    if (type === "pivot") return <PivotTable model={built.model} title={title} selectedValue={selectedValue} hasSelection={hasSelection} onPick={onPick && built.model.cross ? onPick : undefined} minHeight={minHeight} defaultShade={block.config?.pivot_shade !== false} defaultTotals={block.config?.show_totals !== false} />;
    return <HeatmapChart model={built.model} {...common} onPick={onPick && built.model.cross ? onPick : undefined} defaultTotals={Boolean(block.config?.show_totals)} />;
  }
  if (built.kind === "scatter") return <ScatterChart model={built.model} {...common} onPick={onPick && built.model.pickable ? onPick : undefined} />;
  if (built.kind === "treemap") return <TreemapChart model={built.model} {...common} onPick={onPick} />;
  if (built.kind === "funnel") return <FunnelChart model={built.model} {...common} onPick={onPick && built.model.column ? onPick : undefined} />;
  return <BulletChart model={built.model} {...common} onPick={onPick && built.model.column ? onPick : undefined} />;
}
