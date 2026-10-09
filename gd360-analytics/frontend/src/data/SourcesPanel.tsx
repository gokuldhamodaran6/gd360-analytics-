// 2026-10-09 (round 15): the Sources tab of the Data page - the browsing
// that used to be the whole page (search, sort, grid/list, categories,
// pager), moved here unchanged apart from three things: each source shows
// the Spaces it is in, sources can be ticked and added to a Space in one go,
// and every logo is the shared BrandTile.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { datasourceApi, DataSourceSummary } from "../api/client";
import { Space, spacesApi } from "../api/spaces";
import BrandTile from "../components/BrandTile";
import {
  connectionKindMeta, dataSourceCategory, DATA_SOURCE_CATEGORIES, DataSourceCategory, SyncedAppIcon,
} from "../components/DataSourceForm";
import { SyncControl } from "../components/ConnectApps";
import ViewToggle, { useViewMode } from "../components/ViewToggle";
import { BulkAddBar, errorText, Skeleton, SpaceTag, spacesBySource } from "./shared";

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

function EditIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
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
  if (cat === "Apps") return SyncedAppIcon;
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

// 2026-09-28 (streaming/webhook ingestion round): "live" means a real
// webhook event genuinely arrived within the last 5 minutes - never a
// simulated or assumed status. Only ever true for a kind==="streaming"
// source; every other kind has no last_event_at at all.
const LIVE_WINDOW_MS = 5 * 60 * 1000;

function isLiveStreaming(ds: DataSourceSummary): boolean {
  if (ds.kind !== "streaming" || !ds.last_event_at) return false;
  return Date.now() - new Date(ds.last_event_at).getTime() < LIVE_WINDOW_MS;
}

// Same pulsing-dot-plus-label pattern AdminDashboard.tsx's own "Active"
// status pill uses (a small colored dot + text) - reused here rather than
// invented fresh, per this app's own small-badge convention.
function LiveBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 shrink-0"
      title="Received an event in the last few minutes"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
      Live
    </span>
  );
}

