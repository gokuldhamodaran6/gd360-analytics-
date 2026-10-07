import { forwardRef, useRef, type ChangeEvent, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn";
import { useFieldContext } from "./Field";
import { CloseIcon, SearchIcon } from "./Icons";

// Text controls per System.dc.html: 36 px tall, radius 8, 13.5 px, surface
// background, 1 px border; focus ring 2 px accent; error = danger border.
// All read the surrounding Field (id / aria-describedby / aria-invalid).

export const inputBaseClasses =
  "ui-focus h-ctl w-full min-w-0 rounded-ctl border bg-surface px-2.5 text-ui text-text placeholder:text-faint " +
  "transition-colors duration-100 disabled:cursor-not-allowed disabled:bg-subtle disabled:text-faint";

export function inputStateClasses(invalid: boolean) {
  return invalid ? "border-danger" : "border-border hover:border-border-strong focus:border-border-strong";
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; mono?: boolean };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, invalid, mono, id, ...rest }, ref) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <input
      ref={ref}
      id={id || field?.id}
      aria-describedby={rest["aria-describedby"] || field?.describedBy}
      aria-invalid={isInvalid || undefined}
      className={cn(inputBaseClasses, inputStateClasses(isInvalid), mono && "font-mono text-[12.5px]", className)}
      {...rest}
    />
  );
});

export type NumberInputProps = Omit<InputProps, "type" | "value" | "onChange"> & {
  value: number | null;
  onChange: (value: number | null) => void;
  // Optional unit shown at the right edge ("days", "%").
  unit?: ReactNode;
  // Show +/- stepper buttons (default off - most numeric filters don't want
  // them and the native spinner is hidden by .ui-number).
  stepper?: boolean;
};

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onChange, unit, stepper = false, className, invalid, min, max, step, disabled, ...rest },
  ref
) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  const clamp = (n: number) => {
    let v = n;
    if (typeof min === "number") v = Math.max(min, v);
    if (typeof max === "number") v = Math.min(max, v);
    return v;
  };
  const handle = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.trim();
    if (raw === "" || raw === "-") { onChange(null); return; }
    const n = Number(raw);
    if (Number.isNaN(n)) return;
    onChange(n);
  };
  const stepBy = (dir: 1 | -1) => {
    const s = typeof step === "number" ? step : 1;
    onChange(clamp((value ?? (typeof min === "number" ? min : 0)) + dir * s));
  };
  return (
    <div className={cn("relative flex items-center", className)}>
      <input
        ref={ref}
        type="number"
        inputMode="decimal"
        id={rest.id || field?.id}
        aria-describedby={rest["aria-describedby"] || field?.describedBy}
        aria-invalid={isInvalid || undefined}
        className={cn(inputBaseClasses, inputStateClasses(isInvalid), "ui-number tabular-nums", unit && "pr-12", stepper && "pr-14")}
        value={value === null || value === undefined ? "" : String(value)}
        onChange={handle}
        onBlur={() => { if (value !== null && value !== undefined) { const c = clamp(value); if (c !== value) onChange(c); } }}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        {...rest}
      />
      {unit && !stepper && <span className="pointer-events-none absolute right-2.5 text-caption text-muted">{unit}</span>}
      {stepper && (
        <div className="absolute right-1 flex items-center gap-0.5">
          <button type="button" tabIndex={-1} disabled={disabled} aria-label="Decrease" onClick={() => stepBy(-1)} className="ui-focus h-6 w-6 rounded-[5px] text-secondary hover:bg-subtle hover:text-text disabled:text-faint">&minus;</button>
          <button type="button" tabIndex={-1} disabled={disabled} aria-label="Increase" onClick={() => stepBy(1)} className="ui-focus h-6 w-6 rounded-[5px] text-secondary hover:bg-subtle hover:text-text disabled:text-faint">+</button>
        </div>
      )}
    </div>
  );
});

export type SearchInputProps = Omit<InputProps, "value" | "onChange" | "size"> & {
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  // Compact 32 px variant for popover headers / checkbox lists.
  size?: "sm" | "md";
  // Borderless variant for the top of a list where the box already has one.
  flush?: boolean;
};

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onChange, onClear, size = "md", flush = false, className, placeholder = "Search", invalid, ...rest },
  ref
) {
  const field = useFieldContext();
  const inner = useRef<HTMLInputElement | null>(null);
  const setRef = (el: HTMLInputElement | null) => {
    inner.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) (ref as { current: HTMLInputElement | null }).current = el;
  };
  const clear = () => {
    onChange("");
    onClear?.();
    inner.current?.focus();
  };
  return (
    <div className={cn("relative flex items-center", className)}>
      <SearchIcon size={15} className="pointer-events-none absolute left-2.5 text-muted" />
      <input
        ref={setRef}
        type="search"
        role="searchbox"
        id={rest.id || field?.id}
        aria-describedby={rest["aria-describedby"] || field?.describedBy}
        className={cn(
          inputBaseClasses,
          flush ? "border-transparent rounded-none bg-transparent hover:border-transparent focus:border-transparent" : inputStateClasses(invalid ?? field?.invalid ?? false),
          size === "sm" && "h-8 text-[13px]",
          "pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden"
        )}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && value) { e.stopPropagation(); clear(); } rest.onKeyDown?.(e); }}
        {...rest}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={clear}
          className="ui-focus absolute right-1.5 inline-flex h-6 w-6 items-center justify-center rounded-[5px] text-muted hover:bg-subtle hover:text-text"
        >
          <CloseIcon size={13} />
        </button>
      )}
    </div>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; mono?: boolean };

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, invalid, mono, id, rows = 3, ...rest }, ref) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <textarea
      ref={ref}
      id={id || field?.id}
      rows={rows}
      aria-describedby={rest["aria-describedby"] || field?.describedBy}
      aria-invalid={isInvalid || undefined}
      className={cn(inputBaseClasses, inputStateClasses(isInvalid), "h-auto min-h-[72px] py-2 leading-[1.45] resize-y", mono && "font-mono text-[12.5px]", className)}
      {...rest}
    />
  );
});
