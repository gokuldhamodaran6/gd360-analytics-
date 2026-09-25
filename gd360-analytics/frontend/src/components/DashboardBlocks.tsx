import { useEffect, useMemo, useState } from "react";
import ChartCanvas from "./ChartCanvas";
import { datasourceApi, DashboardBlock, DashboardBlockType } from "../api/client";
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

export function useIsNarrow(breakpoint = NARROW_BREAKPOINT) {
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
//
// 2026-09-25e (responsive pass): exported so DashboardCanvas.tsx (the
// owner's edit view) can size its own narrow-mode stacked blocks off the
// exact same numbers Preview/the public viewer already use here - one
// table of "how tall should a kpi/table/chart/etc. be when stacked",
// never two tables that could quietly drift apart.
export const STACK_MIN_HEIGHT: Record<string, number> = {
  kpi: 128,
  table: 320,
  chart: 360,
  text: 160,
  filter: 88,
  // 2026-09-25 (Round 3): the four new native widget types - see this
  // file's own KpiTile/BlockTable comment block for the general pattern
  // these follow (GaugeBlock/DonutBlock/SparklineBlock/AvatarListBlock,
  // just below TextBlock).
  gauge: 240,
  donut: 320,
  sparkline: 200,
  avatar_list: 280,
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
function ResetSwatchIcon({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 1 2.64 6.36" />
      <path d="M3 21v-6h6" />
    </svg>
  );
}

// 2026-09-25h (inline editing round): a kpi tile's color used to be
// entirely automatic (accentIndex's deterministic hash of its own label) -
// no way to change it short of renaming the tile and hoping for a
// different hash. `editable`/`onAccentColorChange` (only ever passed by
// DashboardCanvas.tsx's edit-mode BlockCard, never by the read-only
// DashboardBlockGrid below) add a small color swatch directly on the tile
// - click it, pick a color, done - plus a tiny reset control once a
// custom color is set. Pure presentation: config.accent_color rides
// alongside the tile's real value/label but never touches them (see the
// backend's set_block_accent_color for why this is its own endpoint
// rather than a generic config write). No custom color set = exactly the
// same automatic palette as before, so every existing dashboard looks
// unchanged until someone actually clicks the swatch.
export function KpiTile({
  title,
  config,
  editable,
  onAccentColorChange,
}: {
  title: string | null;
  config: any;
  editable?: boolean;
  onAccentColorChange?: (color: string | null) => void;
}) {
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
  const customColor: string | null = typeof config?.accent_color === "string" && config.accent_color ? config.accent_color : null;
  const accentCss = customColor || `rgb(var(--dash-accent-${idx}))`;
  return (
    <div
      className="dash-card dash-card--accented h-full p-5 flex flex-col justify-between gap-4 overflow-hidden relative"
      style={{ "--dash-card-accent-color": accentCss } as any}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted truncate">{label}</div>
        <span
          className={`dash-icon-chip ${customColor ? "" : `dash-accent-${idx}`}`}
          style={customColor ? { background: `${customColor}26`, color: customColor } : undefined}
        >
          <Icon className="w-[18px] h-[18px]" />
        </span>
      </div>
      <div className="dash-kpi-value text-3xl font-bold truncate">{display}</div>

      {editable && onAccentColorChange && (
        <div className="no-drag absolute bottom-2.5 right-2.5 flex items-center gap-1">
          {customColor && (
            <button
              type="button"
              className="w-5 h-5 rounded-full bg-surface2 border border-border text-muted hover:text-text transition flex items-center justify-center"
              title="Reset to the automatic color"
              onClick={() => onAccentColorChange(null)}
            >
              <ResetSwatchIcon />
            </button>
          )}
          <label
            className="w-5 h-5 rounded-full border-2 border-surface shadow cursor-pointer block"
            style={{ background: accentCss }}
            title="Click to choose this tile's color"
          >
            <input
              type="color"
              className="sr-only"
              value={customColor || "#2d8267"}
              onChange={(e) => onAccentColorChange(e.target.value)}
            />
          </label>
        </div>
      )}
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

// 2026-09-25 (Round 3): four new native widget types, matching the
// reference dashboards' own radial meters, curved-legend donuts, half-tone
// trend bars, and ranked leaderboard lists - hand-built with inline SVG/CSS
// on the same dash-card/dash-accent-N tokens every other block uses, not a
// relabeled Plotly chart (see routers/dashboard_builder.py's own module
// docstring, Round 3 section, for the exact config shape each one reads
// and why these are manual-build-only this round). All four render
// identically in the read-only grid below and inside DashboardCanvas.tsx's
// edit-mode BlockCard, same convention as KpiTile/BlockTable/BlockChart.

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

// A single metric read as progress toward a target on a 270-degree radial
// arc (a 90-degree gap at the bottom) - the classic "gauge meter" read used
// throughout the Vision UI / Horizon-class admin dashboards this round's
// reference screenshots draw from. config: {value, min, max, target, label}.
export function GaugeBlock({ title, config }: { title: string | null; config: any }) {
  const value = typeof config?.value === "number" ? config.value : 0;
  const min = typeof config?.min === "number" ? config.min : 0;
  const max = typeof config?.max === "number" && config.max > min ? config.max : Math.max(value, min + 1);
  const target = typeof config?.target === "number" ? config.target : null;
  const label = title || config?.label || "Progress";
  const idx = accentIndex(label);

  const cx = 100, cy = 100, r = 72, strokeW = 14;
  const startAngle = 135, sweep = 270;
  const pct = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const [x0, y0] = polar(cx, cy, r, startAngle);
  const [x1, y1] = polar(cx, cy, r, startAngle + sweep);
  const trackPath = `M ${x0} ${y0} A ${r} ${r} 0 1 1 ${x1} ${y1}`;
  const valueAngle = startAngle + sweep * pct;
  const [xv, yv] = polar(cx, cy, r, valueAngle);
  const valueLargeArc = sweep * pct > 180 ? 1 : 0;
  const valuePath = pct > 0 ? `M ${x0} ${y0} A ${r} ${r} 0 ${valueLargeArc} 1 ${xv} ${yv}` : "";

  let targetTick: [number, number, number, number] | null = null;
  if (target !== null && target >= min && target <= max) {
    const tAngle = startAngle + sweep * ((target - min) / (max - min));
    const [tx0, ty0] = polar(cx, cy, r - 11, tAngle);
    const [tx1, ty1] = polar(cx, cy, r + 11, tAngle);
    targetTick = [tx0, ty0, tx1, ty1];
  }

  const display = value.toLocaleString(undefined, { maximumFractionDigits: 2 });

  return (
    <div className="dash-card h-full p-5 flex flex-col gap-1 overflow-hidden">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted truncate">{label}</div>
        <span className={`dash-icon-chip dash-accent-${idx}`}>
          <TargetGlyph className="w-[18px] h-[18px]" />
        </span>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <svg viewBox="0 0 200 175" className="w-full h-full max-w-[240px]" role="img" aria-label={`${label}: ${display}`}>
          <path d={trackPath} fill="none" stroke="rgb(var(--color-border))" strokeWidth={strokeW} strokeLinecap="round" />
          {valuePath && (
            <path d={valuePath} fill="none" stroke={`rgb(var(--dash-accent-${idx}))`} strokeWidth={strokeW} strokeLinecap="round" />
          )}
          {targetTick && (
            <line x1={targetTick[0]} y1={targetTick[1]} x2={targetTick[2]} y2={targetTick[3]} stroke="rgb(var(--color-text))" strokeWidth="2.5" strokeLinecap="round" />
          )}
          <text x={cx} y={cy + 6} textAnchor="middle" style={{ fontSize: "27px", fontWeight: 700, fill: "rgb(var(--color-text))" }} className="dash-kpi-value">
            {display}
          </text>
        </svg>
      </div>
      {target !== null && (
        <div className="text-[11px] text-muted text-center -mt-2">
          Target {target.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </div>
      )}
    </div>
  );
}

// A category breakdown with a curved connector-line legend - each slice's
// label sits out past the ring, joined by a short curved leader line, the
// PowerBI-style donut callout the reference screenshots use. Capped
// server-side to the top 6 categories + "Other" (see _run_manual_recipe) so
// the legend never overlaps itself. config: {items: [{label, value}]}.
export function DonutBlock({ title, config }: { title: string | null; config: any }) {
  const items: { label: string; value: number }[] = Array.isArray(config?.items) ? config.items : [];
  const total = items.reduce((s, it) => s + (typeof it.value === "number" ? it.value : 0), 0);

  if (items.length === 0 || total <= 0) {
    return (
      <div className="dash-card h-full p-5 flex flex-col overflow-hidden">
        {title && <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-2 truncate">{title}</div>}
        <div className="flex-1 flex items-center justify-center text-sm text-muted italic">No data yet.</div>
      </div>
    );
  }

  const cx = 150, cy = 108, rOuter = 66, rInner = 40, labelR = 94;
  let cursor = -90;
  const segments = items.map((it, i) => {
    const val = typeof it.value === "number" ? it.value : 0;
    const frac = val / total;
    const startA = cursor;
    const endA = startA + frac * 360;
    cursor = endA;
    return { label: it.label, value: val, pct: frac, startA, endA, midA: (startA + endA) / 2, idx: i % 6 };
  });

  const arcPath = (startA: number, endA: number) => {
    const [x0, y0] = polar(cx, cy, rOuter, startA);
    const [x1, y1] = polar(cx, cy, rOuter, endA);
    const [ix1, iy1] = polar(cx, cy, rInner, endA);
    const [ix0, iy0] = polar(cx, cy, rInner, startA);
    const large = endA - startA > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1} L ${ix1} ${iy1} A ${rInner} ${rInner} 0 ${large} 0 ${ix0} ${iy0} Z`;
  };

  return (
    <div className="dash-card h-full p-5 flex flex-col overflow-hidden">
      {title && <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-1 truncate">{title}</div>}
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <svg viewBox="0 0 300 216" className="w-full h-full" role="img" aria-label={title || "Breakdown"}>
          {segments.map((s) => (
            <path key={s.idx} d={arcPath(s.startA, s.endA)} fill={`rgb(var(--dash-accent-${s.idx}))`} stroke="rgb(var(--color-surface))" strokeWidth="2" />
          ))}
          <text x={cx} y={cy - 3} textAnchor="middle" style={{ fontSize: "19px", fontWeight: 700, fill: "rgb(var(--color-text))" }}>
            {total.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </text>
          <text x={cx} y={cy + 14} textAnchor="middle" style={{ fontSize: "10px", fill: "rgb(var(--color-muted))" }}>
            Total
          </text>
          {segments.map((s) => {
            const [sx, sy] = polar(cx, cy, (rOuter + rInner) / 2, s.midA);
            const [mx, my] = polar(cx, cy, rOuter + 14, s.midA);
            const [ex, ey] = polar(cx, cy, labelR, s.midA);
            const isRight = Math.cos((s.midA * Math.PI) / 180) >= 0;
            const labelX = ex + (isRight ? 6 : -6);
            return (
              <g key={`leg-${s.idx}-${s.label}`}>
                <path d={`M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`} fill="none" stroke={`rgb(var(--dash-accent-${s.idx}))`} strokeWidth="1.5" opacity="0.7" />
                <circle cx={ex} cy={ey} r="2.2" fill={`rgb(var(--dash-accent-${s.idx}))`} />
                <text x={labelX} y={ey - 1} textAnchor={isRight ? "start" : "end"} style={{ fontSize: "10px", fontWeight: 600, fill: "rgb(var(--color-text))" }}>
                  {s.label.length > 16 ? `${s.label.slice(0, 15)}…` : s.label}
                </text>
                <text x={labelX} y={ey + 11} textAnchor={isRight ? "start" : "end"} style={{ fontSize: "9px", fill: "rgb(var(--color-muted))" }}>
                  {Math.round(s.pct * 100)}%
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// A compact trend tile - the current value, an up/down delta badge, and a
// half-tone bar sparkline underneath (older bars fade in, the latest bar
// solid) - the "half-tone bar" trend read from the reference dashboards.
// config: {value, series, categories, delta_pct}.
export function SparklineBlock({ title, config }: { title: string | null; config: any }) {
  const rawSeries: unknown[] = Array.isArray(config?.series) ? config.series : [];
  const series: number[] = rawSeries.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const label = title || config?.label || "Trend";
  const idx = accentIndex(label);
  const value = typeof config?.value === "number" ? config.value : series[series.length - 1];
  const deltaPct = typeof config?.delta_pct === "number" ? config.delta_pct : null;
  const max = series.length ? Math.max(...series, 0) : 1;
  const min = series.length ? Math.min(...series, 0) : 0;
  const range = max - min || 1;
  const display = typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—";
  const up = deltaPct !== null && deltaPct >= 0;

  return (
    <div className="dash-card h-full p-5 flex flex-col justify-between gap-3 overflow-hidden">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted truncate">{label}</div>
        <span className={`dash-icon-chip dash-accent-${idx}`}>
          <TrendIcon className="w-[18px] h-[18px]" />
        </span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="dash-kpi-value text-2xl font-bold truncate">{display}</div>
        {deltaPct !== null && (
          <span
            className="text-[11px] font-semibold px-1.5 py-0.5 rounded-md shrink-0"
            style={{
              color: up ? "rgb(var(--dash-accent-2))" : "rgb(var(--dash-accent-5))",
              background: `rgb(var(--dash-accent-${up ? 2 : 5}) / 0.12)`,
            }}
          >
            {up ? "▲" : "▼"} {Math.abs(deltaPct).toFixed(1)}%
          </span>
        )}
      </div>
      {series.length > 1 ? (
        <div className="flex items-end gap-[3px] h-10">
          {series.map((v, i) => {
            const h = Math.max(8, ((v - min) / range) * 100);
            const isLast = i === series.length - 1;
            const opacity = isLast ? 0.95 : 0.22 + (i / Math.max(1, series.length - 1)) * 0.45;
            return (
              <div
                key={i}
                className="flex-1 rounded-sm min-w-[2px]"
                style={{ height: `${h}%`, background: `rgb(var(--dash-accent-${idx}) / ${opacity})` }}
              />
            );
          })}
        </div>
      ) : (
        <div className="text-[11px] text-muted italic">Not enough points for a trend yet.</div>
      )}
    </div>
  );
}

function initials(name: string): string {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// A ranked leaderboard - rank, an initials "avatar" chip, name, value, and
// a thin relative-share bar - the top-N banner list style from the
// reference dashboards. Capped server-side to the top 8 (see
// _run_manual_recipe). config: {items: [{rank, name, value}], label}.
export function AvatarListBlock({ title, config }: { title: string | null; config: any }) {
  const items: { rank?: number; name: string; value: number }[] = Array.isArray(config?.items) ? config.items : [];
  const label = title || config?.label || "Top list";
  const max = items.length ? Math.max(...items.map((it) => (typeof it.value === "number" ? it.value : 0)), 1) : 1;

  return (
    <div className="dash-card h-full p-4 flex flex-col overflow-hidden">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-3 shrink-0 truncate">{label}</div>
      <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-2.5">
        {items.length === 0 && <div className="text-sm text-muted italic">No data yet.</div>}
        {items.map((it, i) => {
          const idx = accentIndex(it.name || String(i));
          const val = typeof it.value === "number" ? it.value : 0;
          const pct = Math.max(4, (val / max) * 100);
          return (
            <div key={i} className="flex items-center gap-2.5">
              <span className="text-[10px] font-semibold text-muted w-4 shrink-0 text-right tabular-nums">{it.rank ?? i + 1}</span>
              <span className={`dash-icon-chip dash-icon-chip--sm dash-accent-${idx}`}>{initials(it.name)}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium truncate">{it.name}</span>
                  <span className="text-xs font-semibold tabular-nums shrink-0">
                    {val.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-surface2 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: `rgb(var(--dash-accent-${idx}))` }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
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

  // 2026-09-25e (elite pass): a filter used to be its own small dash-card -
  // a bordered, backgrounded box, same chrome as a KPI tile - which is
  // exactly why a row of them read as scattered little widgets instead of
  // the clean, label-over-control filter bar in the reference dashboards
  // Gokul sent (a plain label above a plain bordered select, no card
  // around either). Dropped the card entirely: a filter block is now just
  // its label and its control sitting straight on the page, so several of
  // them placed in a row read as one continuous, premium filter strip
  // instead of N separate boxes.
  return (
    <div className="h-full flex flex-col justify-center gap-1.5 min-w-0">
      <label className="text-[13px] font-medium text-muted truncate">{block.title || column || "Filter"}</label>
      {!column ? (
        <div className="text-xs text-muted italic">Not set up yet.</div>
      ) : (
        <select
          className="dash-select w-full"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={loading}
        >
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
    <div className="h-full flex flex-col justify-center gap-1.5 opacity-60 min-w-0">
      <label className="text-[13px] font-medium text-muted truncate">{block.title || column || "Filter"}</label>
      <div className="dash-select w-full pointer-events-none">All</div>
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
        {/* accent_color always comes from the block's own real config, not
            an active filter override - same reasoning as
            DashboardCanvas.tsx's edit-mode BlockCard. */}
        {type === "kpi" && <KpiTile title={b.title} config={{ ...config, accent_color: b.config?.accent_color }} />}
        {type === "table" && <BlockTable title={b.title} config={config} />}
        {type === "chart" && <BlockChart title={b.title} config={config} />}
        {type === "text" && <TextBlock title={b.title} config={config} />}
        {type === "gauge" && <GaugeBlock title={b.title} config={config} />}
        {type === "donut" && <DonutBlock title={b.title} config={config} />}
        {type === "sparkline" && <SparklineBlock title={b.title} config={config} />}
        {type === "avatar_list" && <AvatarListBlock title={b.title} config={config} />}
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

// 2026-09-25g (live-data freshness round): a real "Data updated Xm ago"
// trust signal, shared by both the owner's Preview (DashboardBuilderView)
// and the anonymous public viewer (PublicDashboardView) - top design-
// trends priority from this round's research, and the one flagged as
// especially valuable on a shared/public dashboard someone outside GD360
// is looking at. Deliberately honest rather than a fake "live" pulse: this
// app has no auto-refreshing data pipeline, so what actually changes is
// when a block's numbers were last (re)computed by someone asking AI or
// building manually - exactly what backend DashboardBlock.data_updated_at
// tracks (see its own docstring for precisely which actions advance it).
// A block with no real computed data yet (never built, or an empty text/
// filter block) never counts toward this - nothing here is ever guessed.
const DATA_BLOCK_TYPES: DashboardBlockType[] = ["chart", "table", "kpi", "gauge", "donut", "sparkline", "avatar_list"];

function hasComputedData(block: DashboardBlock): boolean {
  return DATA_BLOCK_TYPES.includes(block.type) && !!block.config && Object.keys(block.config).length > 0;
}

function formatRelativeTime(whenMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.round((nowMs - whenMs) / 1000));
  if (diffSec < 45) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return new Date(whenMs).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function DataFreshnessBadge({ blocks }: { blocks: DashboardBlock[] }) {
  // Ticks every 30s purely to re-render this one small label so "2 minutes
  // ago" quietly becomes "3 minutes ago" without the person ever
  // refreshing the page - not a data refetch, just a clock tick.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const latestMs = useMemo(() => {
    let latest = 0;
    for (const b of blocks) {
      if (!hasComputedData(b) || !b.data_updated_at) continue;
      const t = new Date(b.data_updated_at).getTime();
      if (!Number.isNaN(t) && t > latest) latest = t;
    }
    return latest;
  }, [blocks]);

  if (latestMs === 0) return null;

  return (
    <div
      className="inline-flex items-center gap-1.5 text-[11px] text-muted"
      title={`Last computed ${new Date(latestMs).toLocaleString()}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
      Data updated {formatRelativeTime(latestMs, now)}
    </div>
  );
}
