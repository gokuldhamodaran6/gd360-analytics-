import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useExclusiveOpen } from "../lib/useExclusiveOpen";
import { cn } from "./cn";

// The one floating-panel primitive every menu/filter popover in the kit is
// built on. It sits on the app's existing page-wide exclusivity registry
// (src/lib/useExclusiveOpen.ts, the 2026-09-30 "only one of these is open
// at a time" rule): opening any Popover closes every other registered
// menu, the registry's own capture-phase document listeners close it on an
// outside mousedown or Escape, and the `data-exclusive-id` wrapper is what
// marks "inside". This file adds on top of that: focus returns to the
// trigger when the panel closes from Escape, ArrowDown on the trigger opens
// the panel, and the panel is positioned under/over the trigger without a
// portal (so clicks inside it are "inside" for the registry's check).
//
// `portal` (2026-10-07, dashboard edit mode): a menu that opens from inside
// a clipped or transformed box - a chart card (overflow hidden), a grid
// item being laid out with CSS transforms - is rendered into <body> with
// fixed positioning instead, flipped above the trigger when there is no
// room below and kept inside the viewport. The portaled panel carries the
// same `data-exclusive-id`, so the registry still counts clicks in it as
// "inside".

export type PopoverTriggerApi = {
  open: boolean;
  toggle: () => void;
  setOpen: (next: boolean) => void;
  // Spread these on the trigger element.
  props: {
    "aria-expanded": boolean;
    "aria-haspopup": "dialog" | "listbox" | "menu" | "true";
    onClick: () => void;
    onKeyDown: (e: ReactKeyboardEvent) => void;
  };
};

export type PopoverProps = {
  trigger: (api: PopoverTriggerApi) => ReactNode;
  children: ReactNode | ((api: { close: () => void }) => ReactNode);
  align?: "start" | "end";
  side?: "bottom" | "top";
  // Panel width: a CSS length, or "trigger" to match the trigger's width.
  width?: string | number | "trigger";
  className?: string;
  panelClassName?: string;
  haspopup?: "dialog" | "listbox" | "menu" | "true";
  role?: "dialog" | "listbox" | "menu";
  ariaLabel?: string;
  onOpenChange?: (open: boolean) => void;
  // Called when the panel opens; return false to veto (e.g. disabled).
  disabled?: boolean;
  // Focus the first focusable element inside the panel when it opens.
  autoFocus?: boolean;
  // Render the panel into <body> (fixed, viewport-aware). See the note above.
  portal?: boolean;
};

const VIEWPORT_GAP = 8;

