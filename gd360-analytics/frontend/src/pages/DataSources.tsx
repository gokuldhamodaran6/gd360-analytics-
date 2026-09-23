import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { datasourceApi, DataSourceSummary } from "../api/client";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import DataSourceForm, {
  connectionKindMeta, dataSourceCategory, DATA_SOURCE_CATEGORIES, DataSourceCategory,
} from "../components/DataSourceForm";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import ViewToggle, { useViewMode } from "../components/ViewToggle";

// 2026-09-23 (sidebar redesign round): the real, dedicated home for
// browsing every connected data source - previously the only way to see
// them was an always-expanded flat list wedged into the sidebar, with no
// search, no grouping, and no grid/list choice. Mirrors the polish of the
// Dashboards page: search, a category filter, newest/oldest/name sort, and
// a grid/list toggle, with sources grouped by category (Files / Databases
// / Warehouses - see DataSourceForm.dataSourceCategory) so a workspace with
// a dozen sources actually reads at a glance instead of scrolling a plain
// list.

type SortKey = "newest" | "oldest" | "name";

function PlusIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
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

function CloseIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
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

function SourceCard({ ds, viewMode, onOpen }: { ds: DataSourceSummary; viewMode: "grid" | "list"; onOpen: () => void }) {
  const meta = connectionKindMeta(ds.kind);
  if (viewMode === "list") {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="w-full flex items-center gap-3 p-3 rounded-xl border border-border hover:border-primary/50 hover:bg-surface2 transition text-left"
      >
        <span
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}
        >
          <meta.Logo className="w-4 h-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium truncate">{ds.name}</span>
          <span className="block text-xs text-muted truncate">{meta.label}</span>
        </span>
        <span className="text-xs text-muted shrink-0">{timeAgo(ds.created_at)}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="card p-4 flex flex-col gap-2.5 text-left hover:border-primary/50 transition"
    >
      <span
        className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}
      >
        <meta.Logo className="w-4 h-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold truncate">{ds.name}</span>
        <span className="block text-xs text-muted mt-0.5 truncate">{meta.label}</span>
      </span>
      <span className="text-[11px] text-muted mt-auto">{timeAgo(ds.created_at)}</span>
    </button>
  );
}

function ConnectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (ds: { id: string }) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/60 p-4 overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card w-full max-w-lg my-8 sm:my-0 p-6 relative">
        <button className="absolute top-4 right-4 text-muted hover:text-text transition" onClick={onClose} aria-label="Close">
          <CloseIcon className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-bold mb-1">Connect data</h2>
        <p className="text-xs text-muted mb-5 leading-relaxed">
          Connect a database, a warehouse, or upload a file - it'll show up here and in your Projects
          picker right away.
        </p>
        <DataSourceForm onCreated={onCreated} />
      </div>
    </div>,
    document.body
  );
}

export default function DataSources() {
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [sources, setSources] = useState<DataSourceSummary[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<DataSourceCategory | "all">("all");
  const [sortBy, setSortBy] = useState<SortKey>("newest");
  const [viewMode, setViewMode] = useViewMode("gd360_view_datasources");
  const [showConnect, setShowConnect] = useState(false);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    setSources(null);
    datasourceApi
      .list(activeWorkspaceId)
      .then(setSources)
      .catch(() => setError("Couldn't load your data sources. Please try refreshing."));
  }, [activeWorkspaceId]);

  const isViewerHere = workspaces.find((w) => w.id === activeWorkspaceId)?.role === "viewer";

  const grouped = useMemo(() => {
    let list = sources || [];
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((ds) => ds.name.toLowerCase().includes(q));
    const sorted = [...list];
    if (sortBy === "newest") sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    else if (sortBy === "oldest") sorted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    else sorted.sort((a, b) => a.name.localeCompare(b.name));

    const cats = category === "all" ? DATA_SOURCE_CATEGORIES : [category];
    return cats
      .map((cat) => ({ category: cat, sources: sorted.filter((ds) => dataSourceCategory(ds.kind) === cat) }))
      .filter((g) => g.sources.length > 0);
  }, [sources, search, sortBy, category]);

  const hasAny = (sources || []).length > 0;
  const hasFiltersApplied = search.trim() !== "" || category !== "all";

  const handleCreated = (ds: { id: string }) => {
    setShowConnect(false);
    navigate(`/workspace/${ds.id}`);
  };

  return (
    <div className="flex">
      <AppSidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onWorkspaceSwitch={switchWorkspace}
        onWorkspaceCreated={handleWorkspaceCreated}
      />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />

        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Data Sources</h1>
              <p className="text-sm text-muted mt-1">
                Every database, warehouse, and file connected to this workspace, in one place.
              </p>
            </div>
            <button
              type="button"
              className="btn-primary text-sm px-4 py-2.5 inline-flex items-center gap-1.5 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => setShowConnect(true)}
              disabled={isViewerHere}
              title={isViewerHere ? "You have view-only access to this workspace." : undefined}
            >
              <PlusIcon className="w-4 h-4" /> Connect data
            </button>
          </div>

          {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">{error}</div>}

          {hasAny && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 mb-6">
              <div className="relative flex-1 min-w-0 sm:max-w-xs">
                <SearchIcon className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  className="input pl-9 text-sm w-full"
                  placeholder="Search data sources..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <select
                className="input text-sm w-full sm:w-auto"
                value={category}
                onChange={(e) => setCategory(e.target.value as DataSourceCategory | "all")}
              >
                <option value="all">All categories</option>
                {DATA_SOURCE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <select
                className="input text-sm w-full sm:w-auto"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortKey)}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="name">Name A-Z</option>
              </select>
              <ViewToggle mode={viewMode} onChange={setViewMode} />
            </div>
          )}

          {sources === null && !error && <div className="text-sm text-muted">Loading&hellip;</div>}

          {sources !== null && !hasAny && (
            <div className="card p-10 text-center">
              <div className="text-lg font-semibold mb-1.5">No data sources yet</div>
              <p className="text-sm text-muted max-w-sm mx-auto leading-relaxed mb-5">
                {isViewerHere
                  ? "Nothing's been shared into this workspace yet. Ask the workspace owner to add a data source."
                  : "Connect a database, a warehouse, or upload a file to get started."}
              </p>
              {!isViewerHere && (
                <button type="button" className="btn-primary text-sm px-4 py-2.5 inline-flex items-center gap-1.5" onClick={() => setShowConnect(true)}>
                  <PlusIcon className="w-4 h-4" /> Connect data
                </button>
              )}
            </div>
          )}

          {sources !== null && hasAny && grouped.length === 0 && (
            <div className="card p-10 text-center text-sm text-muted">
              No data sources match your filters.{" "}
              {hasFiltersApplied && (
                <button className="text-primary font-medium hover:underline" onClick={() => { setSearch(""); setCategory("all"); }}>
                  Clear filters
                </button>
              )}
            </div>
          )}

          {grouped.map((g) => (
            <div key={g.category} className="mb-8 last:mb-0">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-2">{g.category}</div>
              <div className={viewMode === "grid" ? "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" : "grid grid-cols-1 gap-2"}>
                {g.sources.map((ds) => (
                  <SourceCard key={ds.id} ds={ds} viewMode={viewMode} onOpen={() => navigate(`/workspace/${ds.id}`)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} onCreated={handleCreated} />}
    </div>
  );
}
