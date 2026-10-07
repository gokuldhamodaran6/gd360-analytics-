import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

// The plain card (System.dc.html "Cards & tiles"): white surface, 1 px
// border, radius 12, the optional 0 1px 2px shadow, 16 px padding. Header /
// body / footer are fixed slots so every card in the product lines up;
// ChartCard and KpiTile are the two specialised versions.

export type CardProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title?: ReactNode;
  subtitle?: ReactNode;
  // Right-hand header slot (buttons, a pill).
  actions?: ReactNode;
  footer?: ReactNode;
  // Drop the body padding (tables, full-bleed content).
  flush?: boolean;
  // "none" removes the shadow entirely.
  shadow?: "card" | "none";
  as?: "div" | "section" | "article";
  bodyClassName?: string;
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { title, subtitle, actions, footer, flush = false, shadow = "card", as = "div", className, bodyClassName, children, ...rest },
  ref
) {
  const Tag = as;
  const hasHeader = !!(title || subtitle || actions);
  return (
    <Tag
      ref={ref}
      className={cn("flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface", shadow === "card" && "shadow-card", className)}
      {...rest}
    >
      {hasHeader && (
        <header className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2.5">
          <div className="min-w-0 flex-1">
            {title && <h3 className="truncate text-body font-semibold text-text">{title}</h3>}
            {subtitle && <div className="text-[12.5px] text-muted">{subtitle}</div>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={cn("min-w-0 flex-1", !flush && (hasHeader ? "px-4 pb-4" : "p-4"), bodyClassName)}>{children}</div>
      {footer && <footer className="border-t border-subtle px-4 py-2.5 text-caption text-muted">{footer}</footer>}
    </Tag>
  );
});
