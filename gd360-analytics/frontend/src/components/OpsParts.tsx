// 2026-10-10 (round 19): small pieces shared by the Automations home, the
// Trust Center and the company-domain pages - kind chips, the last-7-runs
// bars, status dots, a copy button, the page frame and a few formatters.
import { useState, type ReactNode } from "react";
import type { OpsKind, RunStatus } from "../api/ops";
import { CheckIcon, CopyIcon } from "../ui";

export const KIND_LABEL: Record<OpsKind, string> = {
  automation: "Automation",
  alert: "Alert",
  refresh: "Dashboard refresh",
  chain: "Chain",
  sync: "Data sync",
};
export const KIND_SHORT: Record<OpsKind, string> = {
  automation: "Automation",
  alert: "Alert",
  refresh: "Refresh",
  chain: "Chain",
  sync: "Sync",
};
export const KIND_PLURAL: Record<OpsKind, string> = {
  automation: "Automations",
  alert: "Alerts",
  refresh: "Dashboard refreshes",
  chain: "Chains",
  sync: "Data syncs",
};

export function KindChip({ kind, short = false }: { kind: OpsKind; short?: boolean }) {
  return (
    <span className={`ops-kind-${kind} ops-chip inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full text-[11px] font-medium whitespace-nowrap`}>
      <span className="ops-dot w-1.5 h-1.5 rounded-full" aria-hidden="true" />
      {short ? KIND_SHORT[kind] : KIND_LABEL[kind]}
    </span>
  );
}

export function KindDot({ kind, className = "" }: { kind: OpsKind; className?: string }) {
  return <span className={`ops-kind-${kind} ops-dot inline-block w-2 h-2 rounded-full shrink-0 ${className}`} aria-hidden="true" />;
}

const STATUS_CLASS: Record<string, string> = { success: "bg-good", failed: "bg-danger", running: "bg-warning ops-pulse" };

/** The last seven runs as little bars, oldest on the left. Never colour
 * alone - each bar carries a title, and the cell beside it says the last result. */
export function RunBars({ runs, label }: { runs: { status: RunStatus; at: string | null }[]; label: string }) {
  const slots = [...Array(Math.max(0, 7 - runs.length)).fill(null), ...runs.slice(-7)];
  const ok = runs.filter((r) => r.status === "success").length;
  return (
    <span className="inline-flex items-end gap-[3px] h-5" role="img" aria-label={`${label}: ${runs.length ? `${ok} of ${runs.length} recent runs succeeded` : "no runs yet"}`}>
      {slots.map((r, i) => (
        <span
          key={i}
          title={r ? `${r.status === "success" ? "Succeeded" : r.status === "failed" ? "Failed" : "Running"}${r.at ? ` · ${fmtWhen(r.at)}` : ""}` : "No run"}
          className={`w-[5px] rounded-[2px] ${r ? STATUS_CLASS[r.status] || "bg-border-strong" : "bg-border"} ${r?.status === "failed" ? "h-5" : r ? "h-3.5" : "h-2"}`}
        />
      ))}
    </span>
  );
}

