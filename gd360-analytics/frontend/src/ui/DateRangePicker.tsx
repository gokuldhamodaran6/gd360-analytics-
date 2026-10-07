import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";
import {
  addDays, addMonths, compareYMD, daysBetween, daysInMonth, formatRange, MONTHS_LONG, parseISO, todayYMD, toISO,
  weekdayMondayFirst, WEEKDAYS_MIN, type ISODate, type YMD,
} from "./dateUtils";
import { FilterChip } from "./FilterChip";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "./Icons";
import { Input } from "./Input";
import { inputBaseClasses, inputStateClasses } from "./Input";
import { Popover } from "./Popover";

// Closed: a chip (or 36 px field) reading "7 – 20 Aug 2017" / "All time".
// Open: presets down the left, a two-month calendar with range selection
// (first click = start, second = end, swapped if backwards, hover previews
// the range), manual ISO inputs, and Cancel / Apply. Presets apply at once;
// calendar/manual edits are a draft until Apply. Value in and out is
// {from, to} as ISO "YYYY-MM-DD" strings (null = open-ended). `format`
// picks the closed chip's wording: "days" -> "7 – 20 Aug 2017", "months"
// -> "Jul 2015 – Aug 2017" (the dashboard header's coverage chip).

export type DateRange = { from: ISODate | null; to: ISODate | null };

// `range(anchor)`: the anchor is today - or, for data that ended a while
// ago, the data's last day (see DATA_ANCHOR_AFTER_DAYS). `dataLabel` is
// what the preset is called then: "Last 30 days" of a table that stops in
// 2017 is the last 30 days OF THE DATA, and says so.
export type DateRangePreset = { id: string; label: string; range: (anchor: YMD) => DateRange; dataLabel?: string | ((anchor: YMD) => string) };

export const DEFAULT_PRESETS: DateRangePreset[] = [
  { id: "7d", label: "Last 7 days", dataLabel: "Last 7 days of data", range: (t) => ({ from: toISO(addDays(t, -6)), to: toISO(t) }) },
  { id: "30d", label: "Last 30 days", dataLabel: "Last 30 days of data", range: (t) => ({ from: toISO(addDays(t, -29)), to: toISO(t) }) },
  { id: "12m", label: "Last 12 months", dataLabel: "Last 12 months of data", range: (t) => ({ from: toISO(addDays(addMonths(t, -12), 1)), to: toISO(t) }) },
  { id: "ytd", label: "This year", dataLabel: (t) => `Latest year (${t.y})`, range: (t) => ({ from: toISO({ y: t.y, m: 1, d: 1 }), to: toISO(t) }) },
  { id: "all", label: "All time", range: () => ({ from: null, to: null }) },
];

// Data whose last day is more than this many days before today is "old":
// the presets count back from that last day instead of from today.
export const DATA_ANCHOR_AFTER_DAYS = 60;

/** What the presets count back from: today, or the data's last day when
 *  the data ended more than DATA_ANCHOR_AFTER_DAYS ago. */
export function presetAnchor(today: YMD, maxDate?: ISODate | null): { anchor: YMD; onData: boolean } {
  const max = parseISO(maxDate || null);
  if (max && compareYMD(max, today) < 0 && daysBetween(max, today) > DATA_ANCHOR_AFTER_DAYS) return { anchor: max, onData: true };
  return { anchor: today, onData: false };
}

export type DateRangePickerProps = {
  value: DateRange;
  onChange: (range: DateRange) => void;
  presets?: DateRangePreset[];
  // Bounds of the data (e.g. the table's own min/max dates); days outside
  // are disabled and "All time" is shown as these bounds in the chip when
  // `showBoundsAsAllTime` is set.
  minDate?: ISODate;
  maxDate?: ISODate;
  label?: ReactNode;
  variant?: "chip" | "field";
  // Fixed "today" for deterministic presets (tests, snapshots).
  today?: ISODate;
  align?: "start" | "end";
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  // Compact single-month calendar for narrow rails.
  months?: 1 | 2;
  // Closed-chip wording (see above).
  format?: "days" | "months";
  // Render the panel into <body> (Popover's portal mode). For a picker
  // that lives in a narrow, clipping container - the filter rail is 240 px
  // wide and the panel is ~430: without this the calendar was cut off at
  // the rail's edge.
  portal?: boolean;
};

