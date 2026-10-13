// 2026-10-12 (round 39): what each step of an ML run did, drawn - the
// default view of every step on the run page (the code and the rows are one
// tab away). The backend sends small chart specs (services/ml_studio.py:
// _data_visuals and the trainers' stage visuals); this file draws them with
// the theme's own tokens, so they read the same in light and dark.
import type { StagePreview, Visual, VisualItem } from "../api/mlStudio";
import { LineView } from "./ResultSections";

const DO = "rgb(var(--auto-do))";
const TELL = "rgb(var(--auto-tell))";
const WHEN = "rgb(var(--auto-when))";
const FAINT = "rgb(var(--color-border-strong))";
const SPLIT_COLORS = [DO, TELL, WHEN, "rgb(var(--color-warning))", "rgb(var(--color-secondary))"];

export function compact(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  if (Number.isInteger(n)) return n.toLocaleString();
  return a >= 100 ? Math.round(n).toLocaleString() : n.toFixed(a < 1 ? 3 : 2);
}

function exact(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) && typeof v !== "string" ? n.toLocaleString() : String(v ?? "—");
}

function fmtVal(v: unknown, format?: string, unit?: string): string {
  if (v === null || v === undefined) return "—";
  if (format === "score") return Number(v).toFixed(3);
  if (format === "share") return Number(v).toFixed(3);
  return compact(v) + (unit ? unit : "");
}

function Card({ title, children, note }: { title?: string; children: React.ReactNode; note?: string }) {
  return (
    <figure className="m-0 rounded-card border border-border bg-surface p-4 flex flex-col gap-3 min-w-0">
      {title && <figcaption className="text-ui font-semibold text-text">{title}</figcaption>}
      {children}
      {note && <p className="m-0 text-caption text-secondary leading-relaxed">{note}</p>}
    </figure>
  );
}

