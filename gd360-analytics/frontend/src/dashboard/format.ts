import type { BlockResult, BlockSpec, BlockSpecMeasure, DashboardBlock } from "../api/client";

// 2026-10-07 (dashboard polish round): the ONE place a dashboard number,
// a column name and a block description are turned into words. Everything
// that prints a warehouse value - the KPI strip, canvas KPI cells, gauges,
// table cells, chart axis ticks, bar value labels, tooltips, the donut
// legend - goes through formatValue() with the format resolved here, so a
// rate can never read "0.37" on a tile and "37%" on the chart beside it.
//
//   block.config.format    "number" | "percent" | "currency" | "compact"
//   block.config.decimals  0 | 1 | 2
//   block.config.format_inferred  true when the backend picked the format
//                                 (query_builder.infer_number_format)
//
// "percent" means the stored value is a 0-1 fraction: 0.3704 -> "37%",
// with decimals 1 -> "37.0%". When config.format is absent the client
// infers, per measure and only ever to "percent" (see inferFormat).

export type NumberFormat = "number" | "percent" | "currency" | "compact";

export type ValueFormat = {
  format: NumberFormat;
  // null = the format's own default.
  decimals: number | null;
  // Picked by GD360 (backend or client), not by the owner.
  inferred: boolean;
  currency: string;
};

export const NUMBER_FORMATS: NumberFormat[] = ["number", "percent", "currency", "compact"];

export const PLAIN_FORMAT: ValueFormat = { format: "number", decimals: null, inferred: false, currency: "USD" };

// How much room the number has:
//   "auto"    a KPI tile / gauge: the full number below a million, then 42.7M
//   "full"    a table cell or a tooltip: every digit
//   "compact" an axis tick or a tight value label: 25.3M, 6.5K
export type FormatStyle = "auto" | "full" | "compact";

const MINUS = "−";

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v.trim())) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function plain(abs: number, decimals: number | null, maxDefault: number): string {
  if (decimals !== null) return abs.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return abs.toLocaleString(undefined, { maximumFractionDigits: abs >= 1000 ? 0 : maxDefault });
}

const UNITS: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];

// 25,278,862 -> "25.3M"; 6,500 -> "6.5K"; 999,960 -> "1M" (never "1,000K").
function compact(abs: number, decimals: number | null, minUnit = 1e3): string {
  const digits = decimals ?? 1;
  for (let i = 0; i < UNITS.length; i++) {
    const [size, suffix] = UNITS[i];
    if (size < minUnit) break;
    if (abs < size) continue;
    const scaled = abs / size;
    const rounded = Number(scaled.toFixed(digits));
    if (rounded >= 1000 && i > 0) return `${(abs / UNITS[i - 1][0]).toLocaleString(undefined, { minimumFractionDigits: decimals ?? 0, maximumFractionDigits: digits })}${UNITS[i - 1][1]}`;
    return `${scaled.toLocaleString(undefined, { minimumFractionDigits: decimals ?? 0, maximumFractionDigits: digits })}${suffix}`;
  }
  return plain(abs, decimals, abs >= 100 ? 1 : 2);
}

