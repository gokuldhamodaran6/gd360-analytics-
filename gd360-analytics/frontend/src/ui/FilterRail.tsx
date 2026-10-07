import { useState, type ReactNode } from "react";
import { cn } from "./cn";
import { ChevronDownIcon, FilterIcon } from "./Icons";
import { ResetFiltersLine, type ResetFiltersLineProps } from "./ResetFiltersLine";

// The 260 px left filter rail (Main.dc.html): "FILTERS" title with a filter
// glyph, sections stacked with 20 px gaps - each a 12 caps label plus a
// control slot (SegmentedControl, MultiSelect, OptionSearch, RangeSlider,
// CheckboxList, DateRangePicker) - and a footer that is normally the
// "Showing N of M rows · Reset" line plus "Filters apply to every chart ·
// Pin to URL". On narrow screens (`collapsible`) the rail becomes a
// disclosure the page can show/hide; the page owns that state.

export type FilterRailSectionProps = {
  label: ReactNode;
  children: ReactNode;
  // Right-hand slot next to the label (a count, a "Clear" link).
  trailing?: ReactNode;
  // Collapsible section (closed by default when `defaultOpen` is false).
  collapsible?: boolean;
  defaultOpen?: boolean;
  id?: string;
  className?: string;
};

export function FilterRailSection({ label, children, trailing, collapsible = false, defaultOpen = true, id, className }: FilterRailSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const labelEl = <span className="text-caption font-medium uppercase tracking-caps text-muted">{label}</span>;
  return (
    <section id={id} className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2">
        {collapsible ? (
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="ui-focus -ml-1 inline-flex items-center gap-1 rounded px-1 text-left hover:text-text">
            {labelEl}
            <ChevronDownIcon size={12} className={cn("text-muted transition-transform", !open && "-rotate-90")} />
          </button>
        ) : (
          labelEl
        )}
        {trailing && <span className="text-caption text-muted">{trailing}</span>}
      </div>
      {(!collapsible || open) && <div className="flex flex-col gap-2">{children}</div>}
    </section>
  );
}

export type FilterRailProps = {
  children: ReactNode;
  title?: ReactNode;
  // Right of the title (an icon button, a count pill).
  titleExtra?: ReactNode;
  // Either pass the ResetFiltersLine props (`summary`) or a free `footer`.
  summary?: ResetFiltersLineProps;
  footer?: ReactNode;
  // Second footer line, e.g. "Filters apply to every chart · Pin to URL".
  note?: ReactNode;
  width?: number;
  // Make the rail scroll on its own inside a full-height layout.
  sticky?: boolean;
  className?: string;
  ariaLabel?: string;
};

export function FilterRail({ children, title = "Filters", titleExtra, summary, footer, note, width = 260, sticky = true, className, ariaLabel = "Filters" }: FilterRailProps) {
  return (
    <aside
      aria-label={ariaLabel}
      style={{ width: `${width}px`, minWidth: `${width}px` }}
      className={cn(
        "flex shrink-0 flex-col gap-5 border-r border-border bg-surface px-5 pb-4 pt-5",
        sticky && "sticky top-0 max-h-screen overflow-y-auto",
        className
      )}
    >
      <div className="flex items-center justify-between">
        <h2 className="inline-flex items-center gap-1.5 text-caption font-semibold uppercase tracking-caps text-secondary">
          <FilterIcon size={13} className="text-muted" />
          {title}
        </h2>
        {titleExtra}
      </div>
      <div className="flex flex-col gap-5">{children}</div>
      {(summary || footer || note) && (
        <div className="mt-auto flex flex-col gap-2 border-t border-subtle pt-3">
          {summary && <ResetFiltersLine {...summary} />}
          {footer}
          {note && <div className="text-caption text-muted">{note}</div>}
        </div>
      )}
    </aside>
  );
}

FilterRail.Section = FilterRailSection;