export function StatusDot({ status }: { status: string | null | undefined }) {
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${STATUS_CLASS[status || ""] || "bg-border-strong"}`} aria-hidden="true" />;
}

export function parseIso(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);
  return isNaN(d.getTime()) ? null : d;
}

export function fmtWhen(iso?: string | null): string {
  const d = parseIso(iso);
  if (!d) return "";
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  const t = new Date(now.getTime() + 86400000);
  if (d.toDateString() === t.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

export function fmtTime(iso?: string | null): string {
  const d = parseIso(iso);
  return d ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
}

export function ago(iso?: string | null): string {
  const d = parseIso(iso);
  if (!d) return "";
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function inFuture(iso?: string | null): string {
  const d = parseIso(iso);
  if (!d) return "";
  const s = Math.round((d.getTime() - Date.now()) / 1000);
  if (s <= 60) return "any moment";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  return fmtWhen(iso);
}

export function secs(n?: number | null): string {
  if (n == null) return "";
  if (n < 1) return "<1 s";
  if (n < 90) return `${Math.round(n)} s`;
  return `${Math.round(n / 60)} min`;
}

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          /* the value is visible and selectable next to the button */
        }
      }}
      className={`ui-focus inline-flex items-center gap-1.5 h-7 px-2 rounded-ctl border border-border text-caption text-secondary hover:text-text hover:border-border-strong transition-colors ${className}`}
      aria-label={`${label}: ${text}`}
    >
      {done ? <CheckIcon size={13} className="text-good" /> : <CopyIcon size={13} />}
      {done ? "Copied" : label}
    </button>
  );
}

export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted ${className}`}>{children}</div>;
}

export function Banner({ tone = "info", children, action }: { tone?: "info" | "good" | "warning" | "danger"; children: ReactNode; action?: ReactNode }) {
  const cls =
    tone === "good" ? "border-good-border bg-good-fill" :
    tone === "warning" ? "border-warning-border bg-warning-fill" :
    tone === "danger" ? "border-danger-border bg-danger-fill" : "border-border bg-surface";
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`rounded-card border ${cls} px-4 py-3 text-ui text-text flex items-start gap-3 flex-wrap`}>
      <div className="flex-1 min-w-[220px] leading-relaxed">{children}</div>
      {action}
    </div>
  );
}

/** A tab strip that scrolls sideways on a phone instead of wrapping. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { value: T; label: ReactNode; count?: number | null; tone?: "danger" | "warning" }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="overflow-x-auto -mx-1 px-1" role="tablist" aria-label={label}>
      <div className="flex items-center gap-1 border-b border-border min-w-max">
        {tabs.map((t) => {
          const on = t.value === value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onChange(t.value)}
              className={`ui-focus relative h-10 px-3 text-ui font-medium whitespace-nowrap transition-colors ${on ? "text-text" : "text-muted hover:text-text"}`}
            >
              <span className="inline-flex items-center gap-2">
                {t.label}
                {t.count != null && t.count > 0 && (
                  <span className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10.5px] font-mono inline-flex items-center justify-center ${t.tone === "danger" ? "bg-danger-fill text-danger" : t.tone === "warning" ? "bg-warning-fill text-warning" : "bg-subtle text-secondary"}`}>
                    {t.count}
                  </span>
                )}
              </span>
              {on && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full bg-primary" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function EmptyNote({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-border-strong px-5 py-8 text-center flex flex-col items-center gap-1.5">
      <div className="text-section font-semibold text-text">{title}</div>
      {children && <div className="text-ui text-muted max-w-[56ch] leading-relaxed">{children}</div>}
    </div>
  );
}

/** Radio cards - a choice with a line of explanation under each option.
 * Stacks on a phone; never scrolls sideways. */
export function ChoiceCards<T extends string>({ value, onChange, options, label, columns = 3 }: { value: T; onChange: (v: T) => void; options: { value: T; title: string; text: string }[]; label: string; columns?: 2 | 3 }) {
  return (
    <div role="radiogroup" aria-label={label} className={`grid gap-2 grid-cols-1 ${columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`ui-focus text-left rounded-ctl border p-3 flex gap-2.5 transition-colors ${on ? "border-primary bg-tint" : "border-border bg-base hover:border-border-strong"}`}
          >
            <span className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${on ? "border-primary" : "border-border-strong"}`} aria-hidden="true">
              {on && <span className="w-2 h-2 rounded-full bg-primary" />}
            </span>
            <span className="flex flex-col gap-0.5 min-w-0">
              <span className={`text-ui font-medium ${on ? "text-text" : "text-secondary"}`}>{o.title}</span>
              <span className="text-caption text-muted leading-snug">{o.text}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
