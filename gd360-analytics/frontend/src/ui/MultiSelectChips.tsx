import { useMemo, type ReactNode } from "react";
import { CheckboxList, type CheckboxListOption } from "./CheckboxList";
import { cn } from "./cn";
import { FilterChip } from "./FilterChip";
import { ChevronDownIcon } from "./Icons";
import { inputBaseClasses, inputStateClasses } from "./Input";
import { Popover } from "./Popover";
import { Tag } from "./Tag";

// A multi-value filter: the trigger shows what's selected (first `maxVisible`
// as text or removable chips, the rest as "+N"), and opens a popover with
// search, a checkbox list with counts and "Select all / Clear".
//   variant "chip"  - a FilterChip in the filter bar: "Market: PRT, GBR +3"
//   variant "field" - a 36 px field in the filter rail (Main.dc.html):
//                     "Online TA, Offline TA/TO  +3  v"
//   variant "chips" - a field whose selected values are removable Tags
//                     with "+N more" (OptionC's parameter bar)

export type MultiSelectChipsProps = {
  options: CheckboxListOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  label?: ReactNode;
  placeholder?: ReactNode;
  variant?: "chip" | "field" | "chips";
  maxVisible?: number;
  searchPlaceholder?: string;
  width?: number | string;
  align?: "start" | "end";
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  icon?: ReactNode;
  formatCount?: (count: number | string) => ReactNode;
  // Server-side search + its loading state (see CheckboxList).
  onSearch?: (query: string) => void;
  loading?: boolean;
  // Text shown when nothing matches the search.
  emptyText?: ReactNode;
};

function optionLabel(options: CheckboxListOption[], value: string): ReactNode {
  const o = options.find((x) => x.value === value);
  return o ? (o.label ?? o.value) : value;
}

export function MultiSelectChips({
  options,
  selected,
  onChange,
  label,
  placeholder = "All",
  variant = "chip",
  maxVisible = 2,
  searchPlaceholder = "Search values",
  width = 280,
  align = "start",
  className,
  disabled = false,
  ariaLabel,
  icon,
  formatCount,
  onSearch,
  loading,
  emptyText,
}: MultiSelectChipsProps) {
  const visible = useMemo(() => selected.slice(0, maxVisible), [selected, maxVisible]);
  const overflow = Math.max(0, selected.length - visible.length);
  const active = selected.length > 0;
  const summary = visible
    .map((v) => { const l = optionLabel(options, v); return typeof l === "string" ? l : v; })
    .join(", ");
  const a11yLabel = ariaLabel || (typeof label === "string" ? label : "Filter");

  const panel = (
    <CheckboxList
      options={options}
      selected={selected}
      onChange={onChange}
      searchPlaceholder={searchPlaceholder}
      framed={false}
      ariaLabel={a11yLabel}
      formatCount={formatCount}
      onSearch={onSearch}
      loading={loading}
      emptyText={emptyText}
    />
  );

  return (
    <Popover
      align={align}
      width={variant === "chip" ? width : "trigger"}
      ariaLabel={a11yLabel}
      disabled={disabled}
      className={className}
      panelClassName={variant !== "chip" ? "min-w-[240px]" : undefined}
      trigger={(api) =>
        variant === "chip" ? (
          <FilterChip
            label={label}
            value={active ? summary : placeholder}
            count={overflow}
            active={active}
            icon={icon}
            disabled={disabled}
            onClear={active ? () => onChange([]) : undefined}
            aria-label={a11yLabel}
            {...api.props}
          />
        ) : variant === "chips" ? (
          // Removable Tags are buttons themselves, so they live NEXT to the
          // trigger button inside a field-shaped box (never nested in it).
          <div
            onClick={() => { if (!disabled) api.toggle(); }}
            className={cn(
              inputBaseClasses,
              inputStateClasses(false),
              "flex h-auto min-h-[36px] items-center justify-between gap-2 py-1 cursor-pointer",
              api.open && "border-border-strong",
              disabled && "cursor-not-allowed"
            )}
          >
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {icon && <span className="inline-flex shrink-0 text-muted [&>svg]:block">{icon}</span>}
              {!active ? (
                <span className="text-muted truncate">{placeholder}</span>
              ) : (
                <>
                  {visible.map((v) => {
                    const l = optionLabel(options, v);
                    return (
                      <Tag key={v} tone="brand" onRemove={disabled ? undefined : () => onChange(selected.filter((s) => s !== v))} removeLabel={`Remove ${typeof l === "string" ? l : v}`}>
                        {l}
                      </Tag>
                    );
                  })}
                  {overflow > 0 && <span className="text-caption text-muted">+{overflow} more</span>}
                </>
              )}
            </span>
            <button
              type="button"
              data-popover-trigger=""
              disabled={disabled}
              aria-label={`Edit ${a11yLabel}`}
              {...api.props}
              onClick={(e) => { e.stopPropagation(); api.toggle(); }}
              className="ui-focus inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-muted hover:bg-subtle hover:text-text"
            >
              <ChevronDownIcon size={14} className={cn("transition-transform", api.open && "rotate-180")} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            data-popover-trigger=""
            disabled={disabled}
            aria-label={a11yLabel}
            {...api.props}
            className={cn(
              inputBaseClasses,
              inputStateClasses(false),
              "flex items-center justify-between gap-2 text-left cursor-pointer",
              api.open && "border-border-strong"
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {icon && <span className="inline-flex shrink-0 text-muted [&>svg]:block">{icon}</span>}
              {!active ? (
                <span className="text-muted truncate">{placeholder}</span>
              ) : (
                <>
                  <span className="truncate">{summary}</span>
                  {overflow > 0 && (
                    <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-tint px-1.5 text-[11px] font-semibold text-brand-ink tabular-nums">
                      +{overflow}
                    </span>
                  )}
                </>
              )}
            </span>
            <ChevronDownIcon size={14} className={cn("shrink-0 text-muted transition-transform", api.open && "rotate-180")} />
          </button>
        )
      }
    >
      {panel}
    </Popover>
  );
}
