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

export type DateRangePreset = { id: string; label: string; range: (today: YMD) => DateRange };

export const DEFAULT_PRESETS: DateRangePreset[] = [
  { id: "7d", label: "Last 7 days", range: (t) => ({ from: toISO(addDays(t, -6)), to: toISO(t) }) },
  { id: "30d", label: "Last 30 days", range: (t) => ({ from: toISO(addDays(t, -29)), to: toISO(t) }) },
  { id: "12m", label: "Last 12 months", range: (t) => ({ from: toISO(addDays(addMonths(t, -12), 1)), to: toISO(t) }) },
  { id: "ytd", label: "This year", range: (t) => ({ from: toISO({ y: t.y, m: 1, d: 1 }), to: toISO(t) }) },
  { id: "all", label: "All time", range: () => ({ from: null, to: null }) },
];

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
};

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
  months = 2,
  format = "days",
}: DateRangePickerProps) {
  const today = useMemo(() => parseISO(todayProp) || todayYMD(), [todayProp]);
  const [draft, setDraft] = useState<DateRange>(value);
  const [anchor, setAnchor] = useState<YMD | null>(null); // first click of a new range
  const [hover, setHover] = useState<YMD | null>(null);
  const [view, setView] = useState<YMD>(() => { const s = parseISO(value.from) || parseISO(value.to) || today; return { y: s.y, m: s.m, d: 1 }; });
  const [open, setOpen] = useState(false);

  // Resync the draft whenever the panel opens or the committed value changes.
  useEffect(() => {
    setDraft(value);
    setAnchor(null);
    const s = parseISO(value.from) || parseISO(value.to) || today;
    setView({ y: s.y, m: s.m, d: 1 });
  }, [value.from, value.to, open]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const activePresetId = presets.find((p) => { const r = p.range(today); return r.from === draft.from && r.to === draft.to; })?.id;

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
        <div className="flex w-max max-w-[calc(100vw-32px)]">
          <div className="flex w-[148px] shrink-0 flex-col gap-0.5 border-r border-border p-2">
            <div className="px-2 pb-1 pt-1 text-caption font-medium uppercase tracking-caps text-muted">Presets</div>
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { const r = p.range(today); onChange({ from: clampISO(r.from, minDate, maxDate), to: clampISO(r.to, minDate, maxDate) }); close(); }}
                className={cn(
                  "ui-focus rounded-[6px] px-2 py-1.5 text-left text-[13px] font-medium",
                  activePresetId === p.id ? "bg-tint text-brand-ink" : "text-text hover:bg-subtle"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-3 p-3">
            <div className={cn("grid gap-4", months === 2 ? "grid-cols-2" : "grid-cols-1")}>
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
            <div className="flex items-center gap-2">
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
                outside ? "text-faint" : "text-text",
                disabled && "cursor-not-allowed text-faint/60",
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
