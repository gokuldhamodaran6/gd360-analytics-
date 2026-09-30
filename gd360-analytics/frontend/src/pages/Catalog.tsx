import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { catalogApi, datasourceApi, CatalogAssetType, CatalogEntry } from "../api/client";

// 2026-09-30 (data catalog v1): the real, honest answer to
// claude/gd360-competitive-gap-analysis-2026-09-29.md's own gap #8 - "No
// searchable, account-wide data catalog exists - lineage/notes are real but
// scoped to one data source at a time." This page is one search box over
// every kind of asset the account has (data sources, their columns, saved
// transforms, metrics, dashboards, pipelines) - see backend
// services/catalog.py's own module docstring for why this is always a
// live query, never a separate index that could drift out of sync.

const ASSET_TYPE_LABELS: Record<CatalogAssetType, string> = {
  datasource: "Data sources",
  column: "Columns",
  transform: "Saved tables",
  metric: "Metrics",
  dashboard: "Dashboards",
  pipeline: "Pipelines",
};

// Fixed display order - not alphabetical, since "the data source itself"
// reads most naturally before "a column inside one", which reads before
// what's been built on top of it.
const ASSET_TYPE_ORDER: CatalogAssetType[] = ["datasource", "column", "transform", "metric", "dashboard", "pipeline"];

