import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { cn } from "./cn";

// The Day · Week · Month · Year control: 30 px items inside a 36 px frame
// (md, the default - lines up with every other 36 px control) or 26 inside
// 32 (sm, the System.dc.html specimen), the selected item inverts to text-on-surface
// (System.dc.html: "selected item inverts to Text on white"), never more
// than 5 segments. A radiogroup: ArrowLeft/Right (and Up/Down) move the
// selection, Home/End jump, Space/Enter re-select the focused one.

export type SegmentOption<V extends string = string> = { value: V; label: ReactNode; icon?: ReactNode; disabled?: boolean; title?: string };

export type SegmentedControlProps<V extends string = string> = {
  options: SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  size?: "sm" | "md";
  // Stretch segments to fill the parent width (the filter rail's status control).
  fullWidth?: boolean;
  // Light-on-dark inverted style vs. a plain surface tab with a shadow.
  variant?: "invert" | "tab";
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
};

export function SegmentedControl<V extends string = string>({
  options,
  value,
  onChange,
  size = "md",
  fullWidth = false,
  variant = "invert",
  ariaLabel,
  className,
  disabled = false,
}: SegmentedControlProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled && !disabled);

  const move = (fromIdx: number, dir: 1 | -1 | "home" | "end") => {
    if (enabled.length === 0) return;
    const pos = Math.max(0, enabled.findIndex(({ i }) => i === fromIdx));
    let next: number;
    if (dir === "home") next = 0;
    else if (dir === "end") next = enabled.length - 1;
    else next = (pos + dir + enabled.length) % enabled.length;
    const target = enabled[next];
    onChange(target.o.value);
    refs.current[target.i]?.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent, idx: number) => {
    switch (e.key) {
      case "ArrowRight": case "ArrowDown": e.preventDefault(); move(idx, 1); break;
      case "ArrowLeft": case "ArrowUp": e.preventDefault(); move(idx, -1); break;
      case "Home": e.preventDefault(); move(idx, "home"); break;
      case "End": e.preventDefault(); move(idx, "end"); break;
      default: break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center rounded-ctl border border-border bg-surface p-[2px] gap-[2px]",
        variant === "tab" && "bg-subtle",
        fullWidth && "flex w-full",
        disabled && "opacity-60",
        className
      )}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        const isDisabled = disabled || !!o.disabled;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={isDisabled}
            title={o.title}
            onClick={() => { if (!selected) onChange(o.value); }}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "ui-focus inline-flex items-center justify-center gap-1.5 rounded-[6px] font-medium whitespace-nowrap transition-colors duration-100",
              size === "sm" ? "h-[26px] px-2.5 text-[12.5px]" : "h-[30px] px-3 text-[13px]",
              fullWidth && "flex-1",
              selected
                ? variant === "invert" ? "bg-text text-base" : "bg-surface text-text shadow-card"
                : "text-muted hover:text-text hover:bg-subtle",
              isDisabled && "cursor-not-allowed text-faint hover:bg-transparent hover:text-faint"
            )}
          >
            {o.icon && <span className="inline-flex [&>svg]:block">{o.icon}</span>}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
