// 2026-10-12 (round 40): "Where it trains" on the plan. A yes/no or number
// model can train inside the database (every row, where it lives - only sums
// come back) or on a fair sample in GD360 (tuned boosting, forest, linear).
// The plan says which it recommends and, when one can't run, why.
import type { Route, Routes } from "../api/mlStudio";

function DbIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
      <path d="M4.5 5.5v6.5c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V5.5" />
      <path d="M4.5 12v6.5c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V12" />
    </svg>
  );
}

function SampleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <circle cx="9" cy="9" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="11" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="10" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function RoutePicker({
  routes,
  engine,
  busy,
  onPick,
}: {
  routes: Routes;
  engine: "sql" | "sample" | null | undefined;
  busy: boolean;
  onPick: (engine: "sql" | "sample") => void;
}) {
  const current: "sql" | "sample" = engine === "sql" && routes.sql.available ? "sql" : "sample";
  const card = (key: "sql" | "sample", r: Route) => {
    const on = current === key;
    const off = !r.available;
    return (
      <button
        key={key}
        type="button"
        role="radio"
        aria-checked={on}
        disabled={off || busy}
        onClick={() => !on && onPick(key)}
        data-ml-route={key}
        className={`text-left rounded-ctl border px-3.5 py-3 flex flex-col gap-1.5 min-w-0 transition-colors ${
          on ? "bg-surface" : "border-border hover:border-border-strong"
        } ${off ? "opacity-70 cursor-not-allowed" : ""}`}
        style={on ? { borderColor: "rgb(var(--auto-do))", boxShadow: "0 0 0 1px rgb(var(--auto-do)) inset" } : undefined}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="shrink-0" style={{ color: on ? "rgb(var(--auto-do))" : "rgb(var(--color-muted))" }}>
            {key === "sql" ? <DbIcon /> : <SampleIcon />}
          </span>
          <span className="text-ui font-semibold text-text min-w-0">{r.title}</span>
          {routes.recommended === key && r.available && (
            <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] px-1.5 py-0.5 rounded-full"
                  style={{ color: "rgb(var(--auto-do))", background: "rgb(var(--auto-do) / 0.12)" }}>
              Recommended
            </span>
          )}
        </span>
        <span className="text-caption text-secondary leading-snug">{r.text}</span>
        <span className="font-mono text-[11px] text-muted leading-snug">{r.model}</span>
        {key === "sql" && r.estimate?.text && (
          <span className="font-mono text-[11px] leading-snug" style={{ color: r.estimate.over_cap || r.estimate.over_budget ? "rgb(var(--color-warning))" : "rgb(var(--color-secondary))" }}
                data-ml-route-estimate="">
            {r.estimate.text}
            {r.estimate.bytes != null && r.estimate.cap_gb ? ` · limit ${r.estimate.cap_gb.toLocaleString()} GB a run` : ""}
          </span>
        )}
        {off && r.why && <span className="text-caption text-warning leading-snug">{r.why}</span>}
        {!off && on && <span className="text-caption text-muted leading-snug">{r.gives}</span>}
      </button>
    );
  };
  return (
    <div className="flex flex-col gap-2 pt-1" data-ml-routes="">
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted" id="ml-route-label">Where it trains</span>
      <div role="radiogroup" aria-labelledby="ml-route-label" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-2">
        {card("sql", routes.sql)}
        {card("sample", routes.sample)}
      </div>
    </div>
  );
}
