
// 2026-10-11 (Ask Journey): the pieces Home and every thread share - the
// Quick answer | Guided switch, the follow-up box, the GD360 mark and the
// small icons they use. One look, one behaviour, everywhere a question is
// asked (GD360 Ask Journey canvas: A1, B1-B3).
import { ReactNode, RefObject, useEffect, useRef } from "react";

export type AskMode = "quick" | "guided";

type IconProps = { size?: number; className?: string };

const stroke = (size: number, className: string, width = 2) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: width,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  className: `shrink-0 ${className}`,
});

export function BoltIcon({ size = 16, className = "" }: IconProps) {
  return <svg {...stroke(size, className)}><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>;
}

export function StepsIcon({ size = 16, className = "" }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <circle cx="5" cy="6" r="2" />
      <circle cx="5" cy="18" r="2" />
      <path d="M5 8v8M10 6h10M10 12h7M10 18h10" />
    </svg>
  );
}

export function ArrowUpIcon({ size = 18, className = "" }: IconProps) {
  return <svg {...stroke(size, className, 2.3)}><path d="M12 19V5M5 12l7-7 7 7" /></svg>;
}

export function CheckIcon({ size = 12, className = "" }: IconProps) {
  return <svg {...stroke(size, className, 3.2)}><path d="m5 12 5 5 9-10" /></svg>;
}

export function ContinueIcon({ size = 14, className = "" }: IconProps) {
  return (
    <svg {...stroke(size, className)}>
      <path d="M5 4v8a4 4 0 0 0 4 4h10" />
      <path d="m15 12 4 4-4 4" />
    </svg>
  );
}

export function GridIcon({ size = 16, className = "" }: IconProps) {
  return (
    <svg {...stroke(size, className, 1.9)}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </svg>
  );
}

export function CloseIcon({ size = 16, className = "" }: IconProps) {
  return <svg {...stroke(size, className)}><path d="M6 6l12 12M18 6 6 18" /></svg>;
}

/** GD360's mark beside its replies. */
export function GdMark({ size = 22 }: { size?: number }) {
  return (
    <span
      className="rounded-[7px] bg-kind-answer-fill text-kind-answer grid place-items-center shrink-0"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
      </svg>
    </span>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`inline-block w-4 h-4 rounded-full border-2 border-current/25 border-t-current animate-spin shrink-0 ${className}`} style={{ borderColor: "currentColor", borderTopColor: "transparent" }} aria-hidden="true" />;
}

export const MODE_HINT: Record<AskMode, string> = {
  quick: "Quick answer · one answer with its evidence, in about 20 s",
  guided: "Guided · a plan you check and approve, step by step",
};

/** Quick answer | Guided - right beside Send, on Home and in Guided threads. */
export function ModeSwitch({
  mode,
  onChange,
  size = "lg",
  disabled = false,
}: {
  mode: AskMode;
  onChange: (m: AskMode) => void;
  size?: "lg" | "sm";
  disabled?: boolean;
}) {
  const lg = size === "lg";
  const item = (m: AskMode, label: string, icon: ReactNode) => {
    const on = mode === m;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={on}
        disabled={disabled}
        data-mode={m}
        onClick={() => onChange(m)}
        className={`ui-focus inline-flex items-center rounded-full font-semibold transition-colors disabled:opacity-50 ${
          lg ? "h-9 px-3.5 sm:px-4 gap-2 text-[14.5px]" : "h-[26px] px-2.5 gap-1.5 text-[12px]"
        } ${
          on
            ? m === "quick"
              ? "bg-text text-[rgb(var(--color-base))] shadow-[0_1px_0_rgb(255_255_255/0.08)_inset]"
              : "bg-kind-analysis text-[rgb(var(--color-base))]"
            : "text-muted hover:text-text"
        }`}
      >
        {icon}
        {label}
      </button>
    );
  };
  return (
    <div
      role="radiogroup"
      aria-label="How GD360 answers"
      data-mode-switch=""
      className={`inline-flex items-center rounded-full border border-border bg-base ${lg ? "h-11 p-[3px] gap-0.5" : "h-8 p-[2px] gap-0.5"}`}
    >
      {item("quick", lg ? "Quick answer" : "Quick", <BoltIcon size={lg ? 15 : 12} />)}
      {item("guided", "Guided", <StepsIcon size={lg ? 15 : 12} />)}
    </div>
  );
}

/** Grows with what is typed, up to a few lines. */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement>, value: string, max = 220) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(max, el.scrollHeight)}px`;
  }, [ref, value, max]);
}

/** The follow-up box pinned under a thread's conversation. */
export function ThreadComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  busy = false,
  locked = false,
  mode,
  onMode,
  picker,
  context,
  error,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  busy?: boolean;
  // GD360 is still working on the last question
  locked?: boolean;
  mode?: AskMode;
  onMode?: (m: AskMode) => void;
  picker?: ReactNode;
  context?: ReactNode;
  error?: string;
  inputRef?: RefObject<HTMLTextAreaElement>;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef || own;
  useAutoGrow(ref, value, 180);
  const can = value.trim().length >= 2 && !busy && !locked;
  const ring = mode === "guided" ? "focus-within:border-kind-analysis-border" : "focus-within:border-kind-answer-border";
  return (
    <form
      className="p-3 sm:p-3.5 border-t border-border bg-base"
      onSubmit={(e) => {
        e.preventDefault();
        if (can) onSubmit();
      }}
      data-thread-composer=""
    >
      {error && <div role="alert" className="text-ui text-danger mb-2 px-1">{error}</div>}
      <div className={`rounded-[18px] border border-border-strong bg-surface transition-colors ${ring} shadow-[0_16px_40px_-28px_rgb(0_0_0/0.9)]`}>
        {context && <div className="px-2.5 pt-2.5">{context}</div>}
        <label className="sr-only" htmlFor="thread-follow-up">Ask a follow-up</label>
        <textarea
          id="thread-follow-up"
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (can) onSubmit();
            }
          }}
          placeholder={locked ? "GD360 is working on the last question…" : placeholder}
          disabled={busy}
          className="block w-full min-h-[48px] resize-none bg-transparent border-0 outline-none px-3.5 pt-3 pb-1 text-[15px] leading-[22px] text-text placeholder:text-faint"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
          <div className="min-w-0 flex-1 flex items-center">{picker}</div>
          {mode && onMode && <ModeSwitch mode={mode} onChange={onMode} size="sm" disabled={busy} />}
          <button
            type="submit"
            aria-label="Send"
            disabled={!can}
            className="ui-focus w-9 h-9 rounded-full bg-primary text-on-primary grid place-items-center shrink-0 transition-opacity disabled:opacity-35"
          >
            {busy ? <Spinner /> : <ArrowUpIcon size={16} />}
          </button>
        </div>
      </div>
    </form>
  );
}
