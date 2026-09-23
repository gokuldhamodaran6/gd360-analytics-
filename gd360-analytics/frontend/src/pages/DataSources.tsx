import { useEffect, useMemo, useRef, useState } from "react";
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
//
// 2026-09-23, round two (Gokul's own explicit design feedback): "+ Connect
// data" no longer opens a big page-covering popup - the whole browse/
// connect experience now lives directly on the page. "Existing data" and
// "+ New data" are two plain buttons up top, not a single button hiding a
// modal: "Existing data" just brings the page's own already-visible grid
// into view, "+ New data" expands DataSourceForm inline right below the
// header (its own established "pick a logo, get one focused popout form"
// flow - see DataSourceForm.tsx - is unchanged; only the OUTER wrapper
// around it stopped being a modal). The grid itself is now paginated
// (PAGE_SIZE below) so a workspace with a long history of connections
// still loads fast, with numbered page buttons the way a spreadsheet app
// pages through a long sheet - and each category's own section heading is
// far more prominent than before, so "which kind of source is this" reads
// at a glance instead of only showing up as a small subtitle per card.

type SortKey = "newest" | "oldest" | "name";

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
  const [category, setCategory] = useState<DataSourceCategory | "all">("all");
  const [sortBy, setSortBy] = useState<SortKey>("newest");
  const [viewMode, setViewMode] = useViewMode("gd360_view_datasources");
  const [page, setPage] = useState(1);

  // "+ New data" expands DataSourceForm inline, right here on the page -
  // no more modal wrapper (2026-09-23, Gokul's own explicit ask). Its OWN
  // established per-kind popout ("click a logo, get one focused connect
  // form" - see DataSourceForm.tsx) is unchanged; only this outer wrapper
  // stopped being a popup.
  const [showNewData, setShowNewData] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

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
    setShowNewData(false);
    navigate(`/workspace/${ds.id}`);
  };

  // Fires as soon as a connect/upload actually succeeds, before the person
  // has clicked through DataSourceForm's own "Connected" confirmation - so
  // a newly added source already shows up in the grid below even if they
  // close this panel without navigating anywhere.
  const handleConnected = () => {
    if (activeWorkspaceId) datasourceApi.list(activeWorkspaceId).then(setSources).catch(() => {});
  };

  const focusExisting = () => {
    setShowNewData(false);
    gridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
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
            {/* Two plain buttons instead of one "+ Connect data" button that
                used to hide everything behind a popup - "Existing data"
                just brings the grid below into view, "+ New data" expands
                the connect flow inline right here. Same outline-then-
                filled pairing used on the Projects page's New Folder/New
                Project buttons, for one consistent visual language. */}
            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                className="btn-secondary text-sm px-4 py-2.5 inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={focusExisting}
                disabled={!hasAny}
                title={!hasAny ? "Nothing connected yet." : undefined}
              >
                <SearchIcon className="w-3.5 h-3.5" /> Existing data
              </button>
              <button
                type="button"
                className={`text-sm px-4 py-2.5 inline-flex items-center gap-1.5 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed rounded-[9px] font-semibold transition ${
                  showNewData ? "btn-secondary" : "btn-primary"
                }`}
                onClick={() => setShowNewData((v) => !v)}
                disabled={isViewerHere}
                title={isViewerHere ? "You have view-only access to this workspace." : undefined}
              >
                {showNewData ? (
                  <>
                    <CloseIcon className="w-3.5 h-3.5" /> Close
                  </>
                ) : (
                  <>
                    <PlusIcon className="w-4 h-4" /> New data
                  </>
                )}
              </button>
            </div>
          </div>

          {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">{error}</div>}

          {/* ---- Inline "connect new source" panel ----
              Replaces the old full-screen modal - same DataSourceForm
              component, same per-kind popout once a logo is clicked, just
              never covering the whole page anymore. */}
          {showNewData && (
            <div className="card p-5 sm:p-6 mb-6 border-primary/30">
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-base font-bold">Connect a new data source</h2>
                  <p className="text-xs text-muted mt-0.5">
                    Pick a database or warehouse, or upload a file - it shows up below the moment it's ready.
                  </p>
                </div>
                <button
                  type="button"
                  className="text-muted hover:text-text transition shrink-0"
                  onClick={() => setShowNewData(false)}
                  aria-label="Close"
                >
                  <CloseIcon className="w-5 h-5" />
                </button>
              </div>
              <DataSourceForm onCreated={handleCreated} onConnected={handleConnected} />
            </div>
          )}

          {hasAny && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 mb-6 p-2 rounded-xl border border-border bg-surface/60">
              <div className="relative flex-1 min-w-0 sm:max-w-xs">
                <SearchIcon className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  className="input h-10 pl-9 text-sm w-full"
                  placeholder="Search data sources..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <select
                className="input h-10 text-sm w-full sm:w-auto"
                value={category}
                onChange={(e) => setCategory(e.target.value as DataSourceCategory | "all")}
              >
                <option value="all">All categories</option>
                {DATA_SOURCE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
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
          )}

          <div ref={gridRef} className="scroll-mt-6">
            {sources === null && !error && <div className="text-sm text-muted">Loading&hellip;</div>}

            {sources !== null && !hasAny && !showNewData && (
              <div className="card p-10 text-center">
                <div className="text-lg font-semibold mb-1.5">No data sources yet</div>
                <p className="text-sm text-muted max-w-sm mx-auto leading-relaxed mb-5">
                  {isViewerHere
                    ? "Nothing's been shared into this workspace yet. Ask the workspace owner to add a data source."
                    : "Connect a database, a warehouse, or upload a file to get started."}
                </p>
                {!isViewerHere && (
                  <button type="button" className="btn-primary text-sm px-4 py-2.5 inline-flex items-center gap-1.5" onClick={() => setShowNewData(true)}>
                    <PlusIcon className="w-4 h-4" /> New data
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

            {grouped.map((g) => {
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
            })}

            <Pager page={currentPage} totalPages={totalPages} onChange={setPage} />
          </div>
        </div>
      </div>
    </div>
  );
}
