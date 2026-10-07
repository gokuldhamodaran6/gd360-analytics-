// Minimal calendar-date helpers for DateRangePicker. The app has no date
// library (package.json: no date-fns/dayjs) and the picker only needs
// whole calendar days, so everything here works on "YYYY-MM-DD" strings and
// {y, m, d} parts - never on Date objects' time-of-day or timezone, which is
// how off-by-one-day bugs creep in.

export type ISODate = string; // "YYYY-MM-DD"
export type YMD = { y: number; m: number; d: number }; // m is 1..12

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

export function toISO({ y, m, d }: YMD): ISODate {
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function parseISO(s: string | null | undefined): YMD | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

export function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

// 0 = Monday ... 6 = Sunday (the mockups' calendars start on Monday).
export function weekdayMondayFirst(y: number, m: number, d: number): number {
  const js = new Date(y, m - 1, d).getDay(); // 0 = Sunday
  return (js + 6) % 7;
}

export function todayYMD(now: Date = new Date()): YMD {
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

export function addDays(date: YMD, n: number): YMD {
  const dt = new Date(date.y, date.m - 1, date.d + n);
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
}

export function addMonths(date: YMD, n: number): YMD {
  const total = date.y * 12 + (date.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return { y, m, d: Math.min(date.d, daysInMonth(y, m)) };
}

export function compareYMD(a: YMD, b: YMD): number {
  return a.y !== b.y ? a.y - b.y : a.m !== b.m ? a.m - b.m : a.d - b.d;
}

export function compareISO(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0; // zero-padded ISO sorts lexically
}

export function daysBetween(a: YMD, b: YMD): number {
  const ms = Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d);
  return Math.round(ms / 86400000);
}

export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const WEEKDAYS_MIN = ["M", "T", "W", "T", "F", "S", "S"];

// "7 Aug 2017"
export function formatYMD(d: YMD): string {
  return `${d.d} ${MONTHS_SHORT[d.m - 1]} ${d.y}`;
}

// "7 – 20 Aug 2017" / "28 Jul – 3 Aug 2017" / "Jul 2015 → Aug 2017" (if
// `monthsOnly`; `separator: "–"` gives "Jul 2015 – Aug 2017") / "All time"
// when both ends are open / "From 1 Jan 2016" / "Until 31 Dec 2016".
export function formatRange(start: ISODate | null, end: ISODate | null, opts: { monthsOnly?: boolean; separator?: string } = {}): string {
  const s = parseISO(start);
  const e = parseISO(end);
  if (!s && !e) return "All time";
  if (s && !e) return `From ${formatYMD(s)}`;
  if (!s && e) return `Until ${formatYMD(e)}`;
  if (!s || !e) return "All time";
  if (opts.monthsOnly) {
    const sep = opts.separator ?? "→";
    if (s.y === e.y && s.m === e.m) return `${MONTHS_SHORT[s.m - 1]} ${s.y}`;
    return `${MONTHS_SHORT[s.m - 1]} ${s.y} ${sep} ${MONTHS_SHORT[e.m - 1]} ${e.y}`;
  }
  if (compareYMD(s, e) === 0) return formatYMD(s);
  if (s.y === e.y && s.m === e.m) return `${s.d} – ${e.d} ${MONTHS_SHORT[s.m - 1]} ${s.y}`;
  if (s.y === e.y) return `${s.d} ${MONTHS_SHORT[s.m - 1]} – ${e.d} ${MONTHS_SHORT[e.m - 1]} ${s.y}`;
  return `${formatYMD(s)} – ${formatYMD(e)}`;
}
