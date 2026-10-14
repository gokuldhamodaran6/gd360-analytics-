// 2026-10-13 (R45, one number system): the browser twin of
// backend/app/services/semantics.py. Every surface - answer page, dashboard
// KPI cards, chart ticks and tooltips, tables, Excel captions - rounds and
// labels numbers through here, so 21.075 is "21.08" (half-up) everywhere and a
// minutes column always says "min". Pure functions, no React.

export type Meaning = {
  role?: string | null; // money | percent | duration | count | measure | rate | id | sequence | year | clock | ...
  unit?: string | null; // "min" | "h" | "s" | "ms" | "days" | "%" | currency code
  currency?: string | null;
  scale?: "fraction" | "points" | null;
};

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥", KRW: "₩", TRY: "₺", BRL: "R$", AUD: "A$", CAD: "C$", SGD: "S$", AED: "AED ", CHF: "CHF ", CNY: "¥" };
const SYMBOL_CODE: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY" };

/** Half-up rounding that survives binary floats: roundHalfUp(21.075, 2) === 21.08. */
export function roundHalfUp(v: number, digits = 0): number {
  if (!Number.isFinite(v)) return v;
  const sign = v < 0 ? -1 : 1;
  const a = Math.abs(v);
  // shift through the decimal string so 21.075 isn't 21.074999…
  const [m, e] = a.toExponential().split("e");
  const shifted = Number(`${m}e${Number(e) + digits}`);
  const r = Math.round(shifted + 1e-9);
  return sign * Number(`${r}e-${digits}`);
}

