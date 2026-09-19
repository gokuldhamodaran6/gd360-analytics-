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
//
// Every chart's Plotly modebar (the floating camera/zoom/box-select
// toolbar) is switched off via config={{ displayModeBar: false }} - it
// used to appear on hover and sit on top of the bars/lines, which read as
// a stray gray box rather than a control. Data labels are shown directly
// on each chart instead (see the per-chart "showLabels" threshold below),
// which is the more PowerBI-style, glanceable way to read a value without
// needing to hover anything.
//
// This round (2026-09-19, "elite/premium" polish pass, reference: Google
// AI Studio's own usage dashboard): every chart's `dragmode` is switched
// off (baseLayout.dragmode = false) so hovering a chart shows only the
// normal pointer cursor - Plotly's built-in click-drag zoom/pan cursor
// (a crosshair/magnifying icon) was still active even with the modebar
// hidden, which is the odd cursor this fixes. Vertical (category-axis)
// gridlines are removed from every trend chart - only the value axis
// keeps a light horizontal grid (see axisBase/valueAxis/categoryAxis
// below) - and bars get the same rounded corners + breathing room
// chartStyle.ts already gives every chart elsewhere in the app, so this
// page's chart chrome matches the rest of the product, not just looks
// generically "nicer". "Most-used chart types" is now a scrollable ranked
// table instead of a bar chart (same slot, same place in the grid) so a
// longer chart-type list never needs more colors or crowds the page. A
// new "Prompts per active user, per day" trend chart answers "how many
// prompts does a typical active user send in a day" honestly - each
// day's own prompt-count / active-user ratio, never a distinct-user count
// pooled across multiple days, which nothing already on this page can
// compute (see bucketPromptsPerUser's own note). The users table also
// gained its own "Last active" day-range filter (Today/7d/30d/90d),
// independent of search and sort, so a specific window's worth of usage
// can be isolated at a glance.

const BRAND = SIGNATURE_COLORS[0]; // violet - single-hue magnitude/trend charts
const ACTION_COLORS: Record<string, string> = {
  analyze: SIGNATURE_COLORS[0],
  transform: SIGNATURE_COLORS[1],
};
// Fixed kind -> palette slot so a data source kind's color never depends
// on which kinds happen to be present this round (color follows the
// entity, never its rank - see the data-viz skill's non-negotiables).
// All 8 SIGNATURE_COLORS are now spoken for by the app's 8 real kinds, so
// FALLBACK_KIND_COLOR below (a plain neutral gray, not one of the 8) is
// reserved only for a genuinely unknown/future kind, never reused from
// this fixed list.
const KIND_COLOR: Record<string, string> = {
  postgres: SIGNATURE_COLORS[0],
  mysql: SIGNATURE_COLORS[1],
  mongodb: SIGNATURE_COLORS[2],
  sqlserver: SIGNATURE_COLORS[3],
  supabase: SIGNATURE_COLORS[4],
  bigquery: SIGNATURE_COLORS[5],
  csv: SIGNATURE_COLORS[6],
  excel: SIGNATURE_COLORS[7],
};
const FALLBACK_KIND_COLOR = "#94A3B8";

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

