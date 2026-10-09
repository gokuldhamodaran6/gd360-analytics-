// 2026-10-09 (round 15): "Every channel, side by side" on the Space page -
// one row per marketing source, filter chips for the groups present, and
// sortable column headers (aria-sort). Empty cells read "—"; the table
// scrolls sideways inside its own box on a phone.
import { useMemo, useState } from "react";
import BrandTile from "../components/BrandTile";
import type { OverviewChannel } from "../api/spaces";
import { compact, money, pct, signedPct, times } from "./format";

type SortKey = "audience" | "audience_growth_pct" | "reach" | "engagement_rate" | "clicks" | "spend" | "revenue" | "roas";

const COLUMNS: { key: SortKey; label: string; render: (c: OverviewChannel) => string }[] = [
  { key: "audience", label: "Audience", render: (c) => compact(c.audience) },
  { key: "audience_growth_pct", label: "Growth", render: (c) => signedPct(c.audience_growth_pct) },
  { key: "reach", label: "Reach", render: (c) => compact(c.reach) },
  { key: "engagement_rate", label: "Engagement", render: (c) => pct(c.engagement_rate) },
  { key: "clicks", label: "Clicks to site", render: (c) => compact(c.clicks) },
  { key: "spend", label: "Spend", render: (c) => money(c.spend) },
  { key: "revenue", label: "Revenue", render: (c) => money(c.revenue) },
  { key: "roas", label: "ROAS", render: (c) => times(c.roas) },
];

const GROUP_ORDER: OverviewChannel["group"][] = ["Organic", "Paid", "Search", "Web", "Store", "Email"];

export function chipClass(on: boolean): string {
  return `ui-focus inline-flex items-center h-8 px-3 rounded-full border text-ui transition-colors ${
    on ? "border-tint-border bg-tint text-text" : "border-border bg-surface text-secondary hover:text-text"
  }`;
}

export default function ChannelTable({ channels }: { channels: OverviewChannel[] }) {
  const [group, setGroup] = useState<"All" | OverviewChannel["group"]>("All");
  const [sort, setSort] = useState<SortKey>("reach");
  const [dir, setDir] = useState<1 | -1>(-1);

  const groups = useMemo(() => GROUP_ORDER.filter((g) => channels.some((c) => c.group === g)), [channels]);
  const activeGroup = group !== "All" && !groups.includes(group) ? "All" : group;

  const rows = useMemo(() => {
    const list = channels.filter((c) => activeGroup === "All" || c.group === activeGroup);
    return [...list].sort((a, b) => {
      const x = a[sort];
      const y = b[sort];
      if (x == null && y == null) return a.name.localeCompare(b.name);
      if (x == null) return 1; // empty cells always last
      if (y == null) return -1;
      return (x - y) * dir;
    });
  }, [channels, activeGroup, sort, dir]);

  const pickSort = (k: SortKey) => {
    if (k === sort) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSort(k);
      setDir(-1);
    }
  };

  return (
    <section className="rounded-card border border-border bg-surface p-4 sm:p-5 flex flex-col gap-3 min-w-0" aria-labelledby="space-channels-h">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 id="space-channels-h" className="m-0 text-section font-semibold text-text">Every channel, side by side</h2>
        {groups.length > 1 && (
          <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Show channels">
            {(["All", ...groups] as const).map((g) => (
              <button key={g} type="button" className={chipClass(activeGroup === g)} aria-pressed={activeGroup === g} onClick={() => setGroup(g)}>
                {g}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full min-w-[880px] border-collapse tabular-nums">
          <thead>
            <tr>
              <th scope="col" className="text-left px-3 py-2.5 text-caption font-medium text-muted border-b border-border whitespace-nowrap">Channel</th>
              {COLUMNS.map((c) => {
                const on = sort === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={on ? (dir === 1 ? "ascending" : "descending") : "none"}
                    className="text-right px-3 py-2.5 text-caption font-medium border-b border-border whitespace-nowrap"
                  >
                    <button type="button" onClick={() => pickSort(c.key)} className={`ui-focus rounded-sm ${on ? "text-text" : "text-muted hover:text-text"}`}>
                      {c.label}
                      <span aria-hidden="true">{on ? (dir === 1 ? " ↑" : " ↓") : ""}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.source_id} className="border-b border-border last:border-0 hover:bg-subtle/60">
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <span className="flex items-center gap-2.5">
                    <BrandTile kind={r.kind} name={r.name} size={26} />
                    <span className="flex flex-col min-w-0">
                      <span className="text-ui font-medium text-text truncate max-w-[220px]" title={r.name}>{r.name}</span>
                      <span className="text-caption text-muted">{r.group} · {r.label}</span>
                    </span>
                  </span>
                </td>
                {COLUMNS.map((c) => {
                  const growth = c.key === "audience_growth_pct" && r.audience_growth_pct != null;
                  const tone = growth ? (r.audience_growth_pct! > 0 ? "text-good" : r.audience_growth_pct! < 0 ? "text-danger" : "text-text") : r[c.key] == null ? "text-faint" : "text-text";
                  return (
                    <td
                      key={c.key}
                      className={`px-3 py-2.5 text-right font-mono text-[13px] whitespace-nowrap ${tone}`}
                      title={growth && r.audience_growth != null ? `${r.audience_growth >= 0 ? "+" : ""}${r.audience_growth.toLocaleString("en-US")} followers` : undefined}
                    >
                      {c.render(r)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
