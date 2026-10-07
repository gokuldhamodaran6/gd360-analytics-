import type { ReactNode } from "react";
import { cn } from "./cn";
import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon } from "./Icons";
import { Sparkline } from "./Sparkline";
import { TONE_CLASSES, type Tone } from "./tones";

// KPI tile (System.dc.html "KPI tile" + Main.dc.html's KPI strip): 12 caps
// label, 28/600 tabular number (+ optional unit), a delta pill, a 12 px
// caption, optional 120x32 sparkline. The delta's colour comes from
// `good` (or the earlier `sentiment`) passed in by the caller - a
// cancellation rate going UP is bad, revenue going up is good - the tile
// never infers good/bad from the sign, and the direction arrow + text carry
// the meaning, never colour alone.
//   delta: { pct: 12.4, direction: "up", good: true, caption: "vs 2016" }
//   delta: { abs: "−1.8 pts", direction: "down", good: true }
//   delta: { label: "+12.4%", direction: "up", sentiment: "good" }  (older)

export type KpiDelta = {
  // One of: a percentage (formatted "+12.4%"), an absolute value (number ->
  // "+1,234", string as-is), or a preformatted label.
  pct?: number;
  abs?: number | string;
  label?: ReactNode;
  direction: "up" | "down" | "flat";
  // Whether this movement is good news. Omit (or sentiment "neutral") for
  // a neutral grey pill.
  good?: boolean;
  sentiment?: "good" | "bad" | "neutral";
  // Short text after the pill ("vs 2016").
  caption?: ReactNode;
  // Optional qualifier inside the pill after the number ("worse", "better").
  qualifier?: ReactNode;
};

export function formatDelta(delta: KpiDelta): ReactNode {
  if (delta.label !== undefined && delta.label !== null) return delta.label;
  if (typeof delta.pct === "number") {
    const sign = delta.pct > 0 ? "+" : delta.pct < 0 ? "−" : "";
    return `${sign}${Math.abs(delta.pct).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  }
  if (typeof delta.abs === "number") {
    const sign = delta.abs > 0 ? "+" : delta.abs < 0 ? "−" : "";
    return `${sign}${Math.abs(delta.abs).toLocaleString()}`;
  }
  if (typeof delta.abs === "string") return delta.abs;
  return delta.direction === "flat" ? "no change" : "";
}

function deltaTone(delta: KpiDelta): Tone {
  if (delta.sentiment) return SENTIMENT_TONE[delta.sentiment];
  if (delta.good === true) return "good";
  if (delta.good === false) return "danger";
  return "neutral";
}

export type KpiTileProps = {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  delta?: KpiDelta;
  caption?: ReactNode;
  sparkline?: number[];
  sparklineLabel?: string;
  // Small source note bottom-right ("cell 5 · bookings_total").
  footnote?: ReactNode;
  loading?: boolean;
  className?: string;
  onClick?: () => void;
  selected?: boolean;
};

const SENTIMENT_TONE: Record<NonNullable<KpiDelta["sentiment"]>, Tone> = { good: "good", bad: "danger", neutral: "neutral" };

export function DeltaPill({ delta, className }: { delta: KpiDelta; className?: string }) {
  const Icon = delta.direction === "up" ? ArrowUpIcon : delta.direction === "down" ? ArrowDownIcon : ArrowRightIcon;
  const dirWord = delta.direction === "up" ? "up" : delta.direction === "down" ? "down" : "flat";
  const tone = deltaTone(delta);
  const sentiment = tone === "good" ? "good" : tone === "danger" ? "bad" : "neutral";
  return (
    <span
      data-sentiment={sentiment}
      data-direction={delta.direction}
      className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-[1px] text-caption font-medium tabular-nums", TONE_CLASSES[tone], className)}
    >
      <Icon size={11} strokeWidth={2.4} />
      <span className="sr-only">{dirWord}{sentiment === "neutral" ? "" : `, ${sentiment}`}</span>
      {formatDelta(delta)}
      {delta.qualifier && <span className="font-normal">{delta.qualifier}</span>}
    </span>
  );
}

export function KpiTile({ label, value, unit, delta, caption, sparkline, sparklineLabel, footnote, loading = false, className, onClick, selected = false }: KpiTileProps) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      aria-pressed={onClick ? selected : undefined}
      className={cn(
        "flex flex-col gap-1.5 rounded-card border bg-surface px-[18px] py-4 text-left shadow-card",
        selected ? "border-tint-border ring-1 ring-tint-border" : "border-border",
        onClick && "ui-focus cursor-pointer transition-colors hover:border-border-strong",
        className
      )}
    >
      <div className="text-caption font-medium uppercase tracking-caps text-muted">{label}</div>
      {loading ? (
        <div className="ui-shimmer h-8 w-28" aria-busy="true" />
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <div className="text-kpi font-semibold tabular-nums tracking-[-0.01em] text-text">
            {value}
            {unit && <span className="ml-1 text-ui font-normal text-muted">{unit}</span>}
          </div>
          {delta && <DeltaPill delta={delta} />}
          {delta?.caption && <span className="text-caption text-muted">{delta.caption}</span>}
        </div>
      )}
      {sparkline && sparkline.length > 1 && !loading && <Sparkline data={sparkline} width={120} height={32} label={sparklineLabel} className="mt-0.5" />}
      {(caption || footnote) && (
        <div className="flex items-baseline justify-between gap-2 text-caption text-muted">
          {caption && <span className="min-w-0 truncate">{caption}</span>}
          {footnote && <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">{footnote}</span>}
        </div>
      )}
    </Tag>
  );
}
