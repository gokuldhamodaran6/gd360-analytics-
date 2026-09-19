import React, { useEffect, useMemo, useState } from "react";
import Plot from "../lib/plotly";
import TopNav from "../components/TopNav";
import { useTheme } from "../api/ThemeContext";
import { connectionKindMeta } from "../components/DataSourceForm";
import { SIGNATURE_COLORS } from "../lib/chartStyle";
import {
  adminApi,
  AdminActivityEvent,
  AdminBreakdowns,
  AdminGrowthPoint,
  AdminStats,
  AdminUsagePoint,
  AdminUserRow,
} from "../api/client";

// This file is the owner-only admin dashboard - it never renders for a
// normal signed-in user (backend/app/routers/admin.py 403s anyone whose
// account isn't the configured owner). Every number on this page is real,
// computed straight from the same tables the product itself writes to -
// nothing here is estimated, simulated, or a placeholder. If a metric
// isn't actually instrumented yet (e.g. AI token spend), it simply isn't
// shown rather than being made up.
//
// Color usage follows the data-viz skill applied elsewhere in this app:
// every single-series magnitude/trend chart (signups, active users, chart
// popularity, the funnel) uses one fixed brand hue - SIGNATURE_COLORS[0].
// Only genuinely categorical charts (action mix, data source kinds) use a
// FIXED multi-color mapping so a given category's color never shifts
// round to round just because the underlying counts changed rank. No
// chart on this page uses two y-axes - see ChartCanvas.tsx / chartStyle.ts
// for why that's a hard rule in this codebase, not just a preference.

const BRAND = SIGNATURE_COLORS[0]; // violet - single-hue magnitude/trend charts
const ACTION_COLORS: Record<string, string> = {
  analyze: SIGNATURE_COLORS[0],
  transform: SIGNATURE_COLORS[1],
};
// Fixed kind -> palette slot so a data source kind's color never depends
// on which kinds happen to be present this round (color follows the
// entity, never its rank - see the data-viz skill's non-negotiables).
const KIND_COLOR: Record<string, string> = {
  postgres: SIGNATURE_COLORS[0],
  mysql: SIGNATURE_COLORS[1],
  mongodb: SIGNATURE_COLORS[2],
  csv: SIGNATURE_COLORS[3],
  excel: SIGNATURE_COLORS[4],
};
const FALLBACK_KIND_COLOR = SIGNATURE_COLORS[5];

// Mirrors ChartCanvas.tsx's THEME_CHROME by design - kept as its own copy
// here rather than importing (that constant isn't exported there, and this
// page's charts are simpler raw Plot calls, not routed through the shared
// chart-style pipeline every Workspace/dashboard chart goes through).
const THEME_CHROME = {
  dark: {
    text: "#E8E8F0",
    muted: "rgba(232, 232, 240, 0.62)",
    grid: "rgba(232, 232, 240, 0.10)",
    axisLine: "rgba(232, 232, 240, 0.18)",
    hoverBg: "#1D1D33",
    hoverBorder: "rgba(232, 232, 240, 0.14)",
  },
  light: {
    text: "#171725",
    muted: "rgba(23, 23, 37, 0.60)",
    grid: "rgba(23, 23, 37, 0.08)",
    axisLine: "rgba(23, 23, 37, 0.16)",
    hoverBg: "#FFFFFF",
    hoverBorder: "rgba(23, 23, 37, 0.12)",
  },
} as const;

const DAY_RANGES = [7, 30, 90] as const;
type DayRange = (typeof DAY_RANGES)[number];

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const d = new Date(value + (value.endsWith("Z") ? "" : "Z"));
  return d.toLocaleString();
}