const group = (v: number, d: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

function autoDecimals(a: number): number {
  if (a >= 100) return 0;
  if (a >= 10) return 1;
  if (a >= 1) return 2;
  return a === 0 ? 0 : 3;
}

/** 1234.5 -> "1,234.5"; trims trailing zeros unless decimals is fixed. */
export function fmtNumber(v: number, decimals?: number): string {
  if (!Number.isFinite(v)) return "–";
  const d = decimals ?? autoDecimals(Math.abs(v));
  const s = group(roundHalfUp(v, d), d);
  return decimals === undefined && s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** 999,960 -> "1M" (never "1000.0k"); 1,234,567 -> "1.2M"; -15,300 with "$" -> "-$15.3K". */
export function compact(v: number, prefix = ""): string {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  const steps: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [div, suf] of steps) {
    if (a >= div * 0.9995) {
      const x = roundHalfUp(a / div, 1);
      if (x >= 1000 && suf !== "T") continue;
      return `${sign}${prefix}${fmtNumber(x, 1).replace(/\.0$/, "")}${suf}`;
    }
  }
  return `${sign}${prefix}${fmtNumber(a)}`;
}

// ---- meaning from a column name (when the backend didn't send one) ----------------------------------------
const W = (...ws: string[]) => new RegExp(`(^|[^a-z])(${ws.join("|")})([^a-z]|$)`, "i");
const DUR: [string, RegExp][] = [
  ["min", W("min", "mins", "minute", "minutes", "wait", "waiting", "service time", "duration", "handle time", "aht", "lead time", "cycle time", "turnaround", "delay", "iat")],
  ["h", W("hr", "hrs", "hour", "hours")],
  ["s", W("sec", "secs", "seconds", "session duration", "engagement time")],
  ["ms", W("ms", "latency", "response time")],
  ["days", W("days", "nights", "length of stay")],
];
const MONEY = W("revenue", "sales", "amount", "price", "cost", "costs", "spend", "budget", "profit", "income", "expense", "salary", "wage", "wages", "fee", "fees", "gmv", "mrr", "arr", "ltv", "cac", "cpc", "cpm", "cpa", "aov", "arpu", "refund", "balance", "loan", "emi", "premium", "deal value", "bookings value");
const NOT_MONEY = W("count", "qty", "quantity", "units", "rate", "pct", "percent", "share", "ratio", "score", "time", "minutes", "hours", "days");
const PERCENT = W("pct", "percent", "percentage", "share", "rate", "ratio", "conversion", "ctr", "churn", "retention", "margin", "growth", "utilisation", "utilization", "occupancy", "bounce", "%");
const NOT_PERCENT = W("daily rate", "room rate", "adr", "exchange rate", "hourly rate", "day rate", "heart rate");
const ID = W("id", "ids", "uuid", "key", "code", "sku", "zip", "phone", "customers", "customer", "#", "no", "number");
const YEAR = W("year", "yr", "fy");

export function meaningFromName(name: string, values?: unknown[]): Meaning {
  const n = String(name || "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const unitIn = /\(([^)]{1,12})\)\s*$/.exec(String(name || ""))?.[1]?.trim();
  if (unitIn) {
    if (SYMBOL_CODE[unitIn]) return { role: "money", currency: SYMBOL_CODE[unitIn], unit: SYMBOL_CODE[unitIn] };
    if (/^[A-Z]{3}$/.test(unitIn) && SYMBOL[unitIn]) return { role: "money", currency: unitIn, unit: unitIn };
    if (unitIn === "%") return { role: "percent", unit: "%", scale: fractionScale(values) };
    const d = DUR.find(([u, rx]) => u === unitIn.toLowerCase() || rx.test(unitIn));
    if (d) return { role: "duration", unit: d[0] };
  }
  if (YEAR.test(n)) return { role: "year" };
  if (PERCENT.test(n) && !NOT_PERCENT.test(n) && !MONEY.test(n.replace("margin", ""))) return { role: "percent", unit: "%", scale: fractionScale(values) };
  if (MONEY.test(n) && !NOT_MONEY.test(n)) return { role: "money", currency: "USD", unit: "USD" };
  const d = DUR.find(([, rx]) => rx.test(n));
  if (d) return { role: "duration", unit: d[0] };
  if (ID.test(n)) return { role: "id" };
  return { role: "measure" };
}

function fractionScale(values?: unknown[]): "fraction" | "points" {
  const nums = (values || []).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return nums.length && nums.every((v) => v >= -1 && v <= 1) ? "fraction" : "points";
}

const UNIT_TEXT: Record<string, string> = { min: "min", h: "h", s: "s", ms: "ms", days: "days", weeks: "weeks", months: "months" };

/** The unit a reader should see next to an axis or KPI: "min", "%", "$", or "". */
export function unitLabel(m: Meaning): string {
  if (m.role === "money") return SYMBOL[m.currency || "USD"]?.trim() || m.currency || "";
  if (m.role === "percent") return "%";
  if (m.role === "duration") return UNIT_TEXT[m.unit || ""] || m.unit || "";
  return "";
}

/** "Waiting time (min)", "Daily cost ($)" - an axis title that always carries its unit. */
export function axisTitle(label: string, m: Meaning): string {
  const u = unitLabel(m);
  const clean = String(label || "").replace(/\s*\([^)]{1,12}\)\s*$/, "");
  return u ? `${clean} (${u})` : clean;
}

/** Format a value by its meaning: "$963", "21.1 min", "92.5%", "1.2M". */
export function formatByMeaning(v: unknown, m: Meaning = {}, opts: { short?: boolean; decimals?: number } = {}): string {
  if (v === null || v === undefined || v === "") return "–";
  const x = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(x)) return String(v);
  const a = Math.abs(x);
  switch (m.role) {
    case "year": return String(Math.round(x));
    case "id": case "sequence": return String(Math.round(x));
    case "money": {
      const sym = SYMBOL[m.currency || "USD"] ?? "$";
      if (opts.short && a >= 10000) return compact(x, sym);
      const d = opts.decimals ?? (a >= 1000 || Number.isInteger(a) ? 0 : 2);
      return `${x < 0 ? "-" : ""}${sym}${group(roundHalfUp(a, d), d)}`;
    }
    case "percent": {
      const pts = m.scale === "fraction" ? x * 100 : x;
      return `${fmtNumber(pts, opts.decimals ?? (Math.abs(pts) < 100 ? 1 : 0))}%`;
    }
    case "duration": {
      const u = UNIT_TEXT[m.unit || ""] || m.unit || "";
      const body = opts.short && a >= 10000 ? compact(x) : fmtNumber(x, opts.decimals ?? (a < 100 && !Number.isInteger(x) ? 1 : 0));
      return u ? `${body} ${u}` : body;
    }
    case "count": return opts.short && a >= 10000 ? compact(x) : group(Math.round(x), 0);
    default: return opts.short && a >= 10000 ? compact(x) : fmtNumber(x, opts.decimals);
  }
}
