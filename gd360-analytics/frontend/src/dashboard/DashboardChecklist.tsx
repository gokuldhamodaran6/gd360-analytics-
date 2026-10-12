// 2026-10-12 (round 35b): choose dashboards to merge - "New dashboard → Merge existing dashboards"
// and "Merge a dashboard in" on an empty page. Checked dashboards are numbered in the order they
// were picked: that is the page order of the result. Classic boards can't be merged until upgraded.
import { useEffect, useMemo, useState } from "react";
import { dashboardApi, type DashboardSummary } from "../api/client";
import { SearchIcon, cn } from "../ui";
import { relativeTime } from "./runState";

const MODE: Record<string, string> = { live: "Live", file: "Uploaded file", mixed: "Live + file" };

export function DashboardChecklist({
  value, onChange, exclude = [], max = 12, onLoaded,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  exclude?: string[];
  max?: number;
  onLoaded?: (all: DashboardSummary[]) => void;
}) {
  const [all, setAll] = useState<DashboardSummary[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    let cancelled = false;
    dashboardApi.list().then((ds) => { if (!cancelled) { setAll(ds); onLoaded?.(ds); } }).catch(() => { if (!cancelled) setAll([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (all || [])
      .filter((d) => d.layout_version === 2 && !exclude.includes(d.id))
      .filter((d) => !t || d.name.toLowerCase().includes(t) || (d.sources || []).some((s) => s.name.toLowerCase().includes(t)));
  }, [all, q, exclude]);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : value.length >= max ? value : [...value, id]);

  return (
    <div className="flex flex-col gap-2" data-dashboard-checklist="">
      <label className="relative block">
        <span className="sr-only">Search dashboards</span>
        <SearchIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search dashboards"
          className="ui-focus h-9 w-full rounded-ctl border border-border bg-base pl-8 pr-2.5 text-ui text-text placeholder:text-faint"
        />
      </label>
      <div className="max-h-[300px] overflow-y-auto rounded-ctl border border-border" role="group" aria-label="Dashboards">
        {all === null && <div className="px-3 py-4 text-caption text-muted">Loading dashboards…</div>}
        {all !== null && rows.length === 0 && <div className="px-3 py-4 text-caption text-muted">{q.trim() ? `No dashboard matches “${q.trim()}”.` : "No other dashboards to merge yet."}</div>}
        {rows.map((d) => {
          const at = value.indexOf(d.id);
          const on = at >= 0;
          const src = d.sources || [];
          return (
            <label
              key={d.id}
              data-merge-row={d.id}
              className={cn("flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0", on ? "bg-kind-dashboard-fill/60" : "hover:bg-subtle")}
            >
              <input type="checkbox" checked={on} onChange={() => toggle(d.id)} className="h-4 w-4 accent-[rgb(var(--color-kind-dashboard))]" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui font-medium text-text" title={d.name}>{d.name}</span>
                <span className="truncate text-caption text-muted">
                  {[`${d.page_count || 1} page${(d.page_count || 1) === 1 ? "" : "s"}`, `${d.block_count || 0} blocks`, src.length ? src.map((s) => s.name).join(" + ") : null, d.data_mode ? MODE[d.data_mode] : null, relativeTime(d.updated_at || d.created_at) ? `updated ${relativeTime(d.updated_at || d.created_at)}` : null].filter(Boolean).join(" · ")}
                </span>
              </span>
              {on && <span aria-label={`Order ${at + 1}`} className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-kind-dashboard text-[11px] font-bold text-[rgb(var(--color-base))]">{at + 1}</span>}
            </label>
          );
        })}
      </div>
    </div>
  );
}
