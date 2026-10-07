import type { ReactNode } from "react";
import { cn } from "./cn";
import { DatabaseIcon, FileIcon } from "./Icons";

// Small square-ish labels (System.dc.html "Badges & pills"):
//   "new"      NEW - 10/600 caps, white on brand, radius 4, next to a column
//   "provider" BigQuery / Snowflake / Excel file - monochrome glyph, surface,
//              1 px border, radius 6 (no vendor logos)
//   "exact"    exact · COUNT(*) - brand tint, dot, radius 6
//   "sample"   sample · 20 of 119,386 rows - warning tint, radius 6
//   "neutral"  anything else at the same size

export type BadgeVariant = "new" | "provider" | "exact" | "sample" | "neutral" | "brand";

export type BadgeProps = {
  variant?: BadgeVariant;
  children?: ReactNode;
  icon?: ReactNode;
  className?: string;
  title?: string;
};

const PROVIDER_FILE = /file|csv|excel|xlsx|upload|sheet/i;

export function Badge({ variant = "neutral", children, icon, className, title }: BadgeProps) {
  if (variant === "new") {
    return (
      <span title={title} className={cn("inline-flex items-center rounded-[4px] bg-primary px-[5px] py-[1px] text-[10px] font-semibold uppercase tracking-caps text-white", className)}>
        {children ?? "New"}
      </span>
    );
  }
  const base = "inline-flex items-center gap-1.5 rounded-[6px] border px-2 py-[2px] text-caption font-medium whitespace-nowrap";
  if (variant === "provider") {
    const label = typeof children === "string" ? children : "";
    const Icon = icon ? null : PROVIDER_FILE.test(label) ? FileIcon : DatabaseIcon;
    return (
      <span title={title} className={cn(base, "border-border bg-surface text-text", className)}>
        {icon ? <span className="inline-flex [&>svg]:block">{icon}</span> : Icon ? <Icon size={13} className="text-muted" /> : null}
        {children}
      </span>
    );
  }
  const tone =
    variant === "exact" || variant === "brand"
      ? "border-tint-border bg-tint text-brand-ink"
      : variant === "sample"
        ? "border-warning-border bg-warning-fill text-warning"
        : "border-border bg-subtle text-secondary";
  return (
    <span title={title} className={cn(base, tone, variant !== "brand" && "font-normal", className)}>
      {variant === "exact" && !icon && <span aria-hidden="true" className="inline-block h-[6px] w-[6px] rounded-full bg-brand-ink" />}
      {icon && <span className="inline-flex [&>svg]:block">{icon}</span>}
      {children}
    </span>
  );
}
