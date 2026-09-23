import { useEffect, useState } from "react";
import { workspaceApi, WorkspaceSummary } from "../api/client";

// 2026-09-23 (sidebar redesign round): every page that renders the
// persistent left AppSidebar (Projects, Dashboards, Data Sources, ...)
// needs the exact same "which of my real workspaces is active right now"
// state - fetch the list, figure out which one should be selected (last
// one used, if it still exists - otherwise the personal workspace),
// remember the choice, and let the person switch. This used to live only
// inside Dashboard.tsx; pulled out here once a second and third page
// needed their own AppSidebar too, so all of them read/write the exact
// same localStorage key and resolve "which workspace" the exact same way
// instead of three slightly-different copies drifting apart.

// Where the sidebar's WorkspaceSwitcher, this hook, and the invite-join
// page (InviteJoin.tsx) all read/write which workspace is active.
export const ACTIVE_WORKSPACE_KEY = "gd360_active_workspace";

export function useWorkspaceNav() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>("");
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);

  useEffect(() => {
    (async () => {
      setLoadingWorkspaces(true);
      const list = await workspaceApi.list().catch(() => []);
      setWorkspaces(list);
      let active = "";
      try {
        active = localStorage.getItem(ACTIVE_WORKSPACE_KEY) || "";
      } catch {
        // Falls through to the personal-workspace default below.
      }
      if (!active || !list.some((w) => w.id === active)) {
        active = list.find((w) => w.is_personal)?.id || list[0]?.id || "";
      }
      setActiveWorkspaceId(active);
      if (active) {
        try { localStorage.setItem(ACTIVE_WORKSPACE_KEY, active); } catch { /* per-viewer convenience only */ }
      }
      setLoadingWorkspaces(false);
    })();
  }, []);

  // Callers pass their own onSwitched to re-load whatever page-specific
  // data depends on the active workspace (Projects/data sources on the
  // Projects page, dashboards on the Dashboards page, etc.) - this hook
  // only owns the workspace selection itself, not what any one page does
  // with it.
  const switchWorkspace = (id: string, onSwitched?: (id: string) => void) => {
    if (id === activeWorkspaceId) return;
    setActiveWorkspaceId(id);
    try { localStorage.setItem(ACTIVE_WORKSPACE_KEY, id); } catch { /* per-viewer convenience only */ }
    onSwitched?.(id);
  };

  const handleWorkspaceCreated = (ws: WorkspaceSummary, onSwitched?: (id: string) => void) => {
    setWorkspaces((ws_) => [ws, ...ws_]);
    switchWorkspace(ws.id, onSwitched);
  };

  return { workspaces, activeWorkspaceId, loadingWorkspaces, switchWorkspace, handleWorkspaceCreated, setWorkspaces };
}
