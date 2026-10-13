// Event OS charts: small, dependency-free SVG, drawn to scale, themed by
// the app's tokens (light and dark), with a hover readout on every mark.
import { ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export const C = {
  primary: "rgb(var(--color-primary))",
  text: "rgb(var(--color-text))",
  muted: "rgb(var(--color-muted))",
  faint: "rgb(var(--color-faint))",
  grid: "rgb(var(--chart-grid, 31 39 41))",
  border: "rgb(var(--color-border))",
  surface: "rgb(var(--color-surface))",
  warning: "rgb(var(--color-warning))",
  danger: "rgb(var(--color-danger))",
  good: "rgb(var(--color-good))",
  s: (n: number) => `rgb(var(--color-series-${n}))`,
  violet: "rgb(var(--color-kind-alert))",
  blue: "rgb(var(--color-kind-analysis))",
};
export const PHASE_COLOR: Record<string, string> = { before: C.blue, during: C.danger, after: C.violet, done: C.violet };

export function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * p;
}

export function compact(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr`.replace(".0Cr", "Cr");
  if (a >= 1e5) return `${(v / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`.replace(".0L", "L");
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`.replace(".0k", "k");
  return `${Math.round(v * 10) / 10}`;
}

function shortDate(iso: string): string {
  const d = new Date(iso.length <= 10 ? iso + "T12:00:00" : iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function Tip({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) {
  const left = Math.min(Math.max(x - 90, 0), Math.max(0, w - 180));
  return (
    <div className="pointer-events-none absolute z-20 rounded-ctl border border-border bg-surface/95 backdrop-blur shadow-pop px-3 py-2 text-caption min-w-[150px]"
      style={{ left, top: Math.max(0, y - 8), transform: "translateY(-100%)" }}>{children}</div>
  );
}

/* ------------------------------------------------------------ TimeArea */
export type Series = { key: string; label: string; color: string; kind?: "area" | "line" | "dash"; values: (number | null)[] };

export function TimeArea({ dates, series, band, phases, markers = [], height = 240, yFormat = compact, target, targetLabel, ariaLabel, xFmt = shortDate }: {
  dates: string[]; series: Series[]; band?: { lo: (number | null)[]; hi: (number | null)[]; color?: string };
  phases?: (string | null)[]; markers?: { i: number; label: string }[]; height?: number; yFormat?: (v: number) => string;
  target?: number | null; targetLabel?: string; ariaLabel: string; xFmt?: (s: string) => string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = dates.length;
  const pl = 44, pr = 14, pt = 18, pb = 26;
  const iw = Math.max(10, w - pl - pr), ih = height - pt - pb;
  const all = [...series.flatMap((s) => s.values), ...(band ? band.hi : []), target ?? null].filter((v): v is number => v !== null && v !== undefined);
  const ymax = niceMax(Math.max(1, ...all) * 1.08);
  const X = (i: number) => pl + (n <= 1 ? iw / 2 : (i * iw) / (n - 1));
  const Y = (v: number) => pt + ih - (v / ymax) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * ymax);
  const path = (vals: (number | null)[]) => {
    let d = "", on = false;
    vals.forEach((v, i) => {
      if (v === null || v === undefined) { on = false; return; }
      d += `${on ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)} `;
      on = true;
    });
    return d;
  };
  const xlabels = useMemo(() => {
    if (n <= 1) return [0];
    const k = Math.max(1, Math.round(n / Math.max(2, Math.floor(iw / 90))));
    const out: number[] = [];
    for (let i = 0; i < n; i += k) out.push(i);
    if (out[out.length - 1] !== n - 1 && n - 1 - out[out.length - 1] > k / 2) out.push(n - 1);
    return out;
  }, [n, iw]);
  const bandsPh = useMemo(() => {
    if (!phases) return [] as { a: number; b: number; ph: string }[];
    const out: { a: number; b: number; ph: string }[] = [];
    phases.forEach((ph, i) => {
      if (!ph) return;
      const last = out[out.length - 1];
      if (last && last.ph === ph) last.b = i;
      else out.push({ a: i, b: i, ph });
    });
    return out;
  }, [phases]);
  const onMove = (e: React.MouseEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const x = e.clientX - r.left;
    const i = Math.round(((x - pl) / iw) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={ariaLabel} onMouseMove={onMove} onMouseLeave={() => setHover(null)} className="block">
          <defs>
            {series.map((s, k) => (
              <linearGradient key={k} id={`ta-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={s.color} stopOpacity="0.32" /><stop offset="1" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          {bandsPh.map((b, k) => (
            <g key={k}>
              <rect x={X(b.a) - (n > 1 ? iw / (n - 1) / 2 : 0)} y={pt} width={Math.max(2, X(b.b) - X(b.a) + (n > 1 ? iw / (n - 1) : 4))} height={ih}
                fill={PHASE_COLOR[b.ph] || C.muted} opacity={0.06} />
              <text x={X(b.a) + 4} y={pt - 6} fontSize="10" fill={PHASE_COLOR[b.ph] || C.muted} className="font-mono uppercase" letterSpacing="1">
                {b.ph === "during" ? (X(b.b) - X(b.a) > 40 ? "during" : "") : b.ph}
              </text>
            </g>
          ))}
          {ticks.map((t, k) => (
            <g key={k}>
              <line x1={pl} x2={w - pr} y1={Y(t)} y2={Y(t)} stroke={C.grid} />
              <text x={pl - 8} y={Y(t) + 4} textAnchor="end" fontSize="10.5" fill={C.muted} className="font-mono">{yFormat(t)}</text>
            </g>
          ))}
          {xlabels.map((i) => (
            <text key={i} x={X(i)} y={height - 7} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize="10.5" fill={C.muted} className="font-mono">{xFmt(dates[i])}</text>
          ))}
          {band && (
            <path d={(() => {
              const top: string[] = [], bot: string[] = [];
              band.hi.forEach((v, i) => { if (v !== null && v !== undefined) top.push(`${X(i).toFixed(1)},${Y(v).toFixed(1)}`); });
              band.lo.forEach((v, i) => { if (v !== null && v !== undefined) bot.unshift(`${X(i).toFixed(1)},${Y(v).toFixed(1)}`); });
              return top.length ? `M${top.join(" L")} L${bot.join(" L")} Z` : "";
            })()} fill={band.color || C.blue} opacity={0.14} />
          )}
          {target ? (
            <g>
              <line x1={pl} x2={w - pr} y1={Y(target)} y2={Y(target)} stroke={C.warning} strokeDasharray="4 4" opacity={0.8} />
              <text x={w - pr} y={Y(target) - 5} textAnchor="end" fontSize="10.5" fill={C.warning}>{targetLabel || "target"} {yFormat(target)}</text>
            </g>
          ) : null}
          {markers.map((m, k) => (
            <g key={k}>
              <line x1={X(m.i)} x2={X(m.i)} y1={pt} y2={pt + ih} stroke={C.border} strokeDasharray="3 4" />
              <text x={X(m.i) + 4} y={pt + 12} fontSize="10.5" fill={C.muted}>{m.label}</text>
            </g>
          ))}
          {series.map((s) => {
            const d = path(s.values);
            const idx = s.values.map((v, i) => (v === null || v === undefined ? -1 : i)).filter((i) => i >= 0);
            const first = idx[0], last = idx[idx.length - 1];
            return (
              <g key={s.key}>
                {s.kind === "area" && d && first !== undefined && (
                  <path d={`${d} L${X(last).toFixed(1)},${pt + ih} L${X(first).toFixed(1)},${pt + ih} Z`} fill={`url(#ta-${s.key})`} />
                )}
                <path d={d} fill="none" stroke={s.color} strokeWidth={s.kind === "area" ? 2.4 : 2} strokeLinejoin="round" strokeLinecap="round"
                  strokeDasharray={s.kind === "dash" ? "5 5" : undefined} />
                {s.kind === "area" && last !== undefined && (
                  <g><circle cx={X(last)} cy={Y(s.values[last] as number)} r={7} fill={s.color} opacity={0.18} />
                    <circle cx={X(last)} cy={Y(s.values[last] as number)} r={3.5} fill={s.color} stroke={C.surface} strokeWidth={2} /></g>
                )}
              </g>
            );
          })}
          {hover !== null && <line x1={X(hover)} x2={X(hover)} y1={pt} y2={pt + ih} stroke={C.muted} strokeWidth={1} opacity={0.6} />}
          {hover !== null && series.map((s) => s.values[hover] !== null && s.values[hover] !== undefined ? (
            <circle key={s.key} cx={X(hover)} cy={Y(s.values[hover] as number)} r={4} fill={s.color} stroke={C.surface} strokeWidth={2} />
          ) : null)}
        </svg>
      )}
      {hover !== null && w > 0 && (
        <Tip x={X(hover)} y={pt + 4} w={w}>
          <div className="font-medium text-text mb-1">{xFmt(dates[hover])}{phases?.[hover] ? <span className="text-muted font-normal"> · {phases[hover]}</span> : null}</div>
          {series.map((s) => s.values[hover] !== null && s.values[hover] !== undefined ? (
            <div key={s.key} className="flex items-center gap-2 text-secondary">
              <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />{s.label}<b className="ml-auto pl-3 text-text tabular-nums">{(s.values[hover] as number).toLocaleString()}</b>
            </div>
          ) : null)}
          {band && band.lo[hover] !== null && band.lo[hover] !== undefined && (
            <div className="text-muted mt-0.5">80% range {Number(band.lo[hover]).toLocaleString()}–{Number(band.hi[hover]).toLocaleString()}</div>
          )}
        </Tip>
      )}
    </div>
  );
}

/* --------------------------------------------------------- StackedDays */
export function StackedDays({ rows, keys, height = 200, ariaLabel }: {
  rows: ({ date: string; phase?: string | null } & Record<string, any>)[]; keys: { key: string; label: string; color: string }[];
  height?: number; ariaLabel: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pl = 34, pr = 6, pt = 8, pb = 22;
  const iw = Math.max(10, w - pl - pr), ih = height - pt - pb;
  const tot = rows.map((r) => keys.reduce((s, k) => s + (Number(r[k.key]) || 0), 0));
  const ymax = niceMax(Math.max(1, ...tot));
  const bw = iw / Math.max(rows.length, 1);
  const Y = (v: number) => pt + ih - (v / ymax) * ih;
  const step = Math.max(1, Math.round(rows.length / Math.max(2, Math.floor(iw / 70))));
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={ariaLabel} className="block" onMouseLeave={() => setHover(null)}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}><line x1={pl} x2={w - pr} y1={Y(f * ymax)} y2={Y(f * ymax)} stroke={C.grid} />
              <text x={pl - 6} y={Y(f * ymax) + 4} textAnchor="end" fontSize="10" fill={C.muted} className="font-mono">{compact(f * ymax)}</text></g>
          ))}
          {rows.map((r, i) => {
            let base = 0;
            const x = pl + i * bw;
            return (
              <g key={r.date} onMouseEnter={() => setHover(i)}>
                {r.phase === "during" && <rect x={x} y={pt} width={bw} height={ih} fill={C.danger} opacity={0.07} />}
                <rect x={x} y={pt} width={bw} height={ih} fill="transparent" />
                {keys.map((k) => {
                  const v = Number(r[k.key]) || 0;
                  if (!v) return null;
                  const y0 = Y(base), y1 = Y(base + v);
                  base += v;
                  return <rect key={k.key} x={x + Math.min(1.5, bw * 0.12)} y={y1} width={Math.max(1, bw - Math.min(3, bw * 0.24))} height={Math.max(0.5, y0 - y1)}
                    fill={k.color} opacity={hover === null || hover === i ? 0.92 : 0.45} rx={bw > 8 ? 2 : 0} />;
                })}
              </g>
            );
          })}
          {rows.map((r, i) => (i % step === 0 ? (
            <text key={r.date} x={pl + i * bw + bw / 2} y={height - 6} textAnchor="middle" fontSize="10" fill={C.muted} className="font-mono">{shortDate(r.date)}</text>
          ) : null))}
        </svg>
      )}
      {hover !== null && w > 0 && (
        <Tip x={pl + hover * bw + bw / 2} y={pt + 6} w={w}>
          <div className="font-medium text-text mb-1">{shortDate(rows[hover].date)}{rows[hover].phase ? <span className="text-muted font-normal"> · {rows[hover].phase}</span> : null}</div>
          {keys.map((k) => (
            <div key={k.key} className="flex items-center gap-2 text-secondary"><span className="w-2 h-2 rounded-sm" style={{ background: k.color }} />{k.label}
              <b className="ml-auto pl-3 text-text tabular-nums">{Number(rows[hover][k.key]) || 0}</b></div>
          ))}
        </Tip>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Ring */
export function Ring({ value, size = 120, stroke = 10, color = C.primary, label, sub, track = C.border }: {
  value: number | null; size?: number; stroke?: number; color?: string; label?: string; sub?: string; track?: string;
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (value === null) return;
    let raf = 0;
    const t0 = performance.now();
    const go = (t: number) => {
      const k = Math.min(1, (t - t0) / 900);
      setShown(value * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(go);
    };
    raf = requestAnimationFrame(go);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label || `Score ${value ?? "not yet"} of 100`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} opacity={0.6} />
      {value !== null && (
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${(circ * shown) / 100} ${circ}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ filter: color.startsWith("rgb(var(") ? `drop-shadow(0 0 ${size / 18}px ${color.slice(0, -1)} / 0.35))` : undefined }} />
      )}
      <text x={size / 2} y={size / 2 + (sub ? size * 0.04 : size * 0.1)} textAnchor="middle" fontSize={size * 0.29} fontWeight={600} fill={C.text}
        className="font-mono tabular-nums">{value === null ? "–" : Math.round(shown)}</text>
      {sub && <text x={size / 2} y={size / 2 + size * 0.22} textAnchor="middle" fontSize={Math.max(10, size * 0.095)} fill={C.muted}>{sub}</text>}
    </svg>
  );
}

