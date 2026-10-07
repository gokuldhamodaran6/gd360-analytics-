import { useCallback, useMemo, useState } from "react";
import type { DashboardBlock } from "../../api/client";
import { ManualBuildPanel } from "../../components/DashboardCanvas";
import { ConfirmDialog, Sheet } from "../../ui";
import { type CanvasOwnerActions, orderCells } from "../canvas/cells";
import { SqlCell } from "../canvas/SqlCell";
import { NO_COMMENTS } from "../comments/useComments";
import { ParametersEditor } from "../ParametersEditor";
import type { RunSource } from "../useDashboardRun";
import { dashboardBuilderApi } from "../../api/client";
import { AskAiSheet, blockDisplayName, columnsForBlock, type EditorColumn } from "./AskAiSheet";
import { SpecBuilder } from "./SpecBuilder";
import type { DashboardEditor } from "./useDashboardEditor";

// 2026-10-07 (dashboard edit mode): every panel the editor opens, each in
// a kit Sheet on the right:
//   "Change with AI..."  AskAiSheet (both source kinds)
//   "Edit query..."      warehouse block -> SpecBuilder (its BlockSpec);
//                        SQL cell -> the canvas's own SqlCell editor;
//                        file block -> the existing ManualBuildPanel
//   (round 9: there is no "Style..." sheet any more - a file chart's
//    chart type is in its block menu, see BlockMenu.FILE_CHART_TYPES)
//   "Filters"            the existing ParametersEditor (the rail's definition)
// plus the kit confirm for "Remove".

function QuerySheet({ editor, block, source }: { editor: DashboardEditor; block: DashboardBlock; source: RunSource }) {
  const { dash, run, page } = editor;
  const close = editor.closeSheet;
  const tables = useMemo(() => Object.keys(dash.tables || {}), [dash.tables]);
  const columnsOf = useCallback((table: string): EditorColumn[] => columnsForBlock(editor, null, table), [editor]);
  const cells = useMemo(() => orderCells(page?.blocks || []), [page?.blocks]);
  const owner = useMemo<CanvasOwnerActions>(
    () => ({
      updateBlock: async (blockId, payload) => { const d = await dashboardBuilderApi.updateBlock(dash.id, blockId, payload); editor.applyDash(d); return d; },
      createBlock: async () => undefined,
      deleteBlock: async () => undefined,
    }),
    [dash.id, editor]
  );
  const [editingSql, setEditingSql] = useState(true);

  if (block.type === "sql") {
    const cell = cells.find((c) => c.id === block.id);
    return (
      <Sheet open onClose={close} title={blockDisplayName(block)} subtitle="Edit query · SQL cell" size="lg" id="edit-query">
        <div className="-mx-4" data-edit-sql="">
          {cell && (
            <SqlCell
              cell={cell}
              cells={cells}
              run={run}
              source={source}
              mode={editor.warehouse ? "warehouse" : "file"}
              parameters={run.parameters}
              owner={owner}
              comments={NO_COMMENTS}
              editing={editingSql}
              onStartEdit={() => setEditingSql(true)}
              onStopEdit={() => setEditingSql(false)}
              rerunWithDependents={(id) => run.rerunBlocks([id, ...run.dependentsOf(id)])}
            />
          )}
        </div>
      </Sheet>
    );
  }

  if (!editor.warehouse) {
    return (
      <Sheet open onClose={close} title={blockDisplayName(block)} subtitle="Edit query" size="sm" id="edit-query">
        <div className="-m-3" data-edit-manual="">
          <ManualBuildPanel
            dashboardId={dash.id}
            block={block}
            columns={editor.fileColumns}
            datasourceId={dash.datasource_id}
            activeFilters={run.filters}
            onDone={(d) => { editor.applyDash(d, { blockId: block.id }); close(); }}
            onClose={close}
          />
        </div>
      </Sheet>
    );
  }

  return (
    <SpecBuilder
      title={blockDisplayName(block)}
      block={block}
      tables={tables}
      columnsOf={columnsOf}
      provider={editor.provider}
      onCancel={close}
      onSave={async (spec) => {
        await editor.saveSpec(block, spec);
        close();
      }}
    />
  );
}

export function EditSheets({ editor, source }: { editor: DashboardEditor; source: RunSource }) {
  const { sheet, page, dash } = editor;
  const block = sheet && "blockId" in sheet ? page?.blocks.find((b) => b.id === sheet.blockId) || null : null;
  const removing = editor.removing;
  return (
    <>
      {sheet?.kind === "ai" && block && (
        <AskAiSheet editor={editor} block={block} onClose={editor.closeSheet} onEditQuery={() => editor.openSheet({ kind: "query", blockId: block.id })} />
      )}
      {sheet?.kind === "query" && block && <QuerySheet editor={editor} block={block} source={source} />}
      {sheet?.kind === "filters" && (
        <Sheet open onClose={editor.closeSheet} title="Filters" subtitle="The controls in the rail, the date column and the default period." size="lg" id="edit-filters">
          <ParametersEditor
            variant="sheet"
            dash={dash}
            columns={editor.fileColumns}
            onChange={(d) => editor.applyDash(d, { rerunPage: true })}
            onSaved={editor.closeSheet}
          />
        </Sheet>
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title={removing ? `Remove "${blockDisplayName(removing.block)}"?` : ""}
        confirmLabel="Remove"
        busy={removing?.busy}
        error={removing?.error}
        onConfirm={editor.confirmRemove}
        onCancel={editor.cancelRemove}
      >
        The block is deleted from this page. Its data stays where it is.
      </ConfirmDialog>
    </>
  );
}
