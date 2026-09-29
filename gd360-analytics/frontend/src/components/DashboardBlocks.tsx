import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ChartCanvas from "./ChartCanvas";
import { datasourceApi, DashboardBlock, DashboardBlockType, ColumnFilterSpec, FilterTextOp, FilterNumberOp, FilterCriterion } from "../api/client";
import { DashboardFilterState } from "../lib/useDashboardFilters";
import { applyChartStyle, defaultChartStyle, ChartStyle } from "../lib/chartStyle";

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
  // 2026-09-25 (Round 15, element library): heading/divider are the two
  // pure-layout widgets - see HeadingBlock/DividerBlock below.
  heading: 64,
  divider: 40,
};

// 2026-09-25 (Round 15, element library): the (w, h) grid units a freshly
// dropped block should preview at while it's being dragged over the
// canvas, BEFORE the create-block call that actually decides its real
// size lands - see DashboardCanvas.tsx's onDrop/droppingItem. Kept as its
// own table (not derived from STACK_MIN_HEIGHT above, which is pixel
// heights for the narrow-mode stack, a different unit) so it can mirror
// the backend's own _default_block_size in routers/dashboard_builder.py
// exactly, number for number - if one ever changes, this one should too.
export const BLOCK_DEFAULT_SIZE: Record<DashboardBlockType, { w: number; h: number }> = {
  kpi: { w: 3, h: 3 },
  gauge: { w: 4, h: 4 },
  sparkline: { w: 4, h: 4 },
  text: { w: 6, h: 3 },
  filter: { w: 3, h: 2 },
  heading: { w: 12, h: 2 },
  divider: { w: 12, h: 1 },
  chart: { w: 6, h: 6 },
  table: { w: 6, h: 6 },
  donut: { w: 6, h: 6 },
  avatar_list: { w: 6, h: 6 },
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

// 2026-09-25i (inline editing round): a `#rrggbb` custom color needs a
// translucent version of itself for chip backgrounds and (for
// SparklineBlock) per-bar fade - the same trick KpiTile already used as a
// one-off literal string concat (`${customColor}26`). Pulled out as a real
// helper now that a second and third block type need the same math with a
// non-fixed alpha, rather than quietly copy-pasting a magic "26" three
// more times. alpha is a 0-1 fraction, same units as the CSS
// rgb(.../0.14) syntax the automatic accent-N classes use.
function hexWithAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

// 2026-09-25i (inline editing round): the actual swatch control (reset
// button + color-picker circle) factored out of KpiTile, which had it as
// inline markup, now that BlockTable/GaugeBlock/SparklineBlock need the
// exact same control. Purely presentational - the caller owns computing
// customColor/accentCss and persisting the change via onAccentColorChange
// (see set_block_accent_color on the backend for why this is its own
// endpoint). Always absolutely positioned bottom-right by the caller's own
// `relative` wrapper, same spot on every block type so it reads as one
// consistent affordance across the dashboard.
function AccentSwatch({
  customColor,
  accentCss,
  onAccentColorChange,
}: {
  customColor: string | null;
  accentCss: string;
  onAccentColorChange: (color: string | null) => void;
}) {
  return (
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
        title="Click to choose this block's color"
      >
        <input
          type="color"
          className="sr-only"
          value={customColor || "#2d8267"}
          onChange={(e) => onAccentColorChange(e.target.value)}
        />
      </label>
    </div>
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
        <AccentSwatch customColor={customColor} accentCss={accentCss} onAccentColorChange={onAccentColorChange} />
      )}
    </div>
  );
}

