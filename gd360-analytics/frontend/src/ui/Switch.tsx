import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

// A real role="switch" button (Space/Enter toggle natively), 36x20 track,
// 16 px knob, brand fill when on. Label optional, left or right.

export type SwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "type"> & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  labelPosition?: "left" | "right";
  description?: ReactNode;
};

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, label, labelPosition = "right", description, className, disabled, id, ...rest },
  ref
) {
  const control = (
    <button
      ref={ref}
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "ui-focus relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150",
        checked ? "bg-primary border-primary" : "bg-border border-border",
        disabled && "opacity-50 cursor-not-allowed",
        !label && className
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn("absolute top-[1px] left-[1px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150", checked && "translate-x-4")}
      />
    </button>
  );
  if (!label) return control;
  return (
    <label className={cn("inline-flex items-center gap-2.5 text-ui cursor-pointer select-none", disabled && "cursor-not-allowed text-faint", className)}>
      {labelPosition === "left" && <span className="min-w-0">{label}</span>}
      {control}
      {labelPosition === "right" && (
        <span className="min-w-0">
          <span className="block">{label}</span>
          {description && <span className="block text-caption text-muted">{description}</span>}
        </span>
      )}
    </label>
  );
});
