// 2026-10-07 (Option A dashboard view): the viewing experience for a
// pages+blocks dashboard - header, filter rail, KPI strip, block grid -
// shared by the owner's view/preview mode (pages/DashboardBuilderView.tsx)
// and the published link (pages/PublicDashboardView.tsx). The engine is
// useDashboardRun; everything else renders from it.
export { DashboardShell, LegacyBlocksBanner } from "./DashboardShell";
export type { DashboardShellProps } from "./DashboardShell";
export { FilterRailPanel, ParameterField } from "./FilterRailPanel";
export { KpiStrip, kpiBlocksOf } from "./KpiStrip";
export { BlockGrid, BlockCard, compactLayout, isBlockEmpty } from "./BlockGrid";
export type { BlockGridProps, BlockOwnerActions, BlockSqlInfo } from "./BlockGrid";
export { BlockRenderer } from "./BlockRenderer";
export { useDashboardRun } from "./useDashboardRun";
export type { DashboardRun, RunSource, DashboardRunOptions } from "./useDashboardRun";
export { useParameterOptions } from "./useParameterOptions";
export * from "./runState";
export * from "./blockData";
export { ParametersEditor } from "./ParametersEditor";
// 2026-10-07 (analyst canvas round): the Canvas rendering + comments.
export * from "./canvas";
export * from "./comments";
// 2026-10-07 (dashboard from a prompt): describe -> propose -> refine -> publish.
export * from "./builder";
// 2026-10-07 (dashboard edit mode): the same dashboard, editable.
export * from "./edit";
// 2026-10-07 (dashboard polish round): the shared number / name formatter
// and the native charts (bars, lines, small multiples, donut).
export * from "./format";
export { planChart, seriesSlots, SINGLE_COLOR, SERIES_COLORS, OTHER_COLOR } from "./charts/model";
export type { ChartModel, ChartPlan, ChartPanel, ChartSeries } from "./charts/model";
export { layoutChart } from "./charts/layout";
export type { Scene, ScenePanel } from "./charts/layout";
export { makeMeasure, fitText, niceTicks } from "./charts/geometry";
export { CartesianChart } from "./charts/CartesianChart";
export { DonutChart, donutSlices, ringLabels, shareText } from "./charts/DonutChart";
