// 2026-10-09 (round 15): "Ask one Space or chosen sources" - the scope chip
// and popover under the Home question box (HomePicker.dc.html). Two tabs:
// Spaces (radio rows: Everything, or one Space) and Pick sources (checkboxes
// grouped by Space, a source can sit under several, plus "Not in a Space").
// The chosen scope decides what Home sends: space_id for a Space,
// source_ids for picked sources - never both.
// 2026-10-11 (Ask Journey): ONE picker for Quick answer and Guided, on Home
// and in every thread's follow-up box - `variant` only changes the trigger
// ("composer": Home's box, "compact": a thread's box), `placement` opens it
// above a box pinned to the bottom of the screen.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import BrandTile from "../components/BrandTile";
import type { Space } from "../api/spaces";
import type { ProjectSource } from "../api/projects";

export type Scope = { kind: "all" } | { kind: "space"; spaceId: string } | { kind: "sources"; ids: string[] };

const PICKED_COLOR = "rgb(var(--color-series-1))";
const ALL_COLOR = "rgb(var(--color-good))";

const STARTERS: Record<string, string[]> = {
  all: ["Which part of the business grew fastest this quarter?", "What changed most since last week?", "Show revenue per week for the last quarter"],
  marketing: ["Which posts drove the most profile visits?", "What is our blended cost per new customer?", "Compare organic and paid reach by week"],
  sales: ["Which products sell best this month?", "Why were refunds higher last month?", "Forecast next month's orders"],
  finance: ["What is cash in vs cash out this month?", "Which costs grew fastest?", "Revenue recognised vs collected"],
  hr: ["Where is attrition highest?", "Time to hire by role", "Headcount plan vs actual"],
  product: ["Did the latest A/B test win?", "Which features do retained users use?", "Ticket volume after each release"],
};

const GENERIC = ["Why did revenue change this month?", "Which channels bring the most revenue?", "Show revenue per week for the last quarter"];

/** Starter questions for the chosen scope, by common Space names. */
export function startersFor(space: Space | null | undefined): string[] {
  if (!space) return GENERIC;
  const n = space.name.toLowerCase();
  if (/market|brand|social|growth/.test(n)) return STARTERS.marketing;
  if (/sales|revenue|commerce|store/.test(n)) return STARTERS.sales;
  if (/financ|account/.test(n)) return STARTERS.finance;
  if (/\bhr\b|people|talent|hiring/.test(n)) return STARTERS.hr;
  if (/product|testing|experiment|engineering/.test(n)) return STARTERS.product;
  return GENERIC;
}

const scopeKey = (workspaceId: string) => `gd360_home_scope:${workspaceId}`;

export function loadScope(workspaceId: string): Scope | null {
  try {
    const raw = localStorage.getItem(scopeKey(workspaceId));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v?.kind === "all") return { kind: "all" };
    if (v?.kind === "space" && typeof v.spaceId === "string") return { kind: "space", spaceId: v.spaceId };
    if (v?.kind === "sources" && Array.isArray(v.ids)) return { kind: "sources", ids: v.ids.map(String) };
  } catch {
    /* per-browser convenience only */
  }
  return null;
}

export function saveScope(workspaceId: string, scope: Scope): void {
  try {
    localStorage.setItem(scopeKey(workspaceId), JSON.stringify(scope));
  } catch {
    /* per-browser convenience only */
  }
}

/** Sources of a Space that are in the list the person can ask. */
function spaceSources(space: Space, sources: ProjectSource[]): ProjectSource[] {
  const ids = new Set(space.source_ids);
  return sources.filter((s) => ids.has(s.id));
}

