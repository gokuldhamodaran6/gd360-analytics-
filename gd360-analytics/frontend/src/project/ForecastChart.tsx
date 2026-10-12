// 2026-10-12 (round 32): a forecast inside an answer. The headline number
// for exactly the period asked, its likely (80%) and wide (95%) range, how
// it compares with the last actual period - and the chart: actual years as
// solid bars, forecast years as dashed outlines with their range, or the
// months as a line with a widening band. A forecast is never drawn so it
// could be mistaken for real sales. Every number comes from the backend
// (project_engine/forecasting.py); nothing is computed here but positions.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ForecastPoint, ForecastVisual, ForecastYear } from "../api/projects";
import { formatValue } from "./format";

type View = "years" | "months" | "table";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const H = 300;
const PAD = { top: 20, right: 14, bottom: 34, left: 58 };

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setW(Math.max(280, Math.round(el.getBoundingClientRect().width)));
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Round ticks covering [lo, hi]. */
function ticks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out: number[] = [];
  // the last tick is the first round number at or above the top, so no mark rises past the axis
  for (let v = Math.floor(lo / step) * step; out.length < 12; v += step) {
    out.push(Number(v.toPrecision(12)));
    if (v >= hi - step * 1e-9) break;
  }
  return out;
}

const parse = (p: string) => {
  const [y, m, d] = p.slice(0, 10).split("-").map(Number);
  return { y, m: m || 1, d: d || 1 };
};
const periodLabel = (p: string, grain: ForecastVisual["grain"]) => {
  const { y, m, d } = parse(p);
  if (grain === "year") return String(y);
  if (grain === "quarter") return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (grain === "month") return `${MON[m - 1]} ${y}`;
  return `${d} ${MON[m - 1]} ${y}`;
};

type Tip = { x: number; y: number; title: string; lines: { k: string; v: string; tone?: "actual" | "forecast" | "muted" }[] };

