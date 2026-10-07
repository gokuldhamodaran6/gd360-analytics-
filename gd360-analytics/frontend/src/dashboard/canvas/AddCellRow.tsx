import { useState } from "react";
import type { DashboardBlockType } from "../../api/client";
import { BarChartIcon, CodeIcon, FileIcon, FilterIcon, PlusIcon, SqlIcon, TableIcon, cn } from "../../ui";

// 2026-10-07 (analyst canvas round, OptionC.dc.html's "+ Add cell" row):
// SQL · Chart · Text · Input · Table, each creating a block through the
// existing POST /blocks (the canvas never has a block the grid cannot
// show). Python is shown disabled - "coming later".

export type AddCellKind = "sql" | "chart" | "text" | "input" | "table";

const KINDS: { kind: AddCellKind; label: string; type: DashboardBlockType; icon: (p: { size?: number }) => JSX.Element }[] = [
  { kind: "sql", label: "SQL", type: "sql", icon: SqlIcon },
  { kind: "chart", label: "Chart", type: "chart", icon: BarChartIcon },
  { kind: "text", label: "Text", type: "text", icon: FileIcon },
  { kind: "input", label: "Input", type: "input", icon: FilterIcon },
  { kind: "table", label: "Table", type: "table", icon: TableIcon },
];

export function AddCellRow({ onAdd, busy = false, className }: { onAdd: (kind: AddCellKind) => Promise<void>; busy?: boolean; className?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<AddCellKind | null>(null);
  const add = async (kind: AddCellKind) => {
    setPending(kind);
    setError(null);
    try {
      await onAdd(kind);
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : e?.message || "Couldn't add this cell.");
    } finally {
      setPending(null);
    }
  };
  return (
    <div data-add-cell-row="" className={cn("rounded-card border border-dashed border-border-strong bg-surface/60 px-4 py-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-ui font-medium text-secondary"><PlusIcon size={14} /> Add cell</span>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Add cell">
          {KINDS.map(({ kind, label, icon: Icon }) => (
            <button
              key={kind}
              type="button"
              disabled={busy || pending !== null}
              onClick={() => add(kind)}
              data-add-cell={kind}
              className="ui-focus inline-flex h-8 items-center gap-1.5 rounded-ctl border border-border bg-surface px-2.5 text-ui text-text hover:border-border-strong hover:bg-subtle disabled:cursor-default disabled:opacity-60"
            >
              <Icon size={14} />
              {pending === kind ? "Adding…" : label}
            </button>
          ))}
          <button type="button" disabled title="Python cells are coming later" data-add-cell="python" className="inline-flex h-8 cursor-default items-center gap-1.5 rounded-ctl border border-border bg-surface px-2.5 text-ui text-faint">
            <CodeIcon size={14} /> Python <span className="text-[11px]">· coming later</span>
          </button>
        </div>
      </div>
      {error && <div role="alert" className="mt-2 text-caption text-danger">{error}</div>}
    </div>
  );
}
