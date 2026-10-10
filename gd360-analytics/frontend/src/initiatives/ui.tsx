// 2026-10-10: shared pieces for Initiatives and Accounts - one visual
// language: a kind colour per initiative type, a health pill (On track /
// Needs attention / At risk), meters that show actual against target, and
// quiet section cards. Everything takes its colour from the theme tokens.
import { ReactNode, useEffect, useRef, useState } from "react";
import type { Health, Kind, Target } from "../api/initiatives";

export const KIND_TONE: Record<Kind, number> = { event: 2, webinar: 1, campaign: 5, abm: 3, hiring: 6, product: 4, custom: 0 };
export const KIND_LABEL: Record<Kind, string> = {
  event: "Event", webinar: "Webinar", campaign: "Campaign", abm: "Account-based", hiring: "Hiring", product: "Product build", custom: "Custom",
};

export function tone(kind: Kind | string): string {
  const n = KIND_TONE[kind as Kind] ?? 0;
  return n ? `var(--color-series-${n})` : "var(--color-muted)";
}

export function KindGlyph({ kind, size = 16 }: { kind: Kind | string; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (kind) {
    case "event":
      return <svg {...p}><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M8 3v4M16 3v4M3.5 10h17" /></svg>;
    case "webinar":
      return <svg {...p}><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8M12 17v4" /><path d="m10.5 9 3.5 2-3.5 2z" /></svg>;
    case "campaign":
      return <svg {...p}><path d="M4 10v4l11 5V5L4 10Z" /><path d="M18 9a3 3 0 0 1 0 6" /></svg>;
    case "abm":
      return <svg {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" /></svg>;
    case "hiring":
      return <svg {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M19 8v6M16 11h6" /></svg>;
    case "product":
      return <svg {...p}><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" /></svg>;
    default:
      return <svg {...p}><path d="M5 12h14M12 5v14" /></svg>;
  }
}

export function KindBadge({ kind, label }: { kind: Kind | string; label?: string }) {
  const c = tone(kind);
  return (
    <span className="inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-full text-caption font-medium border"
      style={{ color: `rgb(${c})`, background: `rgb(${c} / 0.1)`, borderColor: `rgb(${c} / 0.35)` }} data-kind={kind}>
      <KindGlyph kind={kind} size={13} /> {label || KIND_LABEL[kind as Kind] || "Initiative"}
    </span>
  );
}

export function KindTile({ kind, size = 40 }: { kind: Kind | string; size?: number }) {
  const c = tone(kind);
  return (
    <span className="grid place-items-center shrink-0 rounded-[11px]" style={{ width: size, height: size, color: `rgb(${c})`, background: `rgb(${c} / 0.12)` }}>
      <KindGlyph kind={kind} size={Math.round(size * 0.48)} />
    </span>
  );
}

export function HealthPill({ health }: { health: Health }) {
  const cls = health.state === "risk" ? "text-danger bg-danger-fill border-danger-border"
    : health.state === "watch" ? "text-warning bg-warning-fill border-warning-border"
    : health.state === "done" ? "text-muted bg-surface2 border-border" : "text-good bg-good-fill border-good-border";
  const word = health.state === "risk" ? "At risk" : health.state === "watch" ? "Needs attention" : health.state === "done" ? "Finished" : "On track";
  return (
    <span className={`inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-full border text-caption font-medium max-w-full ${cls}`}
      title={health.label} data-health={health.state}>
      <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
      <span className="truncate">{word}{health.state !== "ok" && health.state !== "done" && health.label !== word ? ` · ${health.label}` : ""}</span>
    </span>
  );
}

export function fmt(v: number | null | undefined, unit: string = "count"): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (unit === "pct") return `${(Math.round(v * 10) / 10).toLocaleString()}%`;
  if (unit === "money") return v >= 1000 ? `$${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k` : `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (Math.abs(v) >= 100000) return `${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })}k`;
  if (Math.abs(v) >= 10000) return `${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k`;
  return Math.round(v * 10) % 10 === 0 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toLocaleString();
}

export function fmtDate(iso: string | null | undefined, withYear = false): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) });
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function daysLabel(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  return n > 0 ? `In ${n} days` : `${-n} days ago`;
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Actual against target, with the pace mark when there's one. */
export function Meter({ t, compact = false }: { t: Target; compact?: boolean }) {
  const pct = t.pct ?? (t.actual !== null && t.target ? (100 * Number(t.actual)) / Number(t.target) : null);
  const w = Math.max(0, Math.min(100, pct ?? 0));
  const color = pct === null ? "bg-border-strong" : pct >= 100 ? "bg-good" : pct >= 50 ? "bg-primary" : "bg-warning";
  return (
    <div className="flex flex-col gap-1.5 min-w-0" data-meter={t.key}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`${compact ? "text-caption" : "text-ui"} text-secondary truncate`}>{t.label}</span>
        <span className={`${compact ? "text-caption" : "text-ui"} tabular-nums text-text whitespace-nowrap`}>
          <b className="font-semibold">{fmt(t.actual, t.unit)}</b>
          <span className="text-muted"> / {fmt(t.target, t.unit)}</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-surface2 overflow-hidden" role="progressbar" aria-valuenow={Math.round(w)} aria-valuemin={0} aria-valuemax={100} aria-label={t.label}>
        <div className={`h-full rounded-full ${color} transition-[width] duration-500`} style={{ width: `${w}%` }} />
      </div>
      {!compact && (
        <span className="text-caption text-muted">
          {t.key === "social_reach" || t.key === "social_engagements" ? "From the team's logged updates" : t.auto ? "Counted by GD360" : "Updated by the owner"}{t.why ? ` · ${t.why}` : ""}
        </span>
      )}
    </div>
  );
}

export function Section({ title, sub, actions, children, className = "", id, tight = false }: {
  title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string; tight?: boolean;
}) {
  return (
    <section id={id} className={`rounded-card border border-border bg-surface ${tight ? "p-4" : "p-5"} flex flex-col gap-4 min-w-0 ${className}`}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            {title && <h2 className="m-0 text-section font-semibold text-text">{title}</h2>}
            {sub && <p className="m-0 mt-0.5 text-caption text-muted">{sub}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone: t }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "good" | "warning" | "danger" }) {
  const c = t === "good" ? "text-good" : t === "warning" ? "text-warning" : t === "danger" ? "text-danger" : "text-text";
  return (
    <div className="flex flex-col gap-0.5 min-w-0" data-stat={label}>
      <span className={`text-[24px] leading-tight font-semibold tracking-tight tabular-nums ${c}`}>{value}</span>
      <span className="text-caption text-muted">{label}</span>
      {hint && <span className="text-caption text-secondary">{hint}</span>}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-border-strong p-6 text-center flex flex-col items-center gap-2">
      <div className="text-ui font-semibold text-text">{title}</div>
      {body && <p className="m-0 text-caption text-muted max-w-[460px] leading-relaxed">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      <span className="text-caption font-medium text-secondary">{label}</span>
      {children}
      {hint && <span className="text-caption text-muted">{hint}</span>}
    </label>
  );
}

export function Sheet({ open, onClose, title, children, wide = false, footer }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean; footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    window.setTimeout(() => ref.current?.querySelector<HTMLElement>("input,textarea,select,button")?.focus(), 30);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div ref={ref} className={`relative h-full w-full ${wide ? "sm:w-[720px]" : "sm:w-[480px]"} bg-surface border-l border-border shadow-pop flex flex-col`}>
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="text-section font-semibold text-text min-w-0 truncate">{title}</div>
          <button type="button" className="ui-focus w-8 h-8 grid place-items-center rounded-ctl text-muted hover:text-text hover:bg-surface2" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-border flex justify-end gap-2 flex-wrap">{footer}</div>}
      </div>
    </div>
  );
}

export function CopyField({ value, label, testId }: { value: string; label?: string; testId?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      window.setTimeout(() => setDone(false), 1600);
    } catch {
      const el = document.getElementById(`cf-${testId || label}`) as HTMLInputElement | null;
      el?.select();
    }
  };
  return (
    <div className="flex items-center gap-2 min-w-0" data-copy={testId || ""}>
      <input id={`cf-${testId || label}`} readOnly value={value} aria-label={label || "Link"} className="input !py-2 text-caption font-mono min-w-0 flex-1" onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="btn-secondary !py-2 !px-3 text-caption shrink-0" onClick={copy}>{done ? "Copied" : "Copy"}</button>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: {
  tabs: { id: T; label: string; badge?: number | string | null }[]; value: T; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto -mb-px [scrollbar-width:none]">
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button key={t.id} type="button" role="tab" aria-selected={on} data-tab={t.id} onClick={() => onChange(t.id)}
            className={`ui-focus shrink-0 inline-flex items-center gap-1.5 px-3 pb-3 pt-1 border-b-2 text-ui transition-colors ${on ? "border-primary text-text font-medium" : "border-transparent text-muted hover:text-text"}`}>
            {t.label}
            {t.badge !== undefined && t.badge !== null && t.badge !== 0 && (
              <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-surface2 text-[11px] grid place-items-center tabular-nums text-secondary">{t.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Tier({ tier }: { tier: string | null | undefined }) {
  if (!tier) return <span className="text-caption text-muted">—</span>;
  const cls = tier === "A" ? "text-good bg-good-fill border-good-border" : tier === "B" ? "text-primary bg-tint border-tint-border" : "text-muted bg-surface2 border-border";
  return <span className={`inline-grid place-items-center w-6 h-6 rounded-[7px] border text-[11.5px] font-semibold ${cls}`} title={`Tier ${tier}`} data-tier={tier}>{tier}</span>;
}

export function Heat({ heat, score }: { heat: "hot" | "warm" | "cold"; score?: number }) {
  const cls = heat === "hot" ? "text-danger" : heat === "warm" ? "text-warning" : "text-muted";
  const bars = heat === "hot" ? 3 : heat === "warm" ? 2 : 1;
  return (
    <span className={`inline-flex items-center gap-1.5 text-caption ${cls}`} title={score !== undefined ? `${score} signal points` : undefined}>
      <span className="inline-flex items-end gap-[2px] h-3" aria-hidden>
        {[1, 2, 3].map((b) => <span key={b} className={`w-[3px] rounded-sm ${b <= bars ? "bg-current" : "bg-border-strong"}`} style={{ height: `${4 + b * 3}px` }} />)}
      </span>
      {heat === "hot" ? "Hot" : heat === "warm" ? "Warm" : "Cold"}
    </span>
  );
}

export function Banner({ kind = "info", children, onClose }: { kind?: "info" | "error" | "good" | "warning"; children: ReactNode; onClose?: () => void }) {
  const cls = kind === "error" ? "border-danger-border bg-danger-fill text-danger" : kind === "good" ? "border-good-border bg-good-fill text-good"
    : kind === "warning" ? "border-warning-border bg-warning-fill text-warning" : "border-tint-border bg-tint text-text";
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`rounded-card border px-4 py-3 text-ui flex justify-between gap-3 items-start ${cls}`}>
      <div className="min-w-0">{children}</div>
      {onClose && <button type="button" className="text-caption underline shrink-0" onClick={onClose}>Dismiss</button>}
    </div>
  );
}

/** A tiny dependency-free stacked bar chart (weeks x groups). */
export function StackBars({ rows, keys, height = 140, labelKey }: { rows: Record<string, any>[]; keys: string[]; height?: number; labelKey: string }) {
  const totals = rows.map((r) => keys.reduce((s, k) => s + (Number(r[k]) || 0), 0));
  const max = Math.max(1, ...totals);
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <div className="relative flex items-end gap-[6px]" style={{ height }} onMouseLeave={() => setHover(null)}>
        {rows.map((r, i) => (
          <div key={i} className="flex-1 min-w-0 h-full flex flex-col justify-end relative" onMouseEnter={() => setHover(i)} data-bar={r[labelKey]}>
            {keys.map((k, ki) => {
              const v = Number(r[k]) || 0;
              if (!v) return null;
              return <div key={k} style={{ height: `${(v / max) * 100}%`, background: `rgb(var(--color-series-${ki + 1}))` }}
                className={`w-full ${ki === keys.length - 1 || keys.slice(ki + 1).every((kk) => !Number(r[kk])) ? "rounded-t-[3px]" : ""} border-t-2 border-surface first:border-t-0`} />;
            })}
            {hover === i && (
              <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-10 rounded-ctl border border-border bg-surface shadow-pop px-3 py-2 text-caption whitespace-nowrap">
                <div className="font-medium text-text mb-1">{fmtDate(r[labelKey])}</div>
                {keys.map((k, ki) => (
                  <div key={k} className="flex items-center gap-2 text-secondary">
                    <span className="w-2 h-2 rounded-sm" style={{ background: `rgb(var(--color-series-${ki + 1}))` }} />{k}<b className="ml-auto pl-3 text-text tabular-nums">{Number(r[k]) || 0}</b>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-3 flex-wrap">
        {keys.map((k, ki) => (
          <span key={k} className="inline-flex items-center gap-1.5 text-caption text-secondary">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: `rgb(var(--color-series-${ki + 1}))` }} />{k}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Funnel({ rows }: { rows: { stage: string; n: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r, i) => (
        <div key={r.stage} className="flex flex-col gap-1" data-funnel={r.stage}>
          <div className="flex justify-between text-caption">
            <span className="text-secondary">{r.stage}</span>
            <span className="tabular-nums text-text font-medium">{r.n.toLocaleString()}
              {i > 0 && rows[i - 1].n > 0 && <span className="text-muted font-normal"> · {Math.round((100 * r.n) / rows[i - 1].n)}%</span>}
            </span>
          </div>
          <div className="h-2 rounded-full bg-surface2 overflow-hidden"><div className="h-full rounded-full bg-primary" style={{ width: `${(100 * r.n) / max}%`, opacity: 1 - i * 0.15 }} /></div>
        </div>
      ))}
    </div>
  );
}
