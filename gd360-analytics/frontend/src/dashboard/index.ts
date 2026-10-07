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
// 2026-10-07 (identity-colour round): the chart theme - the one object
// every renderer reads its colours from - the appearance document's types,
// and the Appearance sheet. A new chart type reads useChartTheme():
//   theme.colorFor(column, value)   identity colour of a dimension value
//   theme.measureColor(name)        colour of a measure among several
//   theme.primary / theme.other / theme.blank / theme.status
//   theme.sequential(mode) / theme.diverging(mode)   7-step ramps
//   theme.slots                     the palette's hues, in slot order
// (the rule is written at the top of theme/chartTheme.ts; the palettes and
// their validation live in theme/palettes.ts).
export * from "./theme/appearance";
export {
  BLANK_KEY, BY_VALUE_MAX_BARS, DEFAULT_CHART_THEME, MEASURES_KEY, LocalColorRegistry, blockColorMode, blockSingleColor, buildChartTheme, identityKeys,
  isPositionWord, localRegistry, resolvePalette, valueKey,
} from "./theme/chartTheme";
export type { ChartTheme, ChartThemeOptions, ColumnColorInfo, ResolvedPalette } from "./theme/chartTheme";
export { ChartThemeProvider, ColorPinPanel, ColorSwatch, useChartTheme, useChartThemeValue, useDashboardScope, useGridMetrics } from "./theme/ChartThemeContext";
export { AppearanceSheet, SaveStatus } from "./theme/AppearanceSheet";
export { BrandKitSheet } from "./theme/BrandKitSheet";
export { CustomPaletteEditor, parseColorList } from "./theme/CustomPaletteEditor";
export { PalettePreview, previewSamples, SAMPLE_PREVIEWS } from "./theme/PalettePreview";
export { useDashboardAppearance, useKitAppearance } from "./theme/useAppearanceEditor";
export type { AppearanceController } from "./theme/useAppearanceEditor";
export * as palettes from "./theme/palettes";