/* -------------------------------------------------------------- Bullet */
export function Bullet({ low, target, high, actual, lowerIsBetter, fmtv, predicted }: {
  low: number; target: number; high: number; actual: number | null; lowerIsBetter: boolean; fmtv: (v: number) => string; predicted?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const lo = Math.min(low, high), hi = Math.max(low, high);
  const pad = (hi - lo) * 0.35 || Math.abs(target) * 0.2 || 1;
  let a = lo - pad, b = hi + pad;
  if (actual !== null) { a = Math.min(a, actual - pad * 0.2); b = Math.max(b, actual + pad * 0.2); }
  if (lowerIsBetter) [a, b] = [b, a];
  const X = (v: number) => 8 + ((v - a) / (b - a)) * Math.max(10, w - 16);
  const meets = actual !== null && (lowerIsBetter ? actual <= target : actual >= target);
  const col = actual === null ? C.muted : predicted ? C.blue : meets ? C.good : C.warning;
  const x1 = Math.min(X(low), X(high)), x2 = Math.max(X(low), X(high));
  return (
    <div ref={ref} className="w-full h-[34px] relative">
      {w > 0 && (
        <svg width={w} height={34} role="img" aria-label={`actual ${actual === null ? "not yet" : fmtv(actual)}, target ${fmtv(target)}`}>
          <rect x={8} y={12} width={w - 16} height={8} rx={4} fill={C.border} opacity={0.55} />
          <rect x={x1} y={12} width={Math.max(2, x2 - x1)} height={8} rx={4} fill={C.primary} opacity={0.22} />
          <line x1={X(target)} x2={X(target)} y1={7} y2={25} stroke={C.text} strokeWidth={2} opacity={0.75} />
          {actual !== null && <circle cx={Math.min(Math.max(X(actual), 8), w - 8)} cy={16} r={7} fill={col} stroke={C.surface} strokeWidth={3} />}
          <text x={X(low)} y={33} textAnchor="middle" fontSize="9.5" fill={C.muted} className="font-mono">{fmtv(low)}</text>
          <text x={X(high)} y={33} textAnchor="middle" fontSize="9.5" fill={C.muted} className="font-mono">{fmtv(high)}</text>
        </svg>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- Histogram */
export function Histogram({ bins, labels, colors, height = 170, marker, ariaLabel }: {
  bins: number[]; labels: string[]; colors: string[]; height?: number; marker?: { at: number; label: string } | null; ariaLabel: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pb = 22, pt = 18;
  const ih = height - pb - pt;
  const max = Math.max(1, ...bins);
  const bw = w / Math.max(bins.length, 1);
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
          {bins.map((v, i) => {
            const h = (v / max) * ih;
            return (
              <g key={i} onMouseEnter={() => setHover(i)}>
                <rect x={i * bw} y={pt} width={bw} height={ih} fill="transparent" />
                <rect x={i * bw + Math.min(3, bw * 0.12)} y={pt + ih - h} width={Math.max(1, bw - Math.min(6, bw * 0.24))} height={Math.max(v ? 1 : 0, h)}
                  rx={Math.min(5, bw / 4)} fill={colors[i] || C.primary} opacity={hover === null || hover === i ? 0.9 : 0.5} />
              </g>
            );
          })}
          {labels.map((l, i) => (l ? <text key={i} x={i * bw + bw / 2} y={height - 6} textAnchor="middle" fontSize="10" fill={C.muted} className="font-mono">{l}</text> : null))}
          {marker && (
            <g>
              <line x1={marker.at * bw} x2={marker.at * bw} y1={pt - 6} y2={pt + ih} stroke={C.text} strokeDasharray="3 3" />
              <text x={marker.at * bw + 5} y={pt + 2} fontSize="10.5" fill={C.text}>{marker.label}</text>
            </g>
          )}
        </svg>
      )}
      {hover !== null && w > 0 && (
        <Tip x={hover * bw + bw / 2} y={pt} w={w}><div className="text-text font-medium">{labels[hover] || ""}</div>
          <div className="text-secondary tabular-nums">{bins[hover].toLocaleString()}</div></Tip>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Bars */
export function HBar({ label, value, max, right, color = C.primary, sub }: {
  label: ReactNode; value: number; max: number; right?: ReactNode; color?: string; sub?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,140px)_1fr_auto] items-center gap-3 min-w-0">
      <div className="min-w-0"><div className="text-ui text-text truncate">{label}</div>{sub && <div className="text-caption text-muted truncate">{sub}</div>}</div>
      <div className="h-2 rounded-full bg-border/60 overflow-hidden">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.max(1, Math.min(100, (100 * value) / Math.max(max, 1)))}%`, background: color }} />
      </div>
      <div className="text-ui tabular-nums text-text text-right min-w-[48px]">{right ?? value.toLocaleString()}</div>
    </div>
  );
}

/* --------------------------------------------------------- MinuteLine */
export function MinuteLine({ points, height = 200, color = C.primary, markers = [], ariaLabel, xLabel = (i: number) => `${i}′` }: {
  points: number[]; height?: number; color?: string; markers?: { i: number; label: string }[]; ariaLabel: string; xLabel?: (i: number) => string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const pl = 40, pr = 10, pt = 16, pb = 22;
  const iw = Math.max(10, w - pl - pr), ih = height - pt - pb;
  const ymax = niceMax(Math.max(1, ...points) * 1.08);
  const X = (i: number) => pl + (n <= 1 ? 0 : (i * iw) / (n - 1));
  const Y = (v: number) => pt + ih - (v / ymax) * ih;
  const d = points.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {w > 0 && n > 1 && (
        <svg width={w} height={height} role="img" aria-label={ariaLabel} className="block"
          onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.round(((e.clientX - r.left - pl) / iw) * (n - 1)); setHover(i >= 0 && i < n ? i : null); }}
          onMouseLeave={() => setHover(null)}>
          <defs><linearGradient id="ml-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.3" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
          {[0, 0.5, 1].map((f) => (
            <g key={f}><line x1={pl} x2={w - pr} y1={Y(f * ymax)} y2={Y(f * ymax)} stroke={C.grid} />
              <text x={pl - 6} y={Y(f * ymax) + 4} textAnchor="end" fontSize="10" fill={C.muted} className="font-mono">{compact(f * ymax)}</text></g>
          ))}
          {markers.map((m, k) => (
            <g key={k}><line x1={X(m.i)} x2={X(m.i)} y1={pt} y2={pt + ih} stroke={C.border} strokeDasharray="3 4" />
              <text x={X(m.i) + 4} y={pt + 10} fontSize="10" fill={C.muted}>{m.label}</text></g>
          ))}
          <path d={`${d} L${X(n - 1)},${pt + ih} L${X(0)},${pt + ih} Z`} fill="url(#ml-g)" />
          <path d={d} fill="none" stroke={color} strokeWidth={2.2} strokeLinejoin="round" />
          {[0, Math.round((n - 1) / 2), n - 1].map((i) => (
            <text key={i} x={X(i)} y={height - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize="10" fill={C.muted} className="font-mono">{xLabel(i)}</text>
          ))}
          {hover !== null && <circle cx={X(hover)} cy={Y(points[hover])} r={4} fill={color} stroke={C.surface} strokeWidth={2} />}
        </svg>
      )}
      {hover !== null && w > 0 && <Tip x={X(hover)} y={Y(points[hover])} w={w}><div className="text-text font-medium">{xLabel(hover)}</div>
        <div className="text-secondary tabular-nums">{points[hover].toLocaleString()} watching</div></Tip>}
    </div>
  );
}

/* ------------------------------------------------------------- Funnel */
export function FunnelSteps({ rows }: { rows: { stage: string; value: number; truth?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const lmax = Math.log10(max + 1);
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => {
        const pct = i > 0 && rows[i - 1].value ? (100 * r.value) / rows[i - 1].value : null;
        const wpct = Math.max(6, (Math.log10(r.value + 1) / Math.max(lmax, 0.0001)) * 100);
        return (
          <div key={r.stage} className="grid grid-cols-[118px_1fr_52px] items-center gap-3" data-funnel={r.stage}>
            <span className="text-caption text-secondary truncate">{r.stage}</span>
            <div className="h-6 rounded-[7px] bg-border/30 relative flex items-center">
              <div className="h-full rounded-[7px] shrink-0"
                style={{ width: `${wpct}%`, background: `linear-gradient(90deg, rgb(var(--color-primary) / ${Math.max(0.35, 0.9 - i * 0.08)}), rgb(var(--color-primary) / ${Math.max(0.15, 0.4 - i * 0.04)}))` }} />
              {pct !== null && <span className="ml-2 text-[11px] font-mono text-muted whitespace-nowrap">{pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%</span>}
            </div>
            <span className="text-ui font-medium tabular-nums text-text text-right">{compact(r.value)}</span>
          </div>
        );
      })}
      <span className="text-caption text-muted">Bars on a log scale so every stage stays visible; percentages are step to step.</span>
    </div>
  );
}