export function scopeSummary(scope: Scope, sources: ProjectSource[] | null, spaces: Space[] | null): { label: string; color: string; footer: string; count: number } {
  const all = sources || [];
  if (scope.kind === "space") {
    const sp = (spaces || []).find((s) => s.id === scope.spaceId);
    if (sp) {
      const n = sp.sources.length;
      return { label: `${sp.name} · ${n} ${n === 1 ? "source" : "sources"}`, color: sp.color, footer: `GD360 answers from ${sp.name} only.`, count: n };
    }
  }
  if (scope.kind === "sources") {
    const n = scope.ids.length;
    return {
      label: `${n} ${n === 1 ? "source" : "sources"} chosen`,
      color: PICKED_COLOR,
      footer: n ? `GD360 will query only ${n === 1 ? "this source" : `these ${n} sources`}.` : "Pick at least one source.",
      count: n,
    };
  }
  return { label: `Everything · ${all.length} ${all.length === 1 ? "source" : "sources"}`, color: ALL_COLOR, footer: "GD360 picks the right sources from everything you can see.", count: all.length };
}

function LogoStack({ items }: { items: { kind: string; name: string }[] }) {
  if (!items.length) return null;
  return (
    <span className="hidden sm:flex items-center shrink-0 pl-1.5" aria-hidden="true">
      {items.slice(0, 4).map((it, i) => (
        <BrandTile key={`${it.kind}-${i}`} kind={it.kind} name={it.name} size={22} className="-ml-1.5 ring-2 ring-[rgb(var(--color-surface))]" />
      ))}
    </span>
  );
}

/** The trigger's words: "All sources · 6", "Sales · 4", "2 sources". */
export function scopeChipLabel(scope: Scope, sources: ProjectSource[] | null, spaces: Space[] | null): string {
  const all = sources || [];
  if (scope.kind === "space") {
    const sp = (spaces || []).find((s) => s.id === scope.spaceId);
    if (sp) return `${sp.name} · ${sp.sources.length}`;
  }
  if (scope.kind === "sources") {
    const n = scope.ids.length;
    if (n === 1) return all.find((s) => s.id === scope.ids[0])?.name || "1 source";
    return `${n} sources`;
  }
  return `All sources · ${all.length}`;
}

function DbIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <ellipse cx="12" cy="6" rx="7" ry="2.6" />
      <path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6" />
      <path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" />
    </svg>
  );
}

