import type { ReactNode } from "react";
import type { BlockResult, DashboardBlock, DashboardBlockType } from "../api/client";
import { cn } from "../ui";
import { CHART_TYPES, fits, fitsBeforeRun, recommend, shapeFromResult, shapeFromSpec, type Recommendation } from "./charts/recommend";

// The menu vocabulary the block grid, the canvas cells and the dashboard
// editor share (split out of BlockGrid.tsx so the editor's menus can use
// it without importing the grid).

export type SwapOption = { label: string; payload: { chart_type?: string; type?: DashboardBlockType } };

// 2026-10-07 (chart-types round): every form a block can be swapped to.
// The first ten are the original list, in its order; the rest are the new
// native charts. Which of them a given block may take is decided by
// swapChoices() below - never offered blindly.
export const SWAP_OPTIONS: SwapOption[] = [
  { label: "Bar chart", payload: { type: "chart", chart_type: "bar" } },
  { label: "Horizontal bars", payload: { type: "chart", chart_type: "horizontal_bar" } },
  { label: "Line chart", payload: { type: "chart", chart_type: "line" } },
  { label: "Area chart", payload: { type: "chart", chart_type: "area" } },
  { label: "Stacked bars", payload: { type: "chart", chart_type: "stacked_bar" } },
  { label: "Pie chart", payload: { type: "chart", chart_type: "pie" } },
  { label: "Donut", payload: { type: "donut" } },
  { label: "Table", payload: { type: "table" } },
  { label: "Top list", payload: { type: "avatar_list" } },
  { label: "KPI tile", payload: { type: "kpi" } },
  { label: "100% stacked bars", payload: { type: "chart", chart_type: "stacked_bar_100" } },
  { label: "Stacked area", payload: { type: "chart", chart_type: "stacked_area" } },
  { label: "100% stacked area", payload: { type: "chart", chart_type: "stacked_area_100" } },
  { label: "Bars + line panels", payload: { type: "chart", chart_type: "combo" } },
  { label: "Map", payload: { type: "chart", chart_type: "map" } },
  { label: "Heatmap", payload: { type: "chart", chart_type: "heatmap" } },
  { label: "Pivot table", payload: { type: "chart", chart_type: "pivot" } },
  { label: "Scatter", payload: { type: "chart", chart_type: "scatter" } },
  { label: "Bubble", payload: { type: "chart", chart_type: "bubble" } },
  { label: "Treemap", payload: { type: "chart", chart_type: "treemap" } },
  { label: "Funnel", payload: { type: "chart", chart_type: "funnel" } },
  { label: "Waterfall", payload: { type: "chart", chart_type: "waterfall" } },
  { label: "Bullet", payload: { type: "chart", chart_type: "bullet" } },
];

export type SwapChoice = SwapOption & { key: string; disabled: boolean; reason: string | null; current: boolean; recommended: boolean };

/** The swap list for one block: every option, each marked usable or not
 *  for the block's CURRENT data shape (its run result when there is one,
 *  else its spec), with the one line that says what a disabled form needs
 *  ("needs a country column"). The form the recommender would pick is
 *  marked. A histogram's spec bins one column: nothing else can draw it. */