const symbolCache = new Map<string, string>();
export function currencySymbol(code: string): string {
  const key = (code || "USD").toUpperCase();
  const hit = symbolCache.get(key);
  if (hit) return hit;
  let symbol = key === "USD" ? "$" : `${key} `;
  try {
    const part = new Intl.NumberFormat(undefined, { style: "currency", currency: key, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency");
    if (part?.value) symbol = /^[A-Z]{3}$/.test(part.value) ? `${part.value} ` : part.value;
  } catch {
    // An unknown code: keep the code itself as the prefix.
  }
  symbolCache.set(key, symbol);
  return symbol;
}

/** A warehouse value as text. Non-numbers pass through ("—" for nothing). */
export function formatValue(v: unknown, fmt: ValueFormat = PLAIN_FORMAT, style: FormatStyle = "auto"): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? (Number.isFinite(v) ? v : null) : null;
  if (n === null) return typeof v === "object" ? JSON.stringify(v) : String(v);
  const sign = n < 0 ? MINUS : "";
  const abs = Math.abs(n);
  const d = fmt.decimals;
  switch (fmt.format) {
    case "percent": {
      const p = abs * 100;
      const body = d !== null ? p.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : p.toLocaleString(undefined, { maximumFractionDigits: p >= 1000 ? 0 : 1 });
      return `${sign}${body}%`;
    }
    case "currency": {
      const sym = currencySymbol(fmt.currency);
      if (style === "compact") return `${sign}${sym}${compact(abs, d)}`;
      if (style === "auto" && abs >= 1e6) return `${sign}${sym}${compact(abs, d, 1e6)}`;
      return `${sign}${sym}${plain(abs, d, 2)}`;
    }
    case "compact":
      return style === "full" ? `${sign}${plain(abs, d, 2)}` : `${sign}${compact(abs, d)}`;
    default: {
      if (style === "compact") return `${sign}${compact(abs, d)}`;
      if (style === "auto" && abs >= 1e6) return `${sign}${compact(abs, d, 1e6)}`;
      return `${sign}${plain(abs, d, 2)}`;
    }
  }
}

export type DeltaInput = { current?: number | null; prior?: number | null; abs?: number | null; pct?: number | null };

/** "+8.1%" for a number, "+2.1 pts" for a percent (a rate that moved from
 *  34.9% to 37.0% went up 2.1 percentage points, not "6.1%"). */
export function formatDelta(delta: DeltaInput, fmt: ValueFormat = PLAIN_FORMAT): string {
  const abs = typeof delta.abs === "number" ? delta.abs : typeof delta.current === "number" && typeof delta.prior === "number" ? delta.current - delta.prior : null;
  const signOf = (n: number) => (n > 0 ? "+" : n < 0 ? MINUS : "");
  if (fmt.format === "percent") {
    if (abs === null) return "";
    const pts = Number((abs * 100).toFixed(1));
    return `${signOf(pts)}${Math.abs(pts).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pts`;
  }
  if (typeof delta.pct === "number" && Number.isFinite(delta.pct)) {
    return `${signOf(delta.pct)}${Math.abs(delta.pct).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  }
  if (abs === null) return "";
  return `${signOf(abs)}${formatValue(Math.abs(abs), fmt, "compact")}`;
}

// ---- inference -----------------------------------------------------------

const RATE_WORDS = new Set(["rate", "share", "ratio", "percent", "percentage", "pct"]);

/** The name starts or ends with rate / share / ratio / percent / pct, or
 *  carries a "%". Word-wise, so "Average Daily Rate (ADR)" (ends "ADR") and
 *  "rated_items" do not count. */
export function looksLikeRateName(name: string | null | undefined): boolean {
  if (!name) return false;
  if (name.includes("%")) return true;
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return false;
  return RATE_WORDS.has(words[0]) || RATE_WORDS.has(words[words.length - 1]);
}

export function isFlagColumn(column: string | null | undefined): boolean {
  if (!column) return false;
  return /^(is|has)_/i.test(column) || /_flag$/i.test(column);
}

/** Conservative, and only ever "percent": the measure is an AVERAGE, every
 *  value that came back sits in [0, 1], and the source column is flag-named
 *  (is_*, has_*, *_flag) or the alias / title reads as a rate. Anything
 *  else stays a plain number - a wrong "%" is worse than a missing one. */
export function inferFormat(measure: Pick<BlockSpecMeasure, "agg" | "column" | "alias"> | null | undefined, values: unknown[], title?: string | null): NumberFormat | null {
  if (!measure || String(measure.agg || "").toLowerCase() !== "avg") return null;
  let seen = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    const n = toFiniteNumber(v);
    if (n === null || n < 0 || n > 1) return null;
    seen++;
  }
  if (!seen) return null;
  if (isFlagColumn(measure.column) || looksLikeRateName(measure.alias) || looksLikeRateName(title)) return "percent";
  return null;
}

function validFormat(v: unknown): NumberFormat | null {
  return typeof v === "string" && (NUMBER_FORMATS as string[]).includes(v) ? (v as NumberFormat) : null;
}
function validDecimals(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 2 ? v : null;
}

export function measureAliases(result: BlockResult | null | undefined, spec?: BlockSpec | null): string[] {
  if (result?.measures?.length) return result.measures;
  return (spec?.measures || []).map((m) => m.alias).filter(Boolean);
}

/** The format of every measure of a block: config.format / config.decimals
 *  describe the block's first measure (a KPI, a gauge, a one-measure chart);
 *  every other measure - and the first when config.format is absent - is
 *  inferred on its own from its spec and the values that came back. */
export function measureFormats(block: Pick<DashboardBlock, "config" | "title"> | null | undefined, result: BlockResult | null | undefined): Record<string, ValueFormat> {
  const cfg = block?.config || {};
  const spec: BlockSpec | null = (cfg.spec && typeof cfg.spec === "object" ? cfg.spec : null) || result?.spec || null;
  const aliases = measureAliases(result, spec);
  const currency = typeof cfg.currency === "string" && /^[A-Za-z]{3}$/.test(cfg.currency) ? cfg.currency.toUpperCase() : "USD";
  const chosen = validFormat(cfg.format);
  const decimals = validDecimals(cfg.decimals);
  const out: Record<string, ValueFormat> = {};
  aliases.forEach((alias, i) => {
    if (i === 0 && chosen) {
      out[alias] = { format: chosen, decimals, inferred: Boolean(cfg.format_inferred), currency };
      return;
    }
    const m = spec?.measures?.find((x) => x.alias === alias) || null;
    const values: unknown[] = [];
    for (const row of result?.rows || []) values.push(row[alias]);
    for (const row of result?.sparkline?.rows || []) values.push(row[alias]);
    for (const row of result?.prior?.rows || []) values.push(row[alias]);
    const inferred = inferFormat(m, values, aliases.length === 1 ? block?.title : null);
    out[alias] = { format: inferred ?? "number", decimals: i === 0 ? decimals : null, inferred: Boolean(inferred), currency };
  });
  return out;
}

/** The format of the block's first measure (what a KPI / gauge shows). */
export function blockFormat(block: Pick<DashboardBlock, "config" | "title"> | null | undefined, result: BlockResult | null | undefined): ValueFormat {
  const formats = measureFormats(block, result);
  const first = Object.keys(formats)[0];
  if (first) return formats[first];
  const cfg = block?.config || {};
  return { ...PLAIN_FORMAT, format: validFormat(cfg.format) ?? "number", decimals: validDecimals(cfg.decimals), inferred: Boolean(cfg.format_inferred) };
}

/** A column of table cells reads best with one number of decimals: whole
 *  numbers stay whole, a percent gets one, anything else two - unless
 *  every value is in the thousands or beyond, where cents are noise
 *  ("25,278,862", not "25,278,862.40") - so the digits line up under each
 *  other. */
export function columnFormat(fmt: ValueFormat, values: unknown[]): ValueFormat {
  if (fmt.decimals !== null) return fmt;
  if (fmt.format === "percent") return { ...fmt, decimals: 1 };
  let any = false, fractional = false, smallest = Infinity;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    any = true;
    if (!Number.isInteger(v)) fractional = true;
    if (v !== 0) smallest = Math.min(smallest, Math.abs(v));
  }
  if (!any) return fmt;
  return { ...fmt, decimals: fractional && smallest < 1000 ? 2 : 0 };
}

// ---- names ---------------------------------------------------------------

const ACRONYMS = [
  "ADR", "ID", "USD", "EUR", "GBP", "YoY", "MoM", "QoQ", "WoW", "YTD", "MTD", "KPI", "URL", "SKU", "CAC", "LTV", "ARPU", "MRR", "ARR", "ROI", "ROAS", "AOV", "GMV",
  "CTR", "CPC", "CPA", "CPM", "API", "SQL", "UTC", "VAT", "NPS", "CSAT", "DAU", "WAU", "MAU", "B2B", "B2C", "IP", "SLA", "UUID", "RevPAR", "OTA", "COGS", "EBITDA", "PII",
];
const ACRONYM_BY_LOWER = new Map(ACRONYMS.map((a) => [a.toLowerCase(), a]));

/** A SQL alias or column name as a label: "total_revenue" -> "Total
 *  revenue", "avg_adr" -> "Avg ADR", "customer_id" -> "Customer ID". For
 *  display only - the name the query uses never changes. A name that is
 *  already written for people ("Total Revenue") is left alone. */
export function humanize(name: string | null | undefined): string {
  const s = String(name ?? "").trim();
  if (!s) return "";
  const acronym = ACRONYM_BY_LOWER.get(s.toLowerCase());
  if (acronym) return acronym;
  const shouting = s === s.toUpperCase() && /[A-Z]/.test(s);
  if (!s.includes("_") && /[A-Z]/.test(s) && !shouting) return s;
  const words = s.replace(/[_\s]+/g, " ").trim().split(" ");
  return words
    .map((w, i) => {
      const known = ACRONYM_BY_LOWER.get(w.toLowerCase());
      if (known) return known;
      const lower = w.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/** humanize() for the middle of a sentence ("… by market segment"). */
export function humanizeLower(name: string | null | undefined): string {
  const h = humanize(name);
  if (!h) return h;
  if (ACRONYM_BY_LOWER.has(h.split(" ")[0].toLowerCase())) return h;
  // Only what humanize() itself capitalised is lowered again.
  if (h === String(name ?? "").trim()) return h;
  return h.charAt(0).toLowerCase() + h.slice(1);
}

function nameTokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9%]+/).filter(Boolean).map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}

/** Does the card title already say this name? ("Bookings by month" says
 *  "bookings"; "Revenue by hotel" does not say "Total revenue".) */
export function titleMentions(title: string | null | undefined, name: string | null | undefined): boolean {
  if (!title || !name) return false;
  const have = new Set(nameTokens(title));
  const want = nameTokens(humanize(name));
  return want.length > 0 && want.every((w) => have.has(w));
}

/** The block subtitle: "Total revenue, Total bookings by month · Hotel_data".
 *  (describeSpec in runState.ts is the exact, query-level sentence; it is
 *  the tooltip.) `grain` is the page's period when it overrides the spec's. */
export function describeSpecShort(spec: BlockSpec | null | undefined, grain?: string | null): string {
  if (!spec) return "";
  const measures = (spec.measures || []).map((m) => humanize(m.alias) || (m.column ? `${String(m.agg || "").replace(/_/g, " ")} of ${humanizeLower(m.column)}` : "Rows"));
  const dims: string[] = [];
  if (spec.time) dims.push(String(grain || spec.time.grain || "period"));
  for (const g of spec.group_by || []) dims.push(humanizeLower(g));
  let text = measures.join(", ");
  if (dims.length) text += ` by ${dims.join(", ")}`;
  return spec.table ? `${text} · ${spec.table}` : text;
}

// ---- one axis, or small multiples? ---------------------------------------

export const MAX_PANELS = 4;
export const MAX_SERIES = 6;
export const SCALE_RATIO = 8;

export type ChartArrangement = "single" | "multiples" | "table";

function unitOf(format: NumberFormat): string {
  return format === "compact" ? "number" : format;
}

/** Two or more measures (no series dimension) share ONE axis only when
 *  they are the same kind of number and of comparable size. A percent
 *  beside a count, or a 2.4M revenue beside a 6,500 bookings (more than
 *  8x apart), would flatten the smaller one to a line at zero - those get
 *  one panel each, stacked on a shared x axis. More than four panels is a
 *  table's job. Never a second y scale. */
export function chartArrangement(measures: { maxAbs: number; format: NumberFormat }[], hasSeriesDimension = false): ChartArrangement {
  if (hasSeriesDimension || measures.length < 2) return "single";
  const units = new Set(measures.map((m) => unitOf(m.format)));
  const sizes = measures.map((m) => Math.abs(m.maxAbs)).filter((v) => Number.isFinite(v) && v > 0);
  const apart = sizes.length > 1 && Math.max(...sizes) / Math.min(...sizes) > SCALE_RATIO;
  if (units.size > 1 || apart) return measures.length > MAX_PANELS ? "table" : "multiples";
  return measures.length > MAX_SERIES ? "table" : "single";
}