// Phase 2, feature 4: the manual "Refresh" action + "last refreshed X ago"
// text an "api"-kind source's card shows, in place of the plain created-at
// timestamp every other kind shows - never a fabricated "live" indicator
// the way streaming's LiveBadge is (there is no ongoing connection here to
// be "live"), just an honest "as of when it was last actually fetched".
// Its own small component (rather than inlined into SourceCard) purely so
// its click can stopPropagation/preventDefault without SourceCard's own
// onOpen handler needing to know this exists.
function ApiRefreshControl({
  ds,
  onRefreshed,
}: {
  ds: DataSourceSummary;
  onRefreshed: (updated: DataSourceSummary) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const doRefresh = async (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const updated = await datasourceApi.refreshApi(ds.id);
      onRefreshed(updated);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
      <span className="text-[11px] text-muted">
        {failed
          ? "Refresh failed"
          : ds.api_last_refreshed_at
          ? `Refreshed ${timeAgo(ds.api_last_refreshed_at)}`
          : "Never refreshed"}
      </span>
      <button
        type="button"
        onClick={doRefresh}
        disabled={busy}
        className="text-[11px] font-medium text-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? "Refreshing…" : "Refresh"}
      </button>
    </span>
  );
}

// 2026-09-30 (Governance/Jobs redesign + Pipelines/Catalog removal round):
// ported over from the now-removed Catalog.tsx (its one real, non-
// redundant capability - editing a data source's short description - see
// AppSidebar.tsx's own removal comment). Same inline "add/edit
// description" pattern, just typed against DataSourceSummary instead of
// CatalogEntry and calling the exact same datasourceApi.updateDescription
// endpoint the Catalog page always called.
function DescriptionEditor({
  ds,
  onSaved,
}: {
  ds: DataSourceSummary;
  onSaved: (updated: DataSourceSummary) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(ds.description || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setValue(ds.description || "");
  }, [ds.description]);

  if (!editing) {
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-text transition"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setEditing(true);
        }}
      >
        <EditIcon />
        {ds.description ? "Edit description" : "Add a description"}
      </button>
    );
  }

  const save = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const updated = await datasourceApi.updateDescription(ds.id, value);
      onSaved(updated);
      setEditing(false);
    } catch {
      setError("Couldn't save that. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-1.5 w-full" onClick={(e) => e.stopPropagation()}>
      <textarea
        autoFocus
        className="text-xs w-full bg-surface2 border border-border rounded-lg px-2.5 py-1.5 resize-none"
        rows={2}
        maxLength={2000}
        placeholder="A short, plain-English blurb of what this data source is - e.g. the Stripe export our finance team refreshes every Monday"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
      />
      {error && <div className="text-[11px] text-red-400 mt-1">{error}</div>}
      <div className="flex items-center gap-2 mt-1.5">
        <button
          type="button"
          className="text-[11px] font-medium px-2.5 py-1 rounded-md bg-primary text-on-primary hover:opacity-90 transition disabled:opacity-50"
          disabled={saving}
          onClick={save}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="text-[11px] font-medium px-2.5 py-1 rounded-md border border-border hover:bg-surface2 transition"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            setValue(ds.description || "");
            setEditing(false);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function SelectBox({ ds, selected, onToggle }: { ds: DataSourceSummary; selected: boolean; onToggle: () => void }) {
  return (
    <label
      className="ui-focus shrink-0 w-8 h-8 -m-1 grid place-items-center rounded-[8px] hover:bg-surface2 cursor-pointer"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <input type="checkbox" className="w-4 h-4" aria-label={`Select ${ds.name}`} checked={selected} onChange={onToggle} />
    </label>
  );
}

function SourceCard({
  ds,
  viewMode,
  onOpen,
  onRefreshed,
  spaces,
  selectable,
  selected,
  onToggleSelect,
}: {
  ds: DataSourceSummary;
  viewMode: "grid" | "list";
  onOpen: () => void;
  // Used for kind === "api" refreshes AND for a description save (2026-
  // 09-30 round) - both update this one card's row in the parent's own
  // `sources` list in place, so the UI reflects reality immediately
  // without a full re-fetch of the whole page.
  onRefreshed: (updated: DataSourceSummary) => void;
  // 2026-10-09 (round 15): the Spaces this source is in, and its tick box.
  spaces: Space[];
  selectable: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const meta = connectionKindMeta(ds.kind);
  const live = isLiveStreaming(ds);
  const isApi = ds.kind === "api";
  const isSynced = dataSourceCategory(ds.kind) === "Apps";
  const tags = spaces.length > 0 && (
    <span className="flex gap-1.5 flex-wrap" aria-label="In Spaces">
      {spaces.map((s) => (
        <SpaceTag key={s.id} space={s} />
      ))}
    </span>
  );
  // Both variants below used to be a single <button>; an api-kind card now
  // needs its own nested, independently-clickable Refresh button, and a
  // <button> can never nest another interactive control validly - so both
  // become a keyboard-accessible <div role="button"> for the main "open
  // this data source" action instead, with the refresh row as a sibling.
  if (viewMode === "list") {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
        className={`w-full flex flex-wrap sm:flex-nowrap items-center gap-3 p-3 rounded-xl border hover:border-primary/50 hover:bg-surface2 transition text-left cursor-pointer ${selected ? "border-primary/50 bg-primary/5" : "border-border"}`}
      >
        {selectable && <SelectBox ds={ds} selected={selected} onToggle={onToggleSelect} />}
        <BrandTile kind={ds.kind} name={ds.name} size={36} />
        <span className="min-w-0 flex-1 flex flex-col gap-1">
          <span className="block text-sm font-medium truncate">{ds.name}</span>
          {tags}
        </span>
        {live && <LiveBadge />}
        {ds.description && (
          <span className="hidden md:inline-block text-xs text-muted truncate max-w-[220px]" title={ds.description}>
            {ds.description}
          </span>
        )}
        {isApi && <ApiRefreshControl ds={ds} onRefreshed={onRefreshed} />}
        <span className="hidden sm:inline-block text-[11px] font-medium px-2 py-0.5 rounded-full shrink-0 bg-surface2 text-secondary">
          {meta.label}
        </span>
        {isSynced && <SyncControl ds={ds} />}
        {!isApi && !isSynced && <span className="text-xs text-muted shrink-0">{timeAgo(ds.created_at)}</span>}
      </div>
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className={`card p-4 flex flex-col gap-2.5 text-left hover:border-primary/50 hover:shadow-glow transition cursor-pointer min-w-0 ${selected ? "!border-primary/50" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <BrandTile kind={ds.kind} name={ds.name} size={36} />
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 bg-surface2 text-secondary truncate">
            {meta.label}
          </span>
          {selectable && <SelectBox ds={ds} selected={selected} onToggle={onToggleSelect} />}
        </span>
      </div>
      <span className="min-w-0 flex items-center gap-1.5">
        <span className="block text-sm font-semibold truncate">{ds.name}</span>
        {live && <LiveBadge />}
      </span>
      {tags}
      {ds.description && <span className="text-xs text-muted line-clamp-2">{ds.description}</span>}
      <DescriptionEditor ds={ds} onSaved={onRefreshed} />
      {isSynced ? (
        <span className="mt-auto"><SyncControl ds={ds} /></span>
      ) : isApi ? (
        <span className="mt-auto"><ApiRefreshControl ds={ds} onRefreshed={onRefreshed} /></span>
      ) : (
        <span className="text-[11px] text-muted mt-auto">{timeAgo(ds.created_at)}</span>
      )}
    </div>
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
      active ? "bg-primary text-on-primary border-primary font-semibold" : "border-border text-muted hover:text-text hover:bg-surface2"
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

export default function SourcesPanel({
  sources,
  setSources,
  spaces,
  isViewer,
  onSpaceUpdated,
  onConnectNew,
}: {
  sources: DataSourceSummary[] | null;
  setSources: React.Dispatch<React.SetStateAction<DataSourceSummary[] | null>>;
  spaces: Space[] | null;
  isViewer: boolean;
  onSpaceUpdated: (s: Space) => void;
  onConnectNew: () => void;
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [sortBy, setSortBy] = useState<SortKey>("newest");
  const [viewMode, setViewMode] = useViewMode("gd360_view_datasources");
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // A fresh search/filter/sort - or a newly connected source changing the
  // result set - always lands back on page 1, so the pager never points at
  // a now-empty page the person has to notice and back out of by hand.
  useEffect(() => { setPage(1); }, [search, category, sortBy, sources]);

  const bySource = useMemo(() => spacesBySource(spaces), [spaces]);

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
  const canAssign = !isViewer && (spaces || []).some((s) => s.can_edit);

  const toggle = (id: string) =>
    setSel((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addTo = async (space: Space) => {
    const ids = Array.from(sel);
    setBusy(true);
    setMsg(null);
    try {
      const out = await spacesApi.assign(space.id, ids);
      onSpaceUpdated(out);
      setSel(new Set());
      setMsg({ ok: true, text: `Added ${ids.length} ${ids.length === 1 ? "source" : "sources"} to ${space.name}.` });
    } catch (e: any) {
      setMsg({ ok: false, text: errorText(e, `Couldn't add those to ${space.name}. Please try again.`) });
    } finally {
      setBusy(false);
    }
  };

  if (sources === null) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" aria-busy="true" aria-label="Loading your sources">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[150px] rounded-[14px]" />
        ))}
      </div>
    );
  }

  if (!hasAny) {
    return (
      <div className="rounded-[18px] border border-dashed border-border-strong py-10 px-6 text-center">
        <div className="text-[16px] font-semibold mb-1.5">No data sources yet</div>
        <p className="text-sm text-muted max-w-sm mx-auto leading-relaxed mb-5">
          {isViewer
            ? "Nothing's been shared into this workspace yet. Ask the workspace owner to add a data source."
            : "Connect an app, a database, a warehouse, or upload a file to get started."}
        </p>
        {!isViewer && (
          <button type="button" className="btn-primary text-sm px-4 py-2.5" onClick={onConnectNew}>
            Browse the catalog
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Search + sort + grid/list toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 mb-3">
        <div className="relative flex-1 min-w-0 sm:max-w-xs">
          <SearchIcon className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <label htmlFor="sources-search" className="sr-only">Search data sources</label>
          <input
            id="sources-search"
            className="input input-icon h-10 text-sm w-full"
            placeholder="Search data sources..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label htmlFor="sources-sort" className="sr-only">Sort</label>
        <select id="sources-sort" className="input h-10 text-sm w-full sm:w-auto" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)}>
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
      <div className="grid grid-cols-5 gap-1 p-1 mb-4 rounded-xl bg-surface2 border border-border">
        {CATEGORY_TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            onClick={() => setCategory(t.key)}
            aria-pressed={category === t.key}
            className={`flex flex-col items-center justify-center gap-1 px-1 py-2.5 rounded-lg text-xs font-medium transition min-w-0 ${
              category === t.key ? "bg-primary text-on-primary shadow-sm" : "text-muted hover:text-text"
            }`}
          >
            <t.Icon className="w-4 h-4 shrink-0" />
            <span className="w-full text-center leading-tight truncate">{t.label}</span>
          </button>
        ))}
      </div>

      {/* Reserved row so ticking a source never pushes the grid down. */}
      {canAssign && (
        <div className="min-h-[44px] mb-3 flex items-center gap-3 flex-wrap">
          {sel.size > 0 ? (
            <BulkAddBar count={sel.size} spaces={spaces || []} busy={busy} onAdd={addTo} onClear={() => setSel(new Set())} />
          ) : msg ? (
            <span role="status" className={`text-[13px] ${msg.ok ? "text-good" : "text-danger"}`}>{msg.text}</span>
          ) : (
            <span className="text-[13px] text-muted">Tick sources to add them to a Space.</span>
          )}
        </div>
      )}

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
                  <SourceCard
                    key={ds.id}
                    ds={ds}
                    viewMode={viewMode}
                    onOpen={() => navigate(`/workspace/${ds.id}`)}
                    onRefreshed={(updated) => setSources((prev) => (prev || []).map((s) => (s.id === updated.id ? updated : s)))}
                    spaces={bySource.get(ds.id) || []}
                    selectable={canAssign}
                    selected={sel.has(ds.id)}
                    onToggleSelect={() => toggle(ds.id)}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}

      <Pager page={currentPage} totalPages={totalPages} onChange={setPage} />

      {!isViewer && (
        <div className="mt-8 pt-6 border-t border-border text-center">
          <p className="text-sm text-muted mb-3">Didn't find what you're looking for?</p>
          <button type="button" className="btn-secondary text-sm px-4 py-2.5 inline-flex items-center gap-1.5" onClick={onConnectNew}>
            <PlusIcon className="w-3.5 h-3.5" /> Connect new data
          </button>
        </div>
      )}
    </div>
  );
}
