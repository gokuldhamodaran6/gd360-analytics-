import { useMemo } from "react";
import { BarChartIcon, FileIcon, FilterIcon, SqlIcon, TableIcon, cn } from "../../ui";
import { resultOk } from "../blockData";
import type { DashboardRun } from "../useDashboardRun";
import { type CanvasCellKind, type CellInfo, dependencyLines, formatBytes, formatSeconds } from "./cells";

// 2026-10-07 (analyst canvas round, OptionC.dc.html's right panel):
// Outline (every cell by number and title - click scrolls to it and
// focuses it) and Dependencies ("2 → 3", "5–7 → 4" from the run response's
// `dependencies`), then the last run's totals.

export const KIND_ICON: Record<CanvasCellKind, (p: { size?: number; className?: string }) => JSX.Element> = {
  sql: SqlIcon, chart: BarChartIcon, kpi: BarChartIcon, table: TableIcon, text: FileIcon, input: FilterIcon,
};

export function OutlinePanel({ cells, run, focusedId, onSelect, className }: { cells: CellInfo[]; run: DashboardRun; focusedId: string | null; onSelect: (id: string) => void; className?: string }) {
  const lines = useMemo(() => dependencyLines(run.dependencies, cells), [run.dependencies, cells]);
  const totals = useMemo(() => {
    let bytes = 0, rows = 0, any = false;
    for (const c of cells) {
      const r = run.results[c.id];
      if (!resultOk(r) || r.kind === "derived") continue;
      any = true;
      if (typeof r.bytes_scanned === "number" && !r.cached) bytes += r.bytes_scanned;
      rows += r.row_count ?? r.rows?.length ?? 0;
    }
    return any ? { bytes, rows } : null;
  }, [cells, run.results]);
  return (
    <aside aria-label="Outline" data-outline-panel="" className={cn("flex flex-col gap-5 text-ui", className)}>
      <section>
        <h2 className="mb-2 text-caption font-medium uppercase tracking-caps text-muted">Outline</h2>
        {cells.length === 0 ? (
          <div className="text-caption text-muted">No cells yet.</div>
        ) : (
          <ol className="flex flex-col">
            {cells.map((c) => {
              const Icon = KIND_ICON[c.kind];
              const active = c.id === focusedId;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    data-outline-cell={c.id}
                    aria-current={active ? "true" : undefined}
                    className={cn("ui-focus flex w-full items-center gap-2 rounded-ctl px-2 py-1 text-left hover:bg-subtle", active ? "bg-tint text-brand-ink" : "text-secondary")}
                  >
                    <span className="w-5 shrink-0 text-right font-mono text-caption tabular-nums text-muted">{c.index}</span>
                    <Icon size={13} className="shrink-0 text-muted" />
                    <span className={cn("min-w-0 truncate", c.kind === "sql" && "font-mono text-[12.5px]")}>{c.kind === "sql" ? c.name || c.label : c.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>
      <section>
        <h2 className="mb-2 text-caption font-medium uppercase tracking-caps text-muted">Dependencies</h2>
        {lines.length === 0 ? (
          <div className="text-caption text-muted" data-dependencies="">{run.ready ? "No cell reads another yet." : "Known after the first run."}</div>
        ) : (
          <ul className="flex flex-col gap-1 font-mono text-[12.5px] tabular-nums text-text" data-dependencies="">
            {lines.map((l) => (
              <li key={l.targetId}>
                <button type="button" className="ui-focus rounded px-1 hover:bg-subtle" onClick={() => onSelect(l.targetId)}>{l.text}</button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-caption text-muted">Changing a cell re-runs only what depends on it.</p>
      </section>
      <section className="flex flex-col gap-1.5 border-t border-subtle pt-4 text-caption">
        <div className="flex justify-between gap-2"><span className="text-muted">Last full run</span><span className="font-medium tabular-nums text-text">{formatSeconds(run.totalDurationMs) || "—"}</span></div>
        <div className="flex justify-between gap-2"><span className="text-muted">Bytes scanned</span><span className="font-medium tabular-nums text-text">{totals ? formatBytes(totals.bytes) || "0 B" : "—"}</span></div>
        <div className="flex justify-between gap-2"><span className="text-muted">Rows left warehouse</span><span className="font-medium tabular-nums text-text">{totals ? totals.rows.toLocaleString() : "—"}</span></div>
        {run.computedIn && <div className="flex justify-between gap-2"><span className="text-muted">Computed in</span><span className="font-medium text-text">{run.computedIn}</span></div>}
      </section>
    </aside>
  );
}
