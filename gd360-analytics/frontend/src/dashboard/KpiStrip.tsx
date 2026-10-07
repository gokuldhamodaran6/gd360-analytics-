import type { DashboardBlock } from "../api/client";
import { KpiTile as LegacyKpiTile } from "../components/DashboardBlocks";
import { KpiTile, Skeleton, cn } from "../ui";
import { kpiDelta, kpiSparkline, kpiValue, resultOk } from "./blockData";
import { formatNumber } from "./runState";
import type { DashboardRun } from "./useDashboardRun";

// 2026-10-07 (Option A dashboard view): the KPI strip across the top of
// the page (Main.dc.html: Revenue · Bookings · Cancellation rate · ...).
// One KpiTile per kpi block, in grid order: the value, a worded delta vs
// the prior period whose good/bad comes from the block's own
// config.good_direction ("down" = lower is better, e.g. a cancellation
// rate; default "up"), and the run's sparkline. Skeleton tiles on the
// first load; on a refilter the old numbers stay and shimmer.

export function kpiBlocksOf(blocks: DashboardBlock[]): DashboardBlock[] {
  return blocks.filter((b) => b.type === "kpi").sort((a, b) => a.y - b.y || a.x - b.x);
}

export function KpiStrip({ blocks, run, mode, className }: { blocks: DashboardBlock[]; run: DashboardRun; mode: "warehouse" | "file"; className?: string }) {
  const kpis = kpiBlocksOf(blocks);
  if (kpis.length === 0) return null;
  const cols = Math.min(kpis.length, 5);
  return (
    <div
      data-kpi-strip=""
      aria-busy={run.loading || undefined}
      className={cn("grid gap-4", className)}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {kpis.map((b) => {
        if (mode === "file") {
          const override = run.overrides[b.id];
          const config = { ...(override?.config ?? b.config), accent_color: b.config?.accent_color };
          return (
            <div key={b.id} className={cn("relative", run.loading && "opacity-80")}>
              <LegacyKpiTile title={b.title} config={config} compareValue={override ? b.config?.value : undefined} />
            </div>
          );
        }
        const r = run.results[b.id];
        if (!run.ready && !r) return <Skeleton key={b.id} variant="tile" />;
        const label = b.title || b.config?.label || r?.measures?.[0] || "Value";
        if (!r || !resultOk(r)) {
          return (
            <KpiTile
              key={b.id}
              label={label}
              value={<span className="text-section font-medium text-danger">{r?.error ? "Couldn't compute" : "No result"}</span>}
              caption={r?.error || (run.skippedBlockIds.includes(b.id) ? "Not built for the warehouse yet" : undefined)}
            />
          );
        }
        const delta = kpiDelta(r, b.config?.good_direction === "down" ? "down" : "up");
        const spark = kpiSparkline(r);
        return (
          <div key={b.id} className="relative" data-kpi-block={b.id}>
            <KpiTile
              label={label}
              value={formatNumber(kpiValue(r))}
              unit={b.config?.unit}
              delta={
                delta
                  ? {
                      pct: delta.pct ?? undefined,
                      abs: delta.pct === null ? delta.abs ?? undefined : undefined,
                      direction: delta.direction,
                      good: delta.good,
                      caption: "vs prior period",
                      qualifier: delta.good === false ? "worse" : delta.good === true && b.config?.good_direction === "down" ? "better" : undefined,
                    }
                  : undefined
              }
              sparkline={spark.length > 1 ? spark : undefined}
              sparklineLabel={spark.length > 1 ? `${label} trend` : undefined}
              caption={delta ? undefined : "No prior period to compare"}
              className={cn("h-full", run.loading && "opacity-80")}
            />
            {run.loading && <div aria-hidden="true" className="ui-shimmer pointer-events-none absolute inset-0 rounded-card opacity-30" />}
          </div>
        );
      })}
    </div>
  );
}
