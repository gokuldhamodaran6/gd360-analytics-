import { forwardRef, useEffect, useRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

// Native checkbox (accent-color themed app-wide in index.css) with an
// optional label + trailing count, the row style the mockups' checkbox
// lists use. `indeterminate` is a real DOM property, not an attribute, so
// it's applied through a ref.

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> & {
  label?: ReactNode;
  count?: ReactNode;
  indeterminate?: boolean;
  description?: ReactNode;
  // 15 px (default) or 16 px.
  size?: "sm" | "md";
};

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, count, indeterminate = false, description, size = "sm", className, disabled, ...rest },
  ref
) {
  const inner = useRef<HTMLInputElement | null>(null);
  const setRef = (el: HTMLInputElement | null) => {
    inner.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) (ref as { current: HTMLInputElement | null }).current = el;
  };
  useEffect(() => { if (inner.current) inner.current.indeterminate = indeterminate; }, [indeterminate]);

  const box = (
    <input
      ref={setRef}
      type="checkbox"
      disabled={disabled}
      className={cn("ui-focus m-0 shrink-0 cursor-pointer rounded-[3px] disabled:cursor-not-allowed", size === "sm" ? "h-[15px] w-[15px]" : "h-4 w-4", !label && className)}
      {...rest}
    />
  );
  if (!label) return box;
  return (
    <label className={cn("flex items-center gap-2 text-[13px] tabular-nums cursor-pointer select-none", disabled && "text-faint cursor-not-allowed", className)}>
      {box}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {description && <span className="block text-caption text-muted">{description}</span>}
      </span>
      {count !== undefined && count !== null && <span className="ml-auto shrink-0 text-caption text-muted">{count}</span>}
    </label>
  );
});