export function swapChoices(block: Pick<DashboardBlock, "type" | "config">, result?: BlockResult | null): { choices: SwapChoice[]; recommendation: Recommendation | null } {
  const cfg = block.config || {};
  const spec = cfg.spec && typeof cfg.spec === "object" ? cfg.spec : null;
  const target = typeof cfg.target === "number";
  const ran = Boolean(result && result.status === "ok" && result.rows?.length);
  const shape = ran ? shapeFromResult(result, spec, { target }) : spec ? shapeFromSpec(spec, cfg.spec_columns || null, { target }) : null;
  const recommendation = shape ? recommend(shape) : null;
  const check = (type: string) => (shape ? (ran ? fits(shape, type) : fitsBeforeRun(shape, type)) : { ok: true as const, why: null });
  const choices = SWAP_OPTIONS.map((o) => {
    const key = o.payload.chart_type || String(o.payload.type);
    // The block types that are not chart forms follow the nearest rule.
    const probe = o.payload.type === "avatar_list" ? "donut" : key;
    const f = check(probe);
    const current = o.payload.type === block.type && (o.payload.chart_type || null) === (block.type === "chart" ? cfg.chart_type || null : null);
    const info = CHART_TYPES.find((t) => t.type === probe);
    return {
      ...o, key, current,
      disabled: !f.ok,
      reason: f.ok ? null : `${o.label} ${f.why || info?.needs || "cannot be drawn from this data"}`,
      recommended: Boolean(recommendation && recommendation.chart_type === key),
    };
  });
  return { choices, recommendation };
}

/** "Swap to": the usable forms as chips (the recommended one marked), and
 *  the rest folded under a line that says how many need different data -
 *  each with its reason. */
export function SwapChips({ block, result, busy, onSwap }: { block: Pick<DashboardBlock, "type" | "config">; result?: BlockResult | null; busy?: boolean; onSwap: (payload: SwapOption["payload"]) => void }) {
  const { choices, recommendation } = swapChoices(block, result);
  const usable = choices.filter((c) => !c.disabled && !c.current);
  const blocked = choices.filter((c) => c.disabled && !c.current);
  const best = recommendation && !choices.some((c) => c.current && c.key === recommendation.chart_type) ? recommendation : null;
  return (
    <div data-swap-chips="">
      {best && (
        <div className="px-3 pb-1.5 text-caption text-muted" data-swap-recommendation="">
          <span className="font-medium text-brand-ink">Recommended:</span> {best.reason}
        </div>
      )}
      <div className="flex flex-wrap gap-1 px-3 pb-1.5">
        {usable.map((o) => (
          <button
            key={o.label}
            type="button"
            role="menuitem"
            disabled={busy}
            data-swap-option={o.key}
            data-swap-recommended={o.recommended ? "" : undefined}
            title={o.recommended && recommendation ? recommendation.reason : undefined}
            className={cn(
              "ui-focus rounded-full border px-2 py-[2px] text-caption hover:border-border-strong hover:bg-subtle hover:text-text disabled:opacity-60",
              o.recommended ? "border-tint-border bg-tint text-brand-ink" : "border-border bg-surface text-secondary"
            )}
            onClick={() => onSwap(o.payload)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {blocked.length > 0 && (
        <details className="px-3 pb-1.5" data-swap-blocked="">
          <summary className="ui-focus cursor-pointer rounded text-caption text-muted hover:text-secondary">{blocked.length} more need different data</summary>
          <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
            {blocked.map((o) => (
              <li key={o.label} className="text-caption text-faint" data-swap-disabled={o.key} aria-disabled="true">{o.reason}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function MenuRow({ children, onClick, disabled, danger, icon, trailing }: { children: ReactNode; onClick?: () => void; disabled?: boolean; danger?: boolean; icon?: ReactNode; trailing?: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "ui-focus-inset flex w-full items-center gap-2.5 px-3 py-2 text-left text-ui hover:bg-subtle disabled:cursor-default disabled:text-faint disabled:hover:bg-transparent",
        danger ? "text-danger hover:bg-danger-fill" : "text-text"
      )}
    >
      {icon && <span className={cn("inline-flex shrink-0 [&>svg]:block", danger ? "text-danger" : "text-muted")}>{icon}</span>}
      <span className="min-w-0 flex-1">{children}</span>
      {trailing && <span className="shrink-0 text-caption text-faint">{trailing}</span>}
    </button>
  );
}

export function MenuCaption({ children }: { children: ReactNode }) {
  return <div className="px-3 pb-1 pt-2 text-caption font-medium uppercase tracking-caps text-muted">{children}</div>;
}

export function MenuDivider() {
  return <div className="my-1 border-t border-subtle" role="separator" />;
}
