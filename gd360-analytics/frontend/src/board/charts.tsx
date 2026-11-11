// 2026-10-15 (R49): the one chart engine for boards - SVG drawn to the container's real width, so labels never
// stretch and every mark sits on one scale. Colours come from the board's theme tokens (--bd-*).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Point, Tone, Unit } from "../api/boards";

export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// R66: the board's currency (from the money columns' names: revenue_inr -> INR), set by BoardView from the page run.
// Rupees read the Indian way: ₹4.2Cr, ₹38.5L.
const SYMBOLS: Record<string, string> = { USD: "$", INR: "₹", EUR: "€", GBP: "£", JPY: "¥", AED: "AED ", SGD: "S$", AUD: "A$" };
let CURRENCY = "USD";
export function setBoardCurrency(code?: string | null) { CURRENCY = (code || "USD").toUpperCase(); }
const symbol = () => SYMBOLS[CURRENCY] ?? "$";

export function fmt(v: number | null | undefined, unit?: Unit, opts: { compact?: boolean; decimals?: number } = {}): string {
  if (v == null || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  if (opts.decimals != null) return v.toFixed(opts.decimals);
  if (unit === "pct") return `${v.toFixed(1)}%`;
  if (unit === "pp") return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} pp`;
  if (unit === "ratio") return v.toFixed(2);
  const compact = (x: number) => (x >= 1e9 ? `${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e4 ? `${(x / 1e3).toFixed(1)}K` : x.toLocaleString(undefined, { maximumFractionDigits: 0 }));
  if (unit === "money") {
    const sym = symbol();
    const sign = v < 0 ? "−" : "";
    if (CURRENCY === "INR" && (opts.compact || a >= 1e5)) {
      const ind = a >= 1e7 ? `${(a / 1e7).toFixed(a >= 1e9 ? 0 : 1)}Cr` : a >= 1e5 ? `${(a / 1e5).toFixed(1)}L` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : `${Math.round(a)}`;
      return `${sign}${sym}${ind.replace(".0Cr", "Cr").replace(".0L", "L").replace(".0K", "K")}`;
    }
    if (opts.compact || a >= 1e5) return `${sign}${sym}${compact(a).replace(".0K", "K").replace(".0M", "M")}`;
    return `${sign}${sym}${a >= 100 ? Math.round(a).toLocaleString(CURRENCY === "INR" ? "en-IN" : undefined) : a.toFixed(2)}`;
  }
  if (unit === "count") return opts.compact && a >= 1e4 ? compact(a) : Math.round(v).toLocaleString();
  if (opts.compact && a >= 1e4) return compact(a);
  return a >= 100 ? Math.round(v).toLocaleString() : Number.isInteger(v) ? `${v}` : v.toFixed(a >= 10 ? 1 : 2);
}

export function toneVar(t?: Tone | string): string {
  return t === "bad" ? "var(--bd-warn)" : t === "good" ? "var(--bd-good)" : t === "warn" ? "var(--bd-amber)" : t === "neutral" ? "var(--bd-faint)" : "var(--bd-accent)";
}

export function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** Small area sparkline. */
export function Spark({ values, tone = "accent", height = 40 }: { values: (number | null)[]; tone?: Tone; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const vs = values.filter((v): v is number => v != null);
  const id = useRef(`sp${Math.random().toString(36).slice(2, 8)}`).current;
  if (vs.length < 2) return <div ref={ref} style={{ height }} />;
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const W = Math.max(w, 60), H = height;
  const x = (i: number) => 2 + (i / (values.length - 1)) * (W - 4);
  const y = (v: number) => H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 8);
  const pts = values.map((v, i) => (v == null ? null : [x(i), y(v)] as const)).filter(Boolean) as [number, number][];
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const color = toneVar(tone);
  return (
    <div ref={ref} style={{ height, width: "100%" }}>
      {w > 0 && (
        <svg width={W} height={H} aria-hidden="true">
          <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".28" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
          <path d={`${line} L${pts[pts.length - 1][0]},${H} L${pts[0][0]},${H} Z`} fill={`url(#${id})`} />
          <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={3} fill={color} />
        </svg>
      )}
    </div>
  );
}