export default function ForecastChart({ visual }: { visual: ForecastVisual }) {
  const v = visual;
  const fmt = (x: number | null | undefined) => formatValue(x ?? null, v.format, v.currency);
  const fineGrain = v.grain !== "year" && v.points.some((p) => p.kind === "forecast");
  const spanMonths = useMemo(() => {
    const a = parse(v.target.start), b = parse(v.target.end);
    return (b.y - a.y) * 12 + b.m - a.m + 1;
  }, [v.target.start, v.target.end]);
  const initial: View = !fineGrain || v.target.multi_year || spanMonths >= 12 ? "years" : "months";
  const [view, setView] = useState<View>(initial);
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const uid = useId().replace(/:/g, "");
  const h = v.headline;
  const vs = h.vs;
  const up = vs ? vs.pct > 0.05 : null;
  const down = vs ? vs.pct < -0.05 : null;
  const certainty = v.method.certainty;
  const certaintyText =
    certainty === "tested" && v.method.mape != null
      ? `Tested · typically within ±${v.method.mape.toFixed(1)}%`
      : certainty === "long-range"
        ? "Long-range projection"
        : certainty === "rough"
          ? "Rough trend · little history"
          : "Not enough history to test";

  const views: { id: View; label: string }[] = [
    { id: "years", label: "By year" },
    ...(fineGrain ? [{ id: "months" as View, label: v.grain === "quarter" ? "By quarter" : v.grain === "week" ? "By week" : v.grain === "day" ? "By day" : "By month" }] : []),
    { id: "table", label: "Table" },
  ];

  return (
    <div className="flex flex-col gap-5 min-w-0" data-forecast="" data-forecast-view={view}>
      {/* the answer, first */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex flex-col gap-1.5 min-w-0">
          <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-kind-answer">
            <span className="w-[7px] h-[7px] rounded-full bg-kind-answer" aria-hidden="true" />
            Forecast · {h.label}
          </span>
          <span className="font-mono text-[40px] sm:text-[46px] leading-none tracking-tight text-text tabular-nums" data-forecast-value="">
            {h.display}
          </span>
          <span className="text-[14px] text-secondary">
            Likely <b className="font-semibold text-text tabular-nums">{h.range_display}</b>
            <span className="text-muted"> · 95%: <span className="tabular-nums">{h.wide_display}</span></span>
          </span>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {vs && (
            <span
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full border text-[13px] font-medium tabular-nums ${
                up ? "border-good-border bg-good-fill text-good" : down ? "border-danger-border bg-danger-fill text-danger" : "border-border bg-subtle text-secondary"
              }`}
              data-forecast-vs=""
            >
              {up ? "▲" : down ? "▼" : "■"} {vs.pct_display || "—"} <span className="font-normal opacity-80">vs {vs.label} ({vs.display})</span>
            </span>
          )}
          {h.total_display && (
            <span className="inline-flex items-center h-8 px-3 rounded-full border border-border bg-subtle text-[13px] text-secondary tabular-nums">
              Total {v.target.label.replace(/^the next.*\((.*)\)$/, "$1")}: <b className="ml-1 font-semibold text-text">{h.total_display}</b>
            </span>
          )}
          <span
            className={`inline-flex items-center h-8 px-3 rounded-full border text-[13px] ${
              certainty === "tested" ? "border-kind-answer-border bg-kind-answer-fill text-kind-answer" : "border-warning-border bg-warning-fill text-warning"
            }`}
            data-forecast-certainty={certainty}
          >
            {certaintyText}
          </span>
        </div>
      </div>

      {/* view switch + legend */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Forecast view" className="inline-flex p-0.5 rounded-full border border-border bg-base/40">
          {views.map((o) => (
            <button
              key={o.id}
              role="tab"
              type="button"
              aria-selected={view === o.id}
              onClick={() => { setTip(null); setView(o.id); }}
              className={`ui-focus h-8 px-3.5 rounded-full text-[13px] transition-colors ${view === o.id ? "bg-surface text-text shadow-[0_1px_0_rgb(255_255_255/0.04)] border border-border-strong" : "text-muted hover:text-text border border-transparent"}`}
              data-forecast-tab={o.id}
            >
              {o.label}
            </button>
          ))}
        </div>
        {view !== "table" && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-secondary" aria-hidden="true">
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-[3px] bg-kind-analysis" />Actual</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-[3px] border-[1.5px] border-dashed border-kind-answer" />Forecast</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-[3px] bg-kind-answer/35" />Likely (80%)</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-[3px] bg-kind-answer/12 border border-kind-answer/30" />Wide (95%)</span>
          </div>
        )}
      </div>

      <div ref={ref} className="relative min-w-0" onMouseLeave={() => setTip(null)}>
        {view === "years" && <YearBars v={v} width={width} fmt={fmt} uid={uid} onTip={setTip} />}
        {view === "months" && <MonthLine v={v} width={width} fmt={fmt} uid={uid} onTip={setTip} />}
        {view === "table" && <ForecastTable v={v} fmt={fmt} />}
        {tip && view !== "table" && (
          <div
            role="status"
            className="pointer-events-none absolute z-10 min-w-[180px] max-w-[260px] rounded-[12px] border border-border-strong bg-surface/95 backdrop-blur px-3 py-2.5 shadow-[0_18px_40px_-18px_rgb(0_0_0/0.8)]"
            style={{ left: Math.min(Math.max(8, tip.x + 12), width - 268), top: Math.max(0, tip.y - 8) }}
            data-forecast-tip=""
          >
            <div className="text-[12.5px] font-semibold text-text mb-1">{tip.title}</div>
            {tip.lines.map((l) => (
              <div key={l.k} className="flex justify-between gap-4 text-[12px] leading-[1.6]">
                <span className={l.tone === "forecast" ? "text-kind-answer" : l.tone === "actual" ? "text-kind-analysis" : "text-muted"}>{l.k}</span>
                <span className="font-mono tabular-nums text-text">{l.v}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <details className="group rounded-[14px] border border-border bg-base/30 px-4 py-3 text-[13px] text-secondary" data-forecast-method="">
        <summary className="cursor-pointer list-none flex items-center justify-between gap-3 text-muted hover:text-text">
          <span>How this forecast was made</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="transition-transform group-open:rotate-180" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </summary>
        <dl className="m-0 mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted">Model</dt>
          <dd className="m-0 text-text">{v.method.label}</dd>
          <dt className="text-muted">Learned from</dt>
          <dd className="m-0 text-text">{v.method.history}</dd>
          {v.method.mape != null && (
            <>
              <dt className="text-muted">Tested</dt>
              <dd className="m-0 text-text">
                On past periods it hadn't seen, it was typically {v.method.mape.toFixed(1)}% off
                {v.method.baseline_mape != null && v.method.baseline ? ` (a simple ${v.method.baseline.toLowerCase()} guess: ${v.method.baseline_mape.toFixed(1)}%)` : ""}.
              </dd>
            </>
          )}
          <dt className="text-muted">Ranges</dt>
          <dd className="m-0 text-text">8 in 10 outcomes should land in the likely range, 19 in 20 in the wide one.</dd>
          {v.method.long_range_from != null && (
            <>
              <dt className="text-muted">Long range</dt>
              <dd className="m-0 text-text">From {v.method.long_range_from} the yearly trend carries on with fading growth, and the range widens every year.</dd>
            </>
          )}
        </dl>
        {v.method.notes.length > 0 && (
          <ul className="m-0 mt-3 pl-4 flex flex-col gap-1 text-[12.5px] text-muted">
            {v.method.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
      </details>
    </div>
  );
}

// ---- by year: actual bars, forecast outlines with their range ------------------------------

function YearBars({ v, width, fmt, uid, onTip }: { v: ForecastVisual; width: number; fmt: (x?: number | null) => string; uid: string; onTip: (t: Tip | null) => void }) {
  const years = v.years;
  const target = v.target.headline_label;
  const W = width;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const max = Math.max(...years.map((y) => Math.max(y.value, y.hi95 ?? y.value, y.hi80 ?? y.value)), 0);
  const min = Math.min(0, ...years.map((y) => Math.min(y.value, y.lo95 ?? y.value)));
  const tk = ticks(min, max * 1.04);
  const top = tk[tk.length - 1];
  const bottom = tk[0];
  const yv = (x: number) => PAD.top + ih - ((x - bottom) / (top - bottom || 1)) * ih;
  const n = Math.max(1, years.length);
  const slot = iw / n;
  const bw = Math.max(6, Math.min(56, slot * 0.62));
  const every = Math.max(1, Math.ceil(46 / slot));
  const firstFc = years.findIndex((y) => y.kind !== "actual");
  const zero = yv(Math.max(0, bottom));
  // value labels: the asked year, and the last actual when there is room beside it
  const show = (y: ForecastYear, i: number) => y.period === target || (i === firstFc - 1 && firstFc > 0 && slot >= 44);
  // year labels: the asked year and the first forecast year always; the rest spaced so none collide
  const forced = new Set(years.map((y, i) => (y.period === target || i === firstFc ? i : -1)).filter((i) => i >= 0));
  const labelled = new Set<number>(forced);
  years.forEach((_y, i) => {
    if (i % every === 0 && [...forced].every((f) => Math.abs(f - i) >= every || f === i)) labelled.add(i);
  });

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" className="block max-w-full"
      aria-label={`${v.metric} by year: ${years.filter((y) => y.kind === "actual").length} actual years and ${years.filter((y) => y.kind !== "actual").length} forecast years. ${v.headline.label}: ${v.headline.display}, likely ${v.headline.range_display}.`}>
      <defs>
        <pattern id={`fc-hatch-${uid}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="rgb(var(--color-kind-answer) / 0.07)" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="rgb(var(--color-kind-answer) / 0.28)" strokeWidth="1.5" />
        </pattern>
      </defs>
      {tk.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={W - PAD.right} y1={yv(t)} y2={yv(t)} stroke="rgb(var(--chart-grid))" strokeWidth="1" />
          <text x={PAD.left - 10} y={yv(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="rgb(var(--color-muted))" className="tabular-nums">{fmt(t)}</text>
        </g>
      ))}
      {firstFc > 0 && (
        <g>
          <line x1={PAD.left + slot * firstFc} x2={PAD.left + slot * firstFc} y1={PAD.top - 6} y2={PAD.top + ih} stroke="rgb(var(--color-border-strong))" strokeDasharray="3 4" />
          <text x={PAD.left + slot * firstFc + 6} y={PAD.top - 6} fontSize="10.5" fill="rgb(var(--color-kind-answer))" className="uppercase" letterSpacing="0.1em">Forecast →</text>
        </g>
      )}
      {years.map((y, i) => {
        const cx = PAD.left + slot * i + slot / 2;
        const x = cx - bw / 2;
        const isFc = y.kind !== "actual";
        const actualPart = y.kind === "mixed" ? y.actual_part ?? 0 : 0;
        const yTop = yv(y.value);
        const isTarget = y.period === target;
        const tip = () => onTip({
          x: cx, y: Math.min(yTop, yv(y.hi95 ?? y.value)),
          title: `${y.period}${isFc ? (y.kind === "mixed" ? " · actual so far + forecast" : " · forecast") : " · actual"}`,
          lines: [
            { k: isFc ? "Forecast" : "Actual", v: fmt(y.value), tone: isFc ? "forecast" : "actual" },
            ...(y.kind === "mixed" && y.actual_part != null ? [{ k: "Actual so far", v: fmt(y.actual_part), tone: "actual" as const }] : []),
            ...(y.lo80 != null && y.hi80 != null ? [{ k: "Likely (80%)", v: `${fmt(y.lo80)} – ${fmt(y.hi80)}`, tone: "muted" as const }] : []),
            ...(y.lo95 != null && y.hi95 != null ? [{ k: "Wide (95%)", v: `${fmt(y.lo95)} – ${fmt(y.hi95)}`, tone: "muted" as const }] : []),
          ],
        });
        return (
          <g key={y.period} data-forecast-year={y.period} data-kind={y.kind}>
            {!isFc && <path d={roundTop(x, yTop, bw, zero - yTop, Math.min(4, bw / 3))} fill="rgb(var(--color-kind-analysis))" opacity={0.92} />}
            {y.kind === "mixed" && actualPart > 0 && (
              <rect x={x} y={yv(actualPart)} width={bw} height={zero - yv(actualPart)} fill="rgb(var(--color-kind-analysis))" opacity={0.92} />
            )}
            {isFc && (
              <>
                <path d={roundTop(x, yTop, bw, (y.kind === "mixed" ? yv(actualPart) : zero) - yTop, Math.min(4, bw / 3))}
                  fill={`url(#fc-hatch-${uid})`} stroke="rgb(var(--color-kind-answer))" strokeWidth={isTarget ? 2 : 1.4} strokeDasharray="5 4" />
                {y.lo95 != null && y.hi95 != null && (
                  <line x1={cx} x2={cx} y1={yv(y.hi95)} y2={yv(y.lo95)} stroke="rgb(var(--color-kind-answer) / 0.45)" strokeWidth="1.5" />
                )}
                {y.lo80 != null && y.hi80 != null && (
                  <rect x={cx - Math.max(3, bw * 0.18)} y={yv(y.hi80)} width={Math.max(6, bw * 0.36)} height={Math.max(2, yv(y.lo80) - yv(y.hi80))}
                    rx={Math.min(3, bw * 0.1)} fill="rgb(var(--color-kind-answer) / 0.55)" />
                )}
                <line x1={cx - Math.max(4, bw * 0.28)} x2={cx + Math.max(4, bw * 0.28)} y1={yTop} y2={yTop} stroke="rgb(var(--color-kind-answer))" strokeWidth="2" strokeLinecap="round" />
              </>
            )}
            {show(y, i) && (
              <text x={cx} y={Math.min(yTop, yv(y.hi95 ?? y.value)) - 8} textAnchor="middle" fontSize="11.5" fontWeight={600}
                fill={isFc ? "rgb(var(--color-kind-answer))" : "rgb(var(--color-text))"} className="tabular-nums">{fmt(y.value)}</text>
            )}
            {labelled.has(i) && (
              <text x={cx} y={H - PAD.bottom + 18} textAnchor="middle" fontSize="11.5" fontWeight={isTarget ? 600 : 400}
                fill={isFc ? "rgb(var(--color-kind-answer))" : "rgb(var(--color-muted))"}>{y.period}</text>
            )}
            <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={ih} fill="transparent" onMouseEnter={tip} onMouseMove={tip} onFocus={tip} tabIndex={-1} />
          </g>
        );
      })}
      <line x1={PAD.left} x2={W - PAD.right} y1={zero} y2={zero} stroke="rgb(var(--chart-axis))" strokeWidth="1" />
    </svg>
  );
}

/** A bar with rounded top corners, anchored to the baseline. */
function roundTop(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return "";
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

// ---- by month: the line, the forecast dashed, its band widening -------------------------------

function MonthLine({ v, width, fmt, uid, onTip }: { v: ForecastVisual; width: number; fmt: (x?: number | null) => string; uid: string; onTip: (t: Tip | null) => void }) {
  // the history kept short enough to read beside the forecast
  const all = v.points;
  const fcAt = all.findIndex((p) => p.kind === "forecast");
  const fcCount = all.length - fcAt;
  const keepHist = Math.max(12, Math.min(fcAt, Math.max(24, fcCount * 2)));
  const pts: ForecastPoint[] = all.slice(Math.max(0, fcAt - keepHist));
  const W = width;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const hiV = Math.max(...pts.map((p) => p.hi95 ?? p.value));
  const loV = Math.min(...pts.map((p) => p.lo95 ?? p.value));
  const tk = ticks(Math.max(0, loV - (hiV - loV) * 0.08), hiV * 1.02);
  const top = tk[tk.length - 1], bottom = tk[0];
  const n = pts.length;
  const xv = (i: number) => PAD.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yv = (x: number) => PAD.top + ih - ((x - bottom) / (top - bottom || 1)) * ih;
  const first = pts.findIndex((p) => p.kind === "forecast");
  const lastActual = first > 0 ? first - 1 : -1;
  const line = (from: number, to: number) => pts.slice(from, to + 1).map((p, j) => `${j ? "L" : "M"}${xv(from + j).toFixed(1)},${yv(p.value).toFixed(1)}`).join("");
  const band = (lo: "lo80" | "lo95", hi: "hi80" | "hi95") => {
    if (first < 0) return "";
    const seg = pts.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === "forecast");
    const start = lastActual >= 0 ? [{ x: xv(lastActual), y: yv(pts[lastActual].value) }] : [];
    const upper = [...start, ...seg.map(({ p, i }) => ({ x: xv(i), y: yv(p[hi] ?? p.value) }))];
    const lower = [...seg.map(({ p, i }) => ({ x: xv(i), y: yv(p[lo] ?? p.value) })).reverse(), ...start];
    return [...upper, ...lower].map((q, j) => `${j ? "L" : "M"}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join("") + "Z";
  };
  const [hover, setHover] = useState<number | null>(null);
  const janTicks = pts.map((p, i) => ({ p, i })).filter(({ p }) => parse(p.period).m === 1 || v.grain === "week" || v.grain === "day");
  const step = Math.max(1, Math.ceil(janTicks.length / Math.max(2, Math.floor(iw / 64))));
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const x = e.clientX - box.left;
    const i = Math.max(0, Math.min(n - 1, Math.round(((x - PAD.left) / iw) * (n - 1))));
    const p = pts[i];
    const isFc = p.kind === "forecast";
    onTip({
      x: xv(i), y: yv(p.hi95 ?? p.value),
      title: `${periodLabel(p.period, v.grain)} · ${isFc ? (p.source === "long" ? "long-range forecast" : "forecast") : p.kind === "partial" ? "partial" : "actual"}`,
      lines: [
        { k: isFc ? "Forecast" : "Actual", v: fmt(p.value), tone: isFc ? "forecast" : "actual" },
        ...(p.lo80 != null && p.hi80 != null ? [{ k: "Likely (80%)", v: `${fmt(p.lo80)} – ${fmt(p.hi80)}`, tone: "muted" as const }] : []),
        ...(p.lo95 != null && p.hi95 != null ? [{ k: "Wide (95%)", v: `${fmt(p.lo95)} – ${fmt(p.hi95)}`, tone: "muted" as const }] : []),
      ],
    });
    setHover(i);
  };
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" className="block max-w-full"
      aria-label={`${v.metric} by ${v.grain}: actual line, then the forecast dashed with its likely and wide ranges.`}
      onMouseLeave={() => setHover(null)}>
      <defs>
        <linearGradient id={`fc-fade-${uid}`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="rgb(var(--color-kind-answer))" stopOpacity="0.32" />
          <stop offset="1" stopColor="rgb(var(--color-kind-answer))" stopOpacity="0.18" />
        </linearGradient>
      </defs>
      {tk.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={W - PAD.right} y1={yv(t)} y2={yv(t)} stroke="rgb(var(--chart-grid))" />
          <text x={PAD.left - 10} y={yv(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="rgb(var(--color-muted))" className="tabular-nums">{fmt(t)}</text>
        </g>
      ))}
      {janTicks.filter((_t, k) => k % step === 0).map(({ p, i }) => (
        <text key={p.period} x={xv(i)} y={H - PAD.bottom + 18} textAnchor="middle" fontSize="11.5"
          fill={p.kind === "forecast" ? "rgb(var(--color-kind-answer))" : "rgb(var(--color-muted))"}>
          {v.grain === "week" || v.grain === "day" ? periodLabel(p.period, v.grain) : parse(p.period).y}
        </text>
      ))}
      {first > 0 && (
        <g>
          <line x1={xv(lastActual)} x2={xv(lastActual)} y1={PAD.top - 6} y2={PAD.top + ih} stroke="rgb(var(--color-border-strong))" strokeDasharray="3 4" />
          <text x={xv(lastActual) + 6} y={PAD.top - 6} fontSize="10.5" fill="rgb(var(--color-kind-answer))" letterSpacing="0.1em">FORECAST →</text>
        </g>
      )}
      <path d={band("lo95", "hi95")} fill="rgb(var(--color-kind-answer) / 0.10)" />
      <path d={band("lo80", "hi80")} fill={`url(#fc-fade-${uid})`} />
      {lastActual >= 0 && <path d={line(0, lastActual)} fill="none" stroke="rgb(var(--color-kind-analysis))" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      {first >= 0 && (
        <path d={line(Math.max(0, lastActual), n - 1)} fill="none" stroke="rgb(var(--color-kind-answer))" strokeWidth="2" strokeDasharray="6 5" strokeLinejoin="round" strokeLinecap="round" />
      )}
      {hover != null && (
        <g>
          <line x1={xv(hover)} x2={xv(hover)} y1={PAD.top} y2={PAD.top + ih} stroke="rgb(var(--color-border-strong))" />
          <circle cx={xv(hover)} cy={yv(pts[hover].value)} r="4.5" fill={pts[hover].kind === "forecast" ? "rgb(var(--color-kind-answer))" : "rgb(var(--color-kind-analysis))"} stroke="rgb(var(--color-surface))" strokeWidth="2" />
        </g>
      )}
      <rect x={PAD.left} y={PAD.top} width={iw} height={ih} fill="transparent" onMouseMove={onMove} />
    </svg>
  );
}

// ---- the table: every year, actual and forecast, with both ranges ---------------------------

function ForecastTable({ v, fmt }: { v: ForecastVisual; fmt: (x?: number | null) => string }) {
  return (
    <div className="overflow-x-auto -mx-1" data-forecast-table="">
      <table className="w-full border-collapse text-ui tabular-nums">
        <thead>
          <tr>
            {["Year", "", v.metric, "Likely (80%)", "Wide (95%)"].map((c, i) => (
              <th key={i} scope="col" className={`px-3 py-2 text-caption font-medium text-muted border-b border-border whitespace-nowrap ${i >= 2 ? "text-right" : "text-left"}`}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {v.years.map((y) => (
            <tr key={y.period} className="border-b border-border last:border-0 hover:bg-subtle/60">
              <td className="px-3 py-2.5 text-text font-medium">{y.period}</td>
              <td className="px-3 py-2.5">
                <span className={`inline-flex h-[20px] items-center px-2 rounded-md text-[11px] ${y.kind === "actual" ? "bg-kind-analysis-fill text-kind-analysis" : "bg-kind-answer-fill text-kind-answer"}`}>
                  {y.kind === "actual" ? "Actual" : y.kind === "mixed" ? "Actual + forecast" : y.long_range ? "Long-range" : "Forecast"}
                </span>
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-[13px] text-text">{fmt(y.value)}</td>
              <td className="px-3 py-2.5 text-right font-mono text-[13px] text-secondary">{y.lo80 != null ? `${fmt(y.lo80)} – ${fmt(y.hi80)}` : "—"}</td>
              <td className="px-3 py-2.5 text-right font-mono text-[13px] text-muted">{y.lo95 != null ? `${fmt(y.lo95)} – ${fmt(y.hi95)}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
