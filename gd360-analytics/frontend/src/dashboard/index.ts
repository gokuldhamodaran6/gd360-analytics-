// 2026-10-07 (Option A dashboard view): the viewing experience for a
// pages+blocks dashboard - header, filter rail, KPI strip, block grid -
// shared by the owner's view/preview mode (pages/DashboardBuilderView.tsx)
// and the published link (pages/PublicDashboardView.tsx). The engine is
// useDashboardRun; everything else renders from it.
export { DashboardShell, LegacyBlocksBanner } from "./DashboardShell";
export type { DashboardShellProps } from "./DashboardShell";
export { FilterRailPanel, ParameterField } from "./FilterRailPanel";
export { KpiStrip, kpiBlocksOf } from "./KpiStrip";
export { BlockGrid, BlockCard, compactLayout } from "./BlockGrid";
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
