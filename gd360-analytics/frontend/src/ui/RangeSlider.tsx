import { useId, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { cn } from "./cn";
import { NumberInput } from "./Input";

// Two-handle min/max slider (System.dc.html "Range slider · lead_time"): a
// 4 px track, the selected span in brand, two 16 px thumbs, the bounds in
// muted at the ends, the current span in the middle ("7 → 120 days"), and
// two numeric inputs underneath. Built on two native <input type="range">
// (see .ui-range-input in index.css for the stacking trick); the keyboard
// is handled explicitly - Arrow keys ± step, PageUp/PageDown ± 10 steps,
// Home/End to the bounds - so the thumbs move identically in every
// browser and a handle can never cross the other one. Value is always
// [low, high] with low <= high.

export type RangeSliderProps = {
  min: number;
  max: number;
  value: [number, number];
  onChange: (value: [number, number]) => void;
  step?: number;
  unit?: string;
  label?: ReactNode;
  // Formats the bound/current labels (defaults to toLocaleString).
  format?: (n: number) => string;
  // Show the numeric inputs (default true).
  inputs?: boolean;
  // Extra marker on the track, e.g. a median ("median 69").
  marker?: { value: number; label: ReactNode };
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
};

const defaultFormat = (n: number) => n.toLocaleString();

export function RangeSlider({
  min, max, value, onChange, step = 1, unit, label, format = defaultFormat, inputs = true, marker, disabled = false, className, ariaLabel,
}: RangeSliderProps) {
  const id = useId();
  const [low, high] = value;
  const span = Math.max(1, max - min);
  const pct = (n: number) => `${((Math.min(max, Math.max(min, n)) - min) / span) * 100}%`;
  const name = ariaLabel || (typeof label === "string" ? label : "Range");

  const setLow = (n: number) => onChange([Math.max(min, Math.min(n, high)), high]);
  const setHigh = (n: number) => onChange([low, Math.min(max, Math.max(n, low))]);

  const onThumbKey = (which: "low" | "high") => (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    const current = which === "low" ? low : high;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowRight": case "ArrowUp": next = current + step; break;
      case "ArrowLeft": case "ArrowDown": next = current - step; break;
      case "PageUp": next = current + step * 10; break;
      case "PageDown": next = current - step * 10; break;
      case "Home": next = min; break;
      case "End": next = max; break;
      default: return;
    }
    e.preventDefault();
    const rounded = Math.round(next / step) * step;
    if (which === "low") setLow(rounded);
    else setHigh(rounded);
  };

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {label && (
        <div className="flex items-center justify-between text-caption">
          <span className="font-medium text-secondary">{label}</span>
          <span className="tabular-nums text-muted">{format(low)} – {format(high)}{unit ? ` ${unit}` : ""}</span>
        </div>
      )}
      <div className="relative h-4">
        <div className="absolute inset-x-0 top-[6px] h-1 rounded-sm bg-border" />
        <div className="absolute top-[6px] h-1 rounded-sm bg-primary" style={{ left: pct(low), right: `calc(100% - ${pct(high)})` }} />
        {marker && (
          <div className="absolute top-[3px] h-[10px] w-[2px] -translate-x-1/2 rounded-full bg-faint" style={{ left: pct(marker.value) }} aria-hidden="true" />
        )}
        <input
          id={`${id}-low`}
          type="range"
          className="ui-range-input"
          min={min}
          max={max}
          step={step}
          value={low}
          disabled={disabled}
          aria-label={`${name} minimum`}
          aria-valuetext={`${format(low)}${unit ? ` ${unit}` : ""}`}
          onChange={(e) => setLow(Number(e.target.value))}
          onKeyDown={onThumbKey("low")}
          style={{ zIndex: low > max - span * 0.05 ? 3 : 2 }}
        />
        <input
          id={`${id}-high`}
          type="range"
          className="ui-range-input"
          min={min}
          max={max}
          step={step}
          value={high}
          disabled={disabled}
          aria-label={`${name} maximum`}
          aria-valuetext={`${format(high)}${unit ? ` ${unit}` : ""}`}
          onChange={(e) => setHigh(Number(e.target.value))}
          onKeyDown={onThumbKey("high")}
          style={{ zIndex: 2 }}
        />
      </div>
      <div className="flex items-center justify-between text-caption tabular-nums">
        <span className="text-muted">{format(min)}</span>
        <span className="font-medium text-text">
          {format(low)} → {format(high)}{unit ? ` ${unit}` : ""}
          {marker && <span className="ml-1.5 font-normal text-muted">· {marker.label}</span>}
        </span>
        <span className="text-muted">{format(max)}</span>
      </div>
      {inputs && (
        <div className="flex gap-2">
          <NumberInput aria-label={`${name} minimum`} value={low} min={min} max={high} step={step} disabled={disabled} onChange={(n) => { if (n !== null) setLow(n); }} className="flex-1 [&>input]:h-8 [&>input]:text-[13px]" />
          <NumberInput aria-label={`${name} maximum`} value={high} min={low} max={max} step={step} disabled={disabled} onChange={(n) => { if (n !== null) setHigh(n); }} className="flex-1 [&>input]:h-8 [&>input]:text-[13px]" />
        </div>
      )}
    </div>
  );
}
