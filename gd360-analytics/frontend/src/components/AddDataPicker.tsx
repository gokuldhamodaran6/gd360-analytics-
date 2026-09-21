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
// Two things the popup lets someone do, picked with a first click:
//   - "Existing data": browse the OTHER data sources already connected (one
//     logo tile each, using the exact same brand logo/color every connector
//     picker in the app already uses - see connectionKindMeta), click one
//     to see its real tables/sheets and saved tables, and check off
//     whichever to pull into this analysis.
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
}) {
  // null = the logo grid; "new" = the connect-a-new-source form; any other
  // string = a specific other data source's id, showing its detail view.
  const [view, setView] = useState<string | null>(null);
  const [versionsById, setVersionsById] = useState<Record<string, DatasetVersion[]>>({});
  const [loadingVersions, setLoadingVersions] = useState<Set<string>>(new Set());

  // Every time the popup opens fresh, start back on the logo grid rather
  // than wherever it was left last time - a person reopening this a minute
  // later almost always wants to see the whole picture again, not resume a
  // half-finished detail view they may not even remember opening.
  useEffect(() => {
    if (open) setView(null);
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

  const activeDs = view && view !== "new" ? otherDataSources.find((d) => d.id === view) || null : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="card w-full sm:w-[26rem] max-h-[85vh] sm:max-h-[75vh] flex flex-col rounded-b-none sm:rounded-b-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {(view === "new" || activeDs) && (
              <button
                type="button"
                className="text-muted hover:text-text shrink-0 text-lg leading-none"
                title="Back"
                onClick={() => setView(null)}
              >
                &#8592;
              </button>
            )}
            <div className="min-w-0">
              <div className="font-semibold text-sm truncate">
                {activeDs ? activeDs.name : view === "new" ? "Connect new data" : "Add data for analysis"}
              </div>
              {!view && <div className="text-xs text-muted mt-0.5">Pick an existing source, or connect a new one</div>}
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
            />
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {otherDataSources.map((ds) => {
                const meta = connectionKindMeta(ds.kind);
                const selectedCount = sourceIds.filter(
                  (id) => id === otherDsSourceId(ds.id) || id.startsWith(`ds:${ds.id}:`)
                ).length;
                return (
                  <button
                    key={ds.id}
                    type="button"
                    className="flex flex-col items-center gap-1.5 p-3 rounded-xl border border-border hover:border-primary/60 hover:bg-surface2 transition relative"
                    onClick={() => openDetail(ds)}
                    title={ds.name}
                  >
                    {selectedCount > 0 && (
                      <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-primary text-white text-[9px] font-bold flex items-center justify-center">
                        {selectedCount}
                      </span>
                    )}
                    <span
                      className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                      style={{ backgroundColor: `${meta.color}22`, color: meta.color }}
                    >
                      <meta.Logo className="w-5 h-5" />
                    </span>
                    <span className="text-[11px] font-medium truncate w-full text-center">{ds.name}</span>
                  </button>
                );
              })}
              <button
                type="button"
                className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border border-dashed border-border hover:border-primary/60 hover:bg-surface2 transition text-muted hover:text-text"
                onClick={() => setView("new")}
              >
                <span className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 border border-dashed border-current text-lg font-semibold">
                  +
                </span>
                <span className="text-[11px] font-medium">New data</span>
              </button>
              {otherDataSources.length === 0 && (
                <div className="col-span-3 text-xs text-muted text-center py-2">
                  No other data sources connected yet - click "New data" to connect one.
                </div>
              )}
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
}: {
  ds: DataSourceSummary;
  sourceIds: string[];
  onToggle: (id: string) => void;
  versions: DatasetVersion[];
  loadingVersions: boolean;
}) {
  const entries = getTableEntries(ds.kind, ds.schema_cache, ds.name);
  const multi = hasMultipleTables(ds.kind, ds.schema_cache);

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
      {versions.length > 0 && (
        <div className="pt-2 mt-1 border-t border-border">
          {versions.map((v) => (
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
