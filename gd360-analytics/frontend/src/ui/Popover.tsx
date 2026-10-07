import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
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
};

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
}: PopoverProps) {
  const [open, setOpenRaw, id] = useExclusiveOpen();
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

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