// Compact form used inside the users table so every column fits without a
// horizontal scrollbar - the full date+time is still one hover away via
// each cell's title attribute (formatDate above).
function formatDateCompact(value: string | null): string {
  if (!value) return "Never";
  const d = new Date(value + (value.endsWith("Z") ? "" : "Z"));
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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

// Plotly picks its own y-axis tick spacing, and with small counts (0, 1,
// 2...) it often lands on a fractional step like 0.5 - combined with this
// page's tickformat: "d" (whole numbers only), that renders as the same
// integer twice in a row (e.g. "1, 1, 0, 0"). Forcing a whole-number
// dtick sized to the data's own range avoids that once and for all.
function integerDtick(values: number[]): number {
  const max = values.length ? Math.max(...values) : 1;
  return Math.max(1, Math.ceil(max / 5));
}

// ---------------------------------------------------------------------
// Per-chart Day / Week / Month grouping - independent from the shared
// 7d/30d/90d "Trends over" filter above the chart row. That filter picks
// how much history is fetched; this toggle picks how the days already on
// screen are grouped, box by box, exactly like a PowerBI visual's own
// field well. Each of the four trend charts keeps its own granularity
// state, so one chart can sit on "Week" while another stays on "Day".
// ---------------------------------------------------------------------
type Granularity = "daily" | "weekly" | "monthly";
const GRANULARITIES: { key: Granularity; label: string }[] = [
  { key: "daily", label: "Day" },
  { key: "weekly", label: "Week" },
  { key: "monthly", label: "Month" },
];

// The bucket key for a "YYYY-MM-DD" day string: itself for "daily", the
// Monday (UTC) that starts its week for "weekly", or its "YYYY-MM" for
// "monthly". Used only to group points together - bucketLabelForKey below
// is what actually gets displayed on the axis.
function bucketKeyForDay(day: string, granularity: Granularity): string {
  if (granularity === "daily") return day;
  const d = new Date(`${day}T00:00:00Z`);
  if (granularity === "monthly") {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const weekday = d.getUTCDay(); // 0 = Sunday
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  d.setUTCDate(d.getUTCDate() + mondayOffset);
  return d.toISOString().slice(0, 10);
}

function bucketLabelForKey(key: string, granularity: Granularity): string {
  if (granularity === "daily") {
    return new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  if (granularity === "monthly") {
    const [y, m] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  const weekStart = new Date(`${key}T00:00:00Z`);
  return `Wk of ${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

// Re-buckets the daily growth series (new signups + running total) into
// weekly/monthly points. "new_users" SUMS across the bucket - a true
// count of how many people joined that period. "cumulative_users" takes
// the LAST day's running total in the bucket instead - the real total as
// of that period's end - since summing a running total would be
// meaningless.
function bucketGrowth(points: AdminGrowthPoint[], granularity: Granularity) {
  if (granularity === "daily") {
    return points.map((p) => ({ key: p.day, label: bucketLabelForKey(p.day, "daily"), new_users: p.new_users, cumulative_users: p.cumulative_users }));
  }
  const map = new Map<string, { new_users: number; cumulative_users: number }>();
  for (const p of points) {
    const key = bucketKeyForDay(p.day, granularity);
    const cur = map.get(key) || { new_users: 0, cumulative_users: 0 };
    cur.new_users += p.new_users;
    cur.cumulative_users = p.cumulative_users; // days arrive in ascending order, so the last write is the bucket's true end-of-period total
    map.set(key, cur);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, v]) => ({ key, label: bucketLabelForKey(key, granularity), ...v }));
}

// Re-buckets the daily usage series (prompts split by action + active
// users). Prompt counts SUM across the bucket - a real total for that
// period. Active users is instead AVERAGED per day within the bucket -
// summing daily active-user counts across a week would double-count
// anyone active on more than one day, which isn't a real number. The
// chart's own subtitle says "avg active users per day" whenever this
// averaging is in effect, so it's never silently misleading.
function bucketUsage(points: AdminUsagePoint[], granularity: Granularity) {
  if (granularity === "daily") {
    return points.map((p) => ({
      key: p.day,
      label: bucketLabelForKey(p.day, "daily"),
      analyze_count: p.analyze_count,
      transform_count: p.transform_count,
      active_users: p.active_users,
    }));
  }
  const map = new Map<string, { analyze: number; transform: number; activeSum: number; n: number }>();
  for (const p of points) {
    const key = bucketKeyForDay(p.day, granularity);
    const cur = map.get(key) || { analyze: 0, transform: 0, activeSum: 0, n: 0 };
    cur.analyze += p.analyze_count;
    cur.transform += p.transform_count;
    cur.activeSum += p.active_users;
    cur.n += 1;
    map.set(key, cur);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, v]) => ({
      key,
      label: bucketLabelForKey(key, granularity),
      analyze_count: v.analyze,
      transform_count: v.transform,
      active_users: Math.round((v.activeSum / v.n) * 10) / 10,
    }));
}

// Re-buckets the daily usage series into "prompts per active user, per
// day" - each day's own prompt count (p.count) divided by that same day's
// distinct active-user count (0 whenever nobody was active that day, since
// a day with zero active users also has zero prompts). For weekly/monthly
// grouping this AVERAGES that daily ratio across the bucket's days, rather
// than dividing the bucket's total prompts by some pooled distinct-user
// count spanning multiple days - this app has no way to compute a real
// distinct-active-user count across more than one day from data already on
// screen (the same reason bucketUsage above averages active_users instead
// of summing it), so averaging the daily ratio is the only honest way to
// show this at a coarser grain. The chart's own subtitle says so whenever
// that averaging is in effect.
function bucketPromptsPerUser(points: AdminUsagePoint[], granularity: Granularity) {
  const dailyRatios = points.map((p) => ({
    day: p.day,
    ratio: p.active_users > 0 ? Math.round((p.count / p.active_users) * 100) / 100 : 0,
  }));
  if (granularity === "daily") {
    return dailyRatios.map((p) => ({ key: p.day, label: bucketLabelForKey(p.day, "daily"), value: p.ratio }));
  }
  const map = new Map<string, { sum: number; n: number }>();
  for (const p of dailyRatios) {
    const key = bucketKeyForDay(p.day, granularity);
    const cur = map.get(key) || { sum: 0, n: 0 };
    cur.sum += p.ratio;
    cur.n += 1;
    map.set(key, cur);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, v]) => ({ key, label: bucketLabelForKey(key, granularity), value: Math.round((v.sum / v.n) * 100) / 100 }));
}

function GranularityToggle({ value, onChange }: { value: Granularity; onChange: (g: Granularity) => void }) {
  return (
    <div className="flex items-center gap-1 shrink-0">
      {GRANULARITIES.map((g) => (
        <button
          key={g.key}
          onClick={() => onChange(g.key)}
          className={`text-[10px] sm:text-xs px-2 py-1 rounded-md border transition ${
            value === g.key ? "border-primary bg-primary/10 text-primary font-semibold" : "border-border hover:bg-surface2 text-muted"
          }`}
        >
          {g.label}
        </button>
      ))}
    </div>
  );
}

function StatTile({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="card p-5 transition-colors duration-200 hover:border-primary/25">
      <div className="text-sm text-muted">{label}</div>
      <div className="text-3xl font-extrabold mt-1">{typeof value === "number" ? formatStatValue(value) : value}</div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}

// The one KPI tile that carries its own filter buttons, built in - a
// direct answer to "active users, but let me pick the window myself"
// without needing a whole extra chart. Sits where "Saved dashboards" used
// to (that count is still visible in the activation funnel below, as the
// "Saved a dashboard" stage).
const ACTIVE_TILE_RANGES: { key: "today" | "7d" | "30d"; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

function ActiveUsersRangeTile({ stats }: { stats: AdminStats }) {
  const [range, setRange] = useState<"today" | "7d" | "30d">("7d");
  const value = range === "today" ? stats.active_users_today : range === "7d" ? stats.active_users_7d : stats.active_users_30d;
  const subLabel = range === "today" ? "sent a prompt today" : `sent a prompt in the last ${range}`;
  return (
    <div className="card p-5 transition-colors duration-200 hover:border-primary/25">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm text-muted">Active users</div>
        <div className="flex items-center gap-1">
          {ACTIVE_TILE_RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`text-[10px] px-1.5 py-0.5 rounded border transition ${
                range === r.key ? "border-primary bg-primary/10 text-primary font-semibold" : "border-border hover:bg-surface2 text-muted"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="text-3xl font-extrabold mt-1">{formatStatValue(value)}</div>
      <div className="text-xs text-muted mt-1">{subLabel}</div>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  controls,
  fading,
  empty,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  controls?: React.ReactNode;
  fading?: boolean;
  empty?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`card p-4 transition-all duration-300 hover:border-primary/25 ${fading ? "opacity-60" : "opacity-100"} ${
        className || ""
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="font-semibold">{title}</div>
          {subtitle && <div className="text-xs text-muted mt-0.5">{subtitle}</div>}
        </div>
        {controls}
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

type SortKey = "email" | "created_at" | "prompt_count" | "datasource_count" | "verified_count" | "last_prompt_at";

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

// A day-range filter on the users table itself, independent of search and
// sort - "how does each user's usage look within a specific window" rather
// than "find this one person". Filters by last_prompt_at, the same field
// the table's own "Active/Inactive this week" badge already reads, so
// "Active within: 7d" and a green "Active" badge always agree with each
// other. "Today" matches the backend's own UTC-calendar-day definition
// (see admin.py's today_start) so it means the same thing as the "Active
// today" KPI tile above, not a rolling 24 hours.
type UserDateFilter = "all" | "today" | "7d" | "30d" | "90d";
const USER_DATE_FILTERS: { key: UserDateFilter; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "today", label: "Today" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "90d", label: "90d" },
];

function isWithinUserDateFilter(lastPromptAt: string | null, filter: UserDateFilter): boolean {
  if (filter === "all") return true;
  if (!lastPromptAt) return false;
  const d = new Date(lastPromptAt + (lastPromptAt.endsWith("Z") ? "" : "Z"));
  if (filter === "today") {
    const now = new Date();
    const utcTodayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return d.getTime() >= utcTodayStart;
  }
  const days = filter === "7d" ? 7 : filter === "30d" ? 30 : 90;
  return Date.now() - d.getTime() < days * 24 * 60 * 60 * 1000;
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
  const [userDateFilter, setUserDateFilter] = useState<UserDateFilter>("all");

  // Each trend chart's own Day/Week/Month grouping - see the bucketing
  // helpers above. Independent per chart, on purpose.
  const [signupsGranularity, setSignupsGranularity] = useState<Granularity>("daily");
  const [totalUsersGranularity, setTotalUsersGranularity] = useState<Granularity>("daily");
  const [promptsGranularity, setPromptsGranularity] = useState<Granularity>("daily");
  const [activeUsersGranularity, setActiveUsersGranularity] = useState<Granularity>("daily");
  const [promptsPerUserGranularity, setPromptsPerUserGranularity] = useState<Granularity>("daily");

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
    const filtered = users.filter((u) => {
      const matchesSearch =
        !q ||
        u.email.toLowerCase().includes(q) ||
        (u.full_name || "").toLowerCase().includes(q) ||
        (u.company || "").toLowerCase().includes(q);
      return matchesSearch && isWithinUserDateFilter(u.last_prompt_at, userDateFilter);
    });
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
  }, [users, search, sortKey, sortDir, userDateFilter]);

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
    const headers = ["Email", "Name", "Company", "Signed up", "Prompts", "Data sources", "Verified checks", "Last active"];
    const rows = filteredSortedUsers.map((u) => [
      u.email,
      u.full_name || "",
      u.company || "",
      u.created_at || "",
      String(u.prompt_count),
      String(u.datasource_count),
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
    // Disables Plotly's built-in click-drag zoom/pan/select layer so
    // hovering any chart shows only the normal pointer cursor - the
    // crosshair/zoom cursor this replaces was still reachable even with
    // the modebar hidden, since dragmode defaults on regardless. Hover
    // tooltips work exactly the same with dragmode off; only click-drag
    // interaction (the only thing the hidden modebar buttons controlled
    // anyway) is disabled.
    dragmode: false as const,
  };

  // Only the value axis carries a light horizontal grid; the category axis
  // (dates/buckets along the bottom of every trend chart) stays clean, with
  // no vertical gridlines crossing the bars/lines - the "clarity" look of a
  // polished analytics dashboard, applied consistently across every chart
  // on this page.
  const axisBase = { linecolor: chrome.axisLine, zeroline: false, color: chrome.muted };
  const valueAxis = { ...axisBase, gridcolor: chrome.grid, showgrid: true };
  const categoryAxis = { ...axisBase, showgrid: false };

  // Plotly's own floating modebar (camera/zoom/box-select) is switched
  // off on every chart on this page - see the header comment for why.
  const plotConfig = { displayModeBar: false, responsive: true } as const;

  const funnelStages: { key: keyof AdminStats["funnel"]; label: string }[] = [
    { key: "signed_up", label: "Signed up" },
    { key: "connected_data", label: "Connected data" },
    { key: "ran_a_prompt", label: "Ran a prompt" },
    { key: "saved_a_dashboard", label: "Saved a dashboard" },
  ];

  // Bucketed series for the four trend charts, each independent per its
  // own granularity toggle.
  const signupsBuckets = useMemo(() => bucketGrowth(growth, signupsGranularity), [growth, signupsGranularity]);
  const totalUsersBuckets = useMemo(() => bucketGrowth(growth, totalUsersGranularity), [growth, totalUsersGranularity]);
  const promptsBuckets = useMemo(() => bucketUsage(usage, promptsGranularity), [usage, promptsGranularity]);
  const activeUsersBuckets = useMemo(() => bucketUsage(usage, activeUsersGranularity), [usage, activeUsersGranularity]);
  const promptsPerUserBuckets = useMemo(
    () => bucketPromptsPerUser(usage, promptsPerUserGranularity),
    [usage, promptsPerUserGranularity]
  );

  // Ranked-table bars on "Most-used chart types" are sized relative to the
  // single most-used chart type, so the longest bar always reads as "100%
  // of the leader" rather than against some fixed scale.
  const maxChartTypeCount = useMemo(
    () => Math.max(1, ...(breakdowns?.chart_types.map((c) => c.count) || [1])),
    [breakdowns]
  );

  // Past this many bars/points, a direct data label on every one of them
  // would just overlap into noise - the dataviz rule this app already
  // follows elsewhere ("selective direct labels, never a number on every
  // point"). Below the threshold every value is labeled; at or above it,
  // line charts fall back to labeling just their most recent point.
  const signupsShowLabels = signupsBuckets.length > 0 && signupsBuckets.length <= 14;
  const totalUsersLabelAll = totalUsersBuckets.length > 0 && totalUsersBuckets.length <= 10;
  const promptsShowLabels = promptsBuckets.length > 0 && promptsBuckets.length <= 10;
  const activeUsersLabelAll = activeUsersBuckets.length > 0 && activeUsersBuckets.length <= 10;
  const promptsPerUserLabelAll = promptsPerUserBuckets.length > 0 && promptsPerUserBuckets.length <= 10;

  return (
    <div className="admin-dashboard">
      {/* Plotly still paints its own hover-only drag layer with a CSS
          class it calls "cursor-crosshair" even with dragmode switched
          off above (dragmode:false stops the actual click-drag zoom/pan,
          but Plotly's cursor logic doesn't special-case "false" - it just
          isn't 'pan', so it still picks the crosshair cursor). This is the
          other half of that fix: force the normal pointer back on, scoped
          to this page only via the .admin-dashboard wrapper so it can
          never affect any other chart elsewhere in the app. */}
      <style>{`
        .admin-dashboard .js-plotly-plot .cursor-crosshair {
          cursor: default !important;
        }
      `}</style>
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
              <ActiveUsersRangeTile stats={stats} />
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
                config={plotConfig}
              />
            </ChartCard>

            {/* Shared date-range filter - scopes the four trend charts directly below it, exactly the charts whose x-axis is a day, per the dataviz skill's "one row above what it scopes" rule. Each chart card below also has its own Day/Week/Month grouping toggle, independent of this one. */}
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
              <ChartCard
                title="New signups per day"
                controls={<GranularityToggle value={signupsGranularity} onChange={setSignupsGranularity} />}
                fading={refreshingRange}
                empty={signupsBuckets.length === 0}
              >
                <Plot
                  data={[
                    {
                      x: signupsBuckets.map((p) => p.label),
                      y: signupsBuckets.map((p) => p.new_users),
                      type: "bar",
                      marker: { color: BRAND, cornerradius: 6 },
                      hovertemplate: "%{x}<br>%{y} new users<extra></extra>",
                      ...(signupsShowLabels
                        ? {
                            text: signupsBuckets.map((p) => String(p.new_users)),
                            textposition: "outside" as const,
                            textfont: { color: chrome.muted, size: 10 },
                          }
                        : {}),
                    },
                  ]}
                  layout={{
                    ...baseLayout,
                    margin: { ...baseLayout.margin, t: signupsShowLabels ? 26 : baseLayout.margin.t },
                    bargap: 0.42,
                    xaxis: categoryAxis,
                    yaxis: {
                      ...valueAxis,
                      tickformat: "d",
                      rangemode: "tozero",
                      dtick: integerDtick(signupsBuckets.map((p) => p.new_users)),
                    },
                  }}
                  style={{ width: "100%", height: 260 }}
                  useResizeHandler
                  config={plotConfig}
                />
              </ChartCard>

              <ChartCard
                title="Total users over time"
                controls={<GranularityToggle value={totalUsersGranularity} onChange={setTotalUsersGranularity} />}
                fading={refreshingRange}
                empty={totalUsersBuckets.length === 0}
              >
                <Plot
                  data={[
                    {
                      x: totalUsersBuckets.map((p) => p.label),
                      y: totalUsersBuckets.map((p) => p.cumulative_users),
                      type: "scatter",
                      mode: totalUsersLabelAll ? "lines+markers+text" : "lines",
                      line: { color: BRAND, width: 2, shape: "spline" },
                      marker: { color: BRAND, size: 6 },
                      fill: "tozeroy",
                      fillcolor: `${BRAND}1a`,
                      // Plotly clips a scatter trace's text/markers right at
                      // the plot's edge by default (cliponaxis defaults to
                      // true) - with no bar-style half-category padding on a
                      // line chart, the first/last point sits flush against
                      // that edge, so its label used to render half-cut-off.
                      cliponaxis: false,
                      ...(totalUsersLabelAll
                        ? {
                            text: totalUsersBuckets.map((p) => String(p.cumulative_users)),
                            textposition: "top center" as const,
                            textfont: { color: chrome.muted, size: 10 },
                          }
                        : {}),
                      hovertemplate: "%{x}<br>%{y} total users<extra></extra>",
                    },
                    ...(!totalUsersLabelAll && totalUsersBuckets.length > 0
                      ? [
                          {
                            x: [totalUsersBuckets[totalUsersBuckets.length - 1].label],
                            y: [totalUsersBuckets[totalUsersBuckets.length - 1].cumulative_users],
                            type: "scatter" as const,
                            mode: "markers+text" as const,
                            text: [String(totalUsersBuckets[totalUsersBuckets.length - 1].cumulative_users)],
                            textposition: "top center" as const,
                            textfont: { color: chrome.text, size: 11 },
                            marker: { color: BRAND, size: 8 },
                            cliponaxis: false,
                            hoverinfo: "skip" as const,
                            showlegend: false,
                          },
                        ]
                      : []),
                  ]}
                  layout={{
                    ...baseLayout,
                    xaxis: categoryAxis,
                    yaxis: { ...valueAxis, tickformat: "d", dtick: integerDtick(totalUsersBuckets.map((p) => p.cumulative_users)) },
                  }}
                  style={{ width: "100%", height: 260 }}
                  useResizeHandler
                  config={plotConfig}
                />
              </ChartCard>

              <ChartCard
                title="Prompts per day"
                subtitle="Analyze vs. transform"
                controls={<GranularityToggle value={promptsGranularity} onChange={setPromptsGranularity} />}
                fading={refreshingRange}
                empty={promptsBuckets.length === 0}
              >
                <Plot
                  data={[
                    {
                      x: promptsBuckets.map((p) => p.label),
                      y: promptsBuckets.map((p) => p.analyze_count),
                      name: "Analyze",
                      type: "bar",
                      marker: { color: ACTION_COLORS.analyze, cornerradius: 6 },
                      ...(promptsShowLabels
                        ? {
                            text: promptsBuckets.map((p) => (p.analyze_count > 0 ? String(p.analyze_count) : "")),
                            textposition: "inside" as const,
                            textfont: { color: "#FFFFFF", size: 10 },
                          }
                        : {}),
                    },
                    {
                      x: promptsBuckets.map((p) => p.label),
                      y: promptsBuckets.map((p) => p.transform_count),
                      name: "Transform",
                      type: "bar",
                      marker: { color: ACTION_COLORS.transform, cornerradius: 6 },
                      ...(promptsShowLabels
                        ? {
                            text: promptsBuckets.map((p) => (p.transform_count > 0 ? String(p.transform_count) : "")),
                            textposition: "inside" as const,
                            textfont: { color: "#FFFFFF", size: 10 },
                          }
                        : {}),
                    },
                  ]}
                  layout={{
                    ...baseLayout,
                    barmode: "stack",
                    bargap: 0.28,
                    showlegend: true,
                    legend: { orientation: "h", y: -0.2, font: { color: chrome.muted, size: 11 } },
                    xaxis: categoryAxis,
                    yaxis: {
                      ...valueAxis,
                      tickformat: "d",
                      dtick: integerDtick(promptsBuckets.map((p) => p.analyze_count + p.transform_count)),
                    },
                  }}
                  style={{ width: "100%", height: 260 }}
                  useResizeHandler
                  config={plotConfig}
                />
              </ChartCard>

              <ChartCard
                title="Active users per day"
                subtitle={activeUsersGranularity !== "daily" ? "Avg active users per day in each period" : undefined}
                controls={<GranularityToggle value={activeUsersGranularity} onChange={setActiveUsersGranularity} />}
                fading={refreshingRange}
                empty={activeUsersBuckets.length === 0}
              >
                <Plot
                  data={[
                    {
                      x: activeUsersBuckets.map((p) => p.label),
                      y: activeUsersBuckets.map((p) => p.active_users),
                      type: "scatter",
                      mode: activeUsersLabelAll ? "lines+markers+text" : "lines+markers",
                      line: { color: BRAND, width: 2, shape: "spline" },
                      marker: { color: BRAND, size: 6 },
                      // See the "Total users over time" chart's own note above
                      // on why this is needed - the first/last point's label
                      // otherwise clips against the plot's edge.
                      cliponaxis: false,
                      ...(activeUsersLabelAll
                        ? {
                            text: activeUsersBuckets.map((p) => String(p.active_users)),
                            textposition: "top center" as const,
                            textfont: { color: chrome.muted, size: 10 },
                          }
                        : {}),
                      hovertemplate: "%{x}<br>%{y} active users<extra></extra>",
                    },
                    ...(!activeUsersLabelAll && activeUsersBuckets.length > 0
                      ? [
                          {
                            x: [activeUsersBuckets[activeUsersBuckets.length - 1].label],
                            y: [activeUsersBuckets[activeUsersBuckets.length - 1].active_users],
                            type: "scatter" as const,
                            mode: "markers+text" as const,
                            text: [String(activeUsersBuckets[activeUsersBuckets.length - 1].active_users)],
                            textposition: "top center" as const,
                            textfont: { color: chrome.text, size: 11 },
                            marker: { color: BRAND, size: 8 },
                            cliponaxis: false,
                            hoverinfo: "skip" as const,
                            showlegend: false,
                          },
                        ]
                      : []),
                  ]}
                  layout={{
                    ...baseLayout,
                    xaxis: categoryAxis,
                    yaxis: { ...valueAxis, tickformat: "d", dtick: integerDtick(activeUsersBuckets.map((p) => p.active_users)) },
                  }}
                  style={{ width: "100%", height: 260 }}
                  useResizeHandler
                  config={plotConfig}
                />
              </ChartCard>

              <ChartCard
                title="Prompts per active user, per day"
                subtitle={
                  promptsPerUserGranularity !== "daily"
                    ? "Avg of each day's prompts-per-active-user ratio in the period"
                    : "How many prompts a typical active user sent that day"
                }
                controls={<GranularityToggle value={promptsPerUserGranularity} onChange={setPromptsPerUserGranularity} />}
                fading={refreshingRange}
                empty={promptsPerUserBuckets.length === 0}
                className="lg:col-span-2"
              >
                <Plot
                  data={[
                    {
                      x: promptsPerUserBuckets.map((p) => p.label),
                      y: promptsPerUserBuckets.map((p) => p.value),
                      type: "scatter",
                      mode: promptsPerUserLabelAll ? "lines+markers+text" : "lines+markers",
                      line: { color: BRAND, width: 2, shape: "spline" },
                      marker: { color: BRAND, size: 6 },
                      fill: "tozeroy",
                      fillcolor: `${BRAND}1a`,
                      // See "Total users over time"'s own note above on why
                      // this is needed - the first/last point's label
                      // otherwise clips against the plot's edge.
                      cliponaxis: false,
                      ...(promptsPerUserLabelAll
                        ? {
                            text: promptsPerUserBuckets.map((p) => p.value.toFixed(1)),
                            textposition: "top center" as const,
                            textfont: { color: chrome.muted, size: 10 },
                          }
                        : {}),
                      hovertemplate: "%{x}<br>%{y:.2f} prompts per active user<extra></extra>",
                    },
                    ...(!promptsPerUserLabelAll && promptsPerUserBuckets.length > 0
                      ? [
                          {
                            x: [promptsPerUserBuckets[promptsPerUserBuckets.length - 1].label],
                            y: [promptsPerUserBuckets[promptsPerUserBuckets.length - 1].value],
                            type: "scatter" as const,
                            mode: "markers+text" as const,
                            text: [promptsPerUserBuckets[promptsPerUserBuckets.length - 1].value.toFixed(1)],
                            textposition: "top center" as const,
                            textfont: { color: chrome.text, size: 11 },
                            marker: { color: BRAND, size: 8 },
                            cliponaxis: false,
                            hoverinfo: "skip" as const,
                            showlegend: false,
                          },
                        ]
                      : []),
                  ]}
                  layout={{
                    ...baseLayout,
                    xaxis: categoryAxis,
                    yaxis: { ...valueAxis, tickformat: "d", dtick: integerDtick(promptsPerUserBuckets.map((p) => p.value)) },
                  }}
                  style={{ width: "100%", height: 260 }}
                  useResizeHandler
                  config={plotConfig}
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
                    config={plotConfig}
                  />
                </ChartCard>

                <ChartCard
                  title="Most-used chart types"
                  subtitle="Ranked by how often each has been generated"
                  empty={breakdowns.chart_types.length === 0}
                >
                  <div className="max-h-72 overflow-y-auto pr-1 -mr-1">
                    {breakdowns.chart_types.map((c, i) => (
                      <div key={c.chart_type} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                        <span className="text-xs text-muted w-5 shrink-0 text-right">{i + 1}</span>
                        <span className="text-sm flex-1 min-w-0 truncate capitalize">{c.chart_type.replace(/_/g, " ")}</span>
                        <div className="w-20 sm:w-28 h-1.5 rounded-full bg-surface2 overflow-hidden shrink-0 hidden sm:block">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${Math.max(4, (c.count / maxChartTypeCount) * 100)}%`, backgroundColor: BRAND }}
                          />
                        </div>
                        <span className="text-sm font-semibold w-10 text-right shrink-0">{c.count}</span>
                      </div>
                    ))}
                  </div>
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

            {/* Users table - deliberately table-fixed with percentage
                column widths (rather than letting content dictate width)
                so the whole table sits inside the card and never forces a
                horizontal scrollbar; long values truncate with the full
                value available on hover via each cell's title attribute. */}
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
            {/* Last-active day filter - independent of search/sort, so a
                specific window's usage can be isolated at a glance ("today"
                matches the same UTC-calendar-day definition the "Active
                today" KPI tile above uses, not a rolling 24 hours). */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="text-sm text-muted mr-1">Last active</span>
              {USER_DATE_FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setUserDateFilter(f.key)}
                  className={`text-xs sm:text-sm px-3 py-1.5 rounded-lg border transition ${
                    userDateFilter === f.key ? "border-primary bg-primary/10 text-primary font-semibold" : "border-border hover:bg-surface2"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="card overflow-x-auto">
              <table className="w-full text-sm table-fixed">
                <colgroup>
                  <col style={{ width: "24%" }} />
                  <col style={{ width: "13%" }} />
                  <col style={{ width: "13%" }} />
                  <col style={{ width: "11%" }} />
                  <col style={{ width: "8%" }} />
                  <col style={{ width: "9%" }} />
                  <col style={{ width: "8%" }} />
                  <col style={{ width: "11%" }} />
                  <col style={{ width: "9%" }} />
                </colgroup>
                <thead>
                  <tr className="text-left text-muted border-b border-border select-none">
                    <th className="p-2 cursor-pointer hover:text-fg" onClick={() => toggleSort("email")}>
                      Email{sortArrow("email")}
                    </th>
                    <th className="p-2">Name</th>
                    <th className="p-2">Company</th>
                    <th className="p-2 cursor-pointer hover:text-fg" onClick={() => toggleSort("created_at")}>
                      Signed up{sortArrow("created_at")}
                    </th>
                    <th className="p-2 cursor-pointer hover:text-fg" onClick={() => toggleSort("prompt_count")}>
                      Prompts{sortArrow("prompt_count")}
                    </th>
                    <th className="p-2 cursor-pointer hover:text-fg" onClick={() => toggleSort("datasource_count")}>
                      Data sources{sortArrow("datasource_count")}
                    </th>
                    <th className="p-2 cursor-pointer hover:text-fg" onClick={() => toggleSort("verified_count")}>
                      Verified{sortArrow("verified_count")}
                    </th>
                    <th className="p-2 cursor-pointer hover:text-fg" onClick={() => toggleSort("last_prompt_at")}>
                      Last active{sortArrow("last_prompt_at")}
                    </th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSortedUsers.map((u) => {
                    const activeThisWeek =
                      !!u.last_prompt_at &&
                      Date.now() - new Date(u.last_prompt_at + (u.last_prompt_at.endsWith("Z") ? "" : "Z")).getTime() < 7 * 24 * 60 * 60 * 1000;
                    return (
                      <tr key={u.id} className="border-b border-border last:border-0">
                        <td className="p-2 truncate" title={u.email}>
                          {u.email}
                        </td>
                        <td className="p-2 truncate" title={u.full_name || undefined}>
                          {u.full_name || "—"}
                        </td>
                        <td className="p-2 truncate" title={u.company || undefined}>
                          {u.company || "—"}
                        </td>
                        <td className="p-2 truncate" title={formatDate(u.created_at)}>
                          {formatDateCompact(u.created_at)}
                        </td>
                        <td className="p-2 font-semibold">{u.prompt_count}</td>
                        <td className="p-2">{u.datasource_count}</td>
                        <td className="p-2">{u.verified_count}</td>
                        <td className="p-2 truncate" title={formatDate(u.last_prompt_at)}>
                          {formatDateCompact(u.last_prompt_at)}
                        </td>
                        <td className="p-2">
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
                      <td colSpan={9} className="p-6 text-center text-muted">
                        {search ? `No users match "${search}".` : "No users match this filter."}
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
