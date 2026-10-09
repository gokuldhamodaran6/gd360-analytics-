// 2026-10-08 (round 11): number and time formatting for project answers -
// the same rules as the backend's services/project_engine/numbers.py, so a
// number drawn on a chart reads exactly like the one in the written answer.
const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥", AUD: "A$", CAD: "C$", SGD: "S$" };

function abbreviate(a: number): string {
  if (a >= 1e9) return `${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(a / 1e6).toFixed(a < 1e7 ? 2 : 1)}M`;
  if (a >= 1e4) return `${(a / 1e3).toFixed(1)}k`;
  if (a >= 100) return Math.round(a).toLocaleString("en-US");
  if (a >= 1) return a.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (a === 0) return "0";
  return a.toPrecision(3);
}

export function formatValue(v: number | null | undefined, kind = "number", currency?: string | null, signed = false): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  let s: string;
  if (kind === "percent") s = `${a.toFixed(1)}%`;
  else if (kind === "ratio") s = `${(a * 100).toFixed(a < 0.1 ? 2 : 1)}%`;
  else if (kind === "currency") {
    const sym = SYMBOLS[(currency || "USD").toUpperCase()] ?? "";
    const body = a < 100 ? a.toFixed(2) : abbreviate(a);
    s = sym ? `${sym}${body}` : `${body} ${currency || ""}`.trim();
  } else if (kind === "integer") s = Math.round(a).toLocaleString("en-US");
  else s = abbreviate(a);
  if (v < 0) return `−${s}`;
  if (signed && v > 0) return `+${s}`;
  return s;
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return "";
  const t = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`).getTime();
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function bytes(n?: number | null): string {
  if (n == null) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

export function ms(n?: number | null): string {
  if (n == null) return "";
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`;
}

export const MODE_LABEL: Record<string, string> = { live: "LIVE", synced: "SYNCED", file: "FILE", combine: "COMBINE" };

// 2026-10-08 (round 12): "Next time, run plans like this straight away" - a
// per-browser preference. On (the default): a question plans and runs in one
// go. Off: GD360 stops at the plan and waits for "Run plan".
const AUTO_RUN_KEY = "gd360_auto_run_plans";

export function autoRunPreference(): boolean {
  try {
    return localStorage.getItem(AUTO_RUN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAutoRunPreference(on: boolean): void {
  try {
    localStorage.setItem(AUTO_RUN_KEY, on ? "1" : "0");
  } catch {
    /* per-browser convenience only */
  }
}

/** A table cell: whole money above $1,000 without cents ($14,394,410),
 *  smaller money with them ($105.75), counts with separators, rates with
 *  one decimal - every digit lined up in its column. */
export function formatCell(v: unknown, kind?: string | null, currency?: string | null): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v !== "number" || !Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (kind === "currency") {
    const sym = SYMBOLS[(currency || "USD").toUpperCase()] ?? "";
    const body = a >= 1000 ? Math.round(a).toLocaleString("en-US") : a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${sign}${sym}${body}`;
  }
  if (kind === "percent") return `${sign}${a.toFixed(1)}%`;
  if (kind === "ratio") return `${sign}${(a * 100).toFixed(1)}%`;
  if (kind === "integer" || Number.isInteger(v)) return `${sign}${Math.round(a).toLocaleString("en-US")}`;
  return `${sign}${a.toLocaleString("en-US", { maximumFractionDigits: a >= 1000 ? 0 : 2 })}`;
}