export function Popover({
  trigger,
  children,
  align = "start",
  side = "bottom",
  width,
  className,
  panelClassName,
  haspopup = "dialog",
  role = "dialog",
  ariaLabel,
  onOpenChange,
  disabled = false,
  autoFocus = true,
  portal = false,
}: PopoverProps) {
  const [open, setOpenRaw, id] = useExclusiveOpen();
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const [fixed, setFixed] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  // Portal mode: place the panel from the trigger's box, re-placed while
  // the page scrolls or resizes underneath it.
  const place = useCallback(() => {
    const wrap = wrapRef.current, panel = panelRef.current;
    if (!wrap || !panel || typeof window === "undefined") return;
    const t = wrap.getBoundingClientRect();
    const pw = panel.offsetWidth, ph = panel.scrollHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    const below = vh - t.bottom - VIEWPORT_GAP - 6;
    const above = t.top - VIEWPORT_GAP - 6;
    // Under the trigger when it fits there (or over it for side="top");
    // otherwise on the other side when it fits there; otherwise slid up
    // just far enough to be whole - a menu is never opened half off the
    // screen or scrolled when the viewport could show all of it.
    const maxHeight = Math.max(120, vh - VIEWPORT_GAP * 2);
    const h = Math.min(ph, maxHeight);
    const fitsBelow = h <= below, fitsAbove = h <= above;
    const top =
      side === "top" && fitsAbove ? t.top - 6 - h
      : fitsBelow ? t.bottom + 6
      : fitsAbove ? t.top - 6 - h
      : Math.max(VIEWPORT_GAP, vh - VIEWPORT_GAP - h);
    const rawLeft = align === "end" ? t.right - pw : t.left;
    const left = Math.min(Math.max(VIEWPORT_GAP, rawLeft), Math.max(VIEWPORT_GAP, vw - pw - VIEWPORT_GAP));
    setFixed((prev) => (prev && prev.top === top && prev.left === left && prev.maxHeight === maxHeight ? prev : { top, left, maxHeight }));
  }, [align, side]);
  useLayoutEffect(() => {
    if (!portal || !open) {
      setFixed(null);
      return;
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    // The trigger can move under an open menu without a scroll (a grid
    // block sliding to a new slot); follow it.
    const follow = window.setInterval(place, 150);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.clearInterval(follow);
    };
  }, [portal, open, place]);

  const setOpen = useCallback(
    (next: boolean) => {
      if (disabled && next) return;
      setOpenRaw(next);
    },
    [disabled, setOpenRaw]
  );
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);

  // onOpenChange + focus management on transitions.
  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    onOpenChange?.(open);
    if (open && autoFocus) {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]), [role="option"]:not([disabled]), [role="menuitem"]:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      first?.focus();
    }
  }, [open, onOpenChange, autoFocus]);

  const focusTrigger = () => {
    const t = wrapRef.current?.querySelector<HTMLElement>("[data-popover-trigger]");
    t?.focus();
  };

  const onPanelKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      // The registry's document listener also closes on Escape; closing
      // here first lets us return focus to the trigger.
      e.stopPropagation();
      setOpen(false);
      focusTrigger();
    } else if (e.key === "Tab") {
      // Tabbing out of the panel closes it (like a native menu).
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!e.shiftKey && document.activeElement === last) { setOpen(false); focusTrigger(); e.preventDefault(); }
      if (e.shiftKey && document.activeElement === first) { setOpen(false); focusTrigger(); e.preventDefault(); }
    }
  };

  const api: PopoverTriggerApi = {
    open,
    toggle,
    setOpen,
    props: {
      "aria-expanded": open,
      "aria-haspopup": haspopup,
      onClick: toggle,
      onKeyDown: (e) => {
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) { e.preventDefault(); setOpen(true); }
        if (e.key === "Escape" && open) { e.preventDefault(); setOpen(false); }
      },
    },
  };

  const style: Record<string, string | number> = {};
  if (width === "trigger") style.width = "100%";
  else if (width !== undefined) style.width = typeof width === "number" ? `${width}px` : width;

  if (portal) {
    if (width === "trigger" && wrapRef.current) style.width = `${wrapRef.current.offsetWidth}px`;
    return (
      <div ref={wrapRef} data-exclusive-id={id} className={cn("relative", width === "trigger" ? "block w-full" : "inline-block", className)}>
        {trigger(api)}
        {open && typeof document !== "undefined" &&
          createPortal(
            <div data-exclusive-id={id} data-popover-portal="" className="fixed z-[70]" style={{ top: fixed?.top ?? 0, left: fixed?.left ?? 0, opacity: fixed ? 1 : 0, pointerEvents: fixed ? undefined : "none" }}>
              <div
                ref={panelRef}
                role={role}
                aria-label={ariaLabel}
                onKeyDown={onPanelKeyDown}
                style={{ ...style, maxHeight: fixed?.maxHeight, maxWidth: `calc(100vw - ${VIEWPORT_GAP * 2}px)` }}
                className={cn("min-w-[180px] overflow-y-auto rounded-card border border-border bg-surface shadow-pop", panelClassName)}
              >
                {typeof children === "function" ? children({ close: () => { setOpen(false); focusTrigger(); } }) : children}
              </div>
            </div>,
            document.body
          )}
      </div>
    );
  }

  return (
    <div ref={wrapRef} data-exclusive-id={id} className={cn("relative", width === "trigger" ? "block w-full" : "inline-block", className)}>
      {/* The trigger element should carry `data-popover-trigger` so focus
          can be handed back to it when the panel closes from the keyboard. */}
      {trigger(api)}
      {open && (
        <div
          ref={panelRef}
          role={role}
          aria-label={ariaLabel}
          onKeyDown={onPanelKeyDown}
          style={style}
          className={cn(
            "absolute z-50 min-w-[180px] rounded-card border border-border bg-surface shadow-pop",
            side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5",
            align === "start" ? "left-0" : "right-0",
            panelClassName
          )}
        >
          {typeof children === "function" ? children({ close: () => { setOpen(false); focusTrigger(); } }) : children}
        </div>
      )}
    </div>
  );
}
