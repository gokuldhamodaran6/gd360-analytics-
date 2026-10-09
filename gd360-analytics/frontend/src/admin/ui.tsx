// 2026-10-10: Mission Control UI kit — small, dependency-free pieces every
// screen uses (cards, KPIs, pills, tables, charts, drawers, toasts).
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";

/* ---------------------------------------------------------------- format */
export const fmtN = (n: number | null | undefined, d = 0) =>
  n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
export const fmtUSD = (n: number | null | undefined, d = 0) =>
  n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
export const fmtPct = (n: number | null | undefined, d = 1) => (n == null ? "—" : `${Number(n).toFixed(d)}%`);
export function ago(iso?: string | null): string {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 0) return "just now";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
export const dateShort = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—";
export const dateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
export function minsLabel(m: number | null | undefined): string {
  if (m == null) return "—";
  const a = Math.abs(m);
  const t = a < 60 ? `${a}m` : a < 1440 ? `${Math.floor(a / 60)}h ${a % 60}m` : `${Math.floor(a / 1440)}d`;
  return m < 0 ? `${t} overdue` : `${t} left`;
}
export const bytes = (b?: number | null) => {
  if (b == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};

/* ---------------------------------------------------------------- toasts */
type Toast = { text: string; err?: boolean } | null;
const ToastCtx = createContext<(t: string, err?: boolean) => void>(() => {});
export function ToastHost({ children }: { children: ReactNode }) {
  const [t, setT] = useState<Toast>(null);
  const show = useCallback((text: string, err = false) => setT({ text, err }), []);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => setT(null), 3200);
    return () => clearTimeout(id);
  }, [t]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && <div role="status" className={`mc-toast${t.err ? " err" : ""}`}>{t.text}</div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ---------------------------------------------------------------- me / perms */
export type Me = { email: string; name: string; role: string; role_label: string; perms: string[]; grants: any[]; roles: any[]; permissions: any[] };
export const MeCtx = createContext<Me | null>(null);
export function useMe() {
  return useContext(MeCtx);
}
export function useCan() {
  const me = useMe();
  return (perm: string) => !!me?.perms.includes(perm);
}

/* ---------------------------------------------------------------- layout bits */
export function PageHead({ eyebrow, title, sub, children }: { eyebrow: string; title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mc-head">
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="mc-lbl">{eyebrow}</span>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>{children}</div>}
    </div>
  );
}

export function Card({ title, right, children, pad = true, style, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; pad?: boolean; style?: any; className?: string }) {
  return (
    <section className={`mc-card ${pad ? "mc-pad" : ""} ${className}`} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0, ...style }}>
      {(title || right) && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {typeof title === "string" ? <span className="mc-lbl">{title}</span> : title}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, sub, delta, to, tone, spark, estimate }: { label: string; value: ReactNode; sub?: ReactNode; delta?: number | null; to?: string; tone?: "warn" | "good"; spark?: number[]; estimate?: boolean }) {
  const inner = (
    <>
      <span className="mc-lbl">{label}{estimate ? " · est." : ""}</span>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10 }}>
        <span className="mc-kpi-v mc-num" style={{ color: tone === "warn" ? "var(--amber)" : undefined }}>{value}</span>
        {spark && spark.length > 1 && <Spark values={spark} color={tone === "warn" ? "#F2B84B" : "#43E5A0"} />}
      </div>
      {(sub || delta != null) && (
        <span className="mc-sub" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {delta != null && <b style={{ color: delta >= 0 ? "var(--g)" : "var(--red)" }}>{delta >= 0 ? "+" : ""}{delta}%</b>}
          {sub}
        </span>
      )}
    </>
  );
  return to ? <Link to={to} className="mc-card mc-kpi">{inner}</Link> : <div className="mc-card mc-kpi">{inner}</div>;
}

export function Pill({ tone, children }: { tone?: "g" | "b" | "a" | "r" | "w"; children: ReactNode }) {
  return <span className={`mc-pill ${tone || ""}`}>{children}</span>;
}

export const bandTone = (b?: string) => (b === "Healthy" ? "g" : b === "Watch" ? "a" : "r") as "g" | "a" | "r";
export const prioTone = (p?: string) => (p === "P1" ? "r" : p === "P2" ? "a" : p === "P3" ? "b" : undefined);

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="mc-seg">
      {options.map(([k, l]) => (
        <button key={k} type="button" aria-pressed={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>{l}</button>
      ))}
    </div>
  );
}

export function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="mc-chips">
      {options.map(([k, l]) => (
        <button key={k} type="button" aria-pressed={value === k} className={`mc-chip ${value === k ? "on" : ""}`} onClick={() => onChange(k)}>{l}</button>
      ))}
    </div>
  );
}

export function Loading({ rows = 3, h = 90 }: { rows?: number; h?: number }) {
  return (
    <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))" }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="mc-skel" style={{ height: h }} />)}
    </div>
  );
}
export const ErrorBox = ({ text, retry }: { text: string; retry?: () => void }) => (
  <div className="mc-err" role="alert" style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
    <span>{text}</span>{retry && <button type="button" className="mc-btn sm" onClick={retry}>Try again</button>}
  </div>
);
export const Empty = ({ children }: { children: ReactNode }) => <div className="mc-empty">{children}</div>;

export function Bar({ pct, color }: { pct: number; color?: string }) {
  return <div className="mc-bar"><div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} /></div>;
}

