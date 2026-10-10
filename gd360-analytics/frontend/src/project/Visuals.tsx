// 2026-10-08 (round 11): the charts an answer is drawn with - the change
// split into its parts (waterfall), the change by segment (diverging bars),
// a row of headline numbers, and any result table (WorkspaceChart, the same
// chart component the one-source analysis uses).
import type { DashKpi, Visual } from "../api/projects";
import { formatCell, formatValue, isYearColumn } from "./format";
import ChartWithControls from "./ChartControls";

export function WaterfallChart({ visual }: { visual: Extract<Visual, { type: "waterfall" }> }) {
  const totals = visual.items.filter((i) => i.kind === "total").map((i) => Math.abs(i.value));
  // running levels: every step starts where the previous one ended
  let level = 0;
  const bars = visual.items.map((it) => {
    if (it.kind === "total") {
      level = it.value;
      return { ...it, lo: 0, hi: it.value };
    }
    const from = level;
    level = level + it.value;
    return { ...it, lo: Math.min(from, level), hi: Math.max(from, level) };
  });
  const max = Math.max(...bars.map((b) => b.hi), ...totals, 1);
  const H = 220;
  return (
    <figure className="m-0" aria-label={visual.title}>
      <div className="overflow-x-auto">
        <div className="grid gap-4 min-w-[520px]" style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}>
          {bars.map((b, i) => {
            const color = b.kind === "total" ? "bg-[rgb(var(--color-border-strong))]" : b.kind === "down" ? "bg-danger" : "bg-good";
            const label =
              b.kind === "total"
                ? formatValue(b.value, visual.format, visual.currency)
                : formatValue(b.value, visual.format, visual.currency, true);
            return (
              <div key={i} className="flex flex-col gap-2 min-w-0">
                <span className={`font-mono text-ui text-center ${b.kind === "down" ? "text-danger" : b.kind === "up" ? "text-good" : "text-text"}`}>{label}</span>
                <div className="relative border-b border-border-strong" style={{ height: H }}>
                  <span
                    className={`absolute left-[14%] right-[14%] rounded-t ${color}`}
                    style={{ bottom: (b.lo / max) * H, height: Math.max(3, ((b.hi - b.lo) / max) * H) }}
                    title={`${b.label}: ${label}`}
                  />
                </div>
                <span className="text-caption text-muted text-center leading-snug">{b.label}</span>
              </div>
            );
          })}
        </div>
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-4 text-caption text-muted">
        <Legend className="bg-[rgb(var(--color-border-strong))]" label="Total" />
        <Legend className="bg-danger" label="Pulled it down" />
        <Legend className="bg-good" label="Pushed it up" />
      </figcaption>
    </figure>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-sm ${className}`} />
      {label}
    </span>
  );
}

export function DivergingBars({ visual }: { visual: Extract<Visual, { type: "diverging" }> }) {
  const max = Math.max(...visual.items.map((i) => Math.abs(i.value)), 1);
  const anyUp = visual.items.some((i) => i.value > 0);
  const anyDown = visual.items.some((i) => i.value < 0);
  const zero = anyUp && anyDown ? 50 : anyDown ? 100 : 0;
  return (
    <div className="flex flex-col gap-2" role="list" aria-label={visual.title}>
      {visual.items.map((it) => {
        const w = (Math.abs(it.value) / max) * (anyUp && anyDown ? 50 : 100);
        const left = it.value < 0 ? zero - w : zero;
        return (
          <div key={it.label} role="listitem" className="grid grid-cols-[minmax(90px,28%)_1fr_auto] gap-3 items-center text-ui">
            <span className="truncate text-secondary" title={it.label}>{it.label}</span>
            <span className="relative h-[18px]">
              <span className="absolute top-[-3px] bottom-[-3px] w-px bg-border-strong" style={{ left: `${zero}%` }} />
              <span
                className={`absolute top-0 bottom-0 rounded-sm ${it.value < 0 ? "bg-danger" : "bg-good"}`}
                style={{ left: `${left}%`, width: `${Math.max(w, 0.6)}%` }}
              />
            </span>
            <span className={`font-mono text-right min-w-[84px] ${it.value < 0 ? "text-danger" : "text-good"}`}>
              {formatValue(it.value, visual.format, visual.currency, true)}
              {it.share != null && Math.abs(it.share) >= 1 && (
                <span className="text-muted text-caption ml-1.5">{Math.round(Math.abs(it.share))}%</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function SourceTags({ names }: { names?: string[] | null }) {
  if (!names || !names.length) return null;
  return (
    <span className="inline-flex gap-1.5 flex-wrap justify-end shrink-0">
      {names.slice(0, 3).map((n) => (
        <span key={n} className="inline-flex items-center h-[22px] px-2 rounded-md bg-subtle text-[11px] text-secondary whitespace-nowrap">{n}</span>
      ))}
      {names.length > 3 && <span className="text-[11px] text-muted self-center">+{names.length - 3}</span>}
    </span>
  );
}

export function KpiRow({ items }: { items: DashKpi[] }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
      {items.map((k) => (
        <div key={k.key} className="rounded-card border border-border bg-surface px-[18px] py-4 flex flex-col gap-1">
          <span className="text-ui text-muted">{k.label}</span>
          <span className="font-mono text-kpi leading-tight tracking-tight text-text">{k.display}</span>
          {k.delta && (
            <span className={`text-caption ${k.delta_dir === "down" ? "text-danger" : k.delta_dir === "up" ? "text-good" : "text-muted"}`}>
              {k.delta_dir === "down" ? "▼ " : k.delta_dir === "up" ? "▲ " : ""}
              {k.delta.replace(/^[+−-]/, "")} {k.note || ""}
            </span>
          )}
          {!k.delta && k.note && <span className="text-caption text-muted">{k.note}</span>}
          {(k.sources || []).length > 0 && (
            <span className="mt-1.5">
              <SourceTags names={k.sources} />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function VisualCard({ visual, id, chartType }: { visual: Visual; id: string; chartType?: string | null }) {
  if (visual.type === "kpis") {
    return <KpiRow items={visual.items.map((k) => ({ key: k.fact_id, label: k.label, display: k.display }))} />;
  }
  return (
    <section className="rounded-card border border-border bg-surface p-4 sm:p-5 flex flex-col gap-3 min-w-0 [&>div.card]:border-0 [&>div.card]:bg-transparent [&>div.card]:p-0 [&>div.card]:shadow-none [&>div.card]:rounded-none [&>div.card:hover]:shadow-none">
      <div className="flex items-start justify-between gap-3">
        <h3 className="m-0 text-section font-semibold text-text leading-snug">{visual.title}</h3>
        <SourceTags names={visual.sources} />
      </div>
      {visual.type === "waterfall" && <WaterfallChart visual={visual} />}
      {visual.type === "diverging" && <DivergingBars visual={visual} />}
      {visual.type === "chart" && (
        <ChartWithControls
          id={id}
          title={visual.title}
          columns={visual.columns}
          rows={visual.rows}
          truncated={visual.truncated}
          chartType={visual.display === "table" ? "table" : chartType || visual.chart_type || null}
        />
      )}
      {visual.type === "chart" && visual.note && <p className="m-0 text-caption text-muted">{visual.note}</p>}
    </section>
  );
}

/** A result as a table a finance team would accept: named columns, money
 *  and rates written as such, numbers right-aligned in tabular figures. */
export function DataTable({ visual }: { visual: Extract<Visual, { type: "chart" }> }) {
  const cols = visual.columns || [];
  const rows = (visual.rows || []) as Record<string, unknown>[];
  // a year column is written as it is ("2021"), left-aligned like any label
  const years = new Set(cols.filter((c) => isYearColumn(c.name, rows.map((r) => r[c.name]))).map((c) => c.name));
  const numeric = (c: (typeof cols)[number]) => !years.has(c.name) && (c.dtype === "number" || Boolean(c.format));
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full border-collapse text-ui tabular-nums">
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.name}
                scope="col"
                className={`px-3 py-2 text-caption font-medium text-muted border-b border-border whitespace-nowrap ${numeric(c) ? "text-right" : "text-left"}`}
              >
                {c.label || c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border last:border-0 hover:bg-subtle/60">
              {cols.map((c, j) => (
                <td key={c.name} className={`px-3 py-2.5 whitespace-nowrap ${numeric(c) ? "text-right font-mono text-[13px] text-text" : j === 0 ? "text-text font-medium" : "text-secondary"}`}>
                  {numeric(c) ? formatCell(r[c.name], c.format, c.currency) : r[c.name] == null || r[c.name] === "" ? "—" : String(r[c.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {visual.truncated && <p className="m-0 mt-2 px-1 text-caption text-muted">The first {rows.length.toLocaleString("en-US")} rows are shown; every row is in the Evidence tab.</p>}
    </div>
  );
}
