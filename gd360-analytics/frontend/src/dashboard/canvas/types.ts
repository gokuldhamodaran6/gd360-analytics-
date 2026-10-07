import type { DashboardBlock, DashboardParameter } from "../../api/client";
import type { BlockSqlInfo } from "../BlockGrid";
import type { CommentsApi } from "../comments/useComments";
import type { DashboardRun, RunSource } from "../useDashboardRun";
import type { CanvasOwnerActions, CellInfo } from "./cells";

// What every cell body (SqlCell, DataCell, TextCell, InputCell) receives
// from the Cell frame.
export type CellBodyProps = {
  cell: CellInfo;
  cells: CellInfo[];
  run: DashboardRun;
  source: RunSource;
  mode: "warehouse" | "file";
  parameters: DashboardParameter[];
  owner: CanvasOwnerActions | null;
  comments: CommentsApi;
  // The cell is the one being edited (Enter / "Edit"); Esc leaves.
  editing: boolean;
  onStartEdit: () => void;
  onStopEdit: () => void;
  // After a change that needs fresh numbers (a saved statement, a new
  // binding): re-run this cell and everything that reads it.
  rerunWithDependents: (blockId: string) => void;
  fetchSql?: (block: DashboardBlock) => Promise<BlockSqlInfo>;
  // Chart cells: a "Comment" that is waiting for a bar to be clicked.
  pickingAnchor?: boolean;
  onPickAnchor?: (anchor: { kind: string; key: string | number | boolean | null; column?: string | null }) => void;
  // Narrow, in a KPI row.
  compact?: boolean;
};
