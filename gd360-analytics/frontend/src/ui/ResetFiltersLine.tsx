import type { ReactNode } from "react";
import { cn } from "./cn";

// "● Showing 75,166 of 119,386 rows · 3 filters · recomputed in BigQuery
// 0.9 s ago   Reset" - the one line under every filter bar that says what
// the filters did. The dot is brand when filtered, muted when showing
// everything. `Reset` is a real button and only renders when there is
// something to reset.

export type ResetFiltersLineProps = {
  shown: number;
  // null when the total is not known (the run could not count the whole
  // table): the line then says "Showing 37,518 rows", never "of" a number
  // it does not have.
  total: number | null;
  filterCount?: number;
  onReset?: () => void;
  resetLabel?: string;
  // Free-text suffix, e.g. "recomputed in BigQuery 0.9 s ago".
  note?: ReactNode;
  // Right-aligned extra (e.g. "Filters apply to every chart · Pin to URL").
  trailing?: ReactNode;
  noun?: string;
  loading?: boolean;
  className?: string;
};

const fmt = (n: number) => n.toLocaleString();

export function ResetFiltersLine({ shown, total, filterCount, onReset, resetLabel = "Reset", note, trailing, noun = "rows", loading = false, className }: ResetFiltersLineProps) {
  const filtered = (total !== null && shown !== total) || (filterCount ?? 0) > 0;
  return (
    <div role="status" aria-live="polite" className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-secondary tabular-nums", className)}>
      <span aria-hidden="true" className={cn("inline-block h-[7px] w-[7px] rounded-full", loading ? "bg-warning animate-pulse" : filtered ? "bg-primary" : "bg-faint")} />
      <span>
        Showing <strong className="font-semibold text-text">{fmt(shown)}</strong>{total !== null && <> of {fmt(total)}</>} {noun}
        {typeof filterCount === "number" && filterCount > 0 && <> · {filterCount} {filterCount === 1 ? "filter" : "filters"}</>}
        {note && <> · {note}</>}
      </span>
      {onReset && filtered && (
        <button type="button" onClick={onReset} className="ui-focus rounded px-1 font-medium text-brand-ink hover:underline">
          {resetLabel}
        </button>
      )}
      {trailing && <span className="ml-auto text-caption text-muted">{trailing}</span>}
    </div>
  );
}
