import { cn } from "./cn";

// Loading placeholders built on the .ui-shimmer sweep (index.css): a
// `block` of any size, `text` lines (last one shorter, like real copy) and
// a `tile` that matches KpiTile's footprint so a loading KPI strip doesn't
// jump when the numbers land. Always aria-hidden - the container that
// knows what's loading sets aria-busy.

export type SkeletonProps = {
  variant?: "block" | "text" | "tile";
  width?: number | string;
  height?: number | string;
  // `text` only: number of lines.
  lines?: number;
  className?: string;
};

const px = (v: number | string | undefined) => (typeof v === "number" ? `${v}px` : v);

export function Skeleton({ variant = "block", width, height, lines = 3, className }: SkeletonProps) {
  if (variant === "text") {
    return (
      <div aria-hidden="true" className={cn("flex flex-col gap-2", className)} style={{ width: px(width) }}>
        {Array.from({ length: Math.max(1, lines) }, (_, i) => (
          <div key={i} className="ui-shimmer h-3" style={{ width: i === lines - 1 && lines > 1 ? "62%" : "100%" }} />
        ))}
      </div>
    );
  }
  if (variant === "tile") {
    return (
      <div aria-hidden="true" className={cn("flex flex-col gap-2.5 rounded-card border border-border bg-surface px-[18px] py-4", className)} style={{ width: px(width) }}>
        <div className="ui-shimmer h-3 w-24" />
        <div className="ui-shimmer h-8 w-32" />
        <div className="ui-shimmer h-3 w-40" />
      </div>
    );
  }
  return <div aria-hidden="true" className={cn("ui-shimmer", !height && "h-4", className)} style={{ width: px(width), height: px(height) }} />;
}
