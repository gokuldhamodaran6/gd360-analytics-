import { useCallback, useState } from "react";
import { ConfirmDialog, StatusPill } from "../../ui";
import { AppearanceSheet } from "./AppearanceSheet";
import type { BrandKit } from "./appearance";
import { useKitAppearance } from "./useAppearanceEditor";

// 2026-10-07 (identity-colour round): the workspace brand kit editor - the
// Appearance sheet in "kit" mode, opened from the workspace switcher
// ("Brand kit..."). What is set here is what every dashboard of the
// workspace starts from and follows until its owner customises it, and
// the palette the chat workspace and the prompt builder draw with. Any
// member can open it; only the workspace owner can change it.

/** Fired on window after a kit is saved, so pages that already hold the
 *  workspace list (lib/useWorkspaceNav) show the new kit without a reload. */
export const BRAND_KIT_EVENT = "gd360:brand-kit";

export type BrandKitSheetProps = {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  workspaceName?: string | null;
  // The kit as the workspace list has it (shown before the fetch answers).
  initial?: BrandKit | null;
};

export function BrandKitSheet({ open, onClose, workspaceId, workspaceName, initial = null }: BrandKitSheetProps) {
  const onSaved = useCallback((kit: BrandKit | null) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(BRAND_KIT_EVENT, { detail: { workspaceId, kit } }));
  }, [workspaceId]);
  const controller = useKitAppearance({ workspaceId: open ? workspaceId : null, initial, onSaved });
  const [confirmClear, setConfirmClear] = useState(false);
  return (
    <>
      <AppearanceSheet
        open={open}
        onClose={onClose}
        controller={controller}
        subjectName={workspaceName}
        notice={
          <div className="flex flex-wrap items-center gap-2" data-brand-kit-state={controller.hasKit ? "set" : "none"}>
            <StatusPill tone={controller.hasKit ? "brand" : "neutral"} icon="dot">
              {controller.hasKit ? "This workspace has a brand kit" : "No brand kit yet - dashboards use the GD360 defaults"}
            </StatusPill>
            {controller.hasKit && controller.canEdit && (
              <button type="button" onClick={() => setConfirmClear(true)} className="ui-focus rounded px-0.5 text-caption font-medium text-brand-ink hover:underline" data-brand-kit-remove="">
                Remove the brand kit
              </button>
            )}
            {!controller.hasKit && controller.canEdit && <span className="text-caption text-muted">Change anything below to create one.</span>}
          </div>
        }
      />
      <ConfirmDialog
        open={confirmClear}
        title="Remove this workspace's brand kit?"
        confirmLabel="Remove brand kit"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => { setConfirmClear(false); controller.clear(); }}
      >
        Dashboards that follow the kit go back to the GD360 defaults. Dashboards with their own appearance do not change.
      </ConfirmDialog>
    </>
  );
}
