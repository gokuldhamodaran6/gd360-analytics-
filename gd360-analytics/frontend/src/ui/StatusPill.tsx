import type { ReactNode } from "react";
import { cn } from "./cn";
import { CheckIcon, CloseIcon, InfoIcon, WarningIcon } from "./Icons";
import { TONE_CLASSES, TONE_DOT_CLASSES, type Tone } from "./tones";

// "● Connected" / "▲ Profiling stale" / "✕ Query failed": 12/500, radius
// 999, status fill + ink + border, ALWAYS an icon or dot plus a label -
// colour is never the only carrier. `icon="dot"` (default) draws the
// mockups' 6 px dot; `icon="glyph"` swaps in check / warning / close / info
// by tone; or pass your own ReactNode.

export type StatusPillProps = {
  tone?: Tone;
  children: ReactNode;
  icon?: "dot" | "glyph" | ReactNode;
  size?: "sm" | "md";
  // Radius 6 variant for use inside tiles and table headers (System:
  // "Precision" badges).
  square?: boolean;
  pulse?: boolean;
  className?: string;
  title?: string;
};

const GLYPH: Record<Tone, (p: { size: number }) => ReactNode> = {
  good: (p) => <CheckIcon size={p.size} />,
  warning: (p) => <WarningIcon size={p.size} />,
  danger: (p) => <CloseIcon size={p.size} strokeWidth={2.2} />,
  neutral: (p) => <InfoIcon size={p.size} />,
  brand: (p) => <CheckIcon size={p.size} />,
};

export function StatusPill({ tone = "neutral", children, icon = "dot", size = "sm", square = false, pulse = false, className, title }: StatusPillProps) {
  const glyphSize = size === "sm" ? 12 : 13;
  return (
    <span
      data-tone={tone}
      title={title}
      className={cn(
        "inline-flex items-center gap-[5px] border font-medium whitespace-nowrap",
        square ? "rounded-[6px]" : "rounded-full",
        size === "sm" ? "px-[9px] py-[2px] text-caption" : "px-2.5 py-[3px] text-[13px]",
        TONE_CLASSES[tone],
        className
      )}
    >
      {icon === "dot" ? (
        <span aria-hidden="true" className={cn("inline-block h-[6px] w-[6px] shrink-0 rounded-full", TONE_DOT_CLASSES[tone], pulse && "animate-pulse")} />
      ) : icon === "glyph" ? (
        <span className="inline-flex shrink-0 [&>svg]:block">{GLYPH[tone]({ size: glyphSize })}</span>
      ) : (
        <span className="inline-flex shrink-0 [&>svg]:block">{icon}</span>
      )}
      <span>{children}</span>
    </span>
  );
}