export default function ScopePicker({
  scope,
  onChange,
  sources,
  spaces,
  variant = "chip",
  placement = "below",
  disabled = false,
}: {
  scope: Scope;
  onChange: (s: Scope) => void;
  sources: ProjectSource[] | null;
  spaces: Space[] | null;
  variant?: "chip" | "composer" | "compact";
  placement?: "below" | "above";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"spaces" | "sources">(scope.kind === "sources" ? "sources" : "spaces");
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const all = sources || [];
  const list = spaces || [];
  const summary = scopeSummary(scope, sources, spaces);

  const groups = useMemo(() => {
    const out: { id: string; name: string; color: string | null; items: ProjectSource[] }[] = [];
    const inSpace = new Set<string>();
    for (const sp of list) {
      const items = spaceSources(sp, all);
      items.forEach((s) => inSpace.add(s.id));
      if (items.length) out.push({ id: sp.id, name: sp.name, color: sp.color, items });
    }
    const rest = all.filter((s) => !inSpace.has(s.id));
    if (rest.length) out.push({ id: "__none", name: out.length ? "Not in a Space" : "All sources", color: null, items: rest });
    return out;
  }, [list, all]);

  const chipLabel = scopeChipLabel(scope, sources, spaces);
  const chipLogos = (scope.kind === "sources" ? all.filter((s) => scope.ids.includes(s.id)) : []).slice(0, 3);
  const pickedIds = scope.kind === "sources" ? scope.ids : [];
  const picked = new Set(pickedIds);

  /** The ids the current scope covers - what "Pick sources" starts from. */
  const currentIds = (): string[] => {
    if (scope.kind === "sources") return scope.ids;
    if (scope.kind === "space") {
      const sp = list.find((s) => s.id === scope.spaceId);
      if (sp) return spaceSources(sp, all).map((s) => s.id);
    }
    return all.map((s) => s.id);
  };

  const openSourcesTab = () => {
    setTab("sources");
    if (scope.kind !== "sources") onChange({ kind: "sources", ids: currentIds() });
  };

  const setIds = (ids: string[]) => onChange({ kind: "sources", ids: Array.from(new Set(ids)) });
  const toggle = (id: string) => setIds(picked.has(id) ? pickedIds.filter((x) => x !== id) : [...pickedIds, id]);

  const tabCls = (on: boolean) =>
    `ui-focus flex-1 h-8 rounded-[8px] text-ui ${on ? "bg-subtle text-text font-medium" : "text-muted hover:text-text"}`;

  return (
    <div className="relative min-w-0" ref={wrapRef}>
      {variant === "chip" ? (
        <button
          ref={btnRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          className="ui-focus inline-flex items-center gap-2 h-8 px-3 max-w-full rounded-full border border-tint-border bg-base text-ui text-secondary hover:text-text disabled:opacity-50"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={`Ask across: ${sources === null ? "loading sources" : summary.label}. Change`}
        >
          <span className="w-2 h-2 rounded-[3px] shrink-0" style={{ background: summary.color }} aria-hidden="true" />
          <span className="truncate">{sources === null ? "Loading sources…" : summary.label}</span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0"><path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      ) : (
        <button
          ref={btnRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          data-scope-chip={variant}
          className={`ui-focus inline-flex items-center max-w-full rounded-full border transition-colors disabled:opacity-50 ${
            variant === "composer"
              ? "gap-2.5 h-11 pl-3.5 pr-3 text-[15px] text-text border-border-strong hover:border-[rgb(var(--color-faint))] hover:bg-subtle/60"
              : "gap-1.5 h-8 pl-2.5 pr-2 text-caption text-secondary border-border hover:text-text hover:border-border-strong"
          } ${open ? "border-[rgb(var(--color-faint))] bg-subtle/60" : ""}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={`Ask across: ${sources === null ? "loading sources" : summary.label}. Change`}
        >
          {chipLogos.length > 0 ? (
            <span className="flex items-center pl-1.5" aria-hidden="true">
              {chipLogos.map((s, i) => (
                <BrandTile key={`${s.id}-${i}`} kind={s.kind} name={s.name} size={variant === "composer" ? 20 : 16} className="-ml-1.5 ring-2 ring-[rgb(var(--color-surface))]" />
              ))}
            </span>
          ) : (
            <span className="text-muted"><DbIcon size={variant === "composer" ? 17 : 14} /></span>
          )}
          <span className="truncate">{sources === null ? "Loading…" : chipLabel}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}>
            <path d={placement === "above" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
          </svg>
        </button>
      )}

      {open && sources && (
        <div
          role="dialog"
          aria-label="Choose what to ask across"
          data-scope-popover=""
          className={`absolute z-40 left-0 w-[min(460px,calc(100vw-40px))] rounded-[18px] border border-border bg-surface shadow-pop p-3 flex flex-col gap-2.5 ${
            placement === "above" ? "bottom-[calc(100%+8px)]" : "top-[calc(100%+8px)]"
          }`}
        >
          <div className="flex gap-0.5 rounded-ctl border border-border bg-base p-[3px]" role="tablist" aria-label="Scope">
            <button type="button" role="tab" aria-selected={tab === "spaces"} className={tabCls(tab === "spaces")} onClick={() => setTab("spaces")}>
              Spaces
            </button>
            <button type="button" role="tab" aria-selected={tab === "sources"} className={tabCls(tab === "sources")} onClick={openSourcesTab}>
              Pick sources
            </button>
          </div>

          {tab === "spaces" ? (
            <div role="radiogroup" aria-label="Ask across" className="flex flex-col gap-0.5 max-h-[340px] overflow-y-auto">
              {[
                { id: "__all", name: "Everything", color: ALL_COLOR, desc: `All ${all.length} ${all.length === 1 ? "source" : "sources"} you can see`, logos: all.map((s) => ({ kind: s.kind, name: s.name })) },
                ...list.map((sp) => {
                  const n = sp.sources.length;
                  const labels = Array.from(new Set(sp.sources.map((s) => s.label))).slice(0, 4).join(", ");
                  const bits = [`${n} ${n === 1 ? "source" : "sources"}`, sp.description?.trim() || labels].filter(Boolean);
                  return { id: sp.id, name: sp.name, color: sp.color, desc: bits.join(" · "), logos: sp.sources.map((s) => ({ kind: s.kind, name: s.name })) };
                }),
              ].map((o) => {
                const on = o.id === "__all" ? scope.kind === "all" : scope.kind === "space" && scope.spaceId === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => onChange(o.id === "__all" ? { kind: "all" } : { kind: "space", spaceId: o.id })}
                    className={`ui-focus w-full grid grid-cols-[18px_minmax(0,1fr)_auto] gap-3 items-center text-left px-2.5 py-2.5 rounded-ctl border ${
                      on ? "bg-tint border-tint-border" : "border-transparent hover:bg-subtle"
                    }`}
                  >
                    <span className={`w-[18px] h-[18px] rounded-full border-2 grid place-items-center ${on ? "border-good" : "border-border-strong"}`} aria-hidden="true">
                      {on && <span className="w-2 h-2 rounded-full bg-good" />}
                    </span>
                    <span className="flex flex-col gap-0.5 min-w-0">
                      <span className="flex items-center gap-2 text-body font-medium text-text min-w-0">
                        <span className="w-2 h-2 rounded-[3px] shrink-0" style={{ background: o.color }} aria-hidden="true" />
                        <span className="truncate">{o.name}</span>
                      </span>
                      <span className="text-caption text-muted truncate">{o.desc}</span>
                    </span>
                    <LogoStack items={o.logos} />
                  </button>
                );
              })}
              {spaces !== null && list.length === 0 && (
                <p className="m-0 px-2.5 py-2 text-caption text-muted">
                  No Spaces yet. <Link to="/data?tab=spaces" className="text-brand-ink hover:underline">Group your sources into Spaces</Link> to ask one team's data at a time.
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 max-h-[340px] overflow-y-auto pr-1">
              {groups.map((g) => {
                const allOn = g.items.every((s) => picked.has(s.id));
                return (
                  <div key={g.id} role="group" aria-label={g.name} className="flex flex-col gap-0.5">
                    <div className="flex items-center justify-between px-1.5">
                      <span className="inline-flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-caps text-muted">
                        {g.color && <span className="w-2 h-2 rounded-[3px]" style={{ background: g.color }} aria-hidden="true" />}
                        {g.name}
                      </span>
                      <button
                        type="button"
                        className="ui-focus text-caption text-brand-ink hover:underline px-1 py-1 rounded-sm"
                        onClick={() => {
                          const ids = g.items.map((s) => s.id);
                          setIds(allOn ? pickedIds.filter((x) => !ids.includes(x)) : [...pickedIds, ...ids]);
                        }}
                        aria-label={`${allOn ? "Clear" : "Select all"} in ${g.name}`}
                      >
                        {allOn ? "Clear" : "Select all"}
                      </button>
                    </div>
                    {g.items.map((s) => (
                      <label key={`${g.id}-${s.id}`} className="flex items-center gap-2.5 px-2 py-2 rounded-ctl hover:bg-subtle cursor-pointer min-w-0">
                        <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} className="w-4 h-4 shrink-0 accent-[rgb(var(--color-primary))]" />
                        <BrandTile kind={s.kind} name={s.name} size={22} />
                        <span className="flex-1 min-w-0 text-ui text-text truncate">{s.name}</span>
                        <span className="text-caption text-muted shrink-0 hidden sm:inline">{s.label}</span>
                      </label>
                    ))}
                  </div>
                );
              })}
              {groups.length === 0 && <p className="m-0 px-2 text-caption text-muted">No sources connected yet.</p>}
            </div>
          )}

          <div className="flex justify-between items-center gap-2.5 flex-wrap border-t border-border pt-2.5 px-1">
            <span className={`text-caption ${scope.kind === "sources" && !scope.ids.length ? "text-warning" : "text-muted"}`} aria-live="polite">
              {summary.footer}
            </span>
            <span className="flex items-center gap-3 ml-auto">
              <Link to="/data" className="text-caption text-muted hover:text-text">+ Connect a source</Link>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  btnRef.current?.focus();
                }}
                className="ui-focus h-[34px] px-3.5 rounded-[10px] bg-primary text-on-primary text-ui font-semibold"
              >
                Done
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
