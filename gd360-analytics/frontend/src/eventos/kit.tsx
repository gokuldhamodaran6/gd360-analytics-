// Event OS building blocks shared by every screen.
import { ReactNode, useState } from "react";
import { Action, eventApi, errText, Kpi, Phase, Truth } from "../api/eventos";
import { assetUrl, Mention } from "../api/eventos";
import { C, compact } from "./charts";

export const TRUTH_COLOR: Record<string, string> = {
  counted: "rgb(var(--color-good))", matched: "rgb(var(--color-kind-analysis))", reported: "rgb(var(--color-kind-alert))",
  modelled: "rgb(var(--color-warning))", tested: "rgb(var(--color-danger))",
};
export const TRUTH_HELP: Record<string, string> = {
  counted: "Counted by GD360 from a scan, a sign-up, a sync or a sensor.",
  matched: "Matched across systems (a post to the event, a deal to a company that came).",
  reported: "Told to us: a survey answer, a number a platform reports, or typed by someone.",
  modelled: "Estimated by a model, with its range.",
  tested: "Proved with a test against a hold-out group.",
};

export function TruthPill({ truth, small = false }: { truth: Truth | string; small?: boolean }) {
  return (
    <span title={TRUTH_HELP[truth] || truth} data-truth={truth}
      className={`inline-flex items-center gap-1.5 rounded-full border border-border ${small ? "h-[18px] px-1.5 text-[10.5px]" : "h-[22px] px-2 text-[11.5px]"} whitespace-nowrap`}
      style={{ color: TRUTH_COLOR[truth] || C.muted }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: TRUTH_COLOR[truth] || C.muted }} />{truth}
    </span>
  );
}

const SYM: Record<string, string> = { INR: "₹", USD: "$", EUR: "€", GBP: "£", SGD: "S$", AED: "AED ", AUD: "A$" };

export function money(v: number | null | undefined, currency = "INR", full = false): string {
  if (v === null || v === undefined) return "–";
  const s = SYM[currency] ?? `${currency} `;
  if (full) return `${s}${Math.round(v).toLocaleString()}`;
  if (currency === "INR") return `${s}${compact(v)}`;
  const a = Math.abs(v);
  if (a >= 1e9) return `${s}${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${s}${Math.round(v / 1e3)}k`;
  return `${s}${Math.round(v).toLocaleString()}`;
}

export function fmtv(v: number | null | undefined, unit: string, currency = "INR"): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  switch (unit) {
    case "money": return money(v, currency, Math.abs(v) < 100000);
    case "pct": return `${Math.round(v)}%`;
    case "minutes": return `${Math.round(v * 10) / 10} min`;
    case "rating": return `${v.toFixed(1)} ★`;
    case "score": return `${Math.round(v)}`;
    default: return Math.abs(v) >= 100000 ? compact(v) : Math.round(v).toLocaleString();
  }
}

export function KpiTile({ k, currency = "INR", accent }: { k: Kpi; currency?: string; accent?: string }) {
  const none = k.value === null || k.value === undefined;
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3.5 flex flex-col gap-1 min-w-0 relative overflow-hidden" data-kpi={k.key}>
      {accent && <span className="absolute inset-x-0 top-0 h-[2px]" style={{ background: accent, opacity: 0.8 }} />}
      <div className="flex items-start justify-between gap-2">
        <span className="text-caption text-muted leading-snug">{k.label}</span>
        <TruthPill truth={k.truth} small />
      </div>
      <span className={`text-[24px] leading-tight font-semibold tracking-tight tabular-nums ${none ? "text-faint" : "text-text"}`}>
        {none ? "not yet" : fmtv(k.value, k.unit, currency)}
      </span>
      {k.sub && <span className="text-caption text-secondary truncate">{k.sub}</span>}
    </div>
  );
}

export function MetricRow({ k, currency = "INR" }: { k: Kpi; currency?: string }) {
  const none = k.value === null || k.value === undefined;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 py-2.5 border-t border-border first:border-t-0" data-metric={k.key}>
      <span className="text-ui text-text">{k.label}</span>
      <span className={`text-[15px] font-semibold tabular-nums text-right font-mono ${none ? "text-faint" : "text-text"}`}>{none ? "–" : fmtv(k.value, k.unit, currency)}</span>
      <span className="text-caption text-muted truncate">{k.sub || " "}</span>
      <span className="justify-self-end"><TruthPill truth={k.truth} small /></span>
    </div>
  );
}

