// 2026-10-12 (round 36): the small icon tiles on dashboard cards and KPI tiles, the origin chip of a
// block made from a thread ("From Q2" / "Suggested" / "Added by you"), and the story line that
// says what a chart shows in one sentence.
import { ReactNode, useEffect, useState } from "react";
import type { BlockResult, DashboardBlock } from "../api/client";
import { formatValue, humanizeLower, measureFormats } from "./format";

type IP = { size?: number };
const sv = (size: number) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className: "shrink-0",
});
const ICONS: Record<string, (p: IP) => JSX.Element> = {
  kpi: ({ size = 15 }) => <svg {...sv(size)}><path d="M4 19V9M10 19V5M16 19v-7M22 19H2" /></svg>,
  trend: ({ size = 15 }) => <svg {...sv(size)}><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></svg>,
  map: ({ size = 15 }) => <svg {...sv(size)}><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z" /><path d="M9 4v14M15 6v14" /></svg>,
  donut: ({ size = 15 }) => <svg {...sv(size)}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="M12 3v5" /></svg>,
  split: ({ size = 15 }) => <svg {...sv(size)}><path d="M4 7h16M4 12h16M4 17h16" /><path d="M14 5v4M10 10v4M16 15v4" /></svg>,
  table: ({ size = 15 }) => <svg {...sv(size)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" /></svg>,
  bars: ({ size = 15 }) => <svg {...sv(size)}><path d="M4 6h10M4 12h16M4 18h7" /></svg>,
  users: ({ size = 15 }) => <svg {...sv(size)}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  pulse: ({ size = 15 }) => <svg {...sv(size)}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>,
  money: ({ size = 15 }) => <svg {...sv(size)}><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>,
  percent: ({ size = 15 }) => <svg {...sv(size)}><path d="M19 5 5 19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></svg>,
  zap: ({ size = 15 }) => <svg {...sv(size)}><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>,
  cart: ({ size = 15 }) => <svg {...sv(size)}><circle cx="9" cy="20" r="1.5" /><circle cx="18" cy="20" r="1.5" /><path d="M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L22 7H6" /></svg>,
  calendar: ({ size = 15 }) => <svg {...sv(size)}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></svg>,
};

/** The form a card draws, as an icon key. */
export function visualOf(block: Pick<DashboardBlock, "type" | "config">, chartType?: string | null, hasTime?: boolean): string {
  const t = block.type;
  if (t === "kpi" || t === "gauge" || t === "sparkline") return "kpi";
  if (t === "donut") return "donut";
  if (t === "table" || t === "sql") return "table";
  const ct = chartType || block.config?.chart_type || "";
  if (ct === "map") return "map";
  if (ct === "pie" || ct === "donut") return "donut";
  if (/stacked|heatmap|treemap/.test(ct)) return "split";
  if (hasTime || /line|area/.test(ct)) return "trend";
  return "bars";
}

/** A KPI's icon from what it counts. */
export function kpiIconOf(label: string): string {
  const l = (label || "").toLowerCase();
  if (/rate|ratio|share|%|percent|conversion|margin/.test(l)) return "percent";
  if (/revenue|sales|spend|cost|price|profit|amount|value|income|adr|aov/.test(l)) return "money";
  if (/user|visitor|customer|guest|people|member|subscriber/.test(l)) return "users";
  if (/order|transaction|purchase|booking|cart/.test(l)) return "cart";
  if (/event|click|action|conversion/.test(l)) return "zap";
  if (/session|view|visit|traffic|impression/.test(l)) return "pulse";
  if (/day|month|year|date|night|stay/.test(l)) return "calendar";
  return "kpi";
}

const TILE_TONES: Record<string, string> = {
  kpi: "series-1", trend: "series-3", map: "kind-alert", donut: "series-1", split: "series-2", table: "series-4", bars: "series-1",
  users: "series-1", pulse: "series-3", money: "series-4", percent: "series-2", zap: "series-5", cart: "series-2", calendar: "series-1",
};

export function IconTile({ name, size = 26, iconSize = 14 }: { name: string; size?: number; iconSize?: number }) {
  const Icon = ICONS[name] || ICONS.bars;
  const tone = TILE_TONES[name] || "series-1";
  const isKind = tone.startsWith("kind-");
  const fg = isKind ? `rgb(var(--color-${tone}))` : `rgb(var(--color-${tone}))`;
  const bg = isKind ? `rgb(var(--color-${tone}-fill))` : `rgb(var(--color-${tone}) / 0.13)`;
  return (
    <span aria-hidden="true" data-icon-tile={name} className="grid shrink-0 place-items-center" style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), color: fg, background: bg }}>
      <Icon size={iconSize} />
    </span>
  );
}

/** A title with its icon tile in front. */
export function withIcon(name: string, title: ReactNode, size = 26): ReactNode {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2.5">
      <IconTile name={name} size={size} iconSize={Math.round(size * 0.54)} />
      <span className="min-w-0 truncate">{title}</span>
    </span>
  );
}