/* ---------------------------------------------------------------- charts */
export function Spark({ values, color = "#43E5A0", w = 104, h = 32 }: { values: number[]; color?: string; w?: number; h?: number }) {
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i * (w - 4)) / (values.length - 1) + 2},${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`).join(" ");
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true"><polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** Line/area chart over a series of {label, value} with hover read-out. */
export function LineChart({ points, color = "#43E5A0", height = 200, fmt = (v: number) => fmtN(v), label }: { points: { label: string; value: number }[]; color?: string; height?: number; fmt?: (v: number) => string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, L = 44, R = 10, T = 14, B = 26;
  const max = Math.max(1, ...points.map((p) => p.value)) * 1.1;
  const x = (i: number) => L + (points.length <= 1 ? 0 : (i * (W - L - R)) / (points.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const step = Math.max(1, Math.ceil(points.length / 6));
  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label={label}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - L) / (W - L - R)) * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, i)));
        }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#141A1B" />
            <text x={L - 8} y={y(t) + 4} fill="#7F8C88" fontSize={10.5} textAnchor="end" fontFamily="Geist Mono, monospace">{fmt(t)}</text>
          </g>
        ))}
        {points.length > 1 && <polygon points={`${L},${H - B} ${line} ${x(points.length - 1)},${H - B}`} fill={color} opacity={0.1} />}
        <polyline points={line} fill="none" stroke={color} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (i % step === 0 || i === points.length - 1) && (
          <text key={i} x={x(i)} y={H - 6} fill="#7F8C88" fontSize={10.5} textAnchor="middle" fontFamily="Geist Mono, monospace">{p.label}</text>
        ))}
        {hover != null && points[hover] && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="#2A3436" />
            <circle cx={x(hover)} cy={y(points[hover].value)} r={4.5} fill="#07090A" stroke={color} strokeWidth={2} />
          </g>
        )}
      </svg>
      {hover != null && points[hover] && (
        <div className="mc-mono" style={{ position: "absolute", top: 0, right: 0, fontSize: 11.5, color: "var(--ink2)", background: "var(--s2)", border: "1px solid var(--line)", borderRadius: 8, padding: "4px 8px" }}>
          {points[hover].label} · <b style={{ color: "var(--ink)" }}>{fmt(points[hover].value)}</b>
        </div>
      )}
    </div>
  );
}

/** Vertical bars with value labels. */
export function Bars({ items, height = 160, color = "#43E5A0", fmt = (v: number) => fmtN(v) }: { items: { label: string; value: number; color?: string; title?: string }[]; height?: number; color?: string; fmt?: (v: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div>
      <div style={{ height, display: "grid", gridTemplateColumns: `repeat(${items.length}, minmax(0,1fr))`, gap: 6, alignItems: "end", borderBottom: "1px solid var(--line)" }}>
        {items.map((it, i) => (
          <div key={i} title={it.title || `${it.label}: ${fmt(it.value)}`} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, height: "100%", justifyContent: "flex-end" }}>
            {items.length <= 14 && <span className="mc-mono mc-num" style={{ fontSize: 11, color: "var(--ink2)" }}>{fmt(it.value)}</span>}
            <div style={{ width: "72%", height: `${(it.value / max) * (height - 22)}px`, minHeight: it.value ? 2 : 0, borderRadius: "5px 5px 2px 2px", background: it.color || color }} />
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${items.length}, minmax(0,1fr))`, gap: 6, marginTop: 6 }}>
        {items.map((it, i) => <span key={i} className="mc-mono" style={{ fontSize: 10.5, color: "var(--ink3)", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.label}</span>)}
      </div>
    </div>
  );
}

/** Horizontal labelled bars. */
export function HBars({ items, fmt = (v: number) => fmtN(v), color = "#7AA7FF", max: maxIn }: { items: { k: string; v: number; sub?: string }[]; fmt?: (v: number) => string; color?: string; max?: number }) {
  const max = maxIn ?? Math.max(1, ...items.map((i) => i.v));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {items.map((it) => (
        <div key={it.k} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
            <span>{it.k}</span><span className="mc-mono mc-num" style={{ color: "var(--ink2)" }}>{fmt(it.v)}{it.sub ? ` · ${it.sub}` : ""}</span>
          </div>
          <Bar pct={(it.v / max) * 100} color={color} />
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- overlays */
export function Drawer({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="mc-drawer-veil" onClick={onClose}>
      <aside className="mc-drawer" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="mc-btn sm" onClick={onClose} style={{ alignSelf: "flex-end" }} aria-label="Close">Close</button>
        {children}
      </aside>
    </div>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="mc-modal-veil" onClick={onClose}>
      <div className="mc-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, letterSpacing: "-0.02em" }}>{title}</h2>
          <button type="button" className="mc-btn sm" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A button that runs an async action, shows busy state and a toast. */
export function ActionButton({ run, children, done, className = "mc-btn", disabled, title, confirm }: { run: () => Promise<any>; children: ReactNode; done?: string; className?: string; disabled?: boolean; title?: string; confirm?: string }) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const toast = useToast();
  const go = async () => {
    setAsking(false);
    setBusy(true);
    try {
      await run();
      if (done) toast(done);
    } catch (e: any) {
      const d = e?.response?.data?.detail;
      toast(typeof d === "string" ? d : "That didn't work.", true);
    } finally {
      setBusy(false);
    }
  };
  if (asking) {
    return (
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        <span className="mc-tip">{confirm}</span>
        <button type="button" className="mc-btn sm d" onClick={go}>Yes</button>
        <button type="button" className="mc-btn sm" onClick={() => setAsking(false)}>No</button>
      </span>
    );
  }
  return (
    <button type="button" className={className} disabled={disabled || busy} title={title} onClick={() => (confirm ? setAsking(true) : go())}>
      {busy ? "Working…" : children}
    </button>
  );
}

export const Icon = ({ d, size = 17 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
