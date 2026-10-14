// 2026-10-13 (R45): keyboard and screen-reader basics shared by the thread's
// dialogs, popovers, menus and tabs - focus moves in when one opens, Tab stays
// inside a modal, focus returns to what opened it, and arrow keys move along a
// tab list or menu.
import { KeyboardEvent as ReactKeyboardEvent, RefObject, useEffect } from "react";

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])", "select:not([disabled])",
  "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])", "summary",
].join(",");

export function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true" && (el.offsetParent !== null || el === document.activeElement),
  );
}

/**
 * While `open`: focus the first control in `ref` (or `initial`), keep Tab
 * inside it when `trap`, and on close give focus back to whatever had it.
 */
export function useFocusTrap(open: boolean, ref: RefObject<HTMLElement>, { trap = true, initial }: { trap?: boolean; initial?: RefObject<HTMLElement> } = {}) {
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      const root = ref.current;
      if (!root || root.contains(document.activeElement)) return; // something inside already took focus (autoFocus)
      const target = initial?.current || focusables(root)[0] || root;
      if (target === root && !root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (!trap || e.key !== "Tab") return;
      const root = ref.current;
      const list = focusables(root);
      if (!root || !list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!root.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
      // give focus back only when it would otherwise be lost (still inside, or on <body>)
      const active = document.activeElement;
      if (before && document.contains(before) && (!active || active === document.body || ref.current?.contains(active))) {
        before.focus({ preventScroll: true });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, trap]);
}

/** The next index for an arrow/Home/End key along `count` items (null when the key isn't one). */
export function rovingIndex(key: string, current: number, count: number, orientation: "horizontal" | "vertical" = "horizontal"): number | null {
  if (count <= 0) return null;
  const prev = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const next = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  if (key === next) return (current + 1 + count) % count;
  if (key === prev) return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** onKeyDown for a menu: ↑/↓/Home/End move between its [role=menuitem]s. */
export function menuKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]"));
  const i = items.indexOf(document.activeElement as HTMLElement);
  const n = rovingIndex(e.key, i < 0 ? -1 : i, items.length, "vertical");
  if (n === null) return;
  e.preventDefault();
  items[i < 0 && e.key === "ArrowUp" ? items.length - 1 : n]?.focus();
}
