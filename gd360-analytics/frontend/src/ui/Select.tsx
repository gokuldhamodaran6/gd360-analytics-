import { forwardRef, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "./cn";
import { useFieldContext } from "./Field";
import { inputBaseClasses, inputStateClasses } from "./Input";
import { CheckIcon, ChevronDownIcon } from "./Icons";
import { Popover } from "./Popover";

// Select: the native <select> styled to the kit (keeps native keyboard nav
// and the mobile picker). MenuSelect: a popover listbox with roving focus
// for the cases a native select can't do - rich rows, an action row at the
// bottom ("Save current view..."), per-row affordances - used by
// SavedViewSelect.

export type SelectOption = { value: string; label: ReactNode; disabled?: boolean; description?: ReactNode };

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  invalid?: boolean;
  options?: SelectOption[];
  // Compact 32 px variant for toolbars.
  size?: "sm" | "md";
  // Optional inline prefix rendered inside the control ("View:").
  prefix?: ReactNode;
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ className, invalid, options, size = "md", prefix, id, children, ...rest }, ref) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  const select = (
    <select
      ref={ref}
      id={id || field?.id}
      aria-describedby={rest["aria-describedby"] || field?.describedBy}
      aria-invalid={isInvalid || undefined}
      className={cn(
        inputBaseClasses,
        inputStateClasses(isInvalid),
        "ui-select cursor-pointer pr-8 font-medium",
        size === "sm" && "h-8 text-[13px]",
        prefix && "border-0 bg-transparent pl-0 hover:border-0 focus:border-0 h-auto",
        !prefix && className
      )}
      {...rest}
    >
      {options
        ? options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {typeof o.label === "string" ? o.label : String(o.value)}
            </option>
          ))
        : children}
    </select>
  );
  if (!prefix) return select;
  return (
    <label className={cn(inputBaseClasses, inputStateClasses(isInvalid), "flex items-center gap-1.5 cursor-pointer", size === "sm" && "h-8 text-[13px]", className)}>
      <span className="text-muted shrink-0">{prefix}</span>
      {select}
    </label>
  );
});

export type MenuSelectProps = {
  options: SelectOption[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: ReactNode;
  prefix?: ReactNode;
  // Rendered below the options, separated by a rule (e.g. an action row).
  footer?: ReactNode | ((api: { close: () => void }) => ReactNode);
  // Per-option trailing slot (hover affordances like rename/delete).
  renderOptionExtra?: (option: SelectOption, api: { close: () => void }) => ReactNode;
  align?: "start" | "end";
  width?: number | string | "trigger";
  size?: "sm" | "md";
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  // Custom trigger; defaults to a select-looking button.
  trigger?: (api: { open: boolean; label: ReactNode }) => ReactNode;
};

export function MenuSelect({
  options,
  value,
  onChange,
  placeholder = "Select",
  prefix,
  footer,
  renderOptionExtra,
  align = "start",
  width = 260,
  size = "md",
  className,
  disabled,
  ariaLabel,
  trigger,
}: MenuSelectProps) {
  const selected = options.find((o) => o.value === value) || null;
  const label = selected ? selected.label : <span className="text-muted">{placeholder}</span>;
  return (
    <Popover
      align={align}
      width={width}
      haspopup="listbox"
      role="dialog"
      ariaLabel={ariaLabel}
      disabled={disabled}
      className={className}
      trigger={(api) => (
        <button
          type="button"
          data-popover-trigger=""
          disabled={disabled}
          aria-label={ariaLabel}
          {...api.props}
          className={cn(
            inputBaseClasses,
            inputStateClasses(false),
            "flex items-center justify-between gap-2 text-left font-medium cursor-pointer",
            size === "sm" && "h-8 text-[13px]",
            api.open && "border-border-strong"
          )}
        >
          {trigger ? (
            trigger({ open: api.open, label })
          ) : (
            <>
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                {prefix && <span className="text-muted shrink-0">{prefix}</span>}
                <span className="truncate">{label}</span>
              </span>
              <ChevronDownIcon size={14} className={cn("shrink-0 text-muted transition-transform", api.open && "rotate-180")} />
            </>
          )}
        </button>
      )}
    >
      {({ close }) => (
        <Listbox
          options={options}
          value={value}
          onSelect={(v) => { onChange(v); close(); }}
          renderOptionExtra={renderOptionExtra ? (o) => renderOptionExtra(o, { close }) : undefined}
          footer={typeof footer === "function" ? footer({ close }) : footer}
          ariaLabel={ariaLabel}
        />
      )}
    </Popover>
  );
}

// Roving-focus listbox: ArrowUp/Down move, Home/End jump, Enter/Space pick,
// typing a letter jumps to the next option starting with it.
export function Listbox({
  options,
  value,
  onSelect,
  renderOptionExtra,
  footer,
  ariaLabel,
}: {
  options: SelectOption[];
  value: string | null;
  onSelect: (value: string) => void;
  renderOptionExtra?: (option: SelectOption) => ReactNode;
  footer?: ReactNode;
  ariaLabel?: string;
}) {
  const enabled = options.filter((o) => !o.disabled);
  const initial = Math.max(0, enabled.findIndex((o) => o.value === value));
  const [active, setActive] = useState(initial);
  const refs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => { refs.current[active]?.focus(); }, [active]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const n = enabled.length;
    if (n === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % n); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + n) % n); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(n - 1); }
    else if (e.key === "Enter" || e.key === " ") {
      const target = e.target as HTMLElement;
      if (target.getAttribute("role") === "option") { e.preventDefault(); onSelect(enabled[active].value); }
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase();
      for (let k = 1; k <= n; k++) {
        const idx = (active + k) % n;
        const text = typeof enabled[idx].label === "string" ? (enabled[idx].label as string) : enabled[idx].value;
        if (text.toLowerCase().startsWith(ch)) { setActive(idx); break; }
      }
    }
  };

  return (
    <div onKeyDown={onKeyDown}>
      <div role="listbox" aria-label={ariaLabel} aria-activedescendant={enabled[active] ? `opt-${enabled[active].value}` : undefined} className="max-h-72 overflow-y-auto py-1.5">
        {options.length === 0 && <div className="px-3 py-2 text-caption text-muted">Nothing here yet.</div>}
        {options.map((o) => {
          const idx = enabled.indexOf(o);
          const isSelected = o.value === value;
          return (
            <div
              key={o.value}
              id={`opt-${o.value}`}
              ref={(el) => { if (idx >= 0) refs.current[idx] = el; }}
              role="option"
              aria-selected={isSelected}
              aria-disabled={o.disabled || undefined}
              tabIndex={o.disabled ? -1 : idx === active ? 0 : -1}
              onClick={() => { if (!o.disabled) onSelect(o.value); }}
              onFocus={() => { if (idx >= 0) setActive(idx); }}
              className={cn(
                "group ui-focus-inset flex items-center gap-2.5 px-3 py-2 text-ui cursor-pointer",
                o.disabled ? "text-faint cursor-not-allowed" : "hover:bg-subtle",
                isSelected && "text-brand-ink"
              )}
            >
              <span className={cn("w-4 shrink-0 inline-flex justify-center", !isSelected && "opacity-0")}>
                <CheckIcon size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate", isSelected && "font-medium")}>{o.label}</span>
                {o.description && <span className="block truncate text-caption text-muted">{o.description}</span>}
              </span>
              {renderOptionExtra && <span className="shrink-0 flex items-center gap-0.5">{renderOptionExtra(o)}</span>}
            </div>
          );
        })}
      </div>
      {footer && <div className="border-t border-border py-1.5">{footer}</div>}
    </div>
  );
}
