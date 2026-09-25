import { useEffect, useState } from "react";
import ChartCanvas from "./ChartCanvas";
import { datasourceApi, DashboardBlock } from "../api/client";
import { DashboardFilterState } from "../lib/useDashboardFilters";

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

// 2026-09-25 (naming fix + premium light theme foundation round): below a
// phone/small-tablet width, the absolute x/y/w/h grid positions tuned for
// a 12-column desktop layout stop making sense (a kpi tile sized "3 wide"
// on a 375px screen is a sliver). Rather than trying to reflow the grid
// itself, DashboardBlockGrid switches to a plain single-column stack, each
// block full width and given a sensible natural height for its type - the
// same data, same block components, just laid out differently. This is
// the one place true "every device" responsiveness needed to be solved,
// since this exact component is what both the owner's Preview mode AND
// the public/published page (the surface a customer or investor actually
// opens on their phone) both render through.
const NARROW_BREAKPOINT = 760;

function useIsNarrow(breakpoint = NARROW_BREAKPOINT) {
  const [narrow, setNarrow] = useState(() => (typeof window !== "undefined" ? window.innerWidth < breakpoint : false));
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [breakpoint]);
  return narrow;
}

// Natural stacked-mode height per block type, in px - not a grid unit
// count, just a sensible minimum so a table or chart has real room and a
// kpi tile doesn't stretch to fill the screen.
const STACK_MIN_HEIGHT: Record<string, number> = {
  kpi: 128,
  table: 320,
  chart: 360,
  text: 160,
  filter: 88,
};

// A small, fixed set of accent hues (see index.css's --dash-accent-0..5
// tokens, themed for both light and dark) a kpi tile's icon chip rotates
// through - deterministic per block so the same tile always gets the same
// color/icon pair rather than flickering between renders, and varied
// enough across a page of tiles to read the way the reference dashboards'
// stat cards do (each one its own color) without ever needing per-block
// color configuration to exist as real data.
function accentIndex(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 6;
}

function TrendIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </svg>
  );
}
function BarsGlyph({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="12" width="4" height="8" rx="0.5" />
      <rect x="10" y="7" width="4" height="13" rx="0.5" />
      <rect x="16" y="3" width="4" height="17" rx="0.5" />
    </svg>
  );
}
function UsersGlyph({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function TargetGlyph({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}
function LayersGlyph({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 2 8l10 5 10-5-10-5Z" />
      <path d="m2 14 10 5 10-5" />
    </svg>
  );
}
function BoltGlyph({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
    </svg>
  );
}

const KPI_ICONS = [TrendIcon, BarsGlyph, UsersGlyph, TargetGlyph, LayersGlyph, BoltGlyph];

// 2026-09-24 (Dashboard Builder Phase 2): KpiTile/BlockTable/BlockChart are
// now exported - DashboardCanvas.tsx (the new editable canvas) reuses these
// exact same renderers inside each grid cell, so a block looks pixel-
// identical whether you're looking at it in the read-only viewer
// (DashboardBlockGrid below) or dragging it around in edit mode. TextBlock
// is new this round (Phase 2's freeform note block type).
//
// 2026-09-25 (naming fix + premium light theme foundation round): all four
// block renderers below were plain, generic `.card` boxes with no color,
// icon or typographic accent at all - the concrete gap the reference
// screenshots (Zoho ProjectsPlus, Horizon UI, Vision UI) made obvious.
// They now render on the new `.dash-card` treatment (index.css) - a
// larger radius, a soft layered shadow instead of a flat 1px border, and
// a hover lift - plus per-block accents (a colored icon chip on a kpi
// tile, a tinted header on a table, an accent rule on a text note). This
// is additive: `.card` itself is untouched, so nothing outside Dashboard
// Builder changes.
export function KpiTile({ title, config }: { title: string | null; config: any }) {
  const raw = config?.value;
  const isNumber = typeof raw === "number" && Number.isFinite(raw);
  const display = isNumber
    ? raw.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : raw === null || raw === undefined || raw === ""
    ? "—"
    : String(raw);
  const label = title || config?.label || "Value";
  const idx = accentIndex(label);
  const Icon = KPI_ICONS[idx];
  return (
    <div className="dash-card h-full p-5 flex flex-col justify-between gap-4 overflow-hidden">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted truncate">{label}</div>
        <span className={`dash-icon-chip dash-accent-${idx}`}>
          <Icon className="w-[18px] h-[18px]" />
        </span>
      </div>
      <div className="dash-kpi-value text-3xl font-bold truncate">{display}</div>
    </div>
  );
}

export function BlockTable({ title, config }: { title: string | null; config: any }) {
  const columns: string[] = Array.isArray(config?.columns) ? config.columns : [];
  const rows: Record<string, any>[] = Array.isArray(config?.rows) ? config.rows : [];
  return (
    <div className="dash-card h-full p-4 flex flex-col overflow-hidden">
      {title && <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-2.5 shrink-0 truncate">{title}</div>}
      <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="dash-table-head sticky top-0">
            <tr>
              {columns.map((c) => (
                <th key={c} className="text-left font-semibold text-[11px] text-muted uppercase tracking-wide px-3 py-2.5 whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="dash-table-row border-t border-border transition-colors">
                {columns.map((c) => (
                  <td key={c} className="px-3 py-2 whitespace-nowrap tabular-nums">
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
      <ChartCanvas chartSpec={config?.chart_spec} title={title || undefined} dashPremium />
    </div>
  );
}

export function TextBlock({ title, config }: { title: string | null; config: any }) {
  const text: string = typeof config?.text === "string" ? config.text : "";
  return (
    <div className="dash-card h-full p-5 overflow-auto">
      {title && <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-2.5 truncate">{title}</div>}
      {text ? (
        <div className="dash-note-quote pl-3.5 text-sm leading-relaxed whitespace-pre-wrap text-text">{text}</div>
      ) : (
        <div className="text-sm text-muted italic">Empty note.</div>
      )}
    </div>
  );
}

// 2026-09-24 (Dashboard Builder Phase 2b): a filter block's own control -
// a plain dropdown of that column's distinct values (reusing the existing
// Data-tab distinct-values endpoint, same as the Excel-style filter panel
// in DataTable.tsx uses - no new backend endpoint just for this list).
// Used both here (Preview mode) and inside DashboardCanvas's BlockCard
// (edit mode) - one control, one behavior, everywhere it's interactive.
// The SELECTED VALUE is never fetched from or written to the server; it
// comes in as `value` and goes out through `onChange` - see
// lib/useDashboardFilters.ts for where that state actually lives.
export function FilterControl({
  block,
  datasourceId,
  value,
  onChange,
}: {
  block: DashboardBlock;
  datasourceId: string | null;
  value: string;
  onChange: (value: string) => void;
}) {
  const column: string | null = block.config?.column || null;
  const [values, setValues] = useState<{ value: string | number | boolean | null; count: number }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!column || !datasourceId) {
      setValues([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    datasourceApi
      .getColumnDistinctValues(datasourceId, column, null, { limit: 200 })
      .then((res) => {
        if (!cancelled) setValues(res.values);
      })
      .catch(() => {
        if (!cancelled) setValues([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [column, datasourceId]);

  return (
    <div className="dash-card h-full p-3 flex flex-col justify-center gap-1.5 overflow-hidden">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted truncate">
        {block.title || column || "Filter"}
      </div>
      {!column ? (
        <div className="text-xs text-muted italic">Not set up yet.</div>
      ) : (
        <select className="input text-xs py-1.5" value={value} onChange={(e) => onChange(e.target.value)} disabled={loading}>
          <option value="">All</option>
          {values.map((v) => (
            <option key={String(v.value)} value={String(v.value)}>
              {String(v.value)} ({v.count})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// The public/no-login view's stand-in for a filter block - see this
// file's own top comment and the backend module docstring (Phase 2b,
// point 3) for why cross-filtering isn't wired up there yet: recomputing
// against a customer's own connected data source from an unauthenticated
// link with no rate limiting is a real cost/security question this round
// deliberately didn't answer with "just allow it."
function StaticFilterNote({ block }: { block: DashboardBlock }) {
  const column: string | null = block.config?.column || null;
  return (
    <div className="dash-card h-full p-3 flex flex-col justify-center gap-1 opacity-70">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted truncate">
        {block.title || column || "Filter"}
      </div>
      <div className="text-xs text-muted italic">Filtering isn&apos;t available on the public link yet.</div>
    </div>
  );
}

export function DashboardBlockGrid({
  blocks,
  datasourceId,
  filterState,
}: {
  blocks: DashboardBlock[];
  // Both optional - a caller that omits filterState (PublicDashboardView)
  // gets every block exactly as saved, with a filter block rendered as an
  // inert StaticFilterNote instead of a live control.
  datasourceId?: string | null;
  filterState?: DashboardFilterState;
}) {
  const narrow = useIsNarrow();

  if (blocks.length === 0) {
    return <div className="text-sm text-muted py-10 text-center">This page has no blocks yet.</div>;
  }

  const renderBlock = (b: DashboardBlock) => {
    // A block currently recomputed by an active cross-filter (Phase 2b) -
    // overrides only ever cover a block with a stored `recipe` (see
    // ManualRecipe in api/client.ts); everything else renders its own
    // real, persisted content untouched.
    const override = filterState?.overrides[b.id];
    const type = override?.type ?? b.type;
    const config = override?.config ?? b.config;
    return (
      <>
        {type === "kpi" && <KpiTile title={b.title} config={config} />}
        {type === "table" && <BlockTable title={b.title} config={config} />}
        {type === "chart" && <BlockChart title={b.title} config={config} />}
        {type === "text" && <TextBlock title={b.title} config={config} />}
        {type === "filter" &&
          (filterState ? (
            <FilterControl
              block={b}
              datasourceId={datasourceId || null}
              value={filterState.values[b.id] || ""}
              onChange={(v) => filterState.setFilterValue(b.id, v)}
            />
          ) : (
            <StaticFilterNote block={b} />
          ))}
      </>
    );
  };

  // 2026-09-25: below the phone/small-tablet breakpoint, the desktop-tuned
  // 12-column absolute grid gives way to a plain stacked column, ordered
  // top-to-bottom / left-to-right the way it was laid out on the real
  // grid, each block full width with a sensible natural height for its
  // type. Same blocks, same data - just readable on a real phone.
  if (narrow) {
    const ordered = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);
    return (
      <div className="flex flex-col gap-4">
        {ordered.map((b) => (
          <div key={b.id} style={{ minHeight: STACK_MIN_HEIGHT[b.type] ?? 200 }}>
            {renderBlock(b)}
          </div>
        ))}
      </div>
    );
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
          {renderBlock(b)}
        </div>
      ))}
    </div>
  );
}
