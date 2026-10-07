import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

// Buttons per System.dc.html: radius 8, 13.5/500, 36 px (md, the default)
// or 40 px (lg, page actions), hover is one step darker - never a shadow
// or a lift. `sm` is kept as an alias of md (36 px) for the first callers.
//   primary   brand fill, white text
//   secondary surface, 1 px border; hover -> subtle fill + strong border
//   ghost     transparent; hover -> subtle fill
//   danger    danger fill + ink; hover inverts to solid danger
// `loading` swaps the leading slot for a spinner and disables the button
// without changing its width noticeably; `iconOnly` makes it square and
// requires an aria-label (see IconButton.tsx, which enforces that in the
// type). `leadingIcon` is the spec's name for `icon`; both work.

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  iconOnly?: boolean;
  children?: ReactNode;
};

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-white border-primary hover:bg-primary/90 hover:border-primary/90 disabled:bg-tint-border disabled:border-tint-border disabled:text-white",
  secondary:
    "bg-surface text-text border-border hover:bg-subtle hover:border-border-strong disabled:text-faint disabled:hover:bg-surface disabled:hover:border-border",
  ghost:
    "bg-transparent text-secondary border-transparent hover:bg-subtle hover:text-text disabled:text-faint disabled:hover:bg-transparent",
  danger:
    "bg-danger-fill text-danger border-danger-border hover:bg-danger hover:border-danger hover:text-white disabled:opacity-60 disabled:hover:bg-danger-fill disabled:hover:text-danger disabled:hover:border-danger-border",
};

const SIZE: Record<ButtonSize, { base: string; square: string }> = {
  sm: { base: "h-ctl px-3.5 text-ui", square: "h-ctl w-9" },
  md: { base: "h-ctl px-3.5 text-ui", square: "h-ctl w-9" },
  lg: { base: "h-ctl-lg px-[18px] text-body", square: "h-ctl-lg w-10" },
};

export function buttonClasses(opts: { variant?: ButtonVariant; size?: ButtonSize; iconOnly?: boolean } = {}): string {
  const { variant = "secondary", size = "md", iconOnly = false } = opts;
  return cn(
    "ui-focus inline-flex items-center justify-center gap-2 rounded-ctl border font-medium whitespace-nowrap select-none",
    "transition-colors duration-100 disabled:cursor-not-allowed",
    VARIANT[variant],
    iconOnly ? cn(SIZE[size].square, "px-0") : SIZE[size].base
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon: iconProp, leadingIcon, trailingIcon, iconOnly = false, className, children, disabled, type = "button", ...rest },
  ref
) {
  const icon = iconProp ?? leadingIcon;
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonClasses({ variant, size, iconOnly }), className)}
      {...rest}
    >
      {loading ? <span className="ui-spinner" aria-hidden="true" /> : icon ? <span className="inline-flex shrink-0 [&>svg]:block">{icon}</span> : null}
      {iconOnly ? <span className="sr-only">{children}</span> : children}
      {trailingIcon && !iconOnly ? <span className="inline-flex shrink-0 [&>svg]:block">{trailingIcon}</span> : null}
    </button>
  );
});