// True on a phone-width screen. False where there is no matchMedia.
const NARROW_QUERY = "(max-width: 520px)";
function useNarrowViewport(): boolean {
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
  const [narrow, setNarrow] = useState<boolean>(read);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

function clampISO(iso: ISODate | null, min?: ISODate, max?: ISODate): ISODate | null {
  if (!iso) return iso;
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

export function DateRangePicker({
  value,
  onChange,
  presets = DEFAULT_PRESETS,
  minDate,
  maxDate,
  label = "Date range",
  variant = "chip",
  today: todayProp,
  align = "start",
  className,
  disabled = false,
  ariaLabel,
  months: monthsProp = 2,
  format = "days",
  portal = false,
}: DateRangePickerProps) {
  // 2026-10-07 (round 9): on a phone the panel is one month with the
  // presets as a wrapping row above it. Side by side it was ~400 px wide -
  // wider than a 390 px screen, so the calendar's last columns and the end
  // date were cut off inside the filters sheet.
  const narrow = useNarrowViewport();
  const months = narrow ? 1 : monthsProp;
  const today = useMemo(() => parseISO(todayProp) || todayYMD(), [todayProp]);
  // The first month the calendar shows. With a value: the value's month.
  // Without one: the month the DATA ends in (2026-10-07 - it used to open
  // on today's month, a page of disabled days for a table that stops in
  // 2017), placed last when two months are shown so both are inside the
  // data; today's month only when the data's range is not known.
  const homeView = (): YMD => {
    const picked = parseISO(value.from) || parseISO(value.to);
    if (picked) return { y: picked.y, m: picked.m, d: 1 };
    const max = parseISO(maxDate);
    if (max) {
      const min = parseISO(minDate);
      const first = addMonths({ y: max.y, m: max.m, d: 1 }, -(months - 1));
      // A table that lives inside one month: that month first.
      return min && compareYMD(first, { y: min.y, m: min.m, d: 1 }) < 0 ? { y: min.y, m: min.m, d: 1 } : first;
    }
    return { y: today.y, m: today.m, d: 1 };
  };
  const [draft, setDraft] = useState<DateRange>(value);
  const [anchor, setAnchor] = useState<YMD | null>(null); // first click of a new range
  const [hover, setHover] = useState<YMD | null>(null);
  const [view, setView] = useState<YMD>(homeView);
  const [open, setOpen] = useState(false);

  // Resync the draft whenever the panel opens, the committed value changes
  // or the data's bounds arrive.
  useEffect(() => {
    setDraft(value);
    setAnchor(null);
    setView(homeView());
  }, [value.from, value.to, open, minDate, maxDate]); // eslint-disable-line react-hooks/exhaustive-deps
  const preset = useMemo(() => presetAnchor(today, maxDate), [today, maxDate]);
  const presetLabel = (p: DateRangePreset) => (preset.onData && p.dataLabel ? (typeof p.dataLabel === "function" ? p.dataLabel(preset.anchor) : p.dataLabel) : p.label);
  const presetRange = (p: DateRangePreset): DateRange => { const r = p.range(preset.anchor); return { from: clampISO(r.from, minDate, maxDate), to: clampISO(r.to, minDate, maxDate) }; };

  const active = !!(value.from || value.to);
  const a11yLabel = ariaLabel || (typeof label === "string" ? label : "Date range");
  const minY = parseISO(minDate);
  const maxY = parseISO(maxDate);
  const isDisabledDay = (d: YMD) => (minY && compareYMD(d, minY) < 0) || (maxY && compareYMD(d, maxY) > 0) || false;

  const pickDay = (d: YMD) => {
    if (isDisabledDay(d)) return;
    if (!anchor) {
      setAnchor(d);
      setDraft({ from: toISO(d), to: null });
      return;
    }
    const [s, e] = compareYMD(d, anchor) < 0 ? [d, anchor] : [anchor, d];
    setDraft({ from: toISO(s), to: toISO(e) });
    setAnchor(null);
  };

  // The range to paint: committed draft, or anchor->hover while picking.
  const paint = useMemo(() => {
    if (anchor && hover) {
      const [s, e] = compareYMD(hover, anchor) < 0 ? [hover, anchor] : [anchor, hover];
      return { s, e };
    }
    const s = parseISO(draft.from);
    const e = parseISO(draft.to);
    return { s, e };
  }, [anchor, hover, draft]);

  const activePresetId = presets.find((p) => { const r = presetRange(p); return r.from === draft.from && r.to === draft.to; })?.id;

  const summaryText = (() => {
    const s = parseISO(draft.from), e = parseISO(draft.to);
    if (s && e) return `${formatRange(draft.from, draft.to)} · ${daysBetween(s, e) + 1} days`;
    if (s && anchor) return `${formatRange(draft.from, null)} · pick an end date`;
    return formatRange(draft.from, draft.to);
  })();

  const chipText = formatRange(value.from, value.to, { monthsOnly: format === "months", separator: "–" });

  return (
    <Popover
      align={align}
      ariaLabel={a11yLabel}
      disabled={disabled}
      className={className}
      onOpenChange={setOpen}
      autoFocus={false}
      portal={portal}
      trigger={(api) =>
        variant === "chip" ? (
          <FilterChip
            icon={<CalendarIcon size={14} />}
            value={chipText}
            active={active}
            tabular
            disabled={disabled}
            onClear={active ? () => onChange({ from: null, to: null }) : undefined}
            aria-label={`${a11yLabel}: ${chipText}`}
            {...api.props}
          />
        ) : (
          <button
            type="button"
            data-popover-trigger=""
            disabled={disabled}
            aria-label={`${a11yLabel}: ${chipText}`}
            {...api.props}
            className={cn(inputBaseClasses, inputStateClasses(false), "flex items-center gap-2 text-left tabular-nums cursor-pointer", api.open && "border-border-strong")}
          >
            <CalendarIcon size={15} className="shrink-0 text-muted" />
            <span className="truncate">{chipText}</span>
          </button>
        )
      }
    >
      {({ close }) => (
        <div className={cn("flex", narrow ? "w-[min(326px,calc(100vw-48px))] flex-col" : "w-max max-w-[calc(100vw-32px)]")} data-layout={narrow ? "stacked" : "side"}>
          <div
            className={cn("flex shrink-0 gap-0.5 border-border p-2", narrow ? "flex-row flex-wrap border-b" : "flex-col border-r", !narrow && (preset.onData ? "w-[176px]" : "w-[148px]"))}
            data-preset-anchor={preset.onData ? "data" : "today"}
          >
            <div className={cn("px-2 pb-1 pt-1 text-caption font-medium uppercase tracking-caps text-muted", narrow && "w-full")}>Presets</div>
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                data-preset={p.id}
                onClick={() => { onChange(presetRange(p)); close(); }}
                className={cn(
                  "ui-focus whitespace-nowrap rounded-[6px] px-2 py-1.5 text-left text-[13px] font-medium",
                  activePresetId === p.id ? "bg-tint text-brand-ink" : "text-text hover:bg-subtle"
                )}
              >
                {presetLabel(p)}
              </button>
            ))}
            {preset.onData && maxDate && (
              <div className={cn("px-2 pb-1 text-[11.5px] leading-snug text-muted", narrow ? "w-full pt-1" : "mt-auto pt-2")} data-preset-note="">
                The data ends {formatRange(maxDate, maxDate)}.
              </div>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-3 p-3">
            <div className={cn("grid gap-4", months === 2 ? "grid-cols-2" : "grid-cols-1", narrow && "justify-items-center")}>
              {Array.from({ length: months }, (_, i) => addMonths(view, i)).map((mv, i) => (
                <MonthGrid
                  key={`${mv.y}-${mv.m}`}
                  year={mv.y}
                  month={mv.m}
                  today={today}
                  rangeStart={paint.s}
                  rangeEnd={paint.e}
                  isDisabled={isDisabledDay}
                  onPick={pickDay}
                  onHover={setHover}
                  showPrev={i === 0}
                  showNext={i === months - 1}
                  onPrev={() => setView((v) => addMonths(v, -1))}
                  onNext={() => setView((v) => addMonths(v, 1))}
                />
              ))}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <Input
                type="date"
                aria-label="Start date"
                value={draft.from || ""}
                min={minDate}
                max={draft.to || maxDate}
                onChange={(e) => { const v = e.target.value || null; setDraft((d) => ({ from: v, to: d.to && v && d.to < v ? v : d.to })); setAnchor(null); if (v) { const p = parseISO(v); if (p) setView({ y: p.y, m: p.m, d: 1 }); } }}
                className="h-8 text-[13px] tabular-nums"
              />
              <span className="text-muted">–</span>
              <Input
                type="date"
                aria-label="End date"
                value={draft.to || ""}
                min={draft.from || minDate}
                max={maxDate}
                onChange={(e) => { const v = e.target.value || null; setDraft((d) => ({ from: d.from && v && d.from > v ? v : d.from, to: v })); setAnchor(null); }}
                className="h-8 text-[13px] tabular-nums"
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-subtle pt-2.5 text-caption tabular-nums">
              <span className="text-secondary">{summaryText}</span>
              <div className="flex gap-1.5">
                <Button size="sm" variant="secondary" className="h-7 px-2.5 text-caption" onClick={close}>Cancel</Button>
                <Button
                  size="sm"
                  variant="primary"
                  className="h-7 px-2.5 text-caption"
                  disabled={!!anchor && !draft.to}
                  onClick={() => { onChange({ from: draft.from, to: draft.to }); close(); }}
                >
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Popover>
  );
}

function MonthGrid({
  year, month, today, rangeStart, rangeEnd, isDisabled, onPick, onHover, showPrev, showNext, onPrev, onNext,
}: {
  year: number; month: number; today: YMD;
  rangeStart: YMD | null; rangeEnd: YMD | null;
  isDisabled: (d: YMD) => boolean;
  onPick: (d: YMD) => void; onHover: (d: YMD | null) => void;
  showPrev: boolean; showNext: boolean; onPrev: () => void; onNext: () => void;
}) {
  const lead = weekdayMondayFirst(year, month, 1);
  const count = daysInMonth(year, month);
  const prev = addMonths({ y: year, m: month, d: 1 }, -1);
  const prevCount = daysInMonth(prev.y, prev.m);
  const cells: { d: YMD; outside: boolean }[] = [];
  for (let i = lead - 1; i >= 0; i--) cells.push({ d: { y: prev.y, m: prev.m, d: prevCount - i }, outside: true });
  for (let d = 1; d <= count; d++) cells.push({ d: { y: year, m: month, d }, outside: false });
  const next = addMonths({ y: year, m: month, d: 1 }, 1);
  for (let d = 1; cells.length % 7 !== 0; d++) cells.push({ d: { y: next.y, m: next.m, d }, outside: true });

  const inRange = (d: YMD) => rangeStart && rangeEnd && compareYMD(d, rangeStart) >= 0 && compareYMD(d, rangeEnd) <= 0;
  const isStart = (d: YMD) => rangeStart && compareYMD(d, rangeStart) === 0;
  const isEnd = (d: YMD) => rangeEnd && compareYMD(d, rangeEnd) === 0;

  return (
    <div className="w-[224px]" onMouseLeave={() => onHover(null)}>
      <div className="flex items-center justify-between pb-1.5 text-[13px] font-medium">
        <button type="button" aria-label="Previous month" onClick={onPrev} className={cn("ui-focus inline-flex h-6 w-6 items-center justify-center rounded-[6px] text-muted hover:bg-subtle hover:text-text", !showPrev && "invisible")}>
          <ChevronLeftIcon size={14} />
        </button>
        <span>{MONTHS_LONG[month - 1]} {year}</span>
        <button type="button" aria-label="Next month" onClick={onNext} className={cn("ui-focus inline-flex h-6 w-6 items-center justify-center rounded-[6px] text-muted hover:bg-subtle hover:text-text", !showNext && "invisible")}>
          <ChevronRightIcon size={14} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-y-[2px] text-center text-[11px] uppercase tracking-caps text-muted" aria-hidden="true">
        {WEEKDAYS_MIN.map((w, i) => <div key={i} className="h-5 leading-5">{w}</div>)}
      </div>
      <div role="grid" aria-label={`${MONTHS_LONG[month - 1]} ${year}`} className="grid grid-cols-7 gap-y-[2px] text-caption tabular-nums">
        {cells.map(({ d, outside }) => {
          const disabled = isDisabled(d);
          const start = isStart(d), end = isEnd(d), within = inRange(d);
          const isToday = compareYMD(d, today) === 0;
          return (
            <button
              key={toISO(d)}
              type="button"
              role="gridcell"
              aria-selected={!!(start || end) || undefined}
              aria-label={toISO(d)}
              data-date={toISO(d)}
              disabled={disabled}
              onClick={() => onPick(d)}
              onMouseEnter={() => onHover(d)}
              onFocus={() => onHover(d)}
              className={cn(
                "ui-focus-inset h-[26px] leading-[26px] transition-colors",
                // A day outside the data reads as unavailable. (It used to
                // carry both text-text and text-faint/60 - the second is not
                // a class Tailwind can build from a CSS-variable colour, so a
                // disabled day looked exactly like an enabled one.)
                disabled ? "cursor-not-allowed text-faint opacity-40" : outside ? "text-faint" : "text-text",
                within && !start && !end && "bg-tint text-brand-ink",
                (start || end) && "bg-primary font-semibold text-white",
                start && !end && "rounded-l-[6px]",
                end && !start && "rounded-r-[6px]",
                start && end && "rounded-[6px]",
                !within && !start && !end && !disabled && "hover:bg-subtle rounded-[6px]",
                isToday && !start && !end && "underline underline-offset-2 decoration-brand-ink"
              )}
            >
              {d.d}
            </button>
          );
        })}
      </div>
    </div>
  );
}
