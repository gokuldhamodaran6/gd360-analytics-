// 2026-10-09 (round 15): "Weekly reach - organic and paid" on the Space page.
// Twelve stacked bars on one y-axis with round ticks, a legend, a tooltip per
// bar (hover or keyboard focus; each bar also carries its values as an
// accessible label). A series with no
// source behind it (all null) is left out entirely. Colours are the app's
// chart series tokens, so it reads the same in the dark and light themes;
// every piece of text uses text tokens, never the series colour.
import { useState } from "react";
import type { SpaceOverview } from "../api/spaces";
import { compact, niceTicks, shortDate } from "./format";

type Row = SpaceOverview["weekly"][number];

const SERIES = [
  { key: "organic_reach" as const, label: "Organic (social pages)", color: "rgb(var(--color-series-1))" },
  { key: "paid_reach" as const, label: "Paid (ad accounts)", color: "rgb(var(--color-series-2))" },
];

const H = 200;

export function hasWeeklyData(rows: Row[] | null | undefined): boolean {
  return !!rows && rows.some((r) => r.organic_reach != null || r.paid_reach != null);
}

export default function WeeklyReachChart({ rows }: { rows: Row[] }) {
  const [active, setActive] = useState<number | null>(null);
  const series = SERIES.filter((s) => rows.some((r) => r[s.key] != null));
  if (!series.length) return null;

  const totals = rows.map((r) => series.reduce((sum, s) => sum + (r[s.key] || 0), 0));
  const ticks = niceTicks(Math.max(...totals, 0));
  const top = ticks[ticks.length - 1] || 1;
  const n = rows.length;

  return (
    <figure className="m-0 flex flex-col gap-3 min-w-0">
      {series.length >= 2 && (
        <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-secondary">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: s.color }} aria-hidden="true" />
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
      {series.length === 1 && <figcaption className="text-caption text-secondary">{series[0].label}</figcaption>}

      <div className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-2 mt-2">
        {/* y-axis */}
        <div className="relative font-mono text-[10.5px] text-muted" style={{ height: H }} aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2 leading-none" style={{ bottom: `${(t / top) * 100}%` }}>
              {compact(t)}
            </span>
          ))}
        </div>

        {/* plot */}
        <div className="relative" style={{ height: H }} onMouseLeave={() => setActive(null)}>
          {ticks.map((t) => (
            <span
              key={t}
              aria-hidden="true"
              className="absolute left-0 right-0 h-px"
              style={{ bottom: `${(t / top) * 100}%`, background: t === 0 ? "rgb(var(--chart-axis))" : "rgb(var(--chart-grid))" }}
            />
          ))}
          <div className="absolute inset-0 flex">
            {rows.map((r, i) => {
              const segs = series.filter((s) => (r[s.key] || 0) > 0);
              return (
                <div
                  key={r.week_start}
                  className="relative flex-1 min-w-0 h-full flex justify-center items-end outline-none focus-visible:bg-subtle rounded-sm"
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  tabIndex={0}
                  role="img"
                  aria-label={`Week of ${shortDate(r.week_start)}: ${series.map((s) => `${s.label} ${compact(r[s.key])}`).join(", ")}`}
                >
                  <span
                    className="flex flex-col-reverse justify-start gap-[2px] w-[58%] max-w-[22px]"
                    style={{ height: `${(totals[i] / top) * 100}%`, opacity: active == null || active === i ? 1 : 0.55 }}
                  >
                    {segs.map((s, j) => (
                      <span
                        key={s.key}
                        className={j === segs.length - 1 ? "rounded-t-[4px]" : ""}
                        style={{ background: s.color, flexGrow: r[s.key] || 0, flexBasis: 0, minHeight: 2 }}
                      />
                    ))}
                  </span>
                </div>
              );
            })}
          </div>

          {active != null && rows[active] && (
            <div
              role="tooltip"
              className="pointer-events-none absolute z-10 min-w-[170px] rounded-ctl border border-border bg-surface shadow-pop px-3 py-2 text-caption"
              style={{
                left: `${((active + 0.5) / n) * 100}%`,
                bottom: `${Math.min(92, (totals[active] / top) * 100 + 4)}%`,
                transform: `translateX(${active < 2 ? "-12%" : active > n - 3 ? "-88%" : "-50%"})`,
              }}
            >
              <div className="text-text font-medium mb-1">Week of {shortDate(rows[active].week_start)}</div>
              {series.map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-4 text-secondary">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-[2px]" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span className="font-mono text-text">{compact(rows[active][s.key])}</span>
                </div>
              ))}
              {series.length > 1 && (
                <div className="flex items-center justify-between gap-4 mt-1 pt-1 border-t border-border text-secondary">
                  <span>Total</span>
                  <span className="font-mono text-text">{compact(totals[active])}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* x-axis labels */}
        <span aria-hidden="true" />
        <div className="flex mt-1.5" aria-hidden="true">
          {rows.map((r, i) => (
            <span key={r.week_start} className={`flex-1 min-w-0 text-center text-[10.5px] text-muted whitespace-nowrap overflow-hidden ${i % 2 ? "invisible sm:visible" : ""}`}>
              {shortDate(r.week_start)}
            </span>
          ))}
        </div>
      </div>

    </figure>
  );
}
