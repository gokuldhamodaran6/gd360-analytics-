import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";

// The kit's confirm (2026-10-07, dashboard edit mode): a small centred
// alertdialog for the few irreversible actions - "Remove this block?",
// "Delete this page?". Never window.confirm: this one is themed, names the
// thing being removed, traps focus, opens with focus on Cancel (so Enter on
// a stray keypress never deletes), closes on Escape / the backdrop, and
// hands focus back to whatever opened it.

export type ConfirmDialogProps = {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // "danger" paints the confirm button as destructive.
  tone?: "danger" | "primary";
  busy?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
};

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmDialog({ open, title, children, confirmLabel = "Remove", cancelLabel = "Cancel", tone = "danger", busy = false, error, onConfirm, onCancel }: ConfirmDialogProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    restoreRef.current = (document.activeElement as HTMLElement) || null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const list = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (list.length === 0) return;
      const first = list[0], last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !panel.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !panel.contains(active))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" role="presentation" data-confirm-dialog="">
      <div className="ui-sheet-backdrop absolute inset-0 bg-black/40" aria-hidden="true" onClick={busy ? undefined : onCancel} />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={children ? `${id}-body` : undefined}
        className="relative flex w-[400px] max-w-full flex-col gap-2 rounded-card border border-border bg-surface p-5 shadow-pop"
      >
        <h2 id={`${id}-title`} className="text-section font-semibold text-text">{title}</h2>
        {children && <div id={`${id}-body`} className="text-ui text-secondary">{children}</div>}
        {error && <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-caption text-danger">{error}</div>}
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} loading={busy} data-confirm-action="">{confirmLabel}</Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
