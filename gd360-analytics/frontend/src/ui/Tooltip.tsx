import { cloneElement, isValidElement, useId, useState, type ReactElement, type ReactNode } from "react";
import { cn } from "./cn";

// A small hover/focus tooltip: 12 px text on the inverted surface, no
// arrow, appears above (or below) the child after a short delay. The child
// must accept the aria-describedby/onMouseEnter/onFocus props (any DOM
// element or a kit control). For plain text it also sets the native
// `title` as a fallback when `native` is true, so a tooltip still reads
// in environments that suppress hover (touch, print).

export type TooltipProps = {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "bottom";
  align?: "center" | "start" | "end";
  delayMs?: number;
  // Also set the native title attribute (plain-string content only).
  native?: boolean;
  disabled?: boolean;
  className?: string;
};

type HoverProps = {
  onMouseEnter?: (e: unknown) => void;
  onMouseLeave?: (e: unknown) => void;
  onFocus?: (e: unknown) => void;
  onBlur?: (e: unknown) => void;
  "aria-describedby"?: string;
  title?: string;
};

export function Tooltip({ content, children, side = "top", align = "center", delayMs = 150, native = true, disabled = false, className }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  if (!isValidElement(children)) return children;
  const child = children as ReactElement<HoverProps>;

  const show = () => {
    if (disabled) return;
    if (timer) clearTimeout(timer);
    setTimer(setTimeout(() => setOpen(true), delayMs));
  };
  const hide = () => {
    if (timer) clearTimeout(timer);
    setTimer(null);
    setOpen(false);
  };

  const childProps = child.props;
  const trigger = cloneElement(child, {
    "aria-describedby": open ? id : childProps["aria-describedby"],
    title: native && typeof content === "string" && !open ? content : childProps.title,
    onMouseEnter: (e: unknown) => { childProps.onMouseEnter?.(e); show(); },
    onMouseLeave: (e: unknown) => { childProps.onMouseLeave?.(e); hide(); },
    onFocus: (e: unknown) => { childProps.onFocus?.(e); show(); },
    onBlur: (e: unknown) => { childProps.onBlur?.(e); hide(); },
  });

  return (
    <span className={cn("relative inline-flex", className)} onKeyDown={(e) => { if (e.key === "Escape") hide(); }}>
      {trigger}
      {open && !disabled && (
        <span
          id={id}
          role="tooltip"
          className={cn(
            "pointer-events-none absolute z-50 max-w-[260px] whitespace-pre-line rounded-[6px] bg-text px-2 py-1 text-caption font-medium leading-[1.4] text-base shadow-pop",
            side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
            align === "center" ? "left-1/2 -translate-x-1/2" : align === "start" ? "left-0" : "right-0"
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
