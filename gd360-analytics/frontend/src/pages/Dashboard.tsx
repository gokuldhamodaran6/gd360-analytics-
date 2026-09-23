import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import {
  conversationApi, ConversationSummary, datasourceApi, DataSourceSummary, folderApi, FolderSummary, WorkspaceSummary,
} from "../api/client";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import ConversationRow from "../components/ConversationRow";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import ViewToggle, { ViewMode, useViewMode } from "../components/ViewToggle";

type SortKey = "newest" | "oldest" | "title";
// A folder's real id, or one of the two built-in tabs:
//   "all"   - the Projects page's default, file-explorer-style root view:
//             every folder shown as its own card, followed by only the
//             unfiled Projects (never a flat mix of everything).
//   "files" - only the unfiled Projects, no folder cards - for someone who
//             specifically wants to skip past folders straight to loose
//             Projects.
// 2026-09-23, round four (Gokul's own explicit ask, "if i click file will
// not been in any folder and folder should come"): "All" used to mean "every
// Project regardless of folder", which meant a Project already filed into a
// folder also showed up loose in "All" - the exact confusion Gokul flagged.
// It now means "the root view", same mental model as any file explorer.
const PAGE_SIZE = 12;
type FolderFilter = "all" | "files" | string;

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

function FolderIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

// A folder with a small "+" instead of just an outline - the header's own
// "+ New Folder" action, distinct at a glance from a plain folder chip.
function NewFolderIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M12 11v4M10 13h4" />
    </svg>
  );
}

function CheckSquareIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M8 12l2.5 2.5L16 9" />
    </svg>
  );
}

function ChevronDownIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function PencilIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function TrashIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

