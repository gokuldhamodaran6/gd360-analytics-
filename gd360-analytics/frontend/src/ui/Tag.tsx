import type { ReactNode } from "react";
import { cn } from "./cn";
import { CloseIcon } from "./Icons";

// A small removable value chip: the selected items inside MultiSelectChips
// ("Online TA ×"), column names (mono), the "+173 more" overflow. 12/500,
// radius 999, brand tint when `tone="brand"`, subtle fill otherwise.

export type TagProps = {
  children: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
  tone?: "neutral" | "brand";
  mono?: boolean;
  size?: "sm" | "md";
  className?: string;
  title?: string;
  // Render as a button (e.g. "+3 more" expands something).
  onClick?: () => void;
};

export function Tag({ children, onRemove, removeLabel = "Remove", tone = "neutral", mono = false, size = "sm", className, title, onClick }: TagProps) {
  const base = cn(
    "inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap max-w-full",
    size === "sm" ? "h-6 px-2 text-caption" : "h-7 px-2.5 text-[13px]",
    tone === "brand" ? "border-tint-border bg-tint text-brand-ink" : "border-border bg-subtle text-secondary",
    mono && "font-mono",
    onClick && "ui-focus cursor-pointer hover:border-border-strong",
    className
  );
  const content = (
    <>
      <span className="truncate">{children}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className={cn("ui-focus -mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full", tone === "brand" ? "text-brand-ink hover:bg-tint-border" : "text-muted hover:bg-border hover:text-text")}
        >
          <CloseIcon size={10} strokeWidth={2.4} />
        </button>
      )}
    </>
  );
  if (onClick) return <button type="button" onClick={onClick} title={title} className={base}>{content}</button>;
  return <span title={title} className={base}>{content}</span>;
}