// 2026-09-25i (inline editing round): unlike KpiTile/GaugeBlock/
// SparklineBlock, a table has never had any automatic per-instance color
// (accentIndex hashes a *label*, and a table's title is often blank or
// generic like "Rows") - so there is no honest "automatic" accent to fall
// back to here, only ever a deliberately-picked one. That's why
// customColor has no `|| automaticColor` fallback below, and why the
// accent border only ever renders once config.accent_color is actually
// set: showing a colored border by default would be inventing an accent
// that was never really there, exactly the kind of fabricated default this
// build avoids elsewhere. No custom color set = the exact same plain table
// as before this round.
export function BlockTable({
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
  const columns: string[] = Array.isArray(config?.columns) ? config.columns : [];
  const rows: Record<string, any>[] = Array.isArray(config?.rows) ? config.rows : [];
  const customColor: string | null = typeof config?.accent_color === "string" && config.accent_color ? config.accent_color : null;
  return (
    <div
      className={`dash-card h-full p-4 flex flex-col overflow-hidden relative ${customColor ? "dash-card--accented" : ""}`}
      style={customColor ? ({ "--dash-card-accent-color": customColor } as any) : undefined}
    >
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
      {editable && onAccentColorChange && (
        <AccentSwatch
          customColor={customColor}
          accentCss={customColor || "rgb(var(--color-border))"}
          onAccentColorChange={onAccentColorChange}
        />
      )}
    </div>
  );
}

export function BlockChart({
  title,
  config,
  onMinHeight,
}: {
  title: string | null;
  config: any;
  // 2026-09-29 (design revamp): forwarded straight through to ChartCanvas -
  // see its own comment on this prop. Only BlockCard (DashboardCanvas.tsx)
  // ever passes it.
  onMinHeight?: (px: number) => void;
}) {
  // 2026-09-28: an honest "checked, found none" hint for the "Show
  // anomalies" toggle - anomaly_count is only ever a real int (never
  // fabricated - see chart_builder.py's apply_analysis_overlays) once the
  // toggle has actually been turned on, so === 0 here means the robust
  // z-score check genuinely ran and genuinely found nothing unusual, not
  // that it was skipped. Same low-key italic caption style as this file's
  // other small inline notes (see TextBlock's "Empty note." above).
  const showNoAnomaliesHint = config?.anomalies_enabled && config?.anomaly_count === 0;

  // 2026-09-29 (design revamp): a Dashboard Builder chart used to render
  // straight off the backend's raw figure JSON - chart_builder.py's own
  // fixed defaults (real fixes in their own right - see that file's round-1
  // revamp comments - but never anything a person here could choose) with
  // NONE of lib/chartStyle.ts's premium styling engine (rounded bars,
  // smooth lines, palette choice, smart legend/margins) ever applied, the
  // way the live Workspace chart (ExplorePanel.tsx) already gets it. Every
  // dashboard chart now runs through that exact same engine: `chart_style`
  // is an optional partial ChartStyle a person can set from this block's
  // own "Chart style" panel (see StylePanel's Colors section in
  // DashboardCanvas.tsx, which persists it via updateBlock) - anything left
  // unset falls back to defaultChartStyle's own data-shape-aware defaults
  // (e.g. no legend on a single-series chart), exactly as the Workspace
  // chart already does. `title` is only ever used as a FALLBACK inside
  // applyChartStyle (a real existing chart_spec.layout.title always wins),
  // so this never overwrites a chart's own already-meaningful title with
  // this block's shorter card-header title.
  const styledSpec = useMemo(() => {
    if (!config?.chart_spec) return config?.chart_spec;
    const style: ChartStyle = { ...defaultChartStyle(config.chart_spec), ...(config?.chart_style || {}) };
    return applyChartStyle(config.chart_spec, style, title || undefined);
  }, [config?.chart_spec, config?.chart_style, title]);

  return (
    <div className="h-full flex flex-col">
      {showNoAnomaliesHint && (
        <div className="shrink-0 text-[11px] text-muted italic px-2 pt-1 pb-0.5">No unusual points detected.</div>
      )}
      <div className="flex-1 min-h-0">
        <ChartCanvas chartSpec={styledSpec} title={title || undefined} dashPremium onMinHeight={onMinHeight} />
      </div>
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

// 2026-09-25 (Round 15, element library): the first of two pure-layout
// widgets the element library adds - a section banner, not a data block.
// Its content lives in the exact same config.text field a "text" block
// uses (edited the same way in DashboardCanvas.tsx's BlockCard, just
// through a single-line input instead of a textarea) - it's the same
// "the person typed this themselves" content, just meant to read big and
// bold above whatever follows it rather than as a note.
export function HeadingBlock({ config }: { title: string | null; config: any }) {
  const text: string = typeof config?.text === "string" ? config.text : "";
  return (
    <div className="h-full flex items-center px-1">
      {text ? (
        <h2 className="text-xl font-bold text-text truncate w-full" style={{ textWrap: "balance" }}>
          {text}
        </h2>
      ) : (
        <span className="text-xl font-bold text-muted italic">Untitled heading</span>
      )}
    </div>
  );
}

// 2026-09-25 (Round 15, element library): the second pure-layout widget -
// a plain horizontal rule to separate sections of a page. It has no
// config at all (see backend _default_block_config: it isn't special-
// cased there, so it just gets {}) and nothing to ever edit, so it's the
// one block type BlockCard renders directly in edit mode too instead of
// giving it its own inline-editable control - there's no content for one
// to hold.
export function DividerBlock() {
  return (
    <div className="h-full flex items-center px-1">
      <hr className="w-full border-t border-border" />
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
export function GaugeBlock({
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
  const value = typeof config?.value === "number" ? config.value : 0;
  const min = typeof config?.min === "number" ? config.min : 0;
  const max = typeof config?.max === "number" && config.max > min ? config.max : Math.max(value, min + 1);
  const target = typeof config?.target === "number" ? config.target : null;
  const label = title || config?.label || "Progress";
  const idx = accentIndex(label);
  const customColor: string | null = typeof config?.accent_color === "string" && config.accent_color ? config.accent_color : null;
  const accentCss = customColor || `rgb(var(--dash-accent-${idx}))`;

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
    <div className="dash-card h-full p-5 flex flex-col gap-1 overflow-hidden relative">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted truncate">{label}</div>
        <span
          className={`dash-icon-chip ${customColor ? "" : `dash-accent-${idx}`}`}
          style={customColor ? { background: hexWithAlpha(customColor, 0.14), color: customColor } : undefined}
        >
          <TargetGlyph className="w-[18px] h-[18px]" />
        </span>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <svg viewBox="0 0 200 175" className="w-full h-full max-w-[240px]" role="img" aria-label={`${label}: ${display}`}>
          <path d={trackPath} fill="none" stroke="rgb(var(--color-border))" strokeWidth={strokeW} strokeLinecap="round" />
          {valuePath && (
            <path d={valuePath} fill="none" stroke={accentCss} strokeWidth={strokeW} strokeLinecap="round" />
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
      {editable && onAccentColorChange && (
        <AccentSwatch customColor={customColor} accentCss={accentCss} onAccentColorChange={onAccentColorChange} />
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
export function SparklineBlock({
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
  const rawSeries: unknown[] = Array.isArray(config?.series) ? config.series : [];
  const series: number[] = rawSeries.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const label = title || config?.label || "Trend";
  const idx = accentIndex(label);
  const customColor: string | null = typeof config?.accent_color === "string" && config.accent_color ? config.accent_color : null;
  const value = typeof config?.value === "number" ? config.value : series[series.length - 1];
  const deltaPct = typeof config?.delta_pct === "number" ? config.delta_pct : null;
  const max = series.length ? Math.max(...series, 0) : 1;
  const min = series.length ? Math.min(...series, 0) : 0;
  const range = max - min || 1;
  const display = typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—";
  const up = deltaPct !== null && deltaPct >= 0;

  return (
    <div className="dash-card h-full p-5 flex flex-col justify-between gap-3 overflow-hidden relative">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted truncate">{label}</div>
        <span
          className={`dash-icon-chip ${customColor ? "" : `dash-accent-${idx}`}`}
          style={customColor ? { background: hexWithAlpha(customColor, 0.14), color: customColor } : undefined}
        >
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
                style={{
                  height: `${h}%`,
                  background: customColor ? hexWithAlpha(customColor, opacity) : `rgb(var(--dash-accent-${idx}) / ${opacity})`,
                }}
              />
            );
          })}
        </div>
      ) : (
        <div className="text-[11px] text-muted italic">Not enough points for a trend yet.</div>
      )}
      {editable && onAccentColorChange && (
        <AccentSwatch
          customColor={customColor}
          accentCss={customColor || `rgb(var(--dash-accent-${idx}))`}
          onAccentColorChange={onAccentColorChange}
        />
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

// 2026-09-29 (Hex-level filters round): "ranges, multi-select, per-chart
// filtering... beyond the current single-column equality filter" - the
// user's own words, reacting to the fact that a filter block used to be a
// plain dropdown of exact values with no way to express "between $100 and
// $300" or "West OR East" in one filter. dtypeGroup/isSpecActive/
// describeFilterSpec/ColumnFilterSpecEditor below are the shared engine
// behind BOTH a filter block's own control (FilterControl, just below)
// and per-chart filtering (DashboardCanvas.tsx's BlockFilterButton) - one
// operator vocabulary, reused everywhere a person picks a filter, not two
// that could drift apart. This mirrors DataTable.tsx's own local
// ColumnFilterSpec/dtypeGroup (same shape, same backend
// _apply_column_filter reads it) - kept as its own copy here rather than
// imported from that file, matching this codebase's established "kept as
// its own copy" convention (see backend routers/dashboard_builder.py's
// rate limiter for the same reasoning) so this feature can evolve without
// risking a regression on the already-working Data tab.
function dtypeGroup(dtype: string): "number" | "date" | "boolean" | "text" {
  const d = (dtype || "").toLowerCase();
  if (d.startsWith("bool")) return "boolean";
  if (d.startsWith("int") || d.startsWith("float") || d.startsWith("uint") || d.startsWith("double")) return "number";
  if (d.startsWith("datetime") || d.startsWith("date")) return "date";
  return "text";
}

export function isSpecActive(spec: ColumnFilterSpec | null | undefined): boolean {
  if (!spec) return false;
  if (spec.type === "values") return (spec.include || []).length > 0;
  if (spec.type === "text") return spec.op === "is_empty" || spec.op === "is_not_empty" || Boolean(spec.value);
  if (spec.type === "number") return spec.op === "between" ? Boolean(spec.value && spec.value2) : Boolean(spec.value);
  if (spec.type === "date") return Boolean(spec.from) || Boolean(spec.to);
  if (spec.type === "boolean") return spec.value === "true" || spec.value === "false";
  return false;
}

const TEXT_OP_LABELS: Record<FilterTextOp, string> = {
  contains: "contains", not_contains: "does not contain", equals: "is exactly",
  not_equals: "is not", starts_with: "starts with", ends_with: "ends with",
  is_empty: "is blank", is_not_empty: "is not blank",
};
const NUMBER_OP_LABELS: Record<FilterNumberOp, string> = {
  eq: "=", neq: "≠", gt: "greater than", gte: "at least", lt: "less than", lte: "at most", between: "between",
};

export function describeFilterSpec(spec: ColumnFilterSpec | null | undefined): string {
  if (!isSpecActive(spec) || !spec) return "All";
  if (spec.type === "values") {
    const n = (spec.include || []).length;
    if (n === 1) return String(spec.include[0] ?? "(Blanks)");
    return `${n} selected`;
  }
  if (spec.type === "text") {
    const opLabel = TEXT_OP_LABELS[spec.op];
    return spec.op === "is_empty" || spec.op === "is_not_empty" ? opLabel : `${opLabel} "${spec.value}"`;
  }
  if (spec.type === "number") {
    if (spec.op === "between") return `${spec.value}–${spec.value2}`;
    return `${NUMBER_OP_LABELS[spec.op]} ${spec.value}`;
  }
  if (spec.type === "date") {
    if (spec.from && spec.to) return `${spec.from} → ${spec.to}`;
    if (spec.from) return `on/after ${spec.from}`;
    if (spec.to) return `on/before ${spec.to}`;
  }
  if (spec.type === "boolean") return spec.value === "true" ? "True" : "False";
  return "All";
}

function useColumnDtype(datasourceId: string | null, column: string | null, knownDtype?: string): string {
  const [dtype, setDtype] = useState(knownDtype || "");
  useEffect(() => {
    if (knownDtype) {
      setDtype(knownDtype);
      return;
    }
    if (!datasourceId || !column) return;
    let cancelled = false;
    // A cheap (limit=1) call purely to read this data source's dtypes -
    // the same endpoint DashboardCanvas.tsx already calls once for its own
    // column picker (datasourceApi.preview), reused here for callers (like
    // Preview mode) that don't already have that dtype in hand.
    datasourceApi
      .preview(datasourceId, null, 1, 0)
      .then((p) => {
        if (!cancelled) setDtype(p.dtypes[column] || "");
      })
      .catch(() => {
        if (!cancelled) setDtype("");
      });
    return () => {
      cancelled = true;
    };
  }, [datasourceId, column, knownDtype]);
  return dtype;
}

function TextConditionEditor({
  spec,
  onChange,
}: {
  spec: { type: "text"; op: FilterTextOp; value: string } | null;
  onChange: (spec: ColumnFilterSpec | null) => void;
}) {
  const s = spec || { type: "text" as const, op: "contains" as FilterTextOp, value: "" };
  const needsValue = s.op !== "is_empty" && s.op !== "is_not_empty";
  return (
    <>
      <select className="dash-select w-full text-xs" value={s.op} onChange={(e) => onChange({ ...s, op: e.target.value as FilterTextOp })}>
        {(Object.keys(TEXT_OP_LABELS) as FilterTextOp[]).map((op) => (
          <option key={op} value={op}>
            {TEXT_OP_LABELS[op]}
          </option>
        ))}
      </select>
      {needsValue && (
        <input
          className="input text-xs py-1.5"
          value={s.value}
          placeholder="Value…"
          onChange={(e) => onChange({ ...s, value: e.target.value })}
        />
      )}
      {isSpecActive(s) && (
        <button type="button" className="text-[11px] text-muted hover:text-text self-start" onClick={() => onChange(null)}>
          Clear
        </button>
      )}
    </>
  );
}

function NumberConditionEditor({ spec, onChange }: { spec: ColumnFilterSpec | null; onChange: (spec: ColumnFilterSpec | null) => void }) {
  const numSpec = spec?.type === "number" ? spec : { type: "number" as const, op: "between" as FilterNumberOp, value: "", value2: "" };
  return (
    <>
      <select className="dash-select w-full text-xs" value={numSpec.op} onChange={(e) => onChange({ ...numSpec, op: e.target.value as FilterNumberOp })}>
        {(Object.keys(NUMBER_OP_LABELS) as FilterNumberOp[]).map((op) => (
          <option key={op} value={op}>
            {NUMBER_OP_LABELS[op]}
          </option>
        ))}
      </select>
      <div className="flex items-center gap-2">
        <input
          type="number"
          className="input text-xs py-1.5 flex-1 min-w-0"
          placeholder={numSpec.op === "between" ? "Min" : "Value"}
          value={numSpec.value}
          onChange={(e) => onChange({ ...numSpec, value: e.target.value })}
        />
        {numSpec.op === "between" && (
          <input
            type="number"
            className="input text-xs py-1.5 flex-1 min-w-0"
            placeholder="Max"
            value={numSpec.value2 || ""}
            onChange={(e) => onChange({ ...numSpec, value2: e.target.value })}
          />
        )}
      </div>
      {isSpecActive(numSpec) && (
        <button type="button" className="text-[11px] text-muted hover:text-text self-start" onClick={() => onChange(null)}>
          Clear
        </button>
      )}
    </>
  );
}

function DateConditionEditor({ spec, onChange }: { spec: ColumnFilterSpec | null; onChange: (spec: ColumnFilterSpec | null) => void }) {
  const dateSpec = spec?.type === "date" ? spec : { type: "date" as const, from: null, to: null };
  return (
    <>
      <label className="text-[11px] text-muted">From</label>
      <input type="date" className="input text-xs py-1.5" value={dateSpec.from || ""} onChange={(e) => onChange({ ...dateSpec, from: e.target.value || null })} />
      <label className="text-[11px] text-muted mt-1">To</label>
      <input type="date" className="input text-xs py-1.5" value={dateSpec.to || ""} onChange={(e) => onChange({ ...dateSpec, to: e.target.value || null })} />
      {isSpecActive(dateSpec) && (
        <button type="button" className="text-[11px] text-muted hover:text-text self-start mt-1" onClick={() => onChange(null)}>
          Clear
        </button>
      )}
    </>
  );
}

// The actual type-aware operator picker - Values (multi-select checklist)
// + Condition (a comparison/range appropriate to the column's real dtype).
// Shared by FilterControl (a filter block's own control) and
// DashboardCanvas.tsx/DashboardBlocks.tsx's per-chart filter popover
// (BlockFilterButton).
//
// 2026-09-29 (round 2 of the Hex-level filters work): "the options given
// are not accurate... not suitable for the chart" - the first version of
// this editor only ever offered the Values (multi-select) tab for a TEXT
// column, forcing a numeric or date column into range/comparison-only
// mode. That's wrong for a lot of real business data: a "Year" or
// "Quarter" column is often stored as a plain int, and a specific-dates
// multi-select ("Jan 3, Jan 17, Feb 2") is a completely reasonable ask a
// pure from/to range can't express. Every dtype group now gets BOTH tabs -
// Values always works (the distinct-values endpoint has no dtype
// restriction), Condition is the one thing that's still genuinely
// type-specific (a number wants a comparison/between, a date wants a
// range, text wants contains/equals/etc). Only a boolean column, which has
// exactly two possible values, skips the tabs entirely for a plain
// True/False toggle - a "Values" checklist of two items would just be the
// same choice with extra clicks.
export function ColumnFilterSpecEditor({
  datasourceId,
  column,
  dtype,
  spec,
  onChange,
}: {
  datasourceId: string | null;
  column: string;
  dtype?: string;
  spec: ColumnFilterSpec | null;
  onChange: (spec: ColumnFilterSpec | null) => void;
}) {
  const resolvedDtype = useColumnDtype(datasourceId, column, dtype);
  const group = dtypeGroup(resolvedDtype);
  // Defaults to whichever tab already has an active spec (so reopening a
  // filter that's set as a range doesn't silently land on the empty
  // Values tab), otherwise the tab that's the more natural first move for
  // this dtype - Values for text, Condition (a range) for number/date.
  const [tab, setTab] = useState<"values" | "condition">(
    spec?.type === "values" ? "values" : spec ? "condition" : group === "text" ? "values" : "condition"
  );
  const [values, setValues] = useState<{ value: string | number | boolean | null; count: number }[]>([]);
  const [loadingValues, setLoadingValues] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (group === "boolean" || !datasourceId) return;
    let cancelled = false;
    setLoadingValues(true);
    datasourceApi
      .getColumnDistinctValues(datasourceId, column, null, { limit: 200 })
      .then((res) => {
        if (!cancelled) setValues(res.values);
      })
      .catch(() => {
        if (!cancelled) setValues([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingValues(false);
      });
    return () => {
      cancelled = true;
    };
  }, [datasourceId, column, group]);

  const include = spec?.type === "values" ? spec.include : [];
  const toggleValue = (v: string | number | boolean | null) => {
    const key = String(v);
    const has = include.some((x) => String(x) === key);
    const next = has ? include.filter((x) => String(x) !== key) : [...include, v];
    onChange(next.length ? { type: "values", include: next } : null);
  };
  const filteredValues = search ? values.filter((v) => String(v.value ?? "").toLowerCase().includes(search.toLowerCase())) : values;

  if (group === "boolean") {
    const val = spec?.type === "boolean" ? spec.value : null;
    return (
      <div className="p-2.5 flex flex-col gap-1.5 min-w-[180px]">
        {(["true", "false"] as const).map((v) => (
          <button
            key={v}
            type="button"
            className={`text-xs px-2.5 py-1.5 rounded-lg border text-left transition ${
              val === v ? "border-primary bg-primary/10 text-primary" : "border-border text-muted hover:bg-surface2"
            }`}
            onClick={() => onChange(val === v ? null : { type: "boolean", value: v })}
          >
            {v === "true" ? "True" : "False"}
          </button>
        ))}
        {val && (
          <button type="button" className="text-[11px] text-muted hover:text-text self-start" onClick={() => onChange(null)}>
            Clear
          </button>
        )}
      </div>
    );
  }

  const conditionLabel = group === "number" ? "Range" : group === "date" ? "Range" : "Condition";

  return (
    <div className="flex flex-col min-w-[220px] max-w-[280px]">
      <div className="flex border-b border-border text-[11px]">
        <button
          type="button"
          className={`flex-1 px-2 py-1.5 ${tab === "values" ? "text-primary border-b-2 border-primary font-medium" : "text-muted"}`}
          onClick={() => setTab("values")}
        >
          Values
        </button>
        <button
          type="button"
          className={`flex-1 px-2 py-1.5 ${tab === "condition" ? "text-primary border-b-2 border-primary font-medium" : "text-muted"}`}
          onClick={() => setTab("condition")}
        >
          {conditionLabel}
        </button>
      </div>
      {tab === "values" ? (
        <div className="p-2 flex flex-col gap-1.5">
          <input className="input text-xs py-1.5" placeholder="Search values…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="max-h-44 overflow-y-auto flex flex-col gap-0.5">
            {loadingValues ? (
              <div className="text-[11px] text-muted px-1 py-1">Loading…</div>
            ) : filteredValues.length === 0 ? (
              <div className="text-[11px] text-muted px-1 py-1">No values.</div>
            ) : (
              filteredValues.map((v) => (
                <label key={String(v.value)} className="flex items-center gap-1.5 text-xs px-1 py-1 rounded hover:bg-surface2 cursor-pointer">
                  <input type="checkbox" checked={include.some((x) => String(x) === String(v.value))} onChange={() => toggleValue(v.value)} />
                  <span className="truncate flex-1">{v.value === null ? "(Blanks)" : String(v.value)}</span>
                  <span className="text-muted tabular-nums">{v.count}</span>
                </label>
              ))
            )}
          </div>
          {include.length > 0 && (
            <button type="button" className="text-[11px] text-muted hover:text-text self-start" onClick={() => onChange(null)}>
              Clear ({include.length})
            </button>
          )}
        </div>
      ) : (
        <div className="p-2.5 flex flex-col gap-2">
          {group === "number" && <NumberConditionEditor spec={spec} onChange={onChange} />}
          {group === "date" && <DateConditionEditor spec={spec} onChange={onChange} />}
          {group === "text" && <TextConditionEditor spec={spec?.type === "text" ? spec : null} onChange={onChange} />}
        </div>
      )}
    </div>
  );
}

function ChevronIcon({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M5 7.5L10 12.5L15 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FilterIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h16l-6 7.5V19l-4 2v-8.5L4 5Z" />
    </svg>
  );
}

// A tiny local column-listing hook - name + dtype for every column in a
// data source, the same shape DashboardCanvas.tsx's own ColumnInfo already
// uses for its manual-build/filter-column pickers. Reused by
// BlockFilterButton below so per-chart filtering works in BOTH edit mode
// (which already has this list from its own fetch - passed in via the
// `columns` prop to skip a duplicate call) and Preview mode (which has no
// such list yet - this hook fetches it lazily the first time it's needed).
function useDataSourceColumns(datasourceId: string | null): { name: string; dtype: string }[] {
  const [columns, setColumns] = useState<{ name: string; dtype: string }[]>([]);
  useEffect(() => {
    if (!datasourceId) {
      setColumns([]);
      return;
    }
    let cancelled = false;
    datasourceApi
      .preview(datasourceId, null, 1, 0)
      .then((p) => {
        if (!cancelled) setColumns(p.columns.map((name) => ({ name, dtype: p.dtypes[name] || "" })));
      })
      .catch(() => {
        if (!cancelled) setColumns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [datasourceId]);
  return columns;
}

// 2026-09-29 (Hex-level filters round): "per-chart filtering" - Gokul's
// own words, alongside "ranges" and "multi-select," naming exactly what
// the old single-column-equality filter mechanism couldn't do. This is a
// SEPARATE filter row from the page-wide filter bar (the "filter" block
// type above): a person adds one or more column criteria here that apply
// ONLY to this one block, on top of whatever the page-wide filter bar
// already shows - never affecting any other block on the page. Exactly as
// ephemeral as the page-wide filters themselves (see
// lib/useDashboardFilters.ts's own module comment) - never persisted to
// this block's stored config, gone on the next page load.
//
// 2026-09-29 (round 2): moved here from DashboardCanvas.tsx (where it
// first shipped, edit-mode only) and given a `columns` prop that's now
// OPTIONAL - DashboardCanvas already has the datasource's column list from
// its own fetch and passes it straight in; DashboardBlockGrid (Preview
// mode, see below) doesn't have one yet, so this self-fetches it via
// useDataSourceColumns instead. Same component, same behavior, in both
// edit AND Preview - "the whole dashboard has to have individual...
// filter... as well" applies everywhere a chart is actually shown, not
// just while it's being built. Deliberately still NOT offered on the
// public/no-login link, for the same reason page-wide cross-filtering
// isn't either - see backend routers/dashboard_builder.py's module
// docstring (Phase 2b, point 3): recomputing against a customer's own
// connected data source from an unauthenticated link with no rate
// limiting is a real cost/security question, not one this shares.
export function BlockFilterButton({
  datasourceId,
  columns: columnsProp,
  criteria,
  onChange,
}: {
  datasourceId: string | null;
  columns?: { name: string; dtype: string }[];
  criteria: FilterCriterion[];
  onChange: (criteria: FilterCriterion[]) => void;
}) {
  const fetchedColumns = useDataSourceColumns(columnsProp ? null : datasourceId);
  const columns = columnsProp || fetchedColumns;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [draftColumn, setDraftColumn] = useState("");
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const POPOVER_WIDTH = 260;

  const toggle = () => {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      if (next && btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect();
        const left = Math.min(Math.max(rect.right - POPOVER_WIDTH, 8), window.innerWidth - POPOVER_WIDTH - 8);
        setPos({ top: rect.bottom + 6, left });
      } else {
        setDraftColumn("");
      }
      return next;
    });
  };

  const usedColumns = new Set(criteria.map((c) => c.column));
  const availableColumns = columns.filter((c) => !usedColumns.has(c.name));

  const updateSpec = (column: string, spec: ColumnFilterSpec | null) => {
    const withoutThis = criteria.filter((c) => c.column !== column);
    onChange(spec ? [...withoutThis, { column, spec }] : withoutThis);
    if (!spec) setDraftColumn("");
  };

  return (
    <div className="shrink-0">
      <button
        ref={btnRef}
        type="button"
        className={`dash-chart-menu-btn flex items-center gap-0.5 ${criteria.length > 0 ? "text-primary" : ""}`}
        aria-label="Filter this block"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={criteria.length > 0 ? `${criteria.length} filter${criteria.length === 1 ? "" : "s"} on this block only` : "Filter this block only"}
        onClick={toggle}
      >
        <FilterIcon />
        {criteria.length > 0 && <span className="text-[9px] font-semibold tabular-nums">{criteria.length}</span>}
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              className="fixed z-50 card bg-surface shadow-2xl border border-border overflow-hidden flex flex-col"
              style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
            >
              <div className="px-3 py-2 border-b border-border text-[11px] font-semibold uppercase tracking-wide text-muted">
                Filter just this block
              </div>
              {criteria.length > 0 && (
                <div className="p-2 flex flex-col gap-2 border-b border-border">
                  {criteria.map((c) => (
                    <div key={c.column} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-text truncate">{c.column}</span>
                        <button type="button" className="text-[11px] text-muted hover:text-red-400" onClick={() => updateSpec(c.column, null)}>
                          Remove
                        </button>
                      </div>
                      <ColumnFilterSpecEditor
                        datasourceId={datasourceId}
                        column={c.column}
                        dtype={columns.find((col) => col.name === c.column)?.dtype}
                        spec={c.spec}
                        onChange={(spec) => updateSpec(c.column, spec)}
                      />
                    </div>
                  ))}
                </div>
              )}
              <div className="p-2">
                {draftColumn ? (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-text truncate">{draftColumn}</span>
                      <button type="button" className="text-[11px] text-muted hover:text-text" onClick={() => setDraftColumn("")}>
                        Cancel
                      </button>
                    </div>
                    <ColumnFilterSpecEditor
                      datasourceId={datasourceId}
                      column={draftColumn}
                      dtype={columns.find((col) => col.name === draftColumn)?.dtype}
                      spec={null}
                      onChange={(spec) => updateSpec(draftColumn, spec)}
                    />
                  </div>
                ) : availableColumns.length === 0 ? (
                  <div className="text-[11px] text-muted italic px-1 py-1">
                    {criteria.length === 0 ? "No columns available." : "Every column already has a filter on this block."}
                  </div>
                ) : (
                  <select className="input text-xs py-1.5 w-full" value="" onChange={(e) => setDraftColumn(e.target.value)}>
                    <option value="">+ Add a filter…</option>
                    {availableColumns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  );
}

// 2026-09-24 (Dashboard Builder Phase 2b), rewritten 2026-09-29 (Hex-level
// filters round): a filter block's own control. Used both here (Preview
// mode) and inside DashboardCanvas's BlockCard (edit mode) - one control,
// one behavior, everywhere it's interactive. Was a plain equality dropdown
// until this round; now a compact summary button that opens
// ColumnFilterSpecEditor in a portaled popover, so the same control
// expresses a range, a multi-select, or a text condition - not just
// "equals" - depending on the target column's real dtype. The SELECTED
// SPEC is never fetched from or written to the server; it comes in as
// `value` and goes out through `onChange` - see lib/useDashboardFilters.ts
// for where that state actually lives.
export function FilterControl({
  block,
  datasourceId,
  value,
  onChange,
}: {
  block: DashboardBlock;
  datasourceId: string | null;
  value: ColumnFilterSpec | null;
  onChange: (spec: ColumnFilterSpec | null) => void;
}) {
  const column: string | null = block.config?.column || null;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const togglePopover = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - 300) });
    }
    setOpen((o) => !o);
  };

  // 2026-09-25e (elite pass): a filter used to be its own small dash-card -
  // a bordered, backgrounded box, same chrome as a KPI tile - which is
  // exactly why a row of them read as scattered little widgets instead of
  // the clean, label-over-control filter bar in the reference dashboards
  // Gokul sent (a plain label above a plain bordered select, no card
  // around either). Dropped the card entirely: a filter block is now just
  // its label and its control sitting straight on the page, so several of
  // them placed in a row read as one continuous, premium filter strip
  // instead of N separate boxes.
  //
  // 2026-09-29 (round 2 of the Hex-level filters work): "our current style
  // of given options... is very bad" - the plain bordered `dash-select`
  // look read as a generic form control, not a filter. Now a real pill:
  // rounded-full, a small filter-funnel icon, and - the one thing that
  // actually signals state at a glance - an accent border/fill the moment
  // a real criterion is set, so a glance across the filter row shows
  // exactly which filters are active without reading any text.
  const active = isSpecActive(value);
  return (
    <div className="h-full flex flex-col justify-center gap-1.5 min-w-0">
      <label className="text-[13px] font-medium text-muted truncate">{block.title || column || "Filter"}</label>
      {!column ? (
        <div className="text-xs text-muted italic">Not set up yet.</div>
      ) : (
        <div className="relative min-w-0">
          <button
            ref={btnRef}
            type="button"
            className={`w-full flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition ${
              active
                ? "border-primary/70 bg-primary/10 text-primary font-medium"
                : "border-border bg-surface2/60 text-muted hover:border-primary/40 hover:text-text"
            }`}
            onClick={togglePopover}
          >
            <FilterIcon className="w-3 h-3 shrink-0" />
            <span className="truncate flex-1 text-left">{describeFilterSpec(value)}</span>
            <ChevronIcon className="w-3 h-3 shrink-0 opacity-60" />
          </button>
          {open &&
            pos &&
            createPortal(
              <>
                <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                <div className="fixed z-50 card bg-surface shadow-2xl border border-border overflow-hidden" style={{ top: pos.top, left: pos.left }}>
                  <ColumnFilterSpecEditor datasourceId={datasourceId} column={column} spec={value} onChange={onChange} />
                </div>
              </>,
              document.body
            )}
        </div>
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

  // 2026-09-29 (round 2 of the Hex-level filters work): "the whole
  // dashboard has to have individual graphic filter and overall as well" -
  // per-chart filtering (BlockFilterButton) used to only be reachable from
  // edit mode. Same eligibility rule DashboardCanvas.tsx's BlockCard
  // already uses (a stored `recipe`, or real tidy result_columns/rows on a
  // chart/table) - a block that can't be recomputed under the page-wide
  // filter bar can't be recomputed under its own extra one either.
  const respondsToFilters = (b: DashboardBlock) =>
    Boolean(b.config?.recipe) || (["chart", "table"].includes(b.type) && Boolean(b.config?.result_columns && b.config?.result_rows));

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
            DashboardCanvas.tsx's edit-mode BlockCard. Only the block types
            that actually support a custom accent (kpi/table/gauge/
            sparkline) need this overlay - donut/avatar_list have no single
            "block accent" concept (see their own render functions above),
            so they're left reading straight off config like before. */}
        {type === "kpi" && <KpiTile title={b.title} config={{ ...config, accent_color: b.config?.accent_color }} />}
        {type === "table" && <BlockTable title={b.title} config={{ ...config, accent_color: b.config?.accent_color }} />}
        {type === "chart" && <BlockChart title={b.title} config={config} />}
        {type === "text" && <TextBlock title={b.title} config={config} />}
        {type === "gauge" && <GaugeBlock title={b.title} config={{ ...config, accent_color: b.config?.accent_color }} />}
        {type === "donut" && <DonutBlock title={b.title} config={config} />}
        {type === "sparkline" && <SparklineBlock title={b.title} config={{ ...config, accent_color: b.config?.accent_color }} />}
        {type === "avatar_list" && <AvatarListBlock title={b.title} config={config} />}
        {type === "heading" && <HeadingBlock title={b.title} config={config} />}
        {type === "divider" && <DividerBlock />}
        {type === "filter" &&
          (filterState ? (
            <FilterControl
              block={b}
              datasourceId={datasourceId || null}
              value={filterState.values[b.id] ?? null}
              onChange={(spec) => filterState.setFilterValue(b.id, spec)}
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
  // A small, subtle overlay in the block's own top-right corner - the same
  // BlockFilterButton edit mode uses, so "filter just this chart" is one
  // click away everywhere a chart is actually shown, not just while it's
  // being built. Never shown on a filter block itself (nothing to further
  // filter there) or when filterState/datasourceId are absent (the public/
  // no-login link - see BlockFilterButton's own comment for why).
  const filterOverlay = (b: DashboardBlock) =>
    filterState && datasourceId && b.type !== "filter" && respondsToFilters(b) ? (
      <div className="absolute top-1.5 right-1.5 z-10 opacity-70 hover:opacity-100 transition">
        <BlockFilterButton
          datasourceId={datasourceId}
          criteria={filterState.blockFilters[b.id] || []}
          onChange={(criteria) => filterState.setBlockFilters(b.id, criteria)}
        />
      </div>
    ) : null;

  if (narrow) {
    const ordered = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);
    return (
      <div className="flex flex-col gap-4">
        {ordered.map((b) => (
          <div key={b.id} className="relative" style={{ minHeight: STACK_MIN_HEIGHT[b.type] ?? 200 }}>
            {filterOverlay(b)}
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
          className="relative"
          style={{
            gridColumn: `${b.x + 1} / span ${b.w}`,
            gridRow: `${b.y + 1} / span ${b.h}`,
          }}
        >
          {filterOverlay(b)}
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
