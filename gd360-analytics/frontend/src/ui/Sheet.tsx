import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { cn } from "./cn";
import { CloseIcon } from "./Icons";

// Right-side drawer: portaled to body, backdrop click / Escape / the X
// close it, focus is trapped inside while open and handed back to whatever
// had it before. Header (title + optional subtitle + close), scrolling
// body, optional footer (actions). Widths: sm 420 (the default - "How this
// was computed", "Show SQL"), md 520, lg 720.

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  side?: "right" | "left";
  // Extra header slot (badges, a toolbar).
  headerExtra?: ReactNode;
  closeLabel?: string;
  // Disable backdrop-click close (e.g. an unsaved form).
  persistent?: boolean;
  // False: no dimming behind the panel - the page stays fully visible
  // (a sheet whose changes preview live on the page underneath). The
  // backdrop still closes the sheet on a click.
  scrim?: boolean;
  className?: string;
  id?: string;
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const WIDTH = { sm: "w-sheet", md: "w-[520px]", lg: "w-[720px]" };

export function Sheet({ open, onClose, title, subtitle, children, footer, size = "sm", side = "right", headerExtra, closeLabel = "Close", persistent = false, scrim = true, className, id }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = (document.activeElement as HTMLElement) || null;
    const panel = panelRef.current;
    // Focus the first focusable thing that isn't the close button, else the panel.
    const nodes = panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
    const first = nodes.find((n) => !n.hasAttribute("data-sheet-close")) || nodes[0] || panel;
    first?.focus();

    // A kit Popover in portal mode is rendered into <body>, outside this
    // panel; it carries the same data-exclusive-id as its wrapper in here.
    const ownedPortals = (): HTMLElement[] =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-popover-portal]")).filter((p) => {
        const owner = p.getAttribute("data-exclusive-id");
        return !!owner && !!panel && Array.from(panel.querySelectorAll("[data-exclusive-id]")).some((w) => w.getAttribute("data-exclusive-id") === owner);
      });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // A kit Popover open inside the sheet gets Escape first (it closes
        // itself through the exclusivity registry); the sheet closes on the
        // next Escape.
        const innerOpen = panel?.querySelector('[data-exclusive-id] > [role="dialog"], [data-exclusive-id] > [role="listbox"], [data-exclusive-id] > [role="menu"]');
        if (innerOpen || ownedPortals().length > 0) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      // Focus inside a portaled Popover this sheet opened: that panel
      // handles its own Tab (it closes and hands focus back to its trigger).
      if (ownedPortals().some((p) => p.contains(document.activeElement))) return;
      const list = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (list.length === 0) { e.preventDefault(); panel.focus(); return; }
      const firstEl = list[0], lastEl = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === firstEl || !panel.contains(active))) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && (active === lastEl || !panel.contains(active))) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex" role="presentation">
      <div className={cn("ui-sheet-backdrop absolute inset-0", scrim ? "bg-black/40" : "bg-transparent")} data-sheet-backdrop={scrim ? "scrim" : "clear"} onClick={persistent ? undefined : onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? `${id || "sheet"}-title` : undefined}
        tabIndex={-1}
        className={cn(
          "ui-sheet-panel ui-focus absolute top-0 flex h-full max-w-[94vw] flex-col border-border bg-surface shadow-pop",
          side === "right" ? "right-0 border-l" : "left-0 border-r",
          WIDTH[size],
          className
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            {title && <h2 id={`${id || "sheet"}-title`} className="truncate text-section font-semibold text-text">{title}</h2>}
            {subtitle && <div className="mt-0.5 text-[12.5px] text-muted">{subtitle}</div>}
            {headerExtra && <div className="mt-2">{headerExtra}</div>}
          </div>
          <Button variant="ghost" size="sm" iconOnly data-sheet-close="" aria-label={closeLabel} onClick={onClose} icon={<CloseIcon size={16} />} className="-mr-1.5 -mt-1">
            {closeLabel}
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body
  );
}
