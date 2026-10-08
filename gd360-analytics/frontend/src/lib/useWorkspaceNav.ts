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

// 2026-09-28 (hotfix): every caller of this hook used to be a page already
// wrapped in <Protected> (see App.tsx), so a valid session was always
// guaranteed by the time this effect ran - until CommandPalette.tsx started
// calling useWorkspaceNav() too, mounted unconditionally at the app root
// for EVERY route, including the signed-out Landing page and Login/Register
// (see App.tsx's own comment on why CommandPalette lives outside <Routes>).
// For a signed-out visitor there is no token, GET /workspaces requires one
// (routers/workspaces.py's list_workspaces takes get_current_user), so the
// fetch below 401'd on every single page load - and client.ts's response
// interceptor treats any non-login 401 as an expired session and hard-
// navigates to /login (`window.location.href`, a real full-page reload).
// On /login, CommandPalette mounts again, fires the same unauthenticated
// call, 401s again, reloads again - a real, live-breaking loop that reset
// the page out from under anyone before they could type into the login
// form. The fix is narrow: skip this hook's own fetch entirely when there
// is no token to send, exactly the same check client.ts's own request
// interceptor already uses - every OTHER caller (a page inside <Protected>)
// always has a token by the time it renders, so this changes nothing for
// them; only the signed-out CommandPalette case is affected.
function hasSessionToken(): boolean {
  try {
    return !!localStorage.getItem("gd360_token");
  } catch {
    return false;
  }
}

// 2026-10-08 (round 11): several copies of this hook mount together on one
// screen (the page, its sidebar, the command palette), and each fetched the
// list on its own - 18 identical GET /workspaces in one short session. They
// now share one request for a few seconds; a new token or a created
// workspace starts a fresh one.
const SHARE_MS = 5000;
let shared: { token: string; at: number; p: Promise<WorkspaceSummary[]> } | null = null;

function loadWorkspaces(): Promise<WorkspaceSummary[]> {
  let token = "";
  try { token = localStorage.getItem("gd360_token") || ""; } catch { /* no storage */ }
  const now = Date.now();
  if (shared && shared.token === token && now - shared.at < SHARE_MS) return shared.p;
  const p = workspaceApi.list().catch(() => [] as WorkspaceSummary[]);
  shared = { token, at: now, p };
  return p;
}

export function forgetWorkspaceList() {
  shared = null;
}

export function useWorkspaceNav() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>("");
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);

  useEffect(() => {
    if (!hasSessionToken()) {
      // Signed out (or not yet signed in) - nothing to fetch, and nothing
      // to retry once a token does appear, since AuthProvider does a full
      // context re-render (and every Protected page remounts) on login.
      setWorkspaces([]);
      setActiveWorkspaceId("");
      setLoadingWorkspaces(false);
      return;
    }
    (async () => {
      setLoadingWorkspaces(true);
      const list = await loadWorkspaces();
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

  // 2026-10-07 (identity-colour round): a brand kit saved from the sidebar
  // (dashboard/theme/BrandKitSheet) reaches every page's copy of the list.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKit = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d || typeof d.workspaceId !== "string") return;
      setWorkspaces((list) => list.map((w) => (w.id === d.workspaceId ? { ...w, brand_kit: d.kit ?? null } : w)));
    };
    window.addEventListener("gd360:brand-kit", onKit);
    return () => window.removeEventListener("gd360:brand-kit", onKit);
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
    forgetWorkspaceList();
    setWorkspaces((ws_) => [ws, ...ws_]);
    switchWorkspace(ws.id, onSwitched);
  };

  return { workspaces, activeWorkspaceId, loadingWorkspaces, switchWorkspace, handleWorkspaceCreated, setWorkspaces };
}