// 2026-09-23, round four (Gokul's own explicit ask: "rows should be limited
// ... after certain row it has to show pages"): the same Prev/Next-plus-
// numbers pager DataSources.tsx and AppSidebar's ConnectDataPopup use,
// duplicated here per this codebase's established per-file component
// convention.
function ChevronLeftIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function Pager({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  if (totalPages <= 1) return null;

  const pages: (number | "gap")[] = [];
  const push = (p: number) => { if (!pages.includes(p)) pages.push(p); };
  push(1);
  for (let p = page - 1; p <= page + 1; p++) if (p > 1 && p < totalPages) push(p);
  push(totalPages);
  const withGaps: (number | "gap")[] = [];
  let prev = 0;
  for (const p of pages) {
    if (typeof p === "number" && p - prev > 1) withGaps.push("gap");
    withGaps.push(p);
    if (typeof p === "number") prev = p;
  }

  const btn = (active: boolean) =>
    `min-w-[2rem] h-8 px-2 text-sm rounded-lg border transition ${
      active ? "bg-primary text-white border-primary font-semibold" : "border-border text-muted hover:text-text hover:bg-surface2"
    }`;

  return (
    <div className="flex items-center justify-center gap-1.5 mt-8">
      <button
        type="button"
        className="h-8 px-2 rounded-lg border border-border text-muted hover:text-text hover:bg-surface2 transition disabled:opacity-40 disabled:cursor-not-allowed"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        aria-label="Previous page"
      >
        <ChevronLeftIcon />
      </button>
      {withGaps.map((p, i) =>
        p === "gap" ? (
          <span key={`gap-${i}`} className="px-1 text-muted text-sm select-none">&hellip;</span>
        ) : (
          <button key={p} type="button" className={btn(p === page)} onClick={() => onChange(p)}>
            {p}
          </button>
        )
      )}
      <button
        type="button"
        className="h-8 px-2 rounded-lg border border-border text-muted hover:text-text hover:bg-surface2 transition disabled:opacity-40 disabled:cursor-not-allowed"
        onClick={() => onChange(page + 1)}
        disabled={page >= totalPages}
        aria-label="Next page"
      >
        <ChevronRightIcon />
      </button>
    </div>
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

// The select-all bar's "Move to folder" action - a small popover listing
// every folder plus "No folder" (unfiles whatever's selected), same
// click-outside/Escape pattern as Workspace.tsx's own SaveChartMenu.
function MoveToFolderMenu({
  folders,
  disabled,
  busy,
  onMove,
  onNewFolder,
}: {
  folders: FolderSummary[];
  disabled: boolean;
  busy: boolean;
  onMove: (folderId: string | null) => void;
  onNewFolder: () => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={boxRef}>
      <button
        type="button"
        className="btn-primary text-sm px-3.5 py-2 inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || busy}
      >
        <FolderIcon className="w-3.5 h-3.5" /> {busy ? "Moving…" : "Move to folder"} <ChevronDownIcon />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-20 w-56 rounded-xl border border-border bg-surface2/95 backdrop-blur-xl shadow-2xl p-1.5">
          <button
            type="button"
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-surface2 rounded-lg transition"
            onClick={() => { onMove(null); setOpen(false); }}
          >
            No folder <span className="text-muted text-xs">(unfile)</span>
          </button>
          {folders.length > 0 && <div className="my-1 border-t border-border" />}
          <div className="max-h-56 overflow-y-auto">
            {folders.map((f) => (
              <button
                key={f.id}
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-surface2 rounded-lg transition truncate"
                onClick={() => { onMove(f.id); setOpen(false); }}
              >
                <FolderIcon className="w-3.5 h-3.5 text-muted shrink-0" />
                <span className="truncate">{f.name}</span>
              </button>
            ))}
          </div>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left text-primary hover:bg-surface2 rounded-lg transition"
            onClick={() => { setOpen(false); onNewFolder(); }}
          >
            <PlusIcon className="w-3.5 h-3.5" /> New folder
          </button>
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [datasources, setDatasources] = useState<DataSourceSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("newest");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all");
  const [page, setPage] = useState(1);

  // The account's real workspaces and which one is active - the shared
  // hook (used by every page with a persistent AppSidebar) owns the
  // selection itself; this page just reacts to it below to refetch its own
  // Projects/data sources whenever it changes.
  const { workspaces, activeWorkspaceId, loadingWorkspaces, switchWorkspace: switchWorkspaceId, handleWorkspaceCreated: createWorkspace } = useWorkspaceNav();

  const [viewMode, setViewMode] = useViewMode("gd360_view_projects");

  // Select-all/bulk-move mode (2026-09-23, folders round) - Gokul's own
  // explicit ask: "add a select all option too so i can select some or all
  // to move to folder at once".
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState(false);
  const [moveMsg, setMoveMsg] = useState("");

  // "+ New folder" - a plain name prompt, same lightweight portaled-card
  // pattern as the old "+ New Project" modal this page used to have.
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Inline rename/delete for whichever folder tab is currently active -
  // kept to just the active one rather than a menu on every chip, so
  // managing a folder never competes for space with the (usually much more
  // frequently clicked) filter chips themselves.
  const [renamingFolder, setRenamingFolder] = useState(false);
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState(false);

  // Loads this page's Projects/data sources/folders for one specific
  // workspace - split out from the initial workspace-resolving load below
  // so switching workspaces (or creating a new one) can re-run just this
  // part.
  const loadForWorkspace = async (workspaceId: string) => {
    setLoading(true);
    const [ds, convos, fs] = await Promise.all([
      datasourceApi.list(workspaceId),
      conversationApi.list(workspaceId).catch(() => []),
      folderApi.list(workspaceId).catch(() => []),
    ]);
    setDatasources(ds);
    setConversations(convos);
    setFolders(fs);
    setLoading(false);
  };

  // Whenever the active workspace resolves for the first time, or changes
  // (a real switch, or a brand-new workspace just created), refetch this
  // page's own Projects/data sources for it. Covers the very first load
  // too - useWorkspaceNav resolves activeWorkspaceId from "" to a real id
  // exactly once on mount, which this effect reacts to the same as any
  // other change.
  useEffect(() => {
    if (activeWorkspaceId) {
      loadForWorkspace(activeWorkspaceId);
    } else if (!loadingWorkspaces) {
      // Workspace resolution finished and there's genuinely nothing to
      // show (should only happen if the workspaces fetch itself failed).
      setLoading(false);
    }
  }, [activeWorkspaceId, loadingWorkspaces]);

  // A fresh search/sort/pinned/folder choice always lands back on page 1 -
  // same reasoning as DataSources.tsx's own pager - never leave it pointed
  // at a page that just emptied out from under it.
  useEffect(() => { setPage(1); }, [search, pinnedOnly, folderFilter, sortBy]);

  const resetPageState = () => {
    setSearch("");
    setPinnedOnly(false);
    setFolderFilter("all");
    setSelectMode(false);
    setSelectedIds(new Set());
    setPage(1);
  };

  const switchWorkspace = (id: string) => {
    resetPageState();
    switchWorkspaceId(id);
  };

  const handleWorkspaceCreated = (ws: WorkspaceSummary) => {
    resetPageState();
    createWorkspace(ws);
  };

  // "+ New Project" now lands straight on a blank chat page - see
  // pages/NewProject.tsx - instead of opening a connect-data popup first;
  // connecting data happens from inside that page instead.
  const openConnectFlow = () => navigate("/project/new");

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

  // A single row's own "Move to folder" menu item (see ConversationRow)
  // already made the API call by the time this fires - just reflect the
  // new folder_id locally and refresh folder counts, same as the bulk
  // version below.
  const singleMoved = (id: string, folderId: string | null) => {
    setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, folder_id: folderId } : c)));
    if (activeWorkspaceId) folderApi.list(activeWorkspaceId).then(setFolders).catch(() => {});
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
    if (pinnedOnly) {
      list = list.filter((c) => c.pinned);
    }
    // "All" and "Files" both show only the UNFILED Projects here - a filed
    // Project is represented by its folder's own card instead (rendered
    // separately, above this list, only in "All"). Picking a specific
    // folder still shows just that folder's own Projects, unchanged.
    if (folderFilter === "all" || folderFilter === "files") {
      list = list.filter((c) => c.folder_id == null);
    } else {
      list = list.filter((c) => c.folder_id === folderFilter);
    }
    const sorted = [...list];
    if (sortBy === "newest") sorted.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    else if (sortBy === "oldest") sorted.sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime());
    else sorted.sort((a, b) => a.title.localeCompare(b.title));
    // Pinned projects still float to the top within whichever sort is active.
    sorted.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    return sorted;
  }, [conversations, search, pinnedOnly, folderFilter, sortBy]);

  const hasAnyProjects = conversations.length > 0;
  const hasFiltersApplied = search.trim() !== "" || pinnedOnly || folderFilter !== "all";
  const clearFilters = () => { setSearch(""); setPinnedOnly(false); setFolderFilter("all"); };

  // Pagination - PAGE_SIZE=12, same precedent as DataSources.tsx's own
  // pager, applied to whichever scope is currently showing (unfiled-only in
  // "All"/"Files", or one folder's own Projects).
  const totalPages = Math.max(1, Math.ceil(filteredProjects.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageSlice = useMemo(
    () => filteredProjects.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filteredProjects, currentPage]
  );

  // A workspace "viewer" (2026-09-23, roles & attribution round) can see
  // everything in the active workspace but can't bring in new data or
  // start new analysis there - "+ New Project" is disabled rather than
  // hidden, with a tooltip explaining why, so it's clear this is a
  // deliberate permission rather than a missing feature. Folders follow
  // the same rule (services/workspace_access.py's "editable" tier).
  const isViewerHere = workspaces.find((w) => w.id === activeWorkspaceId)?.role === "viewer";

  const activeFolder = folderFilter !== "all" && folderFilter !== "files" ? folders.find((f) => f.id === folderFilter) || null : null;

  // Folder cards for the "All" root view - only rendered there, never in
  // "Files" (which deliberately skips folders) or inside a specific folder
  // (already just showing that one folder's own contents).
  const showFolderCards = folderFilter === "all" && folders.length > 0;
  const unfiledCount = useMemo(() => conversations.filter((c) => c.folder_id == null).length, [conversations]);

  // ---- Select-all / bulk-move ----
  // Scoped to the CURRENT PAGE's own items, not every filtered Project -
  // "select all" on a huge, paginated list means "everything I can see
  // right now", the same convention most file managers use, rather than an
  // invisible cross-page selection someone could easily forget about.
  const toggleSelectMode = () => {
    setSelectMode((v) => !v);
    setSelectedIds(new Set());
  };
  const toggleSelect = (id: string) => {
    setSelectedIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const visibleIds = pageSlice.map((c) => c.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const toggleSelectAll = () => {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(visibleIds));
  };

  const moveSelectedTo = async (folderId: string | null) => {
    if (selectedIds.size === 0 || !activeWorkspaceId) return;
    setMoving(true);
    try {
      const ids = Array.from(selectedIds);
      const res = await conversationApi.bulkMove(ids, folderId);
      const movedSet = new Set(res.moved);
      setConversations((cs) => cs.map((c) => (movedSet.has(c.id) ? { ...c, folder_id: folderId } : c)));
      folderApi.list(activeWorkspaceId).then(setFolders).catch(() => {});
      setSelectedIds(new Set());
      setSelectMode(false);
      setMoveMsg(
        res.skipped.length > 0
          ? `Moved ${res.moved.length}, skipped ${res.skipped.length} (no permission).`
          : `Moved ${res.moved.length} project${res.moved.length === 1 ? "" : "s"}.`
      );
    } catch {
      setMoveMsg("Could not move those projects.");
    } finally {
      setMoving(false);
      setTimeout(() => setMoveMsg(""), 4000);
    }
  };

  // ---- Folder create/rename/delete ----
  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name || !activeWorkspaceId) return;
    setCreatingFolder(true);
    try {
      const f = await folderApi.create(activeWorkspaceId, name);
      setFolders((fs) => [...fs, f]);
      setFolderFilter(f.id);
      setShowNewFolder(false);
      setNewFolderName("");
    } catch {
      // Modal stays open with what they typed so they can just try again.
    } finally {
      setCreatingFolder(false);
    }
  };

  const startRenameFolder = () => {
    if (!activeFolder) return;
    setFolderNameDraft(activeFolder.name);
    setRenamingFolder(true);
  };
  const commitRenameFolder = async () => {
    if (!activeFolder) { setRenamingFolder(false); return; }
    const name = folderNameDraft.trim();
    setRenamingFolder(false);
    if (!name || name === activeFolder.name) return;
    setFolderBusy(true);
    try {
      const updated = await folderApi.rename(activeFolder.id, name);
      setFolders((fs) => fs.map((f) => (f.id === updated.id ? updated : f)));
    } catch {
      // Name just stays as it was - nothing lost.
    } finally {
      setFolderBusy(false);
    }
  };
  const deleteActiveFolder = async () => {
    if (!activeFolder) return;
    setFolderBusy(true);
    try {
      await folderApi.remove(activeFolder.id);
      const removedId = activeFolder.id;
      setFolders((fs) => fs.filter((f) => f.id !== removedId));
      // Every Project that was filed into it is unfiled server-side, not
      // deleted (see routers/folders.py delete_folder) - mirror that here.
      setConversations((cs) => cs.map((c) => (c.folder_id === removedId ? { ...c, folder_id: null } : c)));
      setFolderFilter("all");
    } catch {
      // Leaves the folder in place - the Delete button is right there to
      // try again.
    } finally {
      setFolderBusy(false);
      setConfirmDeleteFolder(false);
    }
  };

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
    //
    // 2026-09-23, folders round: Projects can now be filed into folders
    // (scoped to this workspace, purely an organizing label - see
    // models.Folder) and multi-selected for a bulk move, per Gokul's own
    // request.
    <div className="flex">
      <AppSidebar
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
            <div className="flex items-center gap-2.5 shrink-0">
              {/* Same two-button pattern Gokul asked to match everywhere:
                  a plain outline action first, the primary filled action
                  second - not the button's own color that carries meaning,
                  the outline-vs-filled weight does. */}
              <button
                className="btn-secondary text-sm px-4 py-2.5 inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => { setNewFolderName(""); setShowNewFolder(true); }}
                disabled={isViewerHere}
                title={isViewerHere ? "You have view-only access to this workspace." : undefined}
              >
                <NewFolderIcon className="w-4 h-4" /> New Folder
              </button>
              <button
                className="btn-primary text-sm px-4 py-2.5 inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={openConnectFlow}
                disabled={isViewerHere}
                title={isViewerHere ? "You have view-only access to this workspace." : undefined}
              >
                <PlusIcon className="w-4 h-4" /> New Project
              </button>
            </div>
          </div>

          {/* ---- Folder tabs ----
              Only rendered once folders actually exist - an empty tab
              strip with nothing but "All" is just noise (the header's own
              "+ New Folder" button above is already the entry point to
              create the first one). */}
          {!loading && folders.length > 0 && (
            <div className="mb-4 rounded-xl border border-border bg-surface/60 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setFolderFilter("all")}
                  className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
                    folderFilter === "all" ? "bg-primary text-white border-primary" : "border-border text-muted hover:text-text hover:bg-surface2"
                  }`}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setFolderFilter("files")}
                  className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border transition ${
                    folderFilter === "files" ? "bg-primary text-white border-primary" : "border-border text-muted hover:text-text hover:bg-surface2"
                  }`}
                  title="Only Projects not filed into any folder"
                >
                  Files
                  <span className={folderFilter === "files" ? "text-white/80" : "text-muted"}>{unfiledCount}</span>
                </button>
                {folders.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFolderFilter(f.id)}
                    className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border transition ${
                      folderFilter === f.id ? "bg-primary text-white border-primary" : "border-border text-muted hover:text-text hover:bg-surface2"
                    }`}
                  >
                    <FolderIcon className="w-3 h-3" /> {f.name}
                    <span className={folderFilter === f.id ? "text-white/80" : "text-muted"}>{f.project_count}</span>
                  </button>
                ))}
              </div>

              {/* Manage the currently-active folder tab - rename/delete.
                  Kept to just this one folder rather than a menu on every
                  chip (see state comment above). */}
              {activeFolder && !isViewerHere && (
                <div className="flex items-center gap-3 mt-2 pt-2 border-t border-border text-xs text-muted">
                  {renamingFolder ? (
                    <input
                      autoFocus
                      className="input py-1 text-xs w-48"
                      value={folderNameDraft}
                      onChange={(e) => setFolderNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRenameFolder();
                        if (e.key === "Escape") setRenamingFolder(false);
                      }}
                      onBlur={commitRenameFolder}
                      maxLength={80}
                    />
                  ) : confirmDeleteFolder ? (
                    <>
                      <span>Delete &ldquo;{activeFolder.name}&rdquo;? Its projects stay - they'll just be unfiled.</span>
                      <button type="button" className="text-muted hover:text-text" onClick={() => setConfirmDeleteFolder(false)} disabled={folderBusy}>
                        Cancel
                      </button>
                      <button type="button" className="text-red-400 font-medium hover:underline" onClick={deleteActiveFolder} disabled={folderBusy}>
                        {folderBusy ? "Deleting…" : "Delete"}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="inline-flex items-center gap-1 hover:text-text transition" onClick={startRenameFolder}>
                        <PencilIcon className="w-3 h-3" /> Rename folder
                      </button>
                      <button type="button" className="inline-flex items-center gap-1 hover:text-red-400 transition" onClick={() => setConfirmDeleteFolder(true)}>
                        <TrashIcon className="w-3 h-3" /> Delete folder
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ---- Filters: search, data source, sort, pinned, select ----
              Grouped inside one toolbar surface (rather than loose controls
              floating on the page background) with the search/browse
              controls on the left and the view-affecting toggles on the
              right, separated by a hairline divider - a single coherent
              piece of UI instead of a row of unrelated-looking buttons. */}
          {hasAnyProjects && (
            <div className="flex flex-col lg:flex-row lg:items-center gap-2.5 lg:gap-2 mb-3 p-2 rounded-xl border border-border bg-surface/60">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 flex-1 min-w-0">
                <div className="relative flex-1 min-w-0 sm:max-w-xs">
                  <SearchIcon className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    className="input input-icon h-10 text-sm w-full"
                    placeholder="Search projects..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <select
                  className="input h-10 text-sm w-full sm:w-auto"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortKey)}
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="title">Title A-Z</option>
                </select>
              </div>

              <div className="hidden lg:block w-px self-stretch bg-border" />

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setPinnedOnly((v) => !v)}
                  className={`inline-flex items-center gap-1.5 h-10 text-sm px-3 rounded-lg border transition shrink-0 ${
                    pinnedOnly
                      ? "bg-primary/15 border-primary/40 text-primary"
                      : "border-border text-muted hover:text-text hover:bg-surface2"
                  }`}
                >
                  <PinIcon className="w-3.5 h-3.5" filled={pinnedOnly} /> Pinned
                </button>
                <button
                  type="button"
                  onClick={toggleSelectMode}
                  className={`inline-flex items-center gap-1.5 h-10 text-sm px-3 rounded-lg border transition shrink-0 ${
                    selectMode
                      ? "bg-primary/15 border-primary/40 text-primary"
                      : "border-border text-muted hover:text-text hover:bg-surface2"
                  }`}
                >
                  <CheckSquareIcon className="w-3.5 h-3.5" /> {selectMode ? "Cancel" : "Select"}
                </button>
                <div className="h-10 flex items-center">
                  <ViewToggle mode={viewMode} onChange={setViewMode} />
                </div>
              </div>
            </div>
          )}

          {/* ---- Select-all / bulk-move bar ---- */}
          {selectMode && hasAnyProjects && (
            <div className="flex flex-wrap items-center gap-3 mb-6 p-3 rounded-xl border border-primary/30 bg-primary/5">
              <label className="flex items-center gap-2 text-sm font-medium cursor-pointer select-none">
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} className="w-4 h-4 rounded accent-primary" />
                {totalPages > 1 ? `Select all on this page (${pageSlice.length})` : `Select all ${pageSlice.length > 0 ? `(${pageSlice.length})` : ""}`}
              </label>
              <span className="text-sm text-muted">{selectedIds.size} selected</span>
              <div className="ml-auto flex items-center gap-2">
                {moveMsg && <span className="text-xs text-accent">{moveMsg}</span>}
                <MoveToFolderMenu
                  folders={folders}
                  disabled={selectedIds.size === 0}
                  busy={moving}
                  onMove={moveSelectedTo}
                  onNewFolder={() => { setNewFolderName(""); setShowNewFolder(true); }}
                />
              </div>
            </div>
          )}

          {/* ---- Projects grid ---- */}
          {!loading && !hasAnyProjects && (
            <div className="card p-10 text-center">
              <div className="text-lg font-semibold mb-1.5">No projects yet</div>
              <p className="text-sm text-muted max-w-sm mx-auto leading-relaxed mb-5">
                {isViewerHere
                  ? "Nothing's been shared into this workspace yet. You have view-only access here, so ask the workspace owner to add a data source."
                  : "A project is one analysis - connect a data source and start asking GD360 questions about it to create your first one."}
              </p>
              {!isViewerHere && (
                <button className="btn-primary text-sm px-4 py-2.5 inline-flex items-center gap-1.5" onClick={openConnectFlow}>
                  <PlusIcon className="w-4 h-4" /> New Project
                </button>
              )}
            </div>
          )}

          {/* Suppressed in the plain "All" root view with folders present
              and no search/pin filter active - the folder cards below
              already explain why there's nothing loose to show; a "no
              match" message there would just be confusing noise next to
              them. */}
          {!loading && hasAnyProjects && filteredProjects.length === 0 && !(showFolderCards && !hasFiltersApplied) && (
            <div className="card p-10 text-center text-sm text-muted">
              {folderFilter === "files"
                ? "No unfiled projects."
                : activeFolder
                ? `No projects in "${activeFolder.name}" yet.`
                : "No projects match your filters."}{" "}
              {hasFiltersApplied && (
                <button className="text-primary font-medium hover:underline" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
          )}

          {/* ---- Folder cards ----
              File-explorer-style root view (2026-09-23, round four, per
              Gokul's own confirmed design choice): every folder shown as
              its own card here, ahead of the loose/unfiled Projects below -
              clicking one still opens just that folder's own contents
              (same as its chip above always did). Not paginated - a
              workspace typically has far fewer folders than Projects, and
              these are lightweight summary tiles, not the "rows" Gokul
              asked to have capped. */}
          {!loading && showFolderCards && (
            <div className="mb-6">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-2.5 px-0.5">
                Folders
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {folders.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFolderFilter(f.id)}
                    className="card p-4 flex flex-col gap-2.5 text-left hover:border-primary/50 hover:shadow-glow transition"
                  >
                    <span className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                      <FolderIcon className="w-4 h-4" />
                    </span>
                    <span className="text-sm font-semibold truncate">{f.name}</span>
                    <span className="text-[11px] text-muted mt-auto">
                      {f.project_count} project{f.project_count === 1 ? "" : "s"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {filteredProjects.length > 0 && (
            <>
              {showFolderCards && (
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-2.5 px-0.5">
                  Files
                </div>
              )}
              <div className={viewMode === "grid" ? "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" : "grid grid-cols-1 gap-2.5"}>
                {pageSlice.map((c) => (
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
                    folders={folders}
                    onMoved={singleMoved}
                    selectMode={selectMode}
                    selected={selectedIds.has(c.id)}
                    onToggleSelect={toggleSelect}
                  />
                ))}
              </div>
              <Pager page={currentPage} totalPages={totalPages} onChange={setPage} />
            </>
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

      {/* ---- "New folder" popup ----
          Portaled straight to document.body (same pattern as the old
          "New Project" modal this page used to have) so it always covers
          the real viewport regardless of where it's mounted in the tree. */}
      {showNewFolder &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/60 p-4 overflow-y-auto"
            onClick={(e) => { if (e.target === e.currentTarget && !creatingFolder) setShowNewFolder(false); }}
          >
            <div className="card w-full max-w-sm my-8 sm:my-0 p-6 relative">
              <button
                className="absolute top-4 right-4 text-muted hover:text-text transition disabled:opacity-50"
                onClick={() => setShowNewFolder(false)}
                disabled={creatingFolder}
                aria-label="Close"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
              <h2 className="text-lg font-bold mb-1">New folder</h2>
              <p className="text-xs text-muted mb-4 leading-relaxed">
                Give it a name - you can move projects into it right after, or any time later.
              </p>
              <input
                autoFocus
                className="input w-full text-sm mb-4"
                placeholder="e.g. Q3 marketing"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") createFolder(); }}
                maxLength={80}
              />
              <button
                type="button"
                className="btn-primary w-full text-sm px-4 py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={createFolder}
                disabled={!newFolderName.trim() || creatingFolder}
              >
                {creatingFolder ? "Creating…" : "Create folder"}
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
