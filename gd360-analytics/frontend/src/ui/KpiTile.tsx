import type { ReactNode } from "react";
import { cn } from "./cn";
import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon } from "./Icons";
import { Sparkline } from "./Sparkline";
import { TONE_CLASSES, type Tone } from "./tones";

// KPI tile (System.dc.html "KPI tile" + Main.dc.html's KPI strip). The
// anatomy is the same on every tile, top to bottom:
//   label      12 caps, one line (cut with an ellipsis, full text on hover)
//   value      28/600 (+ optional unit)
//   delta row  ONE line: the pill, then its caption ("vs prior period").
//              It never sits beside the number and never wraps.
//   sparkline  120x32, pushed to the bottom of the tile
//   caption / footnote
// A strip passes `reserveDeltaRow` so a tile with no delta keeps the row's
// height (empty) and every sparkline in the strip lands on the same line.
// The delta's colour comes from `good` (or the earlier `sentiment`) passed
// in by the caller - a cancellation rate going UP is bad, revenue going up
// is good - the tile never infers good/bad from the sign, and the
// direction arrow + text carry the meaning, never colour alone.
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
  // A shorter caption for a narrow tile ("vs prior" for "vs prior period"):
  // in a strip (`reserveDeltaRow`) the tile switches to it - on every tile
  // of the strip at once, they are all the same width - before the line
  // would have to be cut.
  captionShort?: ReactNode;
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

// The delta as plain words ("+2.1 pts worse") for a tooltip.
function deltaText(delta: KpiDelta): string {
  const body = formatDelta(delta);
  const text = typeof body === "string" || typeof body === "number" ? String(body) : "";
  return typeof delta.qualifier === "string" ? `${text} ${delta.qualifier}` : text;
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
  // The sparkline's colour (a dashboard's chart theme); default: brand primary.
  sparklineColor?: string;
  // Small source note bottom-right ("cell 5 · bookings_total").
  footnote?: ReactNode;
  loading?: boolean;
  // Keep the delta row's height even when there is no delta (see above).
  reserveDeltaRow?: boolean;
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
      className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-[1px] text-caption font-medium tabular-nums", TONE_CLASSES[tone], className)}
    >
      <Icon size={11} strokeWidth={2.4} />
      <span className="sr-only">{dirWord}{sentiment === "neutral" ? "" : `, ${sentiment}`}</span>
      {formatDelta(delta)}
      {delta.qualifier && <span className="ui-kpi-qualifier font-normal">{delta.qualifier}</span>}
    </span>
  );
}

export function KpiTile({ label, value, unit, delta, caption, sparkline, sparklineLabel, sparklineColor, footnote, loading = false, reserveDeltaRow = false, className, onClick, selected = false }: KpiTileProps) {
  const Tag = onClick ? "button" : "div";
  const hasSparkline = Boolean(sparkline && sparkline.length > 1 && !loading);
  const captionText = typeof delta?.caption === "string" ? delta.caption : undefined;
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      aria-pressed={onClick ? selected : undefined}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-card border bg-surface px-[18px] py-4 text-left shadow-card",
        // A strip tile answers to its own width (index.css .ui-kpi).
        reserveDeltaRow && "ui-kpi",
        selected ? "border-tint-border ring-1 ring-tint-border" : "border-border",
        onClick && "ui-focus cursor-pointer transition-colors hover:border-border-strong",
        className
      )}
    >
      <div data-kpi-label="" className="truncate text-caption font-medium uppercase tracking-caps text-muted" title={typeof label === "string" ? label : undefined}>{label}</div>
      {loading ? (
        <div className="ui-shimmer h-8 w-28" aria-busy="true" />
      ) : (
        <>
          {/* Proportional figures: a lone 28 px number set in tabular
              digits looks loose; tabular is for columns. */}
          <div data-kpi-value="" className="ui-kpi-value whitespace-nowrap text-kpi font-semibold tracking-[-0.01em] text-text">
            {value}
            {unit && <span className="ml-1 text-ui font-normal text-muted">{unit}</span>}
          </div>
          {(delta || reserveDeltaRow) && (
            // One line, 22 px, never cut mid-word: the row wraps and clips
            // its second line, so a caption that does not fit beside the
            // pill is simply not shown (it stays in the tooltip).
            <div data-kpi-delta-row="" className="flex h-[22px] min-w-0 flex-wrap content-start items-center gap-x-1.5 overflow-hidden" title={delta && captionText ? `${deltaText(delta)} ${captionText}` : undefined}>
              {delta && <span className="flex h-[22px] items-center"><DeltaPill delta={delta} /></span>}
              {delta?.caption && (
                <span data-kpi-delta-caption="" className="ui-kpi-cap flex h-[22px] items-center whitespace-nowrap text-caption text-muted">
                  {delta.captionShort ? (
                    <>
                      <span className="ui-kpi-cap-long">{delta.caption}</span>
                      <span className="ui-kpi-cap-short">{delta.captionShort}</span>
                    </>
                  ) : delta.caption}
                </span>
              )}
            </div>
          )}
        </>
      )}
      {(hasSparkline || reserveDeltaRow) && (
        <div data-kpi-sparkline-row="" className="mt-auto flex h-[34px] items-end pt-0.5">
          {hasSparkline && <Sparkline data={sparkline!} width={120} height={32} label={sparklineLabel} color={sparklineColor} />}
        </div>
      )}
      {(caption || footnote) && (
        <div className="flex items-baseline justify-between gap-2 text-caption text-muted">
          {caption && <span className="min-w-0 truncate">{caption}</span>}
          {footnote && <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">{footnote}</span>}
        </div>
      )}
    </Tag>
  );
}
