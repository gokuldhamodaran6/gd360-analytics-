import { useEffect, useState } from "react";
import { DataSourceSummary, DatasetVersion, datasourceApi } from "../api/client";
import DataSourceForm, { CreatedDataSource, connectionKindMeta, getTableEntries, hasMultipleTables } from "./DataSourceForm";
import { otherDsSourceId } from "./ChatPanel";

// The header-level "+ Add data" entry point: a dedicated, always-visible
// button next to the datasource name (see Workspace.tsx), as opposed to the
// same underlying capability tucked inside the chat panel's WORKING ON
// dropdown - Gokul's own explicit ask, since the dropdown version turned
// out to be too easy to miss entirely. Both write into the exact same
// `sourceIds` selection ChatPanel reads from, so picking a table here shows
// up in WORKING ON immediately and vice versa - one selection, two doors
// into it.
//
// Two things the popup lets someone do, picked with a first click - just
// two big buttons on open, nothing else (a grid of one tile per connected
// source got unreadable once someone had more than a handful of them, since
// most file uploads share the same generic icon and similar names - "em
// tesst", "emberash", "emberash-1.xlsx" - so the tiles told them nothing
// they could scan at a glance; a plain searchable list reads far better
// once you're actually choosing which one, see the "existing" view below):
//   - "Existing data": browse/search the OTHER data sources already
//     connected, click one to see its real tables/sheets and saved tables,
//     and check off whichever to pull into this analysis.
//   - "New data": connect a brand-new data source on the spot (the same
//     DataSourceForm used everywhere else in the app - a database, a
//     warehouse, or a file upload), which then becomes immediately
//     available to add from, with its default table auto-selected the
//     moment it's connected.
export default function AddDataPicker({
  open,
  onClose,
  sourceIds,
  onSourceIdsChange,
  otherDataSources,
  onDataSourceCreated,
  conversationId,
}: {
  open: boolean;
  onClose: () => void;
  sourceIds: string[];
  onSourceIdsChange: (ids: string[]) => void;
  otherDataSources: DataSourceSummary[];
  // Fired once a brand-new data source is connected from inside this popup,
  // so Workspace can add it to its own `allDataSources` list right away -
  // otherwise it would only show up here the next time that list happens to
  // refetch.
  onDataSourceCreated: (ds: CreatedDataSource) => void;
  // This Project's own conversation id (null before its first message) -
  // scopes which of another connected source's saved tables SourceDetail
  // offers to add (see its own filter below). Mirrors the exact rule
  // Workspace.tsx already applies to this datasource's own versions, and
  // the same fix applied to the WORKING ON picker in ChatPanel.tsx - this
  // is the header-level door into the identical picker, so it needs the
  // identical scoping or the same "every table ever built, from every
  // unrelated past Project" confusion just walks back in through here.
  conversationId?: string | null;
}) {
  // null = the two-button landing; "existing" = the searchable list of
  // already-connected sources; "new" = the connect-a-new-source form; any
  // other string = a specific other data source's id, showing its detail
  // view (one level deeper than "existing", reached by picking a row there).
  const [view, setView] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [versionsById, setVersionsById] = useState<Record<string, DatasetVersion[]>>({});
  const [loadingVersions, setLoadingVersions] = useState<Set<string>>(new Set());

  // Every time the popup opens fresh, start back on the two-button landing
  // rather than wherever it was left last time - a person reopening this a
  // minute later almost always wants to choose again, not resume a
  // half-finished detail view they may not even remember opening.
  useEffect(() => {
    if (open) { setView(null); setQuery(""); }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const fetchVersions = (dsId: string) => {
    if (versionsById[dsId] || loadingVersions.has(dsId)) return;
    setLoadingVersions((s) => new Set(s).add(dsId));
    datasourceApi
      .listVersions(dsId)
      .then((vs) => setVersionsById((m) => (m[dsId] ? m : { ...m, [dsId]: vs })))
      .catch(() => setVersionsById((m) => (m[dsId] ? m : { ...m, [dsId]: [] })))
      .finally(() => setLoadingVersions((s) => { const n = new Set(s); n.delete(dsId); return n; }));
  };

  const openDetail = (ds: DataSourceSummary) => {
    setView(ds.id);
    fetchVersions(ds.id);
  };

  const toggleSource = (id: string) => {
    if (sourceIds.includes(id)) {
      if (sourceIds.length === 1) return; // always keep at least one table selected
      onSourceIdsChange(sourceIds.filter((x) => x !== id));
    } else {
      onSourceIdsChange([...sourceIds, id]);
    }
  };

  // A freshly-connected data source jumps straight into its own detail view
  // with a sensible default already checked - its first sheet/table for a
  // multi-table source, otherwise its original data - so connecting
  // something new is immediately useful in one flow instead of dropping
  // back to an empty grid and making the person hunt for what they just
  // added.
  const handleCreated = (created: { id: string; name: string; kind: string; created_at: string }) => {
    const ds: CreatedDataSource = created;
    onDataSourceCreated(ds);
    const multi = hasMultipleTables(ds.kind, ds.schema_cache);
    const defaultId = multi
      ? otherDsSourceId(ds.id, Object.keys(ds.schema_cache || {})[0])
      : otherDsSourceId(ds.id);
    if (!sourceIds.includes(defaultId)) onSourceIdsChange([...sourceIds, defaultId]);
    setView(ds.id);
  };

  if (!open) return null;

  const activeDs = view && view !== "new" && view !== "existing" ? otherDataSources.find((d) => d.id === view) || null : null;
  // Detail drills down FROM the existing-sources list, so its back arrow
  // returns there, not all the way to the two-button landing - "new" and
  // "existing" are both one level below the landing, so they go straight
  // back to it.
  const goBack = () => setView(activeDs ? "existing" : null);
  const filteredSources = query.trim()
    ? otherDataSources.filter((ds) => ds.name.toLowerCase().includes(query.trim().toLowerCase()))
    : otherDataSources;

  const title = activeDs ? activeDs.name
    : view === "new" ? "Connect new data"
    : view === "existing" ? "Existing data sources"
    : "Add data for analysis";
  const subtitle = activeDs ? null
    : view === "new" ? null
    : view === "existing" ? "Pick a source to see its tables"
    : "Pick an existing source, or connect a new one";

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="card w-full sm:w-[26rem] max-h-[85vh] sm:max-h-[75vh] flex flex-col rounded-b-none sm:rounded-b-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {!!view && (
              <button
                type="button"
                className="text-muted hover:text-text shrink-0 text-lg leading-none"
                title="Back"
                onClick={goBack}
              >
                &#8592;
              </button>
            )}
            <div className="min-w-0">
              <div className="font-semibold text-sm truncate">{title}</div>
              {subtitle && <div className="text-xs text-muted mt-0.5">{subtitle}</div>}
            </div>
          </div>
          <button type="button" className="text-muted hover:text-text text-xl leading-none px-1 shrink-0" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {view === "new" ? (
            <DataSourceForm onCreated={handleCreated} />
          ) : activeDs ? (
            <SourceDetail
              ds={activeDs}
              sourceIds={sourceIds}
              onToggle={toggleSource}
              versions={versionsById[activeDs.id] || []}
              loadingVersions={loadingVersions.has(activeDs.id)}
              conversationId={conversationId}
            />
          ) : view === "existing" ? (
            <div className="space-y-3">
              {otherDataSources.length > 3 && (
                <input
                  type="text"
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search your data sources…"
                  className="input w-full text-sm"
                />
              )}
              {otherDataSources.length === 0 ? (
                <div className="text-center py-6">
                  <div className="text-xs text-muted mb-3">No other data sources connected yet.</div>
                  <button type="button" className="btn-primary text-sm px-4 py-2" onClick={() => setView("new")}>
                    + Connect new data
                  </button>
                </div>
              ) : filteredSources.length === 0 ? (
                <div className="text-xs text-muted text-center py-6">No sources match "{query}".</div>
              ) : (
                <div className="space-y-1">
                  {filteredSources.map((ds) => {
                    const meta = connectionKindMeta(ds.kind);
                    const selectedCount = sourceIds.filter(
                      (id) => id === otherDsSourceId(ds.id) || id.startsWith(`ds:${ds.id}:`)
                    ).length;
                    return (
                      <button
                        key={ds.id}
                        type="button"
                        className="w-full flex items-center gap-3 p-2.5 rounded-xl border border-border hover:border-primary/60 hover:bg-surface2 transition text-left"
                        onClick={() => openDetail(ds)}
                      >
                        <span
                          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                          style={{ backgroundColor: `${meta.color}22`, color: meta.color }}
                        >
                          <meta.Logo className="w-4.5 h-4.5" />
                        </span>
                        <span className="text-sm font-medium truncate flex-1">{ds.name}</span>
                        {selectedCount > 0 && (
                          <span className="shrink-0 w-5 h-5 rounded-full bg-primary text-white text-[10px] font-bold flex items-center justify-center">
                            {selectedCount}
                          </span>
                        )}
                        <span className="text-muted shrink-0 text-sm">&#8250;</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <button
                type="button"
                className="w-full flex items-center gap-3 p-4 rounded-xl border border-border hover:border-primary/60 hover:bg-surface2 transition text-left"
                onClick={() => setView("existing")}
              >
                <span className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 bg-primary/10 text-primary">
                  <ExistingDataIcon className="w-5 h-5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">Existing data</span>
                  <span className="block text-xs text-muted mt-0.5">
                    Use a source you've already connected{otherDataSources.length > 0 ? ` (${otherDataSources.length})` : ""}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-3 p-4 rounded-xl border border-border hover:border-primary/60 hover:bg-surface2 transition text-left"
                onClick={() => setView("new")}
              >
                <span className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 bg-primary/10 text-primary">
                  <NewDataIcon className="w-5 h-5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">New data</span>
                  <span className="block text-xs text-muted mt-0.5">Connect a database, warehouse, or upload a file</span>
                </span>
              </button>
            </div>
          )}
        </div>

        <div className="p-3 border-t border-border shrink-0">
          <button type="button" className="btn-primary w-full text-sm" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function ExistingDataIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" className={className} fill="none">
      <ellipse cx="10" cy="5" rx="6.5" ry="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.5 5v10c0 1.38 2.91 2.5 6.5 2.5s6.5-1.12 6.5-2.5V5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3.5 10c0 1.38 2.91 2.5 6.5 2.5s6.5-1.12 6.5-2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function NewDataIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" className={className} fill="none">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 7v6M7 10h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// One connected data source's own tables/sheets (teal dot - real, untouched
// source data) plus its saved/AI-built tables (violet dot - the same
// "GD360 made this" color used everywhere else in the app), each a plain
// checkbox toggling that exact table into or out of the current selection.
function SourceDetail({
  ds,
  sourceIds,
  onToggle,
  versions,
  loadingVersions,
  conversationId,
}: {
  ds: DataSourceSummary;
  sourceIds: string[];
  onToggle: (id: string) => void;
  versions: DatasetVersion[];
  loadingVersions: boolean;
  conversationId?: string | null;
}) {
  const entries = getTableEntries(ds.kind, ds.schema_cache, ds.name);
  const multi = hasMultipleTables(ds.kind, ds.schema_cache);
  // Only THIS Project's own saved tables for this other source (or one
  // never tied to any conversation at all) are offered here to add - see
  // the conversationId prop's own comment above for why. An already-
  // selected table stays visible regardless, so resuming an old combined
  // conversation never makes its own active pick silently disappear.
  const visibleVersions = versions.filter(
    (v) => v.conversation_id == null || v.conversation_id === conversationId || sourceIds.includes(v.id)
  );

  return (
    <div className="space-y-0.5">
      {multi ? (
        entries.map((t) => {
          const id = otherDsSourceId(ds.id, t.name);
          return (
            <label key={id} className="flex items-center gap-2 text-sm px-2 py-2 rounded-lg hover:bg-surface2 cursor-pointer">
              <input type="checkbox" checked={sourceIds.includes(id)} onChange={() => onToggle(id)} />
              <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-sky-400" aria-hidden />
              <span className="truncate">{t.name}</span>
              <span className="text-muted text-[11px] ml-auto shrink-0">{t.columns.length} cols</span>
            </label>
          );
        })
      ) : (
        <label className="flex items-center gap-2 text-sm px-2 py-2 rounded-lg hover:bg-surface2 cursor-pointer">
          <input
            type="checkbox"
            checked={sourceIds.includes(otherDsSourceId(ds.id))}
            onChange={() => onToggle(otherDsSourceId(ds.id))}
          />
          <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-sky-400" aria-hidden />
          Original data
          <span className="text-muted text-[11px] ml-auto shrink-0">{entries[0]?.columns.length ?? 0} cols</span>
        </label>
      )}

      {loadingVersions && <div className="text-[11px] text-muted px-2 py-2">Loading saved tables…</div>}
      {visibleVersions.length > 0 && (
        <div className="pt-2 mt-1 border-t border-border">
          {visibleVersions.map((v) => (
            <label key={v.id} className="flex items-center gap-2 text-sm px-2 py-2 rounded-lg hover:bg-surface2 cursor-pointer">
              <input type="checkbox" checked={sourceIds.includes(v.id)} onChange={() => onToggle(v.id)} />
              <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-primary" aria-hidden />
              <span className="truncate">{v.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
