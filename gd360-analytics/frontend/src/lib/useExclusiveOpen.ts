import { useCallback, useEffect, useRef, useState } from "react";

// 2026-09-30 (bug fix, Gokul's own report, verbatim): "if i click one
// button and next without closing if i click other button old opened one
// is not closing automatically i have to close the same wher ei pressed
// first and close then it is closing make it more user friendly way" -
// every floating menu/panel/popover on a dashboard (a block's kebab menu,
// its Ask AI/Build manually/Chart style panel, its "Explain this chart"
// popover, and a block's own per-chart filter popover) used to keep its
// own private `useState<boolean>` with no idea any of the others existed,
// so opening a second one anywhere left every earlier one still open on
// screen - the person had to go back to wherever they opened the first one
// and close it by hand.
//
// This is a page-wide "only one of these is open at a time" registry, not
// state lifted into a shared parent component, because these widgets are
// rendered from TWO independent component trees that don't share a useful
// common ancestor without a much bigger refactor: DashboardCanvas.tsx's
// BlockCard (the editable canvas) and DashboardBlocks.tsx's
// BlockFilterButton/FilterControl (used by BOTH the editable canvas AND
// the read-only Preview/public dashboard grid, which has no edit-mode
// state of its own at all to lift anything into). A plain module-level id
// plus a subscriber list works identically regardless of which tree a
// given instance mounted from, with no provider to wire up and no risk of
// a future new call site forgetting to thread a prop through.
//
// Each call to useExclusiveOpen() is its own independent "slot" - a
// block's kebab menu and that same block's explain popover are two
// different slots, so one component can hold more than one of these and
// still have them mutually exclusive with everything else on the page,
// itself included. Opening a slot (setOpen(true), or a functional update
// that resolves to true) makes it the one active slot page-wide and closes
// every other one automatically; closing it only clears the registry if it
// was still the active slot, so an already-stale "close" call can never
// accidentally reach in and close something unrelated that opened after it.

let activeSlotId: string | null = null;
const listeners = new Set<(id: string | null) => void>();

function setActiveSlotId(id: string | null) {
  activeSlotId = id;
  listeners.forEach((listen) => listen(id));
}

let nextSlotId = 0;

// 2026-10-02 fix: a real outside-click + Escape dismiss, which this
// registry never had at all before - the original fix above only ever
// closed whichever slot was open when a DIFFERENT slot opened. Clicking
// anywhere else on the page (empty canvas space, another chart, the page
// background) or pressing Escape did nothing at all, so the only way to
// close an open menu/panel was to find its own trigger again. Attached
// once, lazily, the first time any slot actually mounts - not at module
// load - so a page that never renders one of these never pays for a
// document-level listener it doesn't need.
let outsideListenerAttached = false;

function attachOutsideListenerOnce() {
  if (outsideListenerAttached || typeof document === "undefined") return;
  outsideListenerAttached = true;

  // Capture phase, and deliberately mousedown rather than click: this has
  // to run and decide BEFORE a trigger's own onClick (which fires on the
  // following click event) gets a chance to toggle its slot back open -
  // otherwise clicking a slot's own trigger to close it would get closed
  // here first, then immediately reopened by that same click's onClick.
  document.addEventListener(
    "mousedown",
    (e: MouseEvent) => {
      if (!activeSlotId) return;
      const target = e.target as Element | null;
      // A click inside the active slot's own trigger, or inside its own
      // open panel/menu, is never "outside" it - both are tagged with the
      // same data-exclusive-id (this hook's 3rd return value) by every
      // call site. A form-like panel (Ask AI, Build manually, Chart
      // style) tags its whole container, so typing or clicking inside an
      // input there is never mistaken for a click "outside" that loses
      // the in-progress edit.
      if (target?.closest(`[data-exclusive-id="${activeSlotId}"]`)) return;
      setActiveSlotId(null);
    },
    true
  );

  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape" && activeSlotId) setActiveSlotId(null);
  });
}

export function useExclusiveOpen(): [
  boolean,
  (next: boolean | ((was: boolean) => boolean)) => void,
  // 2026-10-02 fix: this slot's own stable id, to tag onto BOTH its
  // trigger element and its panel/menu element via data-exclusive-id - see
  // attachOutsideListenerOnce above for what that tag is checked against.
  string
] {
  const idRef = useRef<string | null>(null);
  if (idRef.current === null) idRef.current = `dash-open-${++nextSlotId}`;
  const [isOpen, setIsOpen] = useState(() => activeSlotId === idRef.current);

  useEffect(() => {
    attachOutsideListenerOnce();
    const listen = (id: string | null) => setIsOpen(id === idRef.current);
    listeners.add(listen);
    return () => {
      listeners.delete(listen);
      // Unmounting (e.g. the block was just deleted) while this slot was
      // the active one must not leave a dead id permanently blocking every
      // other slot on the page from ever opening again.
      if (activeSlotId === idRef.current) setActiveSlotId(null);
    };
  }, []);

  const setOpen = useCallback((next: boolean | ((was: boolean) => boolean)) => {
    const wasOpen = activeSlotId === idRef.current;
    const resolved = typeof next === "function" ? (next as (was: boolean) => boolean)(wasOpen) : next;
    setActiveSlotId(resolved ? idRef.current : null);
  }, []);

  return [isOpen, setOpen, idRef.current];
}
