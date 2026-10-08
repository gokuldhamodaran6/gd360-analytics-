import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";
import { ChevronDownIcon, CloseIcon } from "./Icons";

// The filter-bar chip (System.dc.html "Chip states"): 32 px pill, 13/500,
// "Label:" in muted + value in text; active = brand tint + tint border +
// brand ink; a `count` renders the "+3" badge; `onClear` renders a small
// clear affordance inside the chip (a real button, so it's reachable by
// keyboard and never only visible on hover). The chip itself is a button
// that opens whatever popover the caller wires it to (spread the Popover
// trigger api's `props`).

export type FilterChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value"> & {
  label?: ReactNode;
  value?: ReactNode;
  count?: number;
  active?: boolean;
  icon?: ReactNode;
  caret?: boolean;
  onClear?: () => void;
  clearLabel?: string;
  // Dashed "+ Add filter" affordance.
  dashed?: boolean;
  // Numbers inside (date ranges) read better tabular.
  tabular?: boolean;
  // A control of its own at the chip's left edge (a colour swatch that
  // opens a picker): rendered BESIDE the chip's button, never inside it.
  leading?: ReactNode;
};

export const FilterChip = forwardRef<HTMLButtonElement, FilterChipProps>(function FilterChip(
  { label, value, count, active = false, icon, caret = true, onClear, clearLabel = "Clear filter", dashed = false, tabular = false, leading, className, children, disabled, ...rest },
  ref
) {
  const showClear = !!onClear && active;
  return (
    <span className={cn("relative inline-flex items-center", className)}>
      <button
        ref={ref}
        type="button"
        data-popover-trigger=""
        disabled={disabled}
        className={cn(
          "ui-focus inline-flex h-chip items-center gap-1.5 rounded-full border text-[13px] font-medium whitespace-nowrap transition-colors duration-100",
          leading ? "pl-7 pr-2.5" : "pl-3 pr-2.5",
          dashed
            ? "border-dashed border-border-strong bg-transparent text-secondary hover:bg-subtle hover:text-text"
            : active
              ? "border-tint-border bg-tint text-brand-ink hover:border-brand-ink/40"
              : "border-border bg-surface text-text hover:border-border-strong hover:bg-subtle",
          showClear && "pr-8",
          tabular && "tabular-nums",
          disabled && "cursor-not-allowed opacity-60"
        )}
        {...rest}
      >
        {icon && <span className="inline-flex shrink-0 [&>svg]:block">{icon}</span>}
        {label && <span className={cn("shrink-0", active ? "text-brand-ink/75" : "text-muted")}>{label}{value !== undefined && value !== null && value !== "" ? ":" : ""}</span>}
        {value !== undefined && value !== null && value !== "" && <span className="truncate max-w-[220px]">{value}</span>}
        {children}
        {typeof count === "number" && count > 0 && (
          <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-on-primary tabular-nums">
            +{count}
          </span>
        )}
        {caret && !dashed && <ChevronDownIcon size={13} className={cn("shrink-0", active ? "text-brand-ink/80" : "text-muted")} />}
      </button>
      {leading && <span className="absolute left-[5px] inline-flex items-center">{leading}</span>}
      {showClear && (
        <button
          type="button"
          aria-label={clearLabel}
          title={clearLabel}
          onClick={(e) => { e.stopPropagation(); onClear?.(); }}
          className="ui-focus absolute right-2 inline-flex h-4 w-4 items-center justify-center rounded-full bg-tint-border text-brand-ink hover:bg-brand-ink hover:text-white"
        >
          <CloseIcon size={10} strokeWidth={2.4} />
        </button>
      )}
    </span>
  );
});
