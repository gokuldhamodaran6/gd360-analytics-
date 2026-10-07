import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { cn } from "./cn";

// A square icon-only button (System.dc.html: "icon-only buttons carry
// aria-label"). `aria-label` is REQUIRED by the type - there is no way to
// render one without a name. Sizes: sm 28 px (chart-card toolbars), md 36,
// lg 40. Defaults to the ghost variant since most icon buttons sit inside a
// card header or a table row.

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & {
  "aria-label": string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: "sm" | ButtonSize;
  loading?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, variant = "ghost", size = "md", loading, className, title, ...rest },
  ref
) {
  const label = rest["aria-label"];
  if (size === "sm") {
    return (
      <Button
        ref={ref}
        variant={variant}
        size="md"
        iconOnly
        loading={loading}
        icon={icon}
        title={title ?? label}
        className={cn("h-7 w-7 rounded-[6px] [&>span>svg]:h-4 [&>span>svg]:w-4", className)}
        {...rest}
      >
        {label}
      </Button>
    );
  }
  return (
    <Button ref={ref} variant={variant} size={size} iconOnly loading={loading} icon={icon} title={title ?? label} className={className} {...rest}>
      {label}
    </Button>
  );
});