/** Horizontal bars, one scale, optional dashed baseline; labels on the left, values on the right. */
export function HBars({ rows, unit, baseline, showN, showShare, decimals, onPick, lollipop = false }: {
  rows: { label: string; value: number | null; n?: number; count?: number; share?: number; tone?: Tone; small?: boolean }[]; unit?: Unit;
  baseline?: { value: number | null; label: string } | null; showN?: boolean; showShare?: boolean; decimals?: number; onPick?: (label: string) => void;
  /** R67: a thin stem with a dot at the value */
  lollipop?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const vals = rows.map((r) => r.value || 0).concat(baseline?.value ? [baseline.value] : []);
  const max = niceMax(Math.max(...vals, 0.0001) * 1.08);
  const labelW = Math.min(Math.max(w * 0.46, 110), 300);
  const valueW = showN || showShare ? 112 : 64;
  const track = Math.max(w - labelW - valueW - 20, 40);
  const rowH = 30, top = baseline ? 20 : 4;
  const H = top + rows.length * rowH + 4;
  const x = (v: number) => labelW + 10 + (Math.max(v, 0) / max) * track;
  return (
    <div ref={ref} className="bd-chart" style={{ height: H }}>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={rows.map((r) => `${r.label} ${fmt(r.value, unit, { decimals })}`).join(", ")}>
          {rows.map((r, i) => {
            const y = top + i * rowH;
            const label = cap(String(r.label));
            const room = Math.floor(labelW / 6.3);
            const clipped = label.length > room ? label.slice(0, room - 1) + "…" : label;
            return (
              <g key={i} className={onPick ? "pick" : undefined} onClick={onPick ? () => onPick(r.label) : undefined}>
                <title>{`${label}: ${fmt(r.value, unit, { decimals })}${r.n != null ? ` · ${r.n.toLocaleString()} rows` : ""}${onPick ? " · click to filter" : ""}`}</title>
                <rect x={0} y={y} width={w} height={rowH} fill="transparent" className="hit" />
                <text x={labelW} y={y + 15} textAnchor="end" className={r.small ? "lb sm" : "lb"}>{clipped}{r.small ? " *" : ""}</text>
                {lollipop ? <>
                  <line x1={labelW + 10} y1={y + 11} x2={Math.max(x(r.value || 0), labelW + 12)} y2={y + 11} stroke={toneVar(r.tone)} strokeWidth={2} opacity={r.small ? 0.4 : 0.55} />
                  <circle cx={Math.max(x(r.value || 0), labelW + 12)} cy={y + 11} r={6} fill={toneVar(r.tone)} opacity={r.small ? 0.4 : 1} />
                </> : <>
                  <rect x={labelW + 10} y={y + 4} width={track} height={14} rx={7} className="trk" />
                  <rect x={labelW + 10} y={y + 4} width={Math.max(x(r.value || 0) - labelW - 10, 3)} height={14} rx={7} fill={toneVar(r.tone)} opacity={r.small ? 0.4 : 1} />
                </>}
                <text x={labelW + 10 + track + 10} y={y + 15} className="vl">{fmt(r.value, unit, { decimals, compact: true })}</text>
                {showN && r.n != null && <text x={w - 2} y={y + 15} textAnchor="end" className="mt">{r.n.toLocaleString()}</text>}
                {showShare && r.share != null && <text x={w - 2} y={y + 15} textAnchor="end" className="mt">{r.share.toFixed(1)}%</text>}
              </g>
            );
          })}
          {baseline?.value != null && (
            <g>
              <line x1={x(baseline.value)} y1={top - 6} x2={x(baseline.value)} y2={H - 2} className="base" />
              <text x={Math.min(x(baseline.value) + 5, w - 80)} y={11} className="mt">{baseline.label}</text>
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

/** A line with a soft area, labelled points, optional dashed comparison series and baseline. */
export function LineArea({ points, compare, unit, baseline, height = 210, labels = true, axis = true, fill = true }: {
  points: Point[]; compare?: Point[] | null; unit?: Unit; baseline?: { value: number | null; label: string } | null; height?: number; labels?: boolean; axis?: boolean;
  /** R67: false draws a plain line (the "Line" style); the default is the soft area */
  fill?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const id = useRef(`la${Math.random().toString(36).slice(2, 8)}`).current;
  const ps = points.filter((p) => p.value != null) as { label: string; value: number }[];
  const cs = (compare || []).filter((p) => p.value != null) as { label: string; value: number }[];
  const all = ps.map((p) => p.value).concat(cs.map((p) => p.value)).concat(baseline?.value != null ? [baseline.value] : []);
  const lo0 = Math.min(...all, 0), hi0 = Math.max(...all, 0.0001);
  const spread = hi0 - Math.min(...all);
  const lo = unit === "pct" || lo0 >= 0 ? (Math.min(...all) > spread * 1.5 ? Math.max(0, Math.min(...all) - spread * 0.6) : 0) : lo0;
  const hi = lo + niceMax((hi0 - lo) * 1.12);
  const L = axis ? 46 : 18, R = 18, T = 22, B = 30;
  const W = Math.max(w, 200), H = height;
  const n = Math.max(points.length, 2);
  const x = (i: number) => L + (i / (n - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const pts = points.map((p, i) => (p.value == null ? null : [x(i), y(p.value), p] as const)).filter(Boolean) as [number, number, Point][];
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const cpts = (compare || []).map((p, i) => (p.value == null ? null : [x(i), y(p.value)] as const)).filter(Boolean) as [number, number][];
  const cline = cpts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const ticks = [lo, lo + (hi - lo) / 2, hi];
  const every = Math.max(1, Math.ceil(points.length / Math.max(Math.floor((W - L - R) / 62), 2)));
  // x labels counted from the last point, so the newest is always named and none collide
  const showX = (i: number) => (points.length - 1 - i) % every === 0;
  // value labels: all of them when there is room, otherwise the first, the last, the highest and the lowest
  const spacing = (W - L - R) / Math.max(n - 1, 1);
  const vals = points.map((p) => p.value);
  const iMax = vals.indexOf(Math.max(...(vals.filter((v) => v != null) as number[])));
  const iMin = vals.indexOf(Math.min(...(vals.filter((v) => v != null) as number[])));
  const chosen = new Set<number>();
  if (spacing >= 58) points.forEach((_, i) => chosen.add(i));
  else {
    for (const i of [points.length - 1, iMax, iMin, 0]) {
      if (i < 0 || points[i]?.value == null) continue;
      if ([...chosen].every((j) => Math.abs(j - i) * spacing >= 56)) chosen.add(i);
    }
  }
  const showV = (i: number) => chosen.has(i);
  return (
    <div ref={ref} className="bd-chart" style={{ height: H }}>
      {w > 0 && pts.length > 0 && (
        <svg width={W} height={H} role="img" aria-label={points.map((p) => `${p.label} ${fmt(p.value, unit)}`).join(", ")}>
          <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--bd-accent)" stopOpacity=".2" /><stop offset="1" stopColor="var(--bd-accent)" stopOpacity="0" /></linearGradient></defs>
          {ticks.map((t, i) => (
            <g key={i}><line x1={L} y1={y(t)} x2={W - R} y2={y(t)} className="grid" />{axis && <text x={L - 8} y={y(t) + 4} textAnchor="end" className="mt">{fmt(t, unit, { compact: true })}</text>}</g>
          ))}
          {baseline?.value != null && <line x1={L} y1={y(baseline.value)} x2={W - R} y2={y(baseline.value)} className="base" />}
          {cline && <path d={cline} fill="none" className="cmp" />}
          {fill && <path d={`${line} L${pts[pts.length - 1][0]},${H - B} L${pts[0][0]},${H - B} Z`} fill={`url(#${id})`} />}
          <path d={line} fill="none" stroke="var(--bd-accent)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          {pts.map(([px, py, p], i) => (
            <g key={i}>
              <title>{`${p.label}: ${fmt(p.value, unit)}${p.n != null ? ` · ${p.n.toLocaleString()} rows` : ""}`}</title>
              <circle cx={px} cy={py} r={3.5} className="dot" />
              {labels && showV(i) && (
                <text x={px} y={py - 10} textAnchor={i === 0 && points.length > 2 ? "start" : i === points.length - 1 && points.length > 2 ? "end" : "middle"} className="vl">{fmt(p.value, unit, { compact: true })}</text>
              )}
            </g>
          ))}
          {points.map((p, i) => showX(i) && <text key={"x" + i} x={x(i)} y={H - 10} textAnchor={i === points.length - 1 && points.length > 2 ? "end" : i === 0 && points.length > 2 ? "start" : "middle"} className="mt">{p.label}</text>)}
        </svg>
      )}
    </div>
  );
}

/** Hero curve: a larger smoothed area for the hero tile. */
export function HeroCurve({ points, unit }: { points: Point[]; unit?: Unit }) {
  return <LineArea points={points} unit={unit} height={150} axis={false} />;
}

/** Fades content in once mounted (never left invisible: a thumbnail sees the resting state). */
export function useMounted(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => { const t = setTimeout(() => setM(true), 10); return () => clearTimeout(t); }, []);
  return m;
}


/** R67: vertical columns - for a breakdown drawn as columns, or a monthly series drawn as bars. */
export function Columns({ rows, unit, height = 230, onPick }: {
  rows: { label: string; value: number | null; tone?: Tone }[]; unit?: Unit; height?: number; onPick?: (label: string) => void;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const vals = rows.map((r) => r.value || 0);
  const max = niceMax(Math.max(...vals, 0.0001) * 1.1);
  const L = 46, R = 8, T = 18, B = 34;
  const W = Math.max(w, 200), H = height;
  const n = Math.max(rows.length, 1);
  const slot = (W - L - R) / n;
  const bw = Math.min(Math.max(slot * 0.62, 6), 56);
  const y = (v: number) => T + (1 - Math.max(v, 0) / max) * (H - T - B);
  const ticks = [0, max / 2, max];
  const every = Math.max(1, Math.ceil(n / Math.max(Math.floor((W - L - R) / 64), 1)));
  return (
    <div ref={ref} className="bd-chart" style={{ height: H }}>
      {w > 0 && (
        <svg width={W} height={H} role="img" aria-label={rows.map((r) => `${r.label} ${fmt(r.value, unit)}`).join(", ")}>
          {ticks.map((t, i) => <g key={i}><line x1={L} y1={y(t)} x2={W - R} y2={y(t)} className="grid" /><text x={L - 8} y={y(t) + 4} textAnchor="end" className="mt">{fmt(t, unit, { compact: true })}</text></g>)}
          {rows.map((r, i) => {
            const cx = L + slot * i + slot / 2;
            const top = y(r.value || 0);
            const label = cap(String(r.label));
            const room = Math.max(3, Math.floor((slot * every) / 6.5));
            return (
              <g key={i} className={onPick ? "pick" : undefined} onClick={onPick ? () => onPick(r.label) : undefined}>
                <title>{`${label}: ${fmt(r.value, unit)}`}</title>
                <rect x={cx - bw / 2} y={top} width={bw} height={Math.max(H - B - top, 2)} rx={Math.min(6, bw / 3)} fill={toneVar(r.tone)} />
                {slot >= 44 && <text x={cx} y={top - 6} textAnchor="middle" className="vl">{fmt(r.value, unit, { compact: true })}</text>}
                {i % every === 0 && <text x={cx} y={H - 12} textAnchor="middle" className="mt">{label.length > room ? label.slice(0, room - 1) + "…" : label}</text>}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/** R67: a donut with the total in the middle and a legend - shares of a whole (at most 6 slices, the rest as "Other"). */
export function Donut({ rows, unit, onPick }: { rows: { label: string; value: number | null }[]; unit?: Unit; onPick?: (label: string) => void }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const clean = rows.filter((r) => (r.value || 0) > 0).map((r) => ({ label: String(r.label), value: r.value || 0 }));
  const top = clean.slice(0, 5);
  const rest = clean.slice(5).reduce((a, r) => a + r.value, 0);
  const parts = rest > 0 ? [...top, { label: "Other", value: rest }] : top;
  const total = parts.reduce((a, r) => a + r.value, 0) || 1;
  const size = Math.min(200, Math.max(140, (w || 300) * 0.42));
  const r0 = size / 2 - 4, r1 = r0 * 0.62;
  const shades = [1, 0.78, 0.6, 0.45, 0.32, 0.2];
  let a0 = -Math.PI / 2;
  const arc = (a: number, b: number) => {
    const big = b - a > Math.PI ? 1 : 0;
    const p = (r: number, t: number) => `${size / 2 + r * Math.cos(t)},${size / 2 + r * Math.sin(t)}`;
    return `M${p(r0, a)} A${r0},${r0} 0 ${big} 1 ${p(r0, b)} L${p(r1, b)} A${r1},${r1} 0 ${big} 0 ${p(r1, a)} Z`;
  };
  return (
    <div ref={ref} className="bd-donut">
      <svg width={size} height={size} role="img" aria-label={parts.map((p) => `${p.label} ${((p.value / total) * 100).toFixed(1)}%`).join(", ")}>
        {parts.map((p, i) => {
          const a1 = a0 + (p.value / total) * Math.PI * 2 - (parts.length > 1 ? 0.012 : 0);
          const d = arc(a0, Math.max(a1, a0 + 0.001));
          a0 = a0 + (p.value / total) * Math.PI * 2;
          return <path key={i} d={d} fill="var(--bd-accent)" opacity={shades[i] ?? 0.2} className={onPick ? "pick" : undefined} onClick={onPick ? () => onPick(p.label) : undefined}><title>{`${p.label}: ${fmt(p.value, unit)} · ${((p.value / total) * 100).toFixed(1)}%`}</title></path>;
        })}
        <text x={size / 2} y={size / 2 - 2} textAnchor="middle" className="dv">{fmt(total, unit, { compact: true })}</text>
        <text x={size / 2} y={size / 2 + 16} textAnchor="middle" className="mt">total</text>
      </svg>
      <ul className="bd-dleg">
        {parts.map((p, i) => (
          <li key={i}><i style={{ background: "var(--bd-accent)", opacity: shades[i] ?? 0.2 }} /><span className="l">{cap(p.label)}</span><span className="v">{((p.value / total) * 100).toFixed(1)}%</span></li>
        ))}
      </ul>
    </div>
  );
}
