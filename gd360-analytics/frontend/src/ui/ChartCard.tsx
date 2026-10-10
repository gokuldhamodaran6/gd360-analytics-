import type { ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";
import { ComputedIn, type ComputedInProps } from "./ComputedIn";
import { RefreshIcon, WarningIcon } from "./Icons";

// The chart-card frame (System.dc.html "Chart card"): header with 14/600
// title + 12.5 muted subtitle (the measure and the filter it reflects) and
// a right toolbar of 28-30 px buttons; a body slot; a footer slot. Pass
// `computed={{ provider, rows, durationMs, cached }}` and the footer
// defaults to <ComputedIn/> ("Computed in BigQuery · 119,386 rows · 0.8 s");
// an explicit `footer` wins.
// `loading` shows a shimmer placeholder in the body (the header stays, so
// the page never jumps); `error` swaps the body for the danger state with
// an optional Retry.

export type ChartCardProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  toolbar?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  // Default footer: the ComputedIn line.
  computed?: ComputedInProps | null;
  loading?: boolean;
  error?: ReactNode;
  onRetry?: () => void;
  // Fixed body height (px) so loading/error/body don't reflow the grid.
  bodyHeight?: number | string;
  // Remove the body's default 16 px side padding (tables, full-bleed).
  flush?: boolean;
  // Leading mark in the header (a cell number, a kind icon).
  leading?: ReactNode;
  className?: string;
  bodyClassName?: string;
  // Extra classes on the header row (the dashboard editor marks it as the
  // card's drag handle).
  headerClassName?: string;
  id?: string;
  // Rendered as a <section> labelled by its title.
  as?: "section" | "div" | "article";
};

export function ChartCard({
  title, subtitle, toolbar, children, footer: footerProp, computed, loading = false, error, onRetry, bodyHeight, flush = false, leading, className, bodyClassName, headerClassName, id, as = "section",
}: ChartCardProps) {
  const Tag = as;
  const footer = footerProp !== undefined ? footerProp : computed ? <ComputedIn {...computed} /> : undefined;
  const bodyStyle = bodyHeight !== undefined ? { height: typeof bodyHeight === "number" ? `${bodyHeight}px` : bodyHeight } : undefined;
  return (
    <Tag id={id} data-pdf-block="" aria-busy={loading || undefined} className={cn("flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card", className)}>
      <header className={cn("flex items-start justify-between gap-3 px-4 pb-2.5 pt-3.5", headerClassName)}>
        <div className="flex min-w-0 items-start gap-2.5">
          {leading && <span className="mt-0.5 shrink-0">{leading}</span>}
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="truncate text-body font-semibold text-text">{title}</h3>
            {subtitle && <div className="text-[12.5px] text-muted">{subtitle}</div>}
          </div>
        </div>
        {toolbar && <div className="flex shrink-0 items-center gap-1" data-pdf-exclude="">{toolbar}</div>}
      </header>
      <div className={cn("relative min-h-0 flex-1", !flush && "px-4 pb-3", bodyClassName)} style={bodyStyle}>
        {error ? (
          <div role="alert" className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 rounded-ctl border border-danger-border bg-danger-fill px-4 py-6 text-center">
            <WarningIcon size={18} className="text-danger" />
            <div className="text-ui font-medium text-danger">{typeof error === "boolean" ? "This chart couldn't be computed." : error}</div>
            {onRetry && <Button size="sm" variant="secondary" icon={<RefreshIcon size={14} />} onClick={onRetry} className="mt-1 h-8 text-caption">Retry</Button>}
          </div>
        ) : loading ? (
          <ChartShimmer />
        ) : (
          children
        )}
      </div>
      {footer && <footer className="border-t border-subtle">{footer}</footer>}
    </Tag>
  );
}

// Placeholder bars in the body while a query runs.
export function ChartShimmer({ className }: { className?: string }) {
  const heights = [42, 58, 67, 75, 83, 75, 92, 100, 75, 75, 50, 42];
  return (
    <div className={cn("flex h-full min-h-[120px] items-end gap-1.5 pt-2", className)} aria-hidden="true">
      {heights.map((h, i) => (
        <div key={i} className="ui-shimmer flex-1" style={{ height: `${h}%`, borderRadius: "3px 3px 0 0" }} />
      ))}
    </div>
  );
}

export type ComputedFooterProps = {
  provider?: string; // "BigQuery", "Snowflake", "Postgres", "file"
  rows?: number | null;
  seconds?: number | null;
  // "exact" | "sample" | custom text after the row count ("sample of 20")
  precision?: ReactNode;
  // Right-hand slot ("Jan → Dec · peak Aug 12%").
  trailing?: ReactNode;
  // Override the leading verb ("Ran in", "Cached from").
  verb?: string;
  cached?: boolean;
  className?: string;
};

// Earlier name of ComputedIn (seconds instead of durationMs). Kept so
// nothing has to change; new code uses ComputedIn. `verb` is accepted for
// compatibility but the line always reads "Computed in" / "Cached from".
export function ComputedFooter({ provider = "BigQuery", rows, seconds, precision, trailing, cached = false, className }: ComputedFooterProps) {
  return (
    <ComputedIn
      provider={provider}
      rows={rows}
      durationMs={typeof seconds === "number" ? seconds * 1000 : undefined}
      precision={precision}
      trailing={trailing}
      cached={cached}
      className={className}
    />
  );
}
