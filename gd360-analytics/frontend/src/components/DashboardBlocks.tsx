import ChartCanvas from "./ChartCanvas";
import { DashboardBlock } from "../api/client";

// 2026-09-24 (Dashboard Builder Phase 1): the shared block-rendering layer
// for a pages+blocks dashboard - used by BOTH the owner's editor view
// (DashboardBuilderView.tsx) and the anonymous public viewer
// (PublicDashboardView.tsx), so a chart/table/kpi block looks and lays out
// identically in both places. Deliberately NOT reused from DataTable.tsx
// (that component is tightly coupled to live datasource/version browsing -
// props like datasourceId/versions/onActiveVersionChange - none of which
// apply to a block's already-computed, static rows) - BlockTable below is a
// new, much smaller component built specifically for this.
//
// Layout: a 12-column CSS grid, one grid row unit per backend "h"/"w" unit
// (see routers/dashboard_builder.py's _layout_blocks - kpi tiles are 3x3,
// chart/table blocks are 6x6 on that same 12-wide grid). ROW_UNIT_PX is
// chosen so a kpi tile (h=3) comes out ~144px tall and a chart/table block
// (h=6) ~288px tall - enough room for a real Plotly chart without being
// wasteful for a KPI number.
const ROW_UNIT_PX = 48;

// 2026-09-24 (Dashboard Builder Phase 2): KpiTile/BlockTable/BlockChart are
// now exported - DashboardCanvas.tsx (the new editable canvas) reuses these
// exact same renderers inside each grid cell, so a block looks pixel-
// identical whether you're looking at it in the read-only viewer
// (DashboardBlockGrid below) or dragging it around in edit mode. TextBlock
// is new this round (Phase 2's freeform note block type).
export function KpiTile({ title, config }: { title: string | null; config: any }) {
  const raw = config?.value;
  const isNumber = typeof raw === "number" && Number.isFinite(raw);
  const display = isNumber
    ? raw.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : raw === null || raw === undefined || raw === ""
    ? "—"
    : String(raw);
  return (
    <div className="card h-full p-5 flex flex-col justify-center gap-1.5 overflow-hidden">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted truncate">
        {title || config?.label || "Value"}
      </div>
      <div className="text-3xl font-bold tabular-nums truncate">{display}</div>
    </div>
  );
}

export function BlockTable({ title, config }: { title: string | null; config: any }) {
  const columns: string[] = Array.isArray(config?.columns) ? config.columns : [];
  const rows: Record<string, any>[] = Array.isArray(config?.rows) ? config.rows : [];
  return (
    <div className="card h-full p-4 flex flex-col overflow-hidden">
      {title && <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-2 shrink-0 truncate">{title}</div>}
      <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface2">
            <tr>
              {columns.map((c) => (
                <th key={c} className="text-left font-semibold text-xs text-muted uppercase tracking-wide px-3 py-2 whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-border">
                {columns.map((c) => (
                  <td key={c} className="px-3 py-1.5 whitespace-nowrap tabular-nums">
                    {row[c] === null || row[c] === undefined ? "" : String(row[c])}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-muted text-xs" colSpan={Math.max(columns.length, 1)}>
                  No rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {config?.truncated && (
        <div className="text-[11px] text-muted mt-1.5 shrink-0">Showing the first {rows.length} rows.</div>
      )}
    </div>
  );
}

export function BlockChart({ title, config }: { title: string | null; config: any }) {
  return (
    <div className="h-full">
      <ChartCanvas chartSpec={config?.chart_spec} title={title || undefined} />
    </div>
  );
}

export function TextBlock({ title, config }: { title: string | null; config: any }) {
  const text: string = typeof config?.text === "string" ? config.text : "";
  return (
    <div className="card h-full p-4 overflow-auto">
      {title && <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-2 truncate">{title}</div>}
      {text ? (
        <div className="text-sm leading-relaxed whitespace-pre-wrap">{text}</div>
      ) : (
        <div className="text-sm text-muted italic">Empty note.</div>
      )}
    </div>
  );
}

export function DashboardBlockGrid({ blocks }: { blocks: DashboardBlock[] }) {
  if (blocks.length === 0) {
    return <div className="text-sm text-muted py-10 text-center">This page has no blocks yet.</div>;
  }
  return (
    <div
      className="grid gap-4"
      style={{
        gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
        gridAutoRows: `${ROW_UNIT_PX}px`,
      }}
    >
      {blocks.map((b) => (
        <div
          key={b.id}
          style={{
            gridColumn: `${b.x + 1} / span ${b.w}`,
            gridRow: `${b.y + 1} / span ${b.h}`,
          }}
        >
          {b.type === "kpi" && <KpiTile title={b.title} config={b.config} />}
          {b.type === "table" && <BlockTable title={b.title} config={b.config} />}
          {b.type === "chart" && <BlockChart title={b.title} config={b.config} />}
          {b.type === "text" && <TextBlock title={b.title} config={b.config} />}
        </div>
      ))}
    </div>
  );
}
