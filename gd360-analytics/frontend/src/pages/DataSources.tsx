import { useEffect, useMemo, useState } from "react";
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
// search, no grouping, and no grid/list choice.
//
// 2026-09-23, round two (Gokul's own explicit design feedback): "+ Connect
// data" no longer opens a big page-covering popup - the whole browse/
// connect experience now lives directly on the page, as two views instead
// of a popup: "Existing data" and "+ New data".
//
// 2026-09-23, round three (more of Gokul's own explicit feedback, after
// seeing round two live): the two views are now genuinely exclusive - New
// data used to render with the full existing-sources grid still sitting
// underneath it, which read as broken. They're a real two-way switch now
// (`view` below), never both on screen together. The page also now opens
// on New data by default - "i have to see new data sources option not
// existing ones" - since that's the action someone opening this page is
// most often here for; Existing data is one click away, and a "Connect new
// data" prompt sits below the existing grid too, not just up in the
// header. The existing-sources browser also lost its plain "All
// categories" dropdown in favor of the exact same segmented, icon-plus-
// label picker style DataSourceForm's own Database/Warehouse/Connect/
// Upload file tabs use (see the grid below) - one consistent picker style
// for "pick a kind of thing" anywhere in this app, not two different
// control types that happen to do the same job.

type SortKey = "newest" | "oldest" | "name";
type CategoryFilter = DataSourceCategory | "all";

const PAGE_SIZE = 12;

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

function DatabaseGlyph({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </svg>
  );
}

function WarehouseGlyph({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10.5 12 4l9 6.5" />
      <path d="M5 9.5V20h14V9.5" />
      <path d="M9 20v-6h6v6" />
    </svg>
  );
}

function FileGlyph({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2h9l5 5v15H6z" />
      <path d="M15 2v5h5" />
    </svg>
  );
}

// The "All" slot in the category picker - a plain 2x2 grid, same visual
// family as AppSidebar's own ProjectsIcon, so "show everything" reads as
// its own distinct glyph rather than a reused Files/Databases/Warehouses
// icon standing in for "all of the above".
function AllGlyph({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

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

function categoryGlyph(cat: DataSourceCategory) {
  if (cat === "Databases") return DatabaseGlyph;
  if (cat === "Warehouses") return WarehouseGlyph;
  return FileGlyph;
}

// The category picker's four slots - "All" plus the same three categories
// DataSourceForm.DATA_SOURCE_CATEGORIES defines, in that order.
const CATEGORY_TABS: { key: CategoryFilter; label: string; Icon: (p: { className?: string }) => JSX.Element }[] = [
  { key: "all", label: "All", Icon: AllGlyph },
  ...DATA_SOURCE_CATEGORIES.map((cat) => ({ key: cat, label: cat, Icon: categoryGlyph(cat) })),
];

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
        </span>
        <span
          className="hidden sm:inline-block text-[11px] font-medium px-2 py-0.5 rounded-full shrink-0"
          style={{ backgroundColor: `${meta.color}14`, color: meta.color }}
        >
          {meta.label}
        </span>
        <span className="text-xs text-muted shrink-0">{timeAgo(ds.created_at)}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="card p-4 flex flex-col gap-2.5 text-left hover:border-primary/50 hover:shadow-glow transition"
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}
        >
          <meta.Logo className="w-4 h-4" />
        </span>
        <span
          className="text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0"
          style={{ backgroundColor: `${meta.color}14`, color: meta.color }}
        >
          {meta.label}
        </span>
      </div>
      <span className="min-w-0">
        <span className="block text-sm font-semibold truncate">{ds.name}</span>
      </span>
      <span className="text-[11px] text-muted mt-auto">{timeAgo(ds.created_at)}</span>
    </button>
  );
}

// Excel-style numbered pager: Prev, a compact run of page numbers (with a
// "…" gap once there are more pages than reasonably fit), Next - so paging
// through a long list of connections is instant instead of an infinite
// scroll that keeps fetching/re-rendering everything at once.
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

