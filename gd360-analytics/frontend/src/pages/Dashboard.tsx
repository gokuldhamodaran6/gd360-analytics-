import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { conversationApi, ConversationSummary, datasourceApi, DataSourceSummary, workspaceApi, WorkspaceSummary } from "../api/client";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import DataSourceForm from "../components/DataSourceForm";
import ConversationRow from "../components/ConversationRow";

type SortKey = "newest" | "oldest" | "title";

// Where the sidebar's WorkspaceSwitcher (AppSidebar.tsx) and the invite-join
// page (InviteJoin.tsx) both read/write which workspace is active - kept as
// one shared constant so all three stay in sync without any extra plumbing.
const ACTIVE_WORKSPACE_KEY = "gd360_active_workspace";

function ChartTypeIcon({ chartType }: { chartType: string | null }) {
  const t = (chartType || "").toLowerCase();
  if (t.includes("pie") || t.includes("donut")) {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
        <path d="M22 12A10 10 0 0 0 12 2v10z" />
      </svg>
    );
  }
  if (t.includes("scatter") || t.includes("bubble")) {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="6" cy="17" r="2" />
        <circle cx="12" cy="9" r="2" />
        <circle cx="18" cy="14" r="2" />
        <circle cx="15" cy="6" r="2" />
      </svg>
    );
  }
  if (t.includes("line") || t.includes("area")) {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 17l5-6 4 3 5-8 4 5" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  );
}

function PlusIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SearchIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function PinIcon({ className = "w-3.5 h-3.5", filled = false }: { className?: string; filled?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d="M9 3h6l-1 6 3.5 3.5a1 1 0 0 1-.7 1.7H6.2a1 1 0 0 1-.7-1.7L9 9Z" />
    </svg>
  );
}

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [datasources, setDatasources] = useState<DataSourceSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("newest");
  const [datasourceFilter, setDatasourceFilter] = useState<string>("all");
  const [pinnedOnly, setPinnedOnly] = useState(false);

  // The account's real workspaces (see AppSidebar.tsx's WorkspaceSwitcher)
  // and which one is active - owned here, not in the sidebar, because
  // switching workspace has to refetch THIS page's Projects/data sources
  // too, not just the sidebar's own quick-jump list.
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>("");

  // "Start a new project" now lives in a focused popup instead of an
  // always-open, page-length form - clicking "+ New Project" opens this,
  // and picking or connecting a data source there drops the person
  // straight into a fresh, empty chat ready to analyze it (see
  // handleDataSourceCreated below). Same DataSourceForm component as
  // always, just presented as a portaled overlay.
  const [showConnectModal, setShowConnectModal] = useState(false);
  // Bumped every time a new source is connected, so the sidebar's own
  // independent data-sources fetch (AppSidebar.tsx) refreshes without this
  // page needing to reach into its internals.
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);

  // Loads this page's Projects/data sources for one specific workspace -
  // split out from the initial workspace-resolving load below so switching
  // workspaces (or creating a new one) can re-run just this part.
  const loadForWorkspace = async (workspaceId: string) => {
    setLoading(true);
    const [ds, convos] = await Promise.all([
      datasourceApi.list(workspaceId),
      conversationApi.list(workspaceId).catch(() => []),
    ]);
    setDatasources(ds);
    setConversations(convos);
    setLoading(false);
  };

  // First load: fetch the account's real workspaces, figure out which one
  // should be active (whichever was active last time, if it still exists -
  // otherwise the personal workspace), then load that workspace's Projects.
  useEffect(() => {
    (async () => {
      setLoading(true);
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
        await loadForWorkspace(active);
      } else {
        setLoading(false);
      }
    })();
  }, []);

  const switchWorkspace = async (id: string) => {
    if (id === activeWorkspaceId) return;
    setActiveWorkspaceId(id);
    try { localStorage.setItem(ACTIVE_WORKSPACE_KEY, id); } catch { /* per-viewer convenience only */ }
    setSearch("");
    setDatasourceFilter("all");
    setPinnedOnly(false);
    await loadForWorkspace(id);
  };

  const handleWorkspaceCreated = async (ws: WorkspaceSummary) => {
    setWorkspaces((ws_) => [ws, ...ws_]);
    await switchWorkspace(ws.id);
  };

  useEffect(() => {
    if (!showConnectModal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowConnectModal(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showConnectModal]);

  const openConnectFlow = () => setShowConnectModal(true);

  const openConversation = (c: ConversationSummary) => {
    if (!c.datasource_id) return;
    navigate(`/workspace/${c.datasource_id}?conversation=${c.id}`);
  };

  // Keeps a rename made here reflected instantly in this list, without a
  // full refetch.
  const renameConversation = (id: string, title: string) => {
    setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, title } : c)));
  };

  // Same idea for pin/delete - update locally so the pinned-to-top order
  // and the removed card both show immediately, without waiting on a
  // refetch. Mirrors the backend's own sort (pinned first, newest within
  // each group) so this list never looks out of order until the next load.
  const pinConversation = (id: string, pinned: boolean) => {
    setConversations((cs) => {
      const next = cs.map((c) => (c.id === id ? { ...c, pinned } : c));
      next.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      next.sort((a, b) => Number(b.pinned) - Number(a.pinned));
      return next;
    });
  };
  const deleteConversation = (id: string) => {
    setConversations((cs) => cs.filter((c) => c.id !== id));
  };

  // Once a data source is added and the person confirms it in
  // DataSourceForm's own "Connected" panel, tag it with whichever
  // workspace is active right now (a brand new source has no workspace of
  // its own yet - see routers/datasources.py assign_datasource_workspace),
  // close this modal, and jump straight into its workspace - a brand new
  // project, now open on an empty chat ready to ask GD360 something. (A
  // "type first, attach data mid-conversation" flow is a deeper change to
  // how Workspace.tsx works - this is the fast, solid version of "new
  // project" for this round: pick/connect the data, land straight in the
  // empty chat for it.)
  const handleDataSourceCreated = async (ds: { id: string }) => {
    setShowConnectModal(false);
    if (!ds?.id) return;
    if (activeWorkspaceId) {
      try { await datasourceApi.assignWorkspace(ds.id, activeWorkspaceId); } catch { /* still usable, just unfiled */ }
    }
    navigate(`/workspace/${ds.id}`);
  };

  // Fires as soon as a connect/upload actually succeeds, before the person
  // has clicked "Try it out" in the confirmation panel - refreshes this
  // page's own lists quietly in the background so they're already current
  // if the person closes the modal and stays here instead of proceeding.
  const handleDataSourceConnected = () => {
    if (activeWorkspaceId) loadForWorkspace(activeWorkspaceId);
    setSidebarRefreshKey((k) => k + 1);
  };

  // Every existing chat/analysis is a "Project" now - no separate concept
  // left to reconcile. Filters below operate on this same list Gokul
  // already had (conversationApi.list()); nothing server-side changed,
  // "Projects" is this page's new name and shape for exactly that data.
  const filteredProjects = useMemo(() => {
    let list = conversations;
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          (c.datasource_name || "").toLowerCase().includes(q) ||
          (c.last_message || "").toLowerCase().includes(q)
      );
    }
    if (datasourceFilter !== "all") {
      list = list.filter((c) => c.datasource_id === datasourceFilter);
    }
    if (pinnedOnly) {
      list = list.filter((c) => c.pinned);
    }
    const sorted = [...list];
    if (sortBy === "newest") sorted.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    else if (sortBy === "oldest") sorted.sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime());
    else sorted.sort((a, b) => a.title.localeCompare(b.title));
    // Pinned projects still float to the top within whichever sort is active.
    sorted.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    return sorted;
  }, [conversations, search, datasourceFilter, pinnedOnly, sortBy]);

  const hasAnyProjects = conversations.length > 0;
  const hasFiltersApplied = search.trim() !== "" || datasourceFilter !== "all" || pinnedOnly;

  return (
    // 2026-09-23: the workspace-structure revamp, round two - Gokul asked
    // for the "Your workspace" stats strip and the duplicate "Your data
    // sources" grid gone from here entirely (the sidebar already owns data
    // sources), the double GD360 logo fixed (TopNav's own logo is hidden
    // whenever this sidebar is present - see hideLogo below), and the
    // header's "+ Connect data" button retired in favor of one obvious
    // "+ New Project" action. Every existing chat is now shown and treated
    // as a Project - same conversations the app already had, just the
    // page's whole name, shape and filters built around that word instead
    // of "conversations".
    <div className="flex">
      <AppSidebar
        onConnectNew={openConnectFlow}
        refreshKey={sidebarRefreshKey}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onWorkspaceSwitch={switchWorkspace}
        onWorkspaceCreated={handleWorkspaceCreated}
      />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />

        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
          {/* ---- Header: page title + the one primary action ---- */}
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Projects</h1>
              <p className="text-sm text-muted mt-1">
                Every analysis you've started, in one place. Start a new one whenever you're ready.
              </p>
            </div>
            <button
              className="btn-primary text-sm px-4 py-2.5 inline-flex items-center gap-1.5 shrink-0"
              onClick={openConnectFlow}
            >
              <PlusIcon className="w-4 h-4" /> New Project
            </button>
          </div>

          {/* ---- Filters: search, data source, sort, pinned ---- */}
          {hasAnyProjects && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 mb-6">
              <div className="relative flex-1 min-w-0 sm:max-w-xs">
                <SearchIcon className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  className="input pl-9 text-sm w-full"
                  placeholder="Search projects..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <select
                className="input text-sm w-full sm:w-auto"
                value={datasourceFilter}
                onChange={(e) => setDatasourceFilter(e.target.value)}
              >
                <option value="all">All data sources</option>
                {datasources.map((ds) => (
                  <option key={ds.id} value={ds.id}>{ds.name}</option>
                ))}
              </select>
              <select
                className="input text-sm w-full sm:w-auto"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortKey)}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="title">Title A-Z</option>
              </select>
              <button
                type="button"
                onClick={() => setPinnedOnly((v) => !v)}
                className={`inline-flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border transition shrink-0 ${
                  pinnedOnly
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : "border-border text-muted hover:text-text hover:bg-surface2"
                }`}
              >
                <PinIcon className="w-3.5 h-3.5" filled={pinnedOnly} /> Pinned
              </button>
            </div>
          )}

          {/* ---- Projects grid ---- */}
          {!loading && !hasAnyProjects && (
            <div className="card p-10 text-center">
              <div className="text-lg font-semibold mb-1.5">No projects yet</div>
              <p className="text-sm text-muted max-w-sm mx-auto leading-relaxed mb-5">
                A project is one analysis - connect a data source and start asking GD360 questions
                about it to create your first one.
              </p>
              <button className="btn-primary text-sm px-4 py-2.5 inline-flex items-center gap-1.5" onClick={openConnectFlow}>
                <PlusIcon className="w-4 h-4" /> New Project
              </button>
            </div>
          )}

          {!loading && hasAnyProjects && filteredProjects.length === 0 && (
            <div className="card p-10 text-center text-sm text-muted">
              No projects match your filters.{" "}
              {hasFiltersApplied && (
                <button
                  className="text-primary font-medium hover:underline"
                  onClick={() => { setSearch(""); setDatasourceFilter("all"); setPinnedOnly(false); }}
                >
                  Clear filters
                </button>
              )}
            </div>
          )}

          {filteredProjects.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {filteredProjects.map((c) => (
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  icon={<ChartTypeIcon chartType={c.last_chart_type} />}
                  subtitle={`${c.datasource_name || "Removed data source"} · ${timeAgo(c.updated_at)}`}
                  trailing={c.message_count}
                  onOpen={() => openConversation(c)}
                  onRenamed={renameConversation}
                  onPinned={pinConversation}
                  onDeleted={deleteConversation}
                />
              ))}
            </div>
          )}
        </div>

        {/* ---- Footer ----
            Dashboard (not Landing) is what a signed-in person actually sees
            at "/" (see App.tsx's Home()), so the Privacy Policy link needs
            to live here too - a footer only on the signed-out Landing page
            is invisible to anyone already logged in. */}
        <div className="border-t border-border mt-4">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
            <div>&copy; {new Date().getFullYear()} GD360 Analytics. All rights reserved.</div>
            <Link to="/privacy" className="hover:text-text hover:underline">
              Privacy Policy
            </Link>
          </div>
        </div>
      </div>

      {/* ---- "New Project" / connect-data popup ----
          Portaled straight to document.body (same pattern as
          AddDataPicker.tsx / DataSourceForm.tsx's own internal modals) so
          it always covers the real viewport regardless of where it's
          mounted in the tree. */}
      {showConnectModal &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/60 p-4 overflow-y-auto"
            onClick={(e) => { if (e.target === e.currentTarget) setShowConnectModal(false); }}
          >
            <div className="card w-full max-w-lg my-8 sm:my-0 p-6 relative">
              <button
                className="absolute top-4 right-4 text-muted hover:text-text transition"
                onClick={() => setShowConnectModal(false)}
                aria-label="Close"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
              <h2 className="text-lg font-bold mb-1">New project</h2>
              <p className="text-xs text-muted mb-5 leading-relaxed">
                Connect a database, a warehouse, or a file - once it's ready you'll land straight in a
                new project to start analyzing it.
              </p>
              <DataSourceForm onCreated={handleDataSourceCreated} onConnected={handleDataSourceConnected} />
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