function AssetIcon({ type, className = "w-4 h-4" }: { type: CatalogAssetType; className?: string }) {
  const common = { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (type) {
    case "datasource":
      return (
        <svg {...common}>
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
          <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
        </svg>
      );
    case "column":
      return (
        <svg {...common}>
          <rect x="4" y="3" width="4" height="18" rx="1" />
          <rect x="10" y="3" width="4" height="18" rx="1" />
          <rect x="16" y="3" width="4" height="18" rx="1" />
        </svg>
      );
    case "transform":
      return (
        <svg {...common}>
          <path d="M4 6h9M4 6l3-3M4 6l3 3" />
          <path d="M20 18h-9M20 18l-3-3M20 18l-3 3" />
        </svg>
      );
    case "metric":
      return (
        <svg {...common}>
          <path d="M4 19V10M11 19V5M18 19v-7" />
        </svg>
      );
    case "dashboard":
      return (
        <svg {...common}>
          <path d="M3 3v18h18" />
          <rect x="7" y="12" width="3" height="6" rx="0.5" />
          <rect x="13" y="8" width="3" height="10" rx="0.5" />
          <rect x="18" y="5" width="3" height="13" rx="0.5" />
        </svg>
      );
    case "pipeline":
      return (
        <svg {...common}>
          <circle cx="5" cy="12" r="2.3" />
          <circle cx="12" cy="6" r="2.3" />
          <circle cx="19" cy="12" r="2.3" />
          <circle cx="12" cy="18" r="2.3" />
          <path d="M7 12h10M9.6 7.6l2.9 2.9M14.4 7.6l-2.9 2.9M9.6 16.4l2.9-2.9M14.4 16.4l-2.9-2.9" />
        </svg>
      );
  }
}

// One row's click-through destination - lands directly on the right
// Workspace panel where that fits (see Workspace.tsx's own generalized
// ?tab= deep-link support), rather than always just opening the data
// source's default view.
function entryHref(entry: CatalogEntry): string {
  switch (entry.asset_type) {
    case "datasource":
      return `/workspace/${entry.id}`;
    case "column":
      return `/workspace/${entry.parent_id}?tab=data`;
    case "transform":
      return `/workspace/${entry.parent_id}?tab=transforms`;
    case "metric":
      return `/workspace/${entry.parent_id}?tab=metrics`;
    case "dashboard":
      return `/dashboard-builder/${entry.id}`;
    case "pipeline":
      return `/pipelines`;
  }
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

// Inline "add/edit description" row, shown only on a datasource entry - the
// only asset kind this round gives an editable description to (see backend
// models.DataSource.description's own comment for why: no other asset here
// lacked a description field already).
function DescriptionEditor({
  entry,
  onSaved,
}: {
  entry: CatalogEntry;
  onSaved: (id: string, description: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.description || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setValue(entry.description || "");
  }, [entry.description]);

  if (!editing) {
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-text transition mt-1"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setEditing(true);
        }}
      >
        <EditIcon />
        {entry.description ? "Edit description" : "Add a description"}
      </button>
    );
  }

  const save = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const updated = await datasourceApi.updateDescription(entry.id, value);
      onSaved(entry.id, updated.description ?? null);
      setEditing(false);
    } catch {
      setError("Couldn't save that. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
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
          className="text-[11px] font-medium px-2.5 py-1 rounded-md bg-primary text-white hover:opacity-90 transition disabled:opacity-50"
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
            setValue(entry.description || "");
            setEditing(false);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function Catalog() {
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();

  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [error, setError] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = (q: string) => {
    catalogApi
      .search(q)
      .then(setEntries)
      .catch(() => setError("Couldn't load the catalog. Please try refreshing."));
  };

  // Load the browse (blank-query) view immediately on mount, then re-search
  // on every keystroke after a short debounce - the same "always show
  // something, never a blank screen while typing" pattern the rest of this
  // app's search boxes use.
  useEffect(() => {
    runSearch("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(query), 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const handleDescriptionSaved = (dsId: string, description: string | null) => {
    setEntries((prev) => (prev || []).map((e) => (e.asset_type === "datasource" && e.id === dsId ? { ...e, description } : e)));
  };

  const grouped = ASSET_TYPE_ORDER.map((t) => ({
    type: t,
    items: (entries || []).filter((e) => e.asset_type === t),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onWorkspaceSwitch={switchWorkspace}
        onWorkspaceCreated={handleWorkspaceCreated}
      />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight">Catalog</h1>
            <p className="text-sm text-muted mt-1 max-w-2xl">
              Search everything you&rsquo;ve connected and built - data sources and their columns, saved
              tables, metrics, dashboards, and pipelines - in one place, instead of hunting for it in
              whichever page it happens to live in.
            </p>
          </div>

          <div className="relative mb-6">
            <SearchIcon className="w-4 h-4 text-muted absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              autoFocus
              className="input text-sm w-full py-2.5 pl-10"
              placeholder="Search by name or description…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">{error}</div>}

          {entries === null && !error && <div className="text-sm text-muted">Loading…</div>}

          {entries !== null && entries.length === 0 && (
            <div className="dash-card p-8 text-center">
              <div className="text-sm text-muted leading-relaxed">
                {query.trim() ? (
                  <>Nothing matches &ldquo;{query.trim()}&rdquo;. Try a different name or description.</>
                ) : (
                  <>Nothing to browse yet - connect a data source, then this list fills in on its own.</>
                )}
              </div>
            </div>
          )}

          {grouped.length > 0 && (
            <div className="flex flex-col gap-6">
              {grouped.map((g) => (
                <div key={g.type}>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-2 px-0.5">
                    {ASSET_TYPE_LABELS[g.type]} &middot; {g.items.length}
                  </div>
                  <div className="flex flex-col gap-2">
                    {g.items.map((entry) => (
                      <div
                        key={`${entry.asset_type}:${entry.id}`}
                        role="button"
                        tabIndex={0}
                        className="card p-3.5 text-left hover:bg-surface2 transition cursor-pointer"
                        onClick={() => navigate(entryHref(entry))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") navigate(entryHref(entry));
                        }}
                      >
                        <div className="flex items-start gap-2.5">
                          <span className="w-7 h-7 rounded-md bg-surface2 flex items-center justify-center text-muted shrink-0 mt-0.5">
                            <AssetIcon type={entry.asset_type} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium truncate">{entry.name}</span>
                              {entry.subtitle && <span className="text-[11px] text-muted shrink-0">{entry.subtitle}</span>}
                            </div>
                            {entry.parent_name && (
                              <div className="text-[11px] text-muted mt-0.5">on {entry.parent_name}</div>
                            )}
                            {entry.description && <div className="text-xs text-muted mt-1 line-clamp-2">{entry.description}</div>}
                            {entry.asset_type === "datasource" && (
                              <DescriptionEditor entry={entry} onSaved={handleDescriptionSaved} />
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