export default function DataSources() {
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [sources, setSources] = useState<DataSourceSummary[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [sortBy, setSortBy] = useState<SortKey>("newest");
  const [viewMode, setViewMode] = useViewMode("gd360_view_datasources");
  const [page, setPage] = useState(1);

  // A real two-way switch, not a popup toggled on top of an always-visible
  // grid (2026-09-23, round three - Gokul's own explicit bug report: the
  // existing-sources list was still showing underneath the New data panel).
  // Defaults to "new" - opening this page is most often "I want to add
  // something", so that's what's in view first; "Existing data" is one
  // click away and stays exactly one click away via the prompt below the
  // grid too.
  const [view, setView] = useState<"new" | "existing">("new");

  useEffect(() => {
    if (!activeWorkspaceId) return;
    setSources(null);
    datasourceApi
      .list(activeWorkspaceId)
      .then(setSources)
      .catch(() => setError("Couldn't load your data sources. Please try refreshing."));
  }, [activeWorkspaceId]);

  // A fresh search/filter/sort - or a newly connected source changing the
  // result set - always lands back on page 1, so the pager never points at
  // a now-empty page the person has to notice and back out of by hand.
  useEffect(() => { setPage(1); }, [search, category, sortBy, sources]);

  const isViewerHere = workspaces.find((w) => w.id === activeWorkspaceId)?.role === "viewer";

  const filteredSorted = useMemo(() => {
    let list = sources || [];
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((ds) => ds.name.toLowerCase().includes(q));
    if (category !== "all") list = list.filter((ds) => dataSourceCategory(ds.kind) === category);
    const sorted = [...list];
    if (sortBy === "newest") sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    else if (sortBy === "oldest") sorted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    else sorted.sort((a, b) => a.name.localeCompare(b.name));
    return sorted;
  }, [sources, search, sortBy, category]);

  const totalPages = Math.max(1, Math.ceil(filteredSorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageSlice = useMemo(
    () => filteredSorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filteredSorted, currentPage]
  );

  // Only THIS page's items get grouped into category sections - grouping
  // the full filtered list first and paginating second would mean a
  // "page" could still be an arbitrarily large slice of one huge category,
  // defeating the point of paging at all.
  const grouped = useMemo(() => {
    const cats = category === "all" ? DATA_SOURCE_CATEGORIES : [category];
    return cats
      .map((cat) => ({ category: cat, sources: pageSlice.filter((ds) => dataSourceCategory(ds.kind) === cat) }))
      .filter((g) => g.sources.length > 0);
  }, [pageSlice, category]);

  const hasAny = (sources || []).length > 0;
  const hasFiltersApplied = search.trim() !== "" || category !== "all";

  const handleCreated = (ds: { id: string }) => {
    navigate(`/workspace/${ds.id}`);
  };

  // Fires as soon as a connect/upload actually succeeds, before the person
  // has clicked through DataSourceForm's own "Connected" confirmation - so
  // a newly added source already shows up in Existing data even if they
  // close this panel without navigating anywhere.
  const handleConnected = () => {
    if (activeWorkspaceId) datasourceApi.list(activeWorkspaceId).then(setSources).catch(() => {});
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
            {/* A real two-way switch - exactly one of "Existing data" /
                "+ New data" is ever the filled (active) button, and exactly
                one of the two sections below is ever on screen. Same
                outline-then-filled pairing used on the Projects page's New
                Folder/New Project buttons, for one consistent visual
                language: filled = this is what you're looking at now. */}
            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                className={`text-sm px-4 py-2.5 inline-flex items-center gap-1.5 shrink-0 ${view === "existing" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setView("existing")}
              >
                <SearchIcon className="w-3.5 h-3.5" /> Existing data
              </button>
              <button
                type="button"
                className={`text-sm px-4 py-2.5 inline-flex items-center gap-1.5 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${view === "new" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setView("new")}
                disabled={isViewerHere}
                title={isViewerHere ? "You have view-only access to this workspace." : undefined}
              >
                <PlusIcon className="w-4 h-4" /> New data
              </button>
            </div>
          </div>

          {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">{error}</div>}

          {/* ---- "New data" view ----
              Same DataSourceForm component, same per-kind popout once a
              logo is clicked, just never covering the whole page and never
              sharing the screen with the existing-sources browser
              underneath it. */}
          {view === "new" && (
            <div className="card p-5 sm:p-6 border-primary/30">
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-base font-bold">Connect a new data source</h2>
                  <p className="text-xs text-muted mt-0.5">
                    Pick a database or warehouse, or upload a file - it shows up under Existing data the moment it's ready.
                  </p>
                </div>
                {hasAny && (
                  <button
                    type="button"
                    className="text-muted hover:text-text transition shrink-0"
                    onClick={() => setView("existing")}
                    aria-label="Back to existing data"
                    title="Back to existing data"
                  >
                    <CloseIcon className="w-5 h-5" />
                  </button>
                )}
              </div>
              <DataSourceForm onCreated={handleCreated} onConnected={handleConnected} />
            </div>
          )}

          {/* ---- "Existing data" view ----
              One coherent card, matching the New data panel's own visual
              weight instead of a thin loose toolbar sitting on the page
              background - and its category filter is the exact same
              segmented icon-plus-label picker style DataSourceForm's own
              Database/Warehouse/Connect/Upload file tabs use, not a plain
              dropdown, so "pick a kind of thing" looks and behaves the same
              wherever it shows up in this app. */}
          {view === "existing" && (
            <div className="card p-5 sm:p-6">
              <div className="mb-4">
                <h2 className="text-base font-bold">Your data sources</h2>
                <p className="text-xs text-muted mt-0.5">Everything connected to this workspace, filtered by category.</p>
              </div>

              {sources === null && !error && <div className="text-sm text-muted py-6 text-center">Loading&hellip;</div>}

              {sources !== null && !hasAny && (
                <div className="py-8 text-center">
                  <div className="text-base font-semibold mb-1.5">No data sources yet</div>
                  <p className="text-sm text-muted max-w-sm mx-auto leading-relaxed mb-5">
                    {isViewerHere
                      ? "Nothing's been shared into this workspace yet. Ask the workspace owner to add a data source."
                      : "Connect a database, a warehouse, or upload a file to get started."}
                  </p>
                  {!isViewerHere && (
                    <button type="button" className="btn-primary text-sm px-4 py-2.5 inline-flex items-center gap-1.5" onClick={() => setView("new")}>
                      <PlusIcon className="w-4 h-4" /> New data
                    </button>
                  )}
                </div>
              )}

              {sources !== null && hasAny && (
                <>
                  {/* Search + sort + grid/list toggle */}
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 mb-3">
                    <div className="relative flex-1 min-w-0 sm:max-w-xs">
                      <SearchIcon className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        className="input input-icon h-10 text-sm w-full"
                        placeholder="Search data sources..."
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
                      <option value="name">Name A-Z</option>
                    </select>
                    <div className="sm:ml-auto h-10 flex items-center">
                      <ViewToggle mode={viewMode} onChange={setViewMode} />
                    </div>
                  </div>

                  {/* Category picker - same segmented style as DataSourceForm's
                      own Database/Warehouse/Connect/Upload file tabs. */}
                  <div className="grid grid-cols-4 gap-1 p-1 mb-5 rounded-xl bg-surface2 border border-border">
                    {CATEGORY_TABS.map((t) => (
                      <button
                        type="button"
                        key={t.key}
                        onClick={() => setCategory(t.key)}
                        aria-pressed={category === t.key}
                        className={`flex flex-col items-center justify-center gap-1 px-1 py-2.5 rounded-lg text-xs font-medium transition ${
                          category === t.key ? "bg-primary text-white shadow-sm" : "text-muted hover:text-text"
                        }`}
                      >
                        <t.Icon className="w-4 h-4 shrink-0" />
                        <span className="w-full text-center leading-tight truncate">{t.label}</span>
                      </button>
                    ))}
                  </div>

                  {grouped.length === 0 ? (
                    <div className="py-10 text-center text-sm text-muted">
                      No data sources match your filters.{" "}
                      {hasFiltersApplied && (
                        <button className="text-primary font-medium hover:underline" onClick={() => { setSearch(""); setCategory("all"); }}>
                          Clear filters
                        </button>
                      )}
                    </div>
                  ) : (
                    grouped.map((g) => {
                      const Glyph = categoryGlyph(g.category);
                      return (
                        <div key={g.category} className="mb-8 last:mb-0">
                          <div className="flex items-center gap-2 mb-3">
                            <span className="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                              <Glyph className="w-4 h-4" />
                            </span>
                            <h3 className="text-sm font-bold tracking-tight">{g.category}</h3>
                            <span className="text-xs text-muted">
                              {filteredSorted.filter((ds) => dataSourceCategory(ds.kind) === g.category).length}
                            </span>
                            <div className="flex-1 h-px bg-border ml-1" />
                          </div>
                          <div className={viewMode === "grid" ? "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" : "grid grid-cols-1 gap-2"}>
                            {g.sources.map((ds) => (
                              <SourceCard key={ds.id} ds={ds} viewMode={viewMode} onOpen={() => navigate(`/workspace/${ds.id}`)} />
                            ))}
                          </div>
                        </div>
                      );
                    })
                  )}

                  <Pager page={currentPage} totalPages={totalPages} onChange={setPage} />

                  {/* The way back to New data from down here, not just the
                      header button up top - so adding another source never
                      means scrolling back to the very top of the page. */}
                  {!isViewerHere && (
                    <div className="mt-8 pt-6 border-t border-border text-center">
                      <p className="text-sm text-muted mb-3">Didn't find what you're looking for?</p>
                      <button type="button" className="btn-secondary text-sm px-4 py-2.5 inline-flex items-center gap-1.5" onClick={() => setView("new")}>
                        <PlusIcon className="w-3.5 h-3.5" /> Connect new data
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