function Funnel({ v }: { v: Extract<Visual, { type: "funnel" }> }) {
  const items = v.items.filter((i) => i.value != null);
  const max = Math.max(...items.map((i) => Number(i.value) || 0), 1);
  return (
    <Card title={v.title} note={v.note}>
      <div className="flex flex-col gap-2.5" role="list">
        {items.map((it, k) => {
          const pct = Math.max(1.5, (Number(it.value) / max) * 100);
          const last = k === items.length - 1;
          return (
            <div key={it.label} role="listitem" className="grid grid-cols-[minmax(120px,34%)_1fr_auto] items-center gap-3 text-ui">
              <span className="text-secondary truncate" title={it.label}>{it.label}</span>
              <span className="h-[10px] rounded-full bg-subtle overflow-hidden">
                <span className="block h-full rounded-full transition-[width] duration-700" style={{ width: `${pct}%`, background: last ? DO : TELL }} />
              </span>
              <span className="font-mono tabular-nums text-text w-[84px] text-right" title={exact(it.value)}>{compact(it.value)}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Kpis({ v }: { v: Extract<Visual, { type: "kpis" }> }) {
  return (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
      {v.items.map((it) => (
        <div key={it.label} className="rounded-card border border-border bg-surface px-3.5 py-3 flex flex-col gap-0.5 min-w-0">
          <span className="text-caption text-muted truncate" title={it.label}>{it.label}</span>
          <span className="font-mono text-[20px] leading-tight tabular-nums text-text" style={it.tone === "good" ? { color: DO } : undefined} title={exact(it.value)}>
            {compact(it.value)}
          </span>
          {it.note && <span className="text-[11.5px] text-muted leading-snug line-clamp-2" title={it.note}>{it.note}</span>}
        </div>
      ))}
    </div>
  );
}

function Bars({ v }: { v: Extract<Visual, { type: "bars" }> }) {
  const two = !!(v.series && v.series.length === 2);
  const vals = v.items.flatMap((i) => (two ? (i.values || []).map(Number) : [Number(i.value)])).filter((x) => Number.isFinite(x));
  const max = Math.max(...vals.map(Math.abs), 1e-9);
  return (
    <Card title={v.title}>
      {two && (
        <div className="flex gap-4 text-caption text-secondary">
          <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: FAINT }} />{v.series![0]}</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: DO }} />{v.series![1]}</span>
        </div>
      )}
      <div className="flex flex-col gap-2">
        {v.items.map((it: VisualItem) => (
          <div key={it.label} className="grid grid-cols-[minmax(110px,32%)_1fr_auto] items-center gap-3 text-ui">
            <span className="text-text truncate" title={it.label}>
              {it.label}
              {it.note && <span className="ml-1.5 text-[11px] text-muted">{it.note}</span>}
            </span>
            {two ? (
              <span className="flex flex-col gap-[3px]">
                {(it.values || []).map((x, k) => (
                  <span key={k} className="h-[6px] rounded-full bg-subtle overflow-hidden">
                    <span className="block h-full rounded-full" style={{ width: `${Math.max(1, (Math.abs(Number(x)) / max) * 100)}%`, background: k ? DO : FAINT }} />
                  </span>
                ))}
              </span>
            ) : (
              <span className="h-[8px] rounded-full bg-subtle overflow-hidden">
                <span className="block h-full rounded-full" style={{ width: `${Math.max(1.5, (Math.abs(Number(it.value)) / max) * 100)}%`, background: it.note === "baseline" ? FAINT : DO }} />
              </span>
            )}
            <span className="font-mono tabular-nums text-secondary text-right w-[96px]">
              {two ? `${compact(it.values?.[0])} → ${compact(it.values?.[1])}` : fmtVal(it.value, v.format, v.unit)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Columns({ v }: { v: Extract<Visual, { type: "columns" }> }) {
  const items = v.items;
  const max = Math.max(...items.map((i) => Number(i.value) || 0), 1);
  const W = 640;
  const H = 150;
  const gap = items.length > 40 ? 1 : 2;
  const bw = Math.max(2, (W - 8) / items.length - gap);
  return (
    <Card title={v.title}>
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full h-auto" role="img" aria-label={`${v.title}: ${items.length} bars, highest ${compact(max)}`}>
        <line x1="0" x2={W} y1={H} y2={H} stroke="rgb(var(--chart-grid))" strokeWidth="1" />
        {items.map((it, i) => {
          const h = Math.max(1, (Number(it.value) / max) * (H - 8));
          return (
            <rect key={it.label} x={4 + i * (bw + gap)} y={H - h} width={bw} height={h} rx={Math.min(3, bw / 2)} fill={DO}>
              <title>{`${it.label}: ${exact(it.value)}`}</title>
            </rect>
          );
        })}
        {items[0] && <text x="4" y={H + 14} fontSize="11" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{items[0].label}</text>}
        {items.length > 1 && (
          <text x={W - 4} y={H + 14} fontSize="11" textAnchor="end" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{items[items.length - 1].label}</text>
        )}
      </svg>
    </Card>
  );
}

function Split({ v }: { v: Extract<Visual, { type: "split" }> }) {
  const total = v.items.reduce((a, i) => a + (Number(i.value) || 0), 0) || 1;
  return (
    <Card title={v.title}>
      <div className="flex h-[12px] rounded-full overflow-hidden gap-[2px]" role="img" aria-label={v.items.map((i) => `${i.label} ${i.value}`).join(", ")}>
        {v.items.map((it, k) => (
          <span key={it.label} style={{ width: `${((Number(it.value) || 0) / total) * 100}%`, background: SPLIT_COLORS[k % SPLIT_COLORS.length] }} title={`${it.label}: ${it.value}`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-caption text-secondary">
        {v.items.map((it, k) => (
          <span key={it.label} className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: SPLIT_COLORS[k % SPLIT_COLORS.length] }} aria-hidden="true" />
            {it.label} <b className="font-mono font-medium text-text tabular-nums">{exact(it.value)}</b>
          </span>
        ))}
      </div>
    </Card>
  );
}

function Histogram({ v }: { v: Extract<Visual, { type: "histogram" }> }) {
  const bins = v.bins || [];
  if (!bins.length) return null;
  const max = Math.max(...bins.map((b) => b.count), 1);
  const W = 640;
  const H = 140;
  const bw = (W - 8) / bins.length;
  return (
    <Card title={v.title}>
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full h-auto" role="img" aria-label={`${v.title}: from ${compact(bins[0].x0)} to ${compact(bins[bins.length - 1].x1)}`}>
        <line x1="0" x2={W} y1={H} y2={H} stroke="rgb(var(--chart-grid))" strokeWidth="1" />
        {bins.map((b, i) => {
          const h = Math.max(1, (b.count / max) * (H - 8));
          return (
            <rect key={i} x={4 + i * bw + 1} y={H - h} width={Math.max(1, bw - 2)} height={h} rx="2" fill={TELL}>
              <title>{`${compact(b.x0)} – ${compact(b.x1)}: ${b.count.toLocaleString()} rows`}</title>
            </rect>
          );
        })}
        <text x="4" y={H + 14} fontSize="11" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{compact(bins[0].x0)}</text>
        <text x={W - 4} y={H + 14} fontSize="11" textAnchor="end" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{compact(bins[bins.length - 1].x1)}</text>
      </svg>
    </Card>
  );
}

function Table({ v }: { v: Extract<Visual, { type: "table" }> }) {
  if (!v.rows.length) return null;
  return (
    <Card title={v.title}>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-ui border-collapse">
          <thead>
            <tr className="text-left">
              {v.columns.map((c) => (
                <th key={c} className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted font-medium px-2 py-2 border-b border-border whitespace-nowrap">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {v.rows.slice(0, 60).map((r, i) => (
              <tr key={i} className="border-b border-border last:border-b-0">
                {r.map((cell, k) => (
                  <td key={k} className={`px-2 py-2 ${k === 0 ? "text-text font-medium" : "text-secondary"} ${cell === "left out" ? "text-warning" : ""}`}>{String(cell ?? "—")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function StageVisuals({ visuals }: { visuals?: Visual[] | null }) {
  if (!visuals || !visuals.length) return null;
  return (
    <div className="flex flex-col gap-3 min-w-0">
      {visuals.map((v, i) => {
        switch (v.type) {
          case "funnel":
            return <Funnel key={i} v={v} />;
          case "kpis":
            return <Kpis key={i} v={v} />;
          case "bars":
            return <Bars key={i} v={v} />;
          case "columns":
            return <Columns key={i} v={v} />;
          case "split":
            return <Split key={i} v={v} />;
          case "histogram":
            return <Histogram key={i} v={v} />;
          case "table":
            return <Table key={i} v={v} />;
          case "line":
            // round 40: a training curve, a ROC curve, calibration - the results page's own line chart
            return (
              <Card key={i} title={v.title} note={v.note}>
                <LineView s={{ type: "line", title: v.title || "", x: v.x, series: v.series, format: v.format || "number" }} />
              </Card>
            );
          case "note":
            return (
              <Card key={i} title={v.title}>
                <p className="m-0 text-ui text-secondary leading-relaxed">{v.text}</p>
              </Card>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

/** The first rows a step produced, as a scrollable table. */
export function RowsPreview({ preview, note }: { preview?: StagePreview | null; note?: string }) {
  if (!preview || !preview.rows.length) return <p className="m-0 text-ui text-muted">This step has no rows to show.</p>;
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="overflow-auto max-h-[440px] rounded-card border border-border bg-surface">
        <table className="w-full text-[12.5px] border-collapse">
          <thead className="sticky top-0 bg-surface">
            <tr className="text-left">
              {preview.columns.map((c) => (
                <th key={c} className="font-mono text-[11px] text-muted font-medium px-3 py-2 border-b border-border whitespace-nowrap">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((r, i) => (
              <tr key={i} className="border-b border-border last:border-b-0">
                {r.map((cell, k) => (
                  <td key={k} className="px-3 py-1.5 font-mono text-secondary whitespace-nowrap max-w-[260px] truncate" title={String(cell ?? "")}>
                    {cell === null || cell === undefined ? <span className="text-faint">null</span> : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span className="text-caption text-muted">
        {note || `First ${preview.rows.length} rows`}
        {preview.total_columns > preview.columns.length ? ` · ${preview.columns.length} of ${preview.total_columns} columns` : ""}
      </span>
    </div>
  );
}