function timeAgo(value: string | null): string {
  if (!value) return "Never";
  const d = new Date(value + (value.endsWith("Z") ? "" : "Z"));
  const seconds = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// Values on this page stay well within normal comma-formatted range at
// GD360's current scale, but this keeps every stat tile readable if a
// count ever grows into the tens/hundreds of thousands.
function formatStatValue(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

function StatTile({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="card p-5">
      <div className="text-sm text-muted">{label}</div>
      <div className="text-3xl font-extrabold mt-1">{typeof value === "number" ? formatStatValue(value) : value}</div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  fading,
  empty,
  children,
}: {
  title: string;
  subtitle?: string;
  fading?: boolean;
  empty?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`card p-4 transition-opacity duration-300 ${fading ? "opacity-60" : "opacity-100"}`}>
      <div className="mb-2">
        <div className="font-semibold">{title}</div>
        {subtitle && <div className="text-xs text-muted mt-0.5">{subtitle}</div>}
      </div>
      {empty ? (
        <div className="text-muted text-sm py-10 text-center">Not enough data yet.</div>
      ) : (
        children
      )}
    </div>
  );
}

const EVENT_META: Record<AdminActivityEvent["type"], { label: string; color: string }> = {
  signup: { label: "New signup", color: SIGNATURE_COLORS[0] },
  connected_data: { label: "Connected data", color: SIGNATURE_COLORS[1] },
  saved_dashboard: { label: "Saved dashboard", color: SIGNATURE_COLORS[2] },
};

type SortKey = "email" | "created_at" | "prompt_count" | "datasource_count" | "dashboard_count" | "verified_count" | "last_prompt_at";

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export default function AdminDashboard() {
  const { theme } = useTheme();
  const chrome = THEME_CHROME[theme === "dark" ? "dark" : "light"];

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [breakdowns, setBreakdowns] = useState<AdminBreakdowns | null>(null);
  const [feed, setFeed] = useState<AdminActivityEvent[]>([]);
  const [usage, setUsage] = useState<AdminUsagePoint[]>([]);
  const [growth, setGrowth] = useState<AdminGrowthPoint[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshingRange, setRefreshingRange] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);

  const [dayRange, setDayRange] = useState<DayRange>(30);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const loadAll = async (range: DayRange) => {
    const [s, u, b, f, t, g] = await Promise.all([
      adminApi.getStats(),
      adminApi.getUsers(),
      adminApi.getBreakdowns(),
      adminApi.getActivityFeed(30),
      adminApi.getUsageTimeseries(range),
      adminApi.getGrowthTimeseries(range),
    ]);
    setStats(s);
    setUsers(u);
    setBreakdowns(b);
    setFeed(f);
    setUsage(t);
    setGrowth(g);
    setLastLoadedAt(new Date());
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadAll(dayRange);
      } catch (e: any) {
        if (cancelled) return;
        if (e?.response?.status === 403) {
          setError("This dashboard is only visible to the app owner account.");
        } else {
          setError("Could not load admin data right now. Please try again in a moment.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Changing the day range only needs to re-pull the two time-windowed
  // series - refetching everything would flash the KPIs/table/funnel for
  // no reason. The previous chart stays on screen at reduced opacity
  // while the new range loads instead of being cleared to a blank/skeleton
  // state, so the layout never jumps.
  const changeRange = async (range: DayRange) => {
    if (range === dayRange) return;
    setDayRange(range);
    setRefreshingRange(true);
    try {
      const [t, g] = await Promise.all([adminApi.getUsageTimeseries(range), adminApi.getGrowthTimeseries(range)]);
      setUsage(t);
      setGrowth(g);
      setLastLoadedAt(new Date());
    } catch {
      // Leave the previous series on screen - a failed refresh shouldn't
      // blank out data the person could already see.
    } finally {
      setRefreshingRange(false);
    }
  };

  const refreshAll = async () => {
    setRefreshingRange(true);
    try {
      await loadAll(dayRange);
    } catch {
      // Same as above - keep showing the last good data on failure.
    } finally {
      setRefreshingRange(false);
    }
  };

  const filteredSortedUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? users.filter(
          (u) =>
            u.email.toLowerCase().includes(q) ||
            (u.full_name || "").toLowerCase().includes(q) ||
            (u.company || "").toLowerCase().includes(q)
        )
      : users;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let av: string | number = "";
      let bv: string | number = "";
      switch (sortKey) {
        case "email":
          av = a.email.toLowerCase();
          bv = b.email.toLowerCase();
          break;
        case "created_at":
          av = a.created_at || "";
          bv = b.created_at || "";
          break;
        case "last_prompt_at":
          av = a.last_prompt_at || "";
          bv = b.last_prompt_at || "";
          break;
        default:
          av = a[sortKey] as number;
          bv = b[sortKey] as number;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [users, search, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "email" ? "asc" : "desc");
    }
  };

  const sortArrow = (key: SortKey) => (key === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  const exportUsersCsv = () => {
    const headers = ["Email", "Name", "Company", "Signed up", "Prompts", "Data sources", "Dashboards", "Verified checks", "Last active"];
    const rows = filteredSortedUsers.map((u) => [
      u.email,
      u.full_name || "",
      u.company || "",
      u.created_at || "",
      String(u.prompt_count),
      String(u.datasource_count),
      String(u.dashboard_count),
      String(u.verified_count),
      u.last_prompt_at || "",
    ]);
    const csv = [headers, ...rows].map((r) => r.map((c) => csvEscape(String(c))).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `gd360-users-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const baseLayout = {
    autosize: true,
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    font: { color: chrome.text, family: "inherit", size: 12 },
    margin: { l: 44, r: 16, t: 10, b: 40 },
    hoverlabel: { bgcolor: chrome.hoverBg, bordercolor: chrome.hoverBorder, font: { color: chrome.text } },
    showlegend: false,
  };

  const gridAxis = { gridcolor: chrome.grid, linecolor: chrome.axisLine, zeroline: false, color: chrome.muted };

  const funnelStages: { key: keyof AdminStats["funnel"]; label: string }[] = [
    { key: "signed_up", label: "Signed up" },
    { key: "connected_data", label: "Connected data" },
    { key: "ran_a_prompt", label: "Ran a prompt" },
    { key: "saved_a_dashboard", label: "Saved a dashboard" },
  ];

  return (
    <div>
      <TopNav />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-bold">Admin dashboard</h1>
            <p className="text-muted mt-1 text-sm">
              Everything real about how GD360 is being used - owner-only, live from the product database.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {lastLoadedAt && (
              <span className="text-xs text-muted hidden sm:inline">Updated {timeAgo(lastLoadedAt.toISOString())}</span>
            )}
            <button
              onClick={refreshAll}
              disabled={refreshingRange || loading}
              className="text-xs sm:text-sm px-3 py-1.5 rounded-lg border border-border hover:bg-surface2 transition disabled:opacity-50"
            >
              {refreshingRange ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {loading && <div className="text-muted">Loading…</div>}

        {error && !loading && <div className="card p-6 text-center text-muted">{error}</div>}

        {!loading && !error && stats && (
          <>
            {/* KPI row - lifetime + rolling counts, not scoped to the day-range filter below since each one has its own natural window (today/7d/lifetime) baked into its label. */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
              <StatTile label="Total users" value={stats.total_users} sub={`+${stats.new_users_today} today · +${stats.new_users_7d} this week`} />
              <StatTile label="Active this week" value={stats.active_users_7d} sub={`${stats.active_users_today} active today`} />
              <StatTile label="Total prompts" value={stats.total_prompts} sub={`${stats.prompts_today} today · ${stats.prompts_7d} this week`} />
              <StatTile
                label="Avg prompts / active user"
                value={stats.active_users_7d > 0 ? Math.round((stats.prompts_7d / stats.active_users_7d) * 10) / 10 : 0}
                sub="over the last 7 days"
              />
              <StatTile label="Data sources connected" value={stats.total_datasources} />
              <StatTile label="Saved dashboards" value={stats.total_dashboards} />
              <StatTile label="Verify checks run" value={stats.total_verify_checks} sub="'Double-check this' usage" />
              <StatTile
                label="Activation rate"
                value={pct(stats.funnel.saved_a_dashboard, stats.funnel.signed_up)}
                sub="signup → saved a dashboard"
              />
            </div>

            {/* Activation funnel */}
            <ChartCard title="Activation funnel" subtitle="Where new signups drop off, lifetime" empty={stats.funnel.signed_up === 0}>
              <Plot
                data={[
                  {
                    type: "funnel",
                    y: funnelStages.map((s) => s.label),
                    x: funnelStages.map((s) => stats.funnel[s.key]),
                    textinfo: "value+percent initial",
                    marker: { color: BRAND },
                    connector: { line: { color: chrome.grid, width: 1 } },
                  } as any,
                ]}
                layout={{ ...baseLayout, margin: { l: 140, r: 24, t: 10, b: 10 } }}
                style={{ width: "100%", height: 260 }}
                useResizeHandler
                config={{ displaylogo: false, responsive: true }}
              />
            </ChartCard>

            {/* Shared date-range filter - scopes the four trend charts directly below it, exactly the charts whose x-axis is a day, per the dataviz skill's "one row above what it scopes" rule. */}
            <div className="flex items-center gap-2 mt-8 mb-3">
              <span className="text-sm text-muted mr-1">Trends over</span>
              {DAY_RANGES.map((r) => (
                <button
                  key={r}
                  onClick={() => changeRange(r)}
                  className={`text-xs sm:text-sm px-3 py-1.5 rounded-lg border transition ${
                    dayRange === r ? "border-primary bg-primary/10 text-primary font-semibold" : "border-border hover:bg-surface2"
                  }`}
                >
                  {r}d
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
              <ChartCard title="New signups per day" fading={refreshingRange} empty={growth.length === 0}>
                <Plot
                  data={[
                    {
                      x: growth.map((p) => p.day),
                      y: growth.map((p) => p.new_users),
                      type: "bar",
                      marker: { color: BRAND },
                      hovertemplate: "%{x}<br>%{y} new users<extra></extra>",
                    },
                  ]}
                  layout={{ ...baseLayout, xaxis: gridAxis, yaxis: { ...gridAxis, tickformat: "d" } }}
                  style={{ width: "100%", height: 260 }}
                  useResizeHandler
                  config={{ displaylogo: false, responsive: true }}
                />
              </ChartCard>

              <ChartCard title="Total users over time" fading={refreshingRange} empty={growth.length === 0}>
                <Plot
                  data={[
                    {
                      x: growth.map((p) => p.day),
                      y: growth.map((p) => p.cumulative_users),
                      type: "scatter",
                      mode: "lines",
                      line: { color: BRAND, width: 2, shape: "spline" },
                      fill: "tozeroy",
                      fillcolor: `${BRAND}1a`,
                      hovertemplate: "%{x}<br>%{y} total users<extra></extra>",
                    },
                  ]}
                  layout={{ ...baseLayout, xaxis: gridAxis, yaxis: { ...gridAxis, tickformat: "d" } }}
                  style={{ width: "100%", height: 260 }}
                  useResizeHandler
                  config={{ displaylogo: false, responsive: true }}
                />
              </ChartCard>

              <ChartCard title="Prompts per day" subtitle="Analyze vs. transform" fading={refreshingRange} empty={usage.length === 0}>
                <Plot
                  data={[
                    {
                      x: usage.map((p) => p.day),
                      y: usage.map((p) => p.analyze_count),
                      name: "Analyze",
                      type: "bar",
                      marker: { color: ACTION_COLORS.analyze },
                    },
                    {
                      x: usage.map((p) => p.day),
                      y: usage.map((p) => p.transform_count),
                      name: "Transform",
                      type: "bar",
                      marker: { color: ACTION_COLORS.transform },
                    },
                  ]}
                  layout={{
                    ...baseLayout,
                    barmode: "stack",
                    showlegend: true,
                    legend: { orientation: "h", y: -0.2, font: { color: chrome.muted, size: 11 } },
                    xaxis: gridAxis,
                    yaxis: { ...gridAxis, tickformat: "d" },
                  }}
                  style={{ width: "100%", height: 260 }}
                  useResizeHandler
                  config={{ displaylogo: false, responsive: true }}
                />
              </ChartCard>

              <ChartCard title="Active users per day" fading={refreshingRange} empty={usage.length === 0}>
                <Plot
                  data={[
                    {
                      x: usage.map((p) => p.day),
                      y: usage.map((p) => p.active_users),
                      type: "scatter",
                      mode: "lines+markers",
                      line: { color: BRAND, width: 2 },
                      marker: { color: BRAND, size: 6 },
                      hovertemplate: "%{x}<br>%{y} active users<extra></extra>",
                    },
                  ]}
                  layout={{ ...baseLayout, xaxis: gridAxis, yaxis: { ...gridAxis, tickformat: "d" } }}
                  style={{ width: "100%", height: 260 }}
                  useResizeHandler
                  config={{ displaylogo: false, responsive: true }}
                />
              </ChartCard>
            </div>

            {/* Breakdowns */}
            {breakdowns && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
                <ChartCard title="Data sources by type" empty={breakdowns.datasource_kinds.length === 0}>
                  <Plot
                    data={[
                      {
                        type: "pie",
                        hole: 0.55,
                        labels: breakdowns.datasource_kinds.map((k) => connectionKindMeta(k.kind).label),
                        values: breakdowns.datasource_kinds.map((k) => k.count),
                        marker: {
                          colors: breakdowns.datasource_kinds.map((k) => KIND_COLOR[k.kind] || FALLBACK_KIND_COLOR),
                          line: { color: theme === "dark" ? "#13131F" : "#FFFFFF", width: 2 },
                        },
                        textinfo: "label+percent",
                        textfont: { color: chrome.text, size: 11 },
                        hovertemplate: "%{label}<br>%{value} (%{percent})<extra></extra>",
                      } as any,
                    ]}
                    layout={{ ...baseLayout, margin: { l: 10, r: 10, t: 10, b: 10 }, showlegend: true, legend: { font: { color: chrome.muted, size: 11 } } }}
                    style={{ width: "100%", height: 280 }}
                    useResizeHandler
                    config={{ displaylogo: false, responsive: true }}
                  />
                </ChartCard>

                <ChartCard title="Most-used chart types" empty={breakdowns.chart_types.length === 0}>
                  <Plot
                    data={[
                      {
                        type: "bar",
                        orientation: "h",
                        y: [...breakdowns.chart_types].reverse().map((c) => c.chart_type),
                        x: [...breakdowns.chart_types].reverse().map((c) => c.count),
                        marker: { color: BRAND },
                        text: [...breakdowns.chart_types].reverse().map((c) => String(c.count)),
                        textposition: "outside",
                        textfont: { color: chrome.muted, size: 11 },
                        hovertemplate: "%{y}<br>%{x} charts<extra></extra>",
                      } as any,
                    ]}
                    layout={{
                      ...baseLayout,
                      margin: { l: 100, r: 30, t: 10, b: 30 },
                      xaxis: { ...gridAxis, tickformat: "d" },
                      yaxis: { ...gridAxis, automargin: true },
                    }}
                    style={{ width: "100%", height: 280 }}
                    useResizeHandler
                    config={{ displaylogo: false, responsive: true }}
                  />
                </ChartCard>
              </div>
            )}

            {/* Adoption & trust mini-stats */}
            {breakdowns && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
                <div className="card p-5">
                  <div className="font-semibold mb-3">Goku adoption</div>
                  <div className="flex items-end gap-6">
                    <div>
                      <div className="text-2xl font-extrabold">{formatStatValue(breakdowns.goku.total_questions)}</div>
                      <div className="text-xs text-muted mt-1">questions asked</div>
                    </div>
                    <div>
                      <div className="text-2xl font-extrabold">{formatStatValue(breakdowns.goku.users)}</div>
                      <div className="text-xs text-muted mt-1">people who've used it</div>
                    </div>
                  </div>
                </div>
                <div className="card p-5">
                  <div className="font-semibold mb-3">Trust: "Double-check this"</div>
                  <div className="flex items-end gap-6">
                    <div>
                      <div className="text-2xl font-extrabold">{formatStatValue(breakdowns.verification.total_checks)}</div>
                      <div className="text-xs text-muted mt-1">checks run</div>
                    </div>
                    <div>
                      <div className="text-2xl font-extrabold">
                        {pct(breakdowns.verification.messages_ever_verified, breakdowns.verification.verifiable_messages)}
                      </div>
                      <div className="text-xs text-muted mt-1">
                        of eligible answers verified ({breakdowns.verification.messages_ever_verified}/{breakdowns.verification.verifiable_messages})
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Recent activity feed */}
            <div className="card p-4 mb-8">
              <div className="font-semibold mb-3">Recent activity</div>
              {feed.length === 0 ? (
                <div className="text-muted text-sm py-6 text-center">No activity yet.</div>
              ) : (
                <div className="max-h-80 overflow-y-auto -mx-1">
                  {feed.map((event, i) => {
                    const meta = EVENT_META[event.type];
                    return (
                      <div key={i} className="flex items-center gap-3 px-1 py-2 border-b border-border last:border-0">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: meta.color }} />
                        <span className="text-xs font-medium text-muted shrink-0 w-32">{meta.label}</span>
                        <span className="text-sm flex-1 min-w-0 truncate">{event.text}</span>
                        <span className="text-xs text-muted shrink-0">{timeAgo(event.at)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Users table */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div className="font-semibold">
                All users ({filteredSortedUsers.length}
                {filteredSortedUsers.length !== users.length ? ` of ${users.length}` : ""})
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search email, name, company…"
                  className="text-sm px-3 py-1.5 rounded-lg border border-border bg-transparent w-48 sm:w-64"
                />
                <button
                  onClick={exportUsersCsv}
                  className="text-xs sm:text-sm px-3 py-1.5 rounded-lg border border-border hover:bg-surface2 transition whitespace-nowrap"
                >
                  Export CSV
                </button>
              </div>
            </div>
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted border-b border-border select-none">
                    <th className="p-3 cursor-pointer hover:text-fg" onClick={() => toggleSort("email")}>
                      Email{sortArrow("email")}
                    </th>
                    <th className="p-3">Name</th>
                    <th className="p-3">Company</th>
                    <th className="p-3 cursor-pointer hover:text-fg" onClick={() => toggleSort("created_at")}>
                      Signed up{sortArrow("created_at")}
                    </th>
                    <th className="p-3 cursor-pointer hover:text-fg" onClick={() => toggleSort("prompt_count")}>
                      Prompts{sortArrow("prompt_count")}
                    </th>
                    <th className="p-3 cursor-pointer hover:text-fg" onClick={() => toggleSort("datasource_count")}>
                      Data sources{sortArrow("datasource_count")}
                    </th>
                    <th className="p-3 cursor-pointer hover:text-fg" onClick={() => toggleSort("dashboard_count")}>
                      Dashboards{sortArrow("dashboard_count")}
                    </th>
                    <th className="p-3 cursor-pointer hover:text-fg" onClick={() => toggleSort("verified_count")}>
                      Verified{sortArrow("verified_count")}
                    </th>
                    <th className="p-3 cursor-pointer hover:text-fg" onClick={() => toggleSort("last_prompt_at")}>
                      Last active{sortArrow("last_prompt_at")}
                    </th>
                    <th className="p-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSortedUsers.map((u) => {
                    const activeThisWeek =
                      !!u.last_prompt_at &&
                      Date.now() - new Date(u.last_prompt_at + (u.last_prompt_at.endsWith("Z") ? "" : "Z")).getTime() < 7 * 24 * 60 * 60 * 1000;
                    return (
                      <tr key={u.id} className="border-b border-border last:border-0">
                        <td className="p-3">{u.email}</td>
                        <td className="p-3">{u.full_name || "—"}</td>
                        <td className="p-3">{u.company || "—"}</td>
                        <td className="p-3 whitespace-nowrap">{formatDate(u.created_at)}</td>
                        <td className="p-3 font-semibold">{u.prompt_count}</td>
                        <td className="p-3">{u.datasource_count}</td>
                        <td className="p-3">{u.dashboard_count}</td>
                        <td className="p-3">{u.verified_count}</td>
                        <td className="p-3 whitespace-nowrap">{formatDate(u.last_prompt_at)}</td>
                        <td className="p-3">
                          <span
                            className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full ${
                              activeThisWeek ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-surface2 text-muted"
                            }`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${activeThisWeek ? "bg-green-500" : "bg-muted"}`} />
                            {activeThisWeek ? "Active" : "Inactive"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredSortedUsers.length === 0 && (
                    <tr>
                      <td colSpan={10} className="p-6 text-center text-muted">
                        No users match "{search}".
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
