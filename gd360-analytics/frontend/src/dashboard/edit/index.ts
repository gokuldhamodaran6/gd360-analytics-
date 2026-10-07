// 2026-10-07 (dashboard edit mode): the editable dashboard - the pieces
// DashboardShell / KpiStrip / BlockGrid take when the owner is editing.
export { useDashboardEditor } from "./useDashboardEditor";
export type { DashboardEditor, EditorSheet, SaveState } from "./useDashboardEditor";
export { useEditMode, readEditFromUrl, writeEditToUrl, EDIT_URL_KEY } from "./useEditMode";
export { EditGrid } from "./EditGrid";
export { EditToolbar, AddBlockPalette, paletteGroups, EDIT_HINT, CONTEXT_ROW_CLASS } from "./EditToolbar";
export { EditSheets } from "./EditSheets";
export { AskAiSheet, examplePrompts, columnsForBlock, columnKind } from "./AskAiSheet";
export { SpecBuilder, specToDraft, draftToSpec, draftProblem, defaultAlias } from "./SpecBuilder";
export { BlockMenu } from "./BlockMenu";
export { EmptyBlockBody, EmptyBlockPlaceholder, BlockTypeIcon } from "./EmptyBlock";
export {
  viewLayout, kpiBand, kpiBlocksInOrder, kpiLayoutItems, toStoredItems, changedItems, reconcileLayout, moveItem, resizeItem, canMove, canResize, minSizeOf, isGridBlock, blockHeightPx,
  GRID_COLS, GRID_GAP_PX,
} from "./layout";
export type { GridItem, MoveDir, SizeDir } from "./layout";
