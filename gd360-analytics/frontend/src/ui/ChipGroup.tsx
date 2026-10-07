import type { ReactNode } from "react";
import { cn } from "./cn";

// The row of FilterChips in a filter bar (System.dc.html "Filter bar ·
// composed"): 8 px gaps, wraps, optional leading label and a trailing slot
// for "+ Add filter" / "Reset filters". Purely layout + a group role so a
// screen reader announces the bar as one thing.

export type ChipGroupProps = {
  children: ReactNode;
  label?: ReactNode;
  trailing?: ReactNode;
  ariaLabel?: string;
  // Keep chips on one scrolling line instead of wrapping (narrow toolbars).
  nowrap?: boolean;
  className?: string;
};

export function ChipGroup({ children, label, trailing, ariaLabel = "Filters", nowrap = false, className }: ChipGroupProps) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("flex items-center gap-2", nowrap ? "overflow-x-auto whitespace-nowrap" : "flex-wrap", className)}>
      {label && <span className="mr-0.5 shrink-0 text-caption font-medium uppercase tracking-caps text-muted">{label}</span>}
      {children}
      {trailing && <span className="ml-auto flex shrink-0 items-center gap-2">{trailing}</span>}
    </div>
  );
}
