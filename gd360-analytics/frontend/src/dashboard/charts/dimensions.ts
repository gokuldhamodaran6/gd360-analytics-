import type { BlockResult } from "../../api/client";
import { normalizeGrain, parseDateParts, periodLabel, periodTick, type Grain } from "./geometry";

// 2026-10-07 (chart-types round): how a dimension's values are NAMED and
// ORDERED, for every chart that lays two dimensions out (heatmap, pivot,
// treemap, waterfall, funnel):
//   - a derived date part (result.date_parts: weekday / month / quarter /
//     day / hour) is an integer from the warehouse; it is labelled
//     "Mon".."Sun", "Jan".."Dec", "Q1".."Q4", "14:00" and kept in calendar
//     order;
//   - the time bucket ("period") is labelled by its grain and kept in
//     time order;
//   - month names, weekday names, numbers, years and ISO dates are a scale:
//     kept in their natural order;
//   - anything else is a set of categories: largest total first.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_INDEX: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
const WEEKDAY_INDEX: Record<string, number> = {
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
  mon: 0, tue: 1, tues: 1, wed: 2, thu: 3, thur: 3, thurs: 3, fri: 4, sat: 5, sun: 6,
};

export type DimInfo = {
  name: string;
  // "time": the period bucket; "part": a derived date part; "ordinal": a
  // scale read off the values; "category": entities.
  kind: "time" | "part" | "ordinal" | "category";
  part?: string;
  grain?: Grain;
  // The values in display order.
  values: unknown[];
  // Full label (tooltips, tables) and a short one (axis ticks).
  label: (v: unknown) => string;
  short: (v: unknown) => string;
};

export function valueId(v: unknown): string {
  return v === null || v === undefined ? "\u0000null" : String(v);
}

function blank(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

function partLabel(part: string, v: unknown, short: boolean): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return blank(v) ? "(Blanks)" : String(v);
  if (part === "weekday") return short ? WEEKDAYS[(n - 1 + 7) % 7] ?? String(n) : ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][(n - 1 + 7) % 7] ?? String(n);
  if (part === "month") return short ? MONTHS[n - 1] ?? String(n) : ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][n - 1] ?? String(n);
  if (part === "quarter") return `Q${n}`;
  if (part === "hour") return `${String(n).padStart(2, "0")}:00`;
  return String(n);
}

/** The natural position of a scale value, or null when it is not one. */
function scalePosition(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s in MONTH_INDEX) return MONTH_INDEX[s];
  if (s in WEEKDAY_INDEX) return WEEKDAY_INDEX[s];
  if (/^-?\d+([.,]\d+)?%?$/.test(s)) return Number(s.replace(",", ".").replace("%", ""));
  const d = parseDateParts(v);
  if (d) return Date.UTC(d.y, d.m, d.d);
  const q = /^q([1-4])(?:[ -]?(\d{2,4}))?$/.exec(s);
  if (q) return (q[2] ? Number(q[2]) * 4 : 0) + Number(q[1]);
  return null;
}

/** The position of a CALENDAR value - a month name, a weekday name, a
 *  quarter ("Q3"), a year (1900-2100) - or null. Unlike scalePosition this
 *  leaves plain numbers alone: an id or a count is not an axis order. */
export function calendarPosition(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 1900 && v <= 2100 ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s in MONTH_INDEX) return MONTH_INDEX[s];
  if (s in WEEKDAY_INDEX) return WEEKDAY_INDEX[s];
  if (/^(19|20)\d{2}$/.test(s)) return Number(s);
  const q = /^q([1-4])(?:[ -]?(\d{2,4}))?$/.exec(s);
  if (q) return (q[2] ? Number(q[2]) * 4 : 0) + Number(q[1]);
  return null;
}

/** The dimension `name` of a result: its kind, its values in display
 *  order (`totals`: value id -> total, used to rank categories) and its
 *  labelling. */
export function dimInfo(result: BlockResult, name: string, totals?: Map<string, number>): DimInfo {
  const rows = result.rows || [];
  const seen = new Map<string, unknown>();
  for (const row of rows) {
    const id = valueId(row[name]);
    if (!seen.has(id)) seen.set(id, row[name] ?? null);
  }
  let values = [...seen.values()];
  const part = result.date_parts?.[name];
  if (part) {
    values.sort((a, b) => Number(a) - Number(b));
    return { name, kind: "part", part, values, label: (v) => partLabel(part, v, false), short: (v) => partLabel(part, v, true) };
  }
  if (result.time_column && name === result.time_column) {
    const grain = normalizeGrain(result.period || result.spec?.time?.grain);
    values = values.filter((v) => !blank(v)).sort((a, b) => String(a).localeCompare(String(b)));
    const text = (v: unknown, short: boolean) => {
      const d = parseDateParts(v);
      return d ? (short ? periodTick(d, grain, true) : periodLabel(d, grain)) : String(v);
    };
    return { name, kind: "time", grain, values, label: (v) => text(v, false), short: (v) => text(v, true) };
  }
  const present = values.filter((v) => !blank(v));
  const positions = present.map(scalePosition);
  const label = (v: unknown) => (blank(v) ? "(Blanks)" : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));
  if (present.length && positions.every((p) => p !== null)) {
    const pos = new Map(present.map((v, i) => [valueId(v), positions[i] as number]));
    values.sort((a, b) => (blank(a) ? 1 : blank(b) ? -1 : (pos.get(valueId(a)) as number) - (pos.get(valueId(b)) as number)));
    return { name, kind: "ordinal", values, label, short: label };
  }
  if (totals) values.sort((a, b) => Math.abs(totals.get(valueId(b)) ?? 0) - Math.abs(totals.get(valueId(a)) ?? 0) || label(a).localeCompare(label(b)));
  return { name, kind: "category", values, label, short: label };
}

/** The two (or one) dimensions a result is laid out by, time first. */
export function resultDims(result: BlockResult): string[] {
  return [...(result.time_column ? [result.time_column] : []), ...(result.dimensions || [])];
}