export const PHASES: { id: Phase | "plan" | "learn"; label: string }[] = [
  { id: "before", label: "Before" }, { id: "during", label: "During" }, { id: "after", label: "After" }, { id: "done", label: "Proved" },
];

export function PhaseStepper({ now, compact: small = false }: { now: Phase; compact?: boolean }) {
  const order = ["before", "during", "after", "done"];
  const at = order.indexOf(now);
  return (
    <div className="flex items-center gap-1 flex-wrap" aria-label={`Event phase: ${now}`} data-phase-now={now}>
      {PHASES.map((p, i) => {
        const done = i < at, cur = i === at;
        return (
          <div key={p.id} className="flex items-center gap-1">
            <span className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-caption ${cur ? "bg-tint border border-tint-border text-text font-medium" : done ? "text-brand-ink" : "text-faint"}`}>
              {done ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden><path d="M5 12l5 5 9-10" /></svg>
              ) : <span className={`w-1.5 h-1.5 rounded-full ${cur ? "bg-primary animate-pulse" : "bg-border-strong"}`} />}
              {small && !cur ? null : p.label}
            </span>
            {i < PHASES.length - 1 && <span className="w-3 h-px bg-border-strong" />}
          </div>
        );
      })}
    </div>
  );
}

export function LiveDot({ label = "LIVE" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full border border-danger-border bg-danger-fill text-danger text-[11.5px] font-semibold tracking-[0.06em]">
      <span className="relative w-2 h-2"><span className="absolute inset-0 rounded-full bg-danger animate-ping opacity-60" /><span className="absolute inset-0 rounded-full bg-danger" /></span>
      {label}
    </span>
  );
}

export function Card({ title, sub, right, children, className = "", tone, pad = true }: {
  title?: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; tone?: "good" | "warning" | "accent"; pad?: boolean;
}) {
  const border = tone === "good" || tone === "accent" ? "border-tint-border" : tone === "warning" ? "border-warning-border" : "border-border";
  const bg = tone === "accent" ? "bg-gradient-to-b from-tint/60 to-surface" : "bg-surface";
  return (
    <section className={`rounded-card border ${border} ${bg} ${pad ? "p-4 sm:p-5" : ""} flex flex-col gap-3.5 min-w-0 shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] ${className}`}>
      {(title || right) && (
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            {title && <h3 className="m-0 text-section font-semibold text-text">{title}</h3>}
            {sub && <p className="m-0 mt-0.5 text-caption text-muted">{sub}</p>}
          </div>
          {right && <div className="flex items-center gap-2 flex-wrap text-caption text-muted">{right}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">{children}</span>;
}

export function Legend({ items }: { items: { label: string; color: string; dash?: boolean }[] }) {
  return (
    <div className="flex gap-4 flex-wrap">
      {items.map((x) => (
        <span key={x.label} className="inline-flex items-center gap-1.5 text-caption text-secondary">
          {x.dash ? <span className="w-4 border-t-2 border-dashed" style={{ borderColor: x.color }} /> : <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: x.color }} />}
          {x.label}
        </span>
      ))}
    </div>
  );
}

const AGENT_COLOR: Record<string, string> = { Demand: "rgb(var(--color-kind-analysis))", Ops: "rgb(var(--color-danger))", Planner: "rgb(var(--color-good))",
  Promoter: "rgb(var(--color-warning))", Sponsor: "rgb(var(--color-warning))", Analyst: "rgb(var(--color-kind-alert))", "Follow-up": "rgb(var(--color-kind-alert))", Concierge: "rgb(var(--color-danger))" };

export function ActionList({ initiativeId, actions, canEdit, onChanged, empty, title = "Euliv suggests" }: {
  initiativeId: string; actions: Action[]; canEdit: boolean; onChanged?: () => void; empty?: string; title?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const decide = async (a: Action, d: "approve" | "dismiss") => {
    setBusy(a.id); setErr("");
    try {
      const r = await eventApi.decide(initiativeId, a.id, d);
      setRes((x) => ({ ...x, [a.id]: r.result || (d === "approve" ? "Done" : "Dismissed") }));
      onChanged?.();
    } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };
  const live = actions.filter((a) => a.state === "proposed" || res[a.id]);
  return (
    <Card title={<span className="inline-flex items-center gap-2"><span className="w-5 h-5 rounded-full" style={{ background: "radial-gradient(circle at 35% 35%, #9BF5CF, #2FB884 60%, #164A36)", boxShadow: "0 0 12px rgba(75,227,163,0.45)" }} />{title}</span>}
      sub="Approve does it; every decision is kept in the log" tone="accent">
      {err && <div className="text-caption text-danger">{err}</div>}
      {!live.length && <div className="text-caption text-muted">{empty || "Nothing needs you right now."}</div>}
      <div className="flex flex-col">
        {live.map((a) => (
          <div key={a.id} className="py-3 border-t border-border first:border-t-0 flex flex-col gap-1.5" data-action={a.key}>
            <div className="flex items-start gap-2.5">
              <span className="mt-1 w-2 h-2 rounded-full shrink-0" style={{ background: AGENT_COLOR[a.agent] || C.primary }} />
              <div className="min-w-0 flex-1">
                <div className="text-ui text-text font-medium leading-snug">{a.title}</div>
                {a.detail && <div className="text-caption text-muted mt-0.5">{a.detail}</div>}
                {a.impact && <div className="text-caption text-secondary mt-0.5">{a.impact}</div>}
                <div className="text-[11px] text-faint mt-1 font-mono uppercase tracking-[0.08em]">{a.agent} agent</div>
              </div>
            </div>
            {res[a.id] ? <div className="pl-4 text-caption text-good">✓ {res[a.id]}</div> : canEdit && (
              <div className="pl-4 flex gap-2">
                <button type="button" className="btn-primary !py-1.5 !px-3 text-caption" disabled={busy === a.id} onClick={() => decide(a, "approve")}>
                  {busy === a.id ? "Working…" : a.can_do ? "Approve and do it" : "Got it"}
                </button>
                <button type="button" className="btn-secondary !py-1.5 !px-3 text-caption" disabled={busy === a.id} onClick={() => decide(a, "dismiss")}>Dismiss</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

const PLATFORM: Record<string, { label: string; bg: string }> = {
  linkedin: { label: "LinkedIn", bg: "#0A66C2" }, instagram: { label: "Instagram", bg: "#C13584" }, facebook: { label: "Facebook", bg: "#1877F2" },
  x: { label: "X", bg: "#111111" }, youtube: { label: "YouTube", bg: "#FF0033" }, news: { label: "News", bg: "#6B5B2A" }, other: { label: "Web", bg: "#3A4A43" },
};
const KIND_LABEL: Record<string, string> = { own: "your account", speaker: "speaker", sponsor: "sponsor", attendee: "attendee", press: "press", creator: "creator", public: "public" };
const HOW_LABEL: Record<string, string> = { hashtag: "hashtag", link: "tracked link", code: "code", keyword: "words", banner: "banner seen", manual: "added by hand" };

export function PostCard({ m, onDecide, canEdit }: { m: Mention; onDecide?: (state: "confirmed" | "rejected") => void; canEdit?: boolean }) {
  const p = PLATFORM[m.platform] || PLATFORM.other;
  const [broken, setBroken] = useState(false);
  const img = m.media_url && !broken ? assetUrl(m.media_url) : null;
  const sentCol = m.sentiment === "positive" ? "text-good" : m.sentiment === "negative" ? "text-danger" : "text-muted";
  return (
    <article className="rounded-card border border-border bg-surface overflow-hidden flex flex-col min-w-0 group" data-post={m.id}>
      <div className={`relative overflow-hidden ${img ? "aspect-[16/10] bg-black" : "h-[132px]"}`}
        style={img ? undefined : { background: `linear-gradient(135deg, ${p.bg}2e, rgb(var(--color-surface2)) 55%, rgb(var(--color-base)))` }}>
        {img ? <img src={img} alt={`Picture in the post by ${m.author || "someone"}`} loading="lazy" className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" onError={() => setBroken(true)} />
          : <div className="absolute inset-0 px-4 pt-8 pb-3 flex flex-col justify-end gap-1"><span className="font-serif text-[40px] leading-[0.6] text-text/25" aria-hidden>“</span><p className="m-0 text-[14px] leading-snug text-text line-clamp-3">{m.text}</p></div>}
        <span className="absolute top-2 left-2 h-5 px-1.5 rounded-[6px] text-[10.5px] text-white inline-flex items-center" style={{ background: p.bg }}>{p.label}</span>
        <span className="absolute top-2 right-2 h-5 px-1.5 rounded-[6px] text-[10.5px] inline-flex items-center bg-black/70 text-white border border-white/10">
          {HOW_LABEL[m.matched_by || "manual"] || m.matched_by}{m.confidence ? ` ${m.confidence.toFixed(2)}` : ""}
        </span>
        {m.state === "review" && <span className="absolute bottom-2 left-2 h-5 px-1.5 rounded-[6px] text-[10.5px] inline-flex items-center bg-warning text-black font-medium">needs a look</span>}
      </div>
      <div className="p-3 flex flex-col gap-1 min-w-0">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <span className="text-ui font-medium text-text truncate">{m.author || "Unknown"}</span>
          <span className="text-[11px] text-muted shrink-0">{KIND_LABEL[m.author_kind || "public"]}</span>
        </div>
        {img && <p className="m-0 text-caption text-secondary line-clamp-2">{m.text}</p>}
        <div className="flex items-center gap-2 text-[11.5px] text-muted flex-wrap">
          {m.posted_at && <span>{new Date(m.posted_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>}
          {m.reach ? <span>· {compact(m.reach)} reach</span> : null}
          {m.engagements ? <span>· {compact(m.engagements)} engagements</span> : null}
          <span className={`ml-auto ${sentCol}`}>{m.sentiment || ""}</span>
        </div>
        {m.why && <div className="text-[11.5px] text-faint truncate" title={m.why}>Why: {m.why}</div>}
        <div className="flex items-center gap-2 mt-1">
          {m.url && <a href={m.url} target="_blank" rel="noreferrer" className="text-caption text-brand-ink hover:underline">Open post ↗</a>}
          {canEdit && onDecide && m.state === "review" && (
            <span className="ml-auto flex gap-1.5">
              <button type="button" className="btn-primary !py-1 !px-2 text-[11.5px]" onClick={() => onDecide("confirmed")}>It's about us</button>
              <button type="button" className="btn-secondary !py-1 !px-2 text-[11.5px]" onClick={() => onDecide("rejected")}>Not ours</button>
            </span>
          )}
          {canEdit && onDecide && m.state !== "review" && (
            <button type="button" className="ml-auto text-[11.5px] text-muted hover:text-danger" onClick={() => onDecide("rejected")}>Not ours</button>
          )}
        </div>
      </div>
    </article>
  );
}

export function Seg<T extends string>({ items, value, onChange, label }: { items: { id: T; label: string; badge?: number | null }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex gap-0.5 p-[3px] rounded-[11px] border border-border bg-surface">
      {items.map((it) => (
        <button key={it.id} type="button" role="tab" aria-selected={value === it.id} onClick={() => onChange(it.id)} data-seg={it.id}
          className={`ui-focus h-[30px] px-3 rounded-[8px] text-caption inline-flex items-center gap-1.5 transition-colors ${value === it.id ? "bg-tint border border-tint-border text-text font-medium" : "text-muted hover:text-text border border-transparent"}`}>
          {it.label}{it.badge ? <span className="text-[10.5px] tabular-nums text-muted">{it.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Skel({ h = 160 }: { h?: number }) {
  return <div className="rounded-card bg-surface2 animate-pulse" style={{ height: h }} />;
}

export function when(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString(undefined, opts);
}

export function localWhen(local: string | null | undefined): string {
  if (!local) return "–";
  const d = new Date(local);
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
