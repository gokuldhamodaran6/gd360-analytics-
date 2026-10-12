// 2026-10-12 (round 35): the data source picker for a new dashboard. The browser's own <select> opened
// as a light system menu over the dark app, listed a ticked "Choose a data source", and gave no way to
// find one among many or to see which sources can't make a dashboard. This one is ours: searchable,
// grouped (live connections, uploaded files, not available yet), keyboard-driven, in the app's theme.
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { DataSourceSummary } from "../../api/client";
import { ChevronDownIcon, Popover, ProviderBadge, SearchIcon, cn } from "../../ui";
import { isLiveKind } from "../DataFreshness";
import { kindLabel, proposalSupport, schemaSummary } from "./sourceSupport";

function rowDetail(ds: DataSourceSummary): string {
  const s = schemaSummary(ds);
  const parts = [s.columns ? `${s.columns} column${s.columns === 1 ? "" : "s"}` : null, s.tables > 1 ? `${s.tables} tables` : null];
  const added = new Date(ds.created_at);
  if (!Number.isNaN(added.getTime())) parts.push(`added ${added.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`);
  return parts.filter(Boolean).join(" · ");
}

type Row = { ds: DataSourceSummary; group: "live" | "file" | "unsupported"; reason: string | null };

const GROUP_LABEL: Record<Row["group"], string> = { live: "Live connections", file: "Uploaded files", unsupported: "Can't build a dashboard yet" };

export function SourcePicker({
  sources, value, onChange, disabled,
}: {
  sources: DataSourceSummary[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = sources.find((d) => d.id === value) || null;

  const rows = useMemo<Row[]>(() => {
    const t = q.trim().toLowerCase();
    const all = sources
      .filter((d) => !t || d.name.toLowerCase().includes(t) || kindLabel(d.kind).toLowerCase().includes(t))
      .map((ds): Row => {
        const s = proposalSupport(ds.kind);
        return { ds, group: s.level === "unsupported" ? "unsupported" : isLiveKind(ds.kind) ? "live" : "file", reason: s.level === "unsupported" ? s.reason : null };
      })
      .sort((a, b) => new Date(b.ds.created_at).getTime() - new Date(a.ds.created_at).getTime());
    const order: Row["group"][] = ["live", "file", "unsupported"];
    return order.flatMap((g) => all.filter((r) => r.group === g));
  }, [sources, q]);
  const pickable = rows.filter((r) => r.group !== "unsupported");

  const onKey = (e: KeyboardEvent, close: () => void) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = pickable.length;
      if (!n) return;
      const next = (active + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      setActive(next);
      listRef.current?.querySelector(`[data-source-row="${pickable[next].ds.id}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = pickable[active];
      if (r) { onChange(r.ds.id); close(); setQ(""); }
    }
  };

  return (
    <Popover
      align="start"
      width="trigger"
      portal
      disabled={disabled}
      haspopup="listbox"
      ariaLabel="Choose a data source"
      onOpenChange={(o) => { if (o) { setActive(Math.max(0, pickable.findIndex((r) => r.ds.id === value))); } else setQ(""); }}
      trigger={(api) => (
        <button
          type="button"
          {...api.props}
          id="builder-source"
          data-source-picker=""
          className={cn(
            "ui-focus flex h-10 w-full items-center gap-2 rounded-ctl border bg-base px-3 text-left text-ui transition-colors",
            selected ? "border-border text-text hover:border-border-strong" : "border-border text-muted hover:border-border-strong",
            disabled && "opacity-60"
          )}
        >
          {selected ? (
            <>
              <ProviderBadge provider={selected.kind} />
              <span className="min-w-0 flex-1 truncate font-medium" title={selected.name}>{selected.name}</span>
            </>
          ) : (
            <span className="min-w-0 flex-1">Choose a data source</span>
          )}
          <ChevronDownIcon size={14} className="shrink-0 text-muted" />
        </button>
      )}
    >
      {({ close }) => (
        <div className="flex max-h-[420px] flex-col" data-source-list="">
          <div className="border-b border-border p-2">
            <label className="relative block">
              <span className="sr-only">Search sources</span>
              <SearchIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                autoFocus
                value={q}
                onChange={(e) => { setQ(e.target.value); setActive(0); }}
                onKeyDown={(e) => onKey(e, close)}
                placeholder={`Search ${sources.length} source${sources.length === 1 ? "" : "s"}`}
                className="ui-focus h-9 w-full rounded-ctl border border-border bg-base pl-8 pr-2.5 text-ui text-text placeholder:text-faint"
                data-source-search=""
              />
            </label>
          </div>
          <div ref={listRef} role="listbox" aria-label="Data sources" className="min-h-0 flex-1 overflow-y-auto py-1">
            {rows.length === 0 && <div className="px-3 py-4 text-caption text-muted">No source matches “{q.trim()}”.</div>}
            {rows.map((r, i) => {
              const first = i === 0 || rows[i - 1].group !== r.group;
              const idx = pickable.indexOf(r);
              const on = r.ds.id === value;
              return (
                <div key={r.ds.id}>
                  {first && <div className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-caps text-muted" data-source-group={r.group}>{GROUP_LABEL[r.group]}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    aria-disabled={r.group === "unsupported" || undefined}
                    disabled={r.group === "unsupported"}
                    data-source-row={r.ds.id}
                    title={r.reason || r.ds.name}
                    onMouseEnter={() => idx >= 0 && setActive(idx)}
                    onClick={() => { onChange(r.ds.id); close(); setQ(""); }}
                    className={cn(
                      "ui-focus-inset flex w-full items-center gap-2.5 px-3 py-2 text-left disabled:cursor-not-allowed",
                      idx === active && r.group !== "unsupported" ? "bg-subtle" : "",
                      r.group === "unsupported" && "opacity-55"
                    )}
                  >
                    <ProviderBadge provider={r.ds.kind} />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-ui", on ? "font-semibold text-text" : "text-text")}>{r.ds.name}</span>
                      <span className="block truncate text-caption text-muted">{r.reason ? "Not available for dashboards yet" : rowDetail(r.ds) || kindLabel(r.ds.kind)}</span>
                    </span>
                    {on && <span className="shrink-0 text-caption font-medium text-brand-ink">Selected</span>}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Popover>
  );
}