// round 37: where a block came from is the builder's business - hidden in view mode unless the
// reader turns it on (More > Show where blocks came from); always shown while editing.
const ORIGINS_KEY = "gd360_show_origins";
const ORIGINS_EVENT = "gd360:show-origins";
function readShowOrigins(): boolean {
  try {
    return localStorage.getItem(ORIGINS_KEY) === "1";
  } catch {
    return false;
  }
}
export function setShowOrigins(on: boolean): void {
  try {
    localStorage.setItem(ORIGINS_KEY, on ? "1" : "0");
  } catch {
    /* a per-browser convenience */
  }
  window.dispatchEvent(new CustomEvent(ORIGINS_EVENT));
}
export function useShowOrigins(): boolean {
  const [on, setOn] = useState(readShowOrigins);
  useEffect(() => {
    const sync = () => setOn(readShowOrigins());
    window.addEventListener(ORIGINS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(ORIGINS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return on;
}

/** "From your question" / "Suggested" / "Added by you" - where a thread dashboard's block came from. */
export function OriginChip({ origin, question }: { origin?: string | null; question?: string | null }) {
  if (!origin) return null;
  const fromAnswer = /^Q\d+$/.test(origin);
  const color = fromAnswer ? "rgb(var(--color-kind-answer))" : origin === "you" ? "rgb(var(--color-kind-dashboard))" : "rgb(var(--color-series-1))";
  const label = fromAnswer ? "From your question" : origin === "you" ? "Added by you" : "Suggested";
  return (
    <span data-origin-chip={origin} className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11.5px] font-medium" style={{ color }}
      title={fromAnswer ? (question ? `Made from your question “${question}”` : "Made from a question in the thread") : origin === "you" ? "You added this block" : "GD360 added this so the dashboard is complete"}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A period as a reader says it at its grain: "12 Oct 2026", "week of 6 Oct", "Nov 2025", "Q4 2025", "2025". */
export function periodLabel(raw: unknown, grain: string | null | undefined): string {
  const t = String(raw ?? "");
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(t);
  if (!m) return t;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3] || 1);
  switch ((grain || "").toLowerCase()) {
    case "year": return String(y);
    case "quarter": return `Q${Math.floor((mo - 1) / 3) + 1} ${y}`;
    case "month": return `${MONTHS[mo - 1]} ${y}`;
    case "week": return `week of ${d} ${MONTHS[mo - 1]}`;
    default: return `${d} ${MONTHS[mo - 1]} ${y}`;
  }
}

/** A category as the start of a sentence: "Desktop", "Home (/)", "Page /about/". */
function subject(v: unknown): string {
  const t = String(v ?? "(blank)");
  if (t === "/") return "Home (/)";
  if (t.startsWith("/")) return `Page ${t}`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** One sentence on what a chart shows, from its own rows ("United States leads with 583, 27% of the
 *  total."). Null when the rows don't make a clear sentence. Never invents a number. */
export function storyOf(block: Pick<DashboardBlock, "type" | "config" | "title">, result: BlockResult | null | undefined): string | null {
  if (!result || !Array.isArray(result.rows) || result.rows.length < 2) return null;
  if (block.type === "kpi" || block.type === "gauge" || block.type === "text") return null;
  const numeric = (name: string) => result.rows.every((r) => r[name] === null || r[name] === undefined || isNum(r[name]));
  const measures = result.measures?.length ? result.measures : result.columns.map((c) => c.name).filter(numeric);
  const m = measures[0];
  if (!m) return null;
  const fmt = measureFormats(block as DashboardBlock, result)[m];
  const show = (v: number) => formatValue(v, fmt);
  const rows = result.rows.filter((r) => isNum(r[m]));
  if (rows.length < 2) return null;
  const word = humanizeLower(m);
  if (result.time_column) {
    const tc = result.time_column;
    const grain = result.period || (block.config?.recipe?.time_grain as string | undefined) || null;
    const peak = rows.reduce((a, b) => (b[m] > a[m] ? b : a));
    const when = periodLabel(peak[tc], grain);
    const prep = !grain || grain === "day" ? "on" : grain === "week" ? "in the" : "in";
    return when ? `Peak ${word}: ${show(peak[m])} ${prep} ${when}.` : null;
  }
  const dims = result.dimensions?.length ? result.dimensions : result.columns.map((c) => c.name).filter((n) => !measures.includes(n));
  if (dims.length !== 1) return null;
  const d = dims[0];
  const sorted = rows.slice().sort((a, b) => b[m] - a[m]);
  const top = sorted[0];
  const rate = fmt?.format === "percent";
  const total = rows.reduce((s, r) => s + r[m], 0);
  if (!rate && total > 0 && sorted.every((r) => r[m] >= 0)) {
    const sharePct = (top[m] / total) * 100;
    const share = sharePct < 10 ? sharePct.toFixed(1) : String(Math.round(sharePct));
    return `${subject(top[d])} leads with ${show(top[m])}, ${share}% of the total.`;
  }
  return `${subject(top[d])} is highest at ${show(top[m])}; ${String(sorted[sorted.length - 1][d])} is lowest at ${show(sorted[sorted.length - 1][m])}.`;
}
