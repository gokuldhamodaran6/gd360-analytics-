import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ConversationSummary } from "../api/client";
import ConversationRow from "./ConversationRow";
import {
  CloseIcon,
  ChevronRightIcon,
  TableIcon,
  DatabaseIcon,
  FileSpreadsheetIcon,
  WarehouseIcon,
  connectionKindMeta,
  getTableEntries,
  type CreatedDataSource,
} from "./DataSourceForm";

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function MessageIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

// Long-form "Xd ago" - matches Dashboard.tsx's own `timeAgo` exactly, kept
// as a separate local copy rather than importing across pages (the same
// pattern DataSourceForm.tsx's `timeAgoShort` already follows in this
// codebase) so this component stays a self-contained, drop-in section.
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

const isDbKind = (k: string) => k === "postgres" || k === "mysql" || k === "sqlserver" || k === "mongodb" || k === "supabase";
const isWarehouseKind = (k: string) => k === "bigquery";

// A workbook/spreadsheet-shaped kind - an uploaded Excel file, or either
// live OAuth connector (Google Sheets, Microsoft Excel/OneDrive) - all
// three use the exact same "sheet" noun and single-sheet-shows-columns
// convention, since they all produce the same schema_cache shape (see
// connectors.py's GoogleSheetsConnector/MicrosoftExcelConnector, which
// deliberately mirror FileConnector's own multi-sheet convention).
const isSheetKind = (k: string) => k === "excel" || k === "google_sheets" || k === "microsoft_excel";

// "4 tables" / "1 collection" / "12 columns" / "3 sheets" (a single-table
// file - a CSV, or a workbook/spreadsheet with only one sheet - has no
// meaningful table count of its own, so its column count is shown
// instead; a genuinely multi-sheet workbook shows its sheet count, same as
// a database shows its table count).
function dataSummaryLabel(ds: CreatedDataSource): string {
  const entries = getTableEntries(ds.kind, ds.schema_cache, ds.name);
  if (ds.kind === "csv" || (isSheetKind(ds.kind) && entries.length <= 1)) {
    const cols = entries[0]?.columns.length || 0;
    return `${cols} column${cols === 1 ? "" : "s"}`;
  }
  const n = entries.length;
  const noun = ds.kind === "mongodb" ? "collection" : isSheetKind(ds.kind) ? "sheet" : "table";
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

type SortKey = "newest" | "oldest" | "name-asc" | "name-desc";
type KindFilter = "all" | "database" | "warehouse" | "file";

// A single data source card - reused identically for the Databases and
// Files subsections below, so both stay visually consistent.
function SourceCard({
  ds,
  conversationCount,
  onClick,
}: {
  ds: CreatedDataSource;
  conversationCount: number;
  onClick: () => void;
}) {
  const meta = connectionKindMeta(ds.kind);
  return (
    <button
      type="button"
      onClick={onClick}
      className="card p-4 text-left hover:shadow-glow transition w-full"
    >
      <div className="flex items-start gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}
        >
          <meta.Logo className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-sm truncate">{ds.name}</div>
          <div className="text-xs text-muted mt-0.5">{meta.label}</div>
        </div>
      </div>
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-border text-[11px] text-muted">
        <span>{dataSummaryLabel(ds)}</span>
        <span className="flex items-center gap-1">
          <MessageIcon className="w-3 h-3" /> {conversationCount}
        </span>
      </div>
      <div className="text-[11px] text-muted mt-1.5">Added {timeAgo(ds.created_at)}</div>
    </button>
  );
}

// The homepage's "Your data sources" section: every database connection
// and file upload the person has, searchable and sortable, grouped into
// Databases / Files subsections. Clicking one opens a popup showing what's
// actually in it (real tables/columns, same schema the connect flow
// showed) plus every conversation already had about it, so a person can
// either resume one or start a fresh analysis - a real-time, elegant
// confirmation of what they're picking, not a blind click into chat.
export default function StoredDataSection({
  datasources,
  conversations,
  loading = false,
  onOpenConversation,
  onAddNew,
  onConversationRenamed,
  onConversationPinned,
  onConversationDeleted,
}: {
  datasources: CreatedDataSource[];
  conversations: ConversationSummary[];
  loading?: boolean;
  onOpenConversation: (c: ConversationSummary) => void;
  onAddNew?: () => void;
  // Keeps a rename made here reflected instantly in whatever list handed
  // this component its `conversations` prop (the homepage's own Recent
  // conversations) - the same conversation, same title, everywhere.
  onConversationRenamed?: (id: string, title: string) => void;
  // Same idea for pin/delete - both delegate up to whichever page owns the
  // real `conversations` state, exactly like onConversationRenamed already
  // does, so a pin or delete made from inside this popup is reflected
  // everywhere else that same conversation is listed too.
  onConversationPinned?: (id: string, pinned: boolean) => void;
  onConversationDeleted?: (id: string) => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});

  const conversationsByDs = useMemo(() => {
    const map: Record<string, ConversationSummary[]> = {};
    for (const c of conversations) {
      if (!c.datasource_id) continue;
      (map[c.datasource_id] ||= []).push(c);
    }
    for (const list of Object.values(map)) {
      list.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    }
    return map;
  }, [conversations]);

  const totalCount = datasources.length;
  const dbCount = useMemo(() => datasources.filter((d) => isDbKind(d.kind)).length, [datasources]);
  const warehouseCount = useMemo(() => datasources.filter((d) => isWarehouseKind(d.kind)).length, [datasources]);
  const fileCount = totalCount - dbCount - warehouseCount;

  const visible = useMemo(() => {
    let list = datasources;
    if (kindFilter === "database") list = list.filter((d) => isDbKind(d.kind));
    if (kindFilter === "warehouse") list = list.filter((d) => isWarehouseKind(d.kind));
    if (kindFilter === "file") list = list.filter((d) => !isDbKind(d.kind) && !isWarehouseKind(d.kind));
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((d) => d.name.toLowerCase().includes(q));
    const sorted = [...list];
    if (sortKey === "name-asc") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortKey === "name-desc") sorted.sort((a, b) => b.name.localeCompare(a.name));
    else if (sortKey === "oldest") sorted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    else sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return sorted;
  }, [datasources, kindFilter, query, sortKey]);

  const databaseItems = useMemo(() => visible.filter((d) => isDbKind(d.kind)), [visible]);
  const warehouseItems = useMemo(() => visible.filter((d) => isWarehouseKind(d.kind)), [visible]);
  const fileItems = useMemo(() => visible.filter((d) => !isDbKind(d.kind) && !isWarehouseKind(d.kind)), [visible]);

  const selectedDs = selectedId ? datasources.find((d) => d.id === selectedId) || null : null;
  const selectedMeta = selectedDs ? connectionKindMeta(selectedDs.kind) : null;
  const selectedTableEntries = selectedDs ? getTableEntries(selectedDs.kind, selectedDs.schema_cache, selectedDs.name) : [];
  const selectedConversations = selectedDs ? conversationsByDs[selectedDs.id] || [] : [];

  const openCard = (ds: CreatedDataSource) => {
    setSelectedId(ds.id);
    const entries = getTableEntries(ds.kind, ds.schema_cache, ds.name);
    setExpandedTables(entries.length === 1 ? { [entries[0].name]: true } : {});
  };
  const closeCard = () => setSelectedId(null);
  const toggleTable = (name: string) => setExpandedTables((prev) => ({ ...prev, [name]: !prev[name] }));

  const startNewAnalysis = () => {
    if (selectedDs) navigate(`/workspace/${selectedDs.id}`);
    setSelectedId(null);
  };
  const openExistingConversation = (c: ConversationSummary) => {
    setSelectedId(null);
    onOpenConversation(c);
  };
  const clearFilters = () => {
    setQuery("");
    setKindFilter("all");
  };

  return (
    <div className="mb-10">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-xl font-bold">Your data sources</h2>
      </div>
      <p className="text-xs text-muted mb-4 leading-relaxed">
        Everything you've connected or uploaded, in one place. Click one to pick up a conversation or start a new analysis.
      </p>

      {loading && datasources.length === 0 && (
        <div className="card p-8 text-center text-muted text-sm leading-relaxed">Loading your data sources...</div>
      )}

      {!loading && totalCount === 0 && (
        <div className="card p-8 text-center text-muted text-sm leading-relaxed">
          You haven't connected any data yet.
          {onAddNew && (
            <div className="mt-3">
              <button type="button" className="btn-primary text-sm px-4 py-2" onClick={onAddNew}>
                Add a data source
              </button>
            </div>
          )}
        </div>
      )}

      {totalCount > 0 && (
        <>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-3">
            <div className="relative flex-1 max-w-sm">
              <SearchIcon className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
              {/* `.input`'s own CSS `padding` shorthand (in index.css) is compiled after
                  Tailwind's utility classes, so a `pl-*` utility on this element loses the
                  cascade and the left padding silently falls back to `.input`'s default -
                  the icon then overlaps the placeholder text. An inline style always wins
                  over any class, regardless of source order, so the left padding is set
                  here instead of via a `pl-*` class. */}
              <input
                className="input"
                style={{ paddingLeft: "2.75rem" }}
                placeholder="Search your data sources..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <select
              className="input sm:w-48"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              aria-label="Sort data sources"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name-asc">Name (A&ndash;Z)</option>
              <option value="name-desc">Name (Z&ndash;A)</option>
            </select>
          </div>

          <div className="flex gap-2 mb-6 flex-wrap">
            {([
              ["all", `All (${totalCount})`],
              ["database", `Databases (${dbCount})`],
              ["warehouse", `Data warehouses (${warehouseCount})`],
              ["file", `Files & live sheets (${fileCount})`],
            ] as [KindFilter, string][]).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setKindFilter(key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  kindFilter === key ? "bg-primary text-white" : "btn-secondary"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <div className="card p-8 text-center text-muted text-sm leading-relaxed">
              No data sources match your search.{" "}
              <button type="button" onClick={clearFilters} className="text-primary font-medium hover:underline">
                Clear filters
              </button>
            </div>
          ) : (
            <>
              {databaseItems.length > 0 && (
                <div className="mb-6">
                  <div className="flex items-center gap-2 mb-3">
                    <DatabaseIcon className="w-4 h-4 text-muted" />
                    <h3 className="text-sm font-semibold">Databases</h3>
                    <span className="text-xs text-muted">{databaseItems.length}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {databaseItems.map((ds) => (
                      <SourceCard
                        key={ds.id}
                        ds={ds}
                        conversationCount={(conversationsByDs[ds.id] || []).length}
                        onClick={() => openCard(ds)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {warehouseItems.length > 0 && (
                <div className="mb-6">
                  <div className="flex items-center gap-2 mb-3">
                    <WarehouseIcon className="w-4 h-4 text-muted" />
                    <h3 className="text-sm font-semibold">Data warehouses</h3>
                    <span className="text-xs text-muted">{warehouseItems.length}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {warehouseItems.map((ds) => (
                      <SourceCard
                        key={ds.id}
                        ds={ds}
                        conversationCount={(conversationsByDs[ds.id] || []).length}
                        onClick={() => openCard(ds)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {fileItems.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <FileSpreadsheetIcon className="w-4 h-4 text-muted" />
                    <h3 className="text-sm font-semibold">Files &amp; live sheets</h3>
                    <span className="text-xs text-muted">{fileItems.length}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {fileItems.map((ds) => (
                      <SourceCard
                        key={ds.id}
                        ds={ds}
                        conversationCount={(conversationsByDs[ds.id] || []).length}
                        onClick={() => openCard(ds)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ---- Click-through popup: shows exactly what's in this data source
          (real tables/columns) and every conversation already had about it,
          so picking "resume" or "start new" is an informed, real-time
          confirmation instead of a blind click into chat. ---- */}
      {selectedDs && selectedMeta && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={closeCard} aria-hidden />
          <div className="relative card bg-surface w-full max-w-md p-6 max-h-[85vh] overflow-y-auto" role="dialog" aria-modal="true">
            <button
              type="button"
              onClick={closeCard}
              aria-label="Close"
              className="absolute top-4 right-4 text-muted hover:text-text transition"
            >
              <CloseIcon className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-3 pr-6">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                style={{ backgroundColor: `${selectedMeta.color}1a`, color: selectedMeta.color }}
              >
                <selectedMeta.Logo className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="font-bold text-lg leading-tight truncate">{selectedDs.name}</div>
                <div className="text-xs text-muted mt-0.5">
                  {selectedMeta.label} &middot; Added {timeAgo(selectedDs.created_at)}
                </div>
              </div>
            </div>

            <div className="mt-5">
              <div className="text-sm font-semibold mb-1">Available data</div>
              {selectedTableEntries.length > 0 ? (
                <div className="space-y-1.5">
                  {selectedTableEntries.map((entry) => (
                    <div key={entry.name} className="rounded-lg border border-border overflow-hidden">
                      <button
                        type="button"
                        onClick={() => toggleTable(entry.name)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface2 transition"
                      >
                        <ChevronRightIcon
                          className={`w-3.5 h-3.5 shrink-0 text-muted transition-transform ${
                            expandedTables[entry.name] ? "rotate-90" : ""
                          }`}
                        />
                        <TableIcon className="w-3.5 h-3.5 shrink-0 text-muted" />
                        <span className="text-sm font-medium truncate flex-1">{entry.name}</span>
                        <span className="text-[11px] text-muted shrink-0">
                          {entry.columns.length} col{entry.columns.length === 1 ? "" : "s"}
                        </span>
                      </button>
                      {expandedTables[entry.name] && (
                        <div className="px-3 pb-2.5 pt-0.5 flex flex-wrap gap-1.5 bg-surface2">
                          {entry.columns.length > 0 ? (
                            entry.columns.map((c) => (
                              <span
                                key={c.name}
                                className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-base border border-border text-muted"
                              >
                                {c.name}
                              </span>
                            ))
                          ) : (
                            <span className="text-[11px] text-muted">No columns detected.</span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-muted">No schema details available.</div>
              )}
            </div>

            <div className="mt-5">
              <div className="text-sm font-semibold mb-1">Conversations</div>
              {selectedConversations.length === 0 ? (
                <div className="text-xs text-muted">No conversations yet for this data source.</div>
              ) : (
                <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                  {selectedConversations.map((c) => (
                    <ConversationRow
                      key={c.id}
                      conversation={c}
                      variant="row"
                      trailing={timeAgo(c.updated_at)}
                      onOpen={() => openExistingConversation(c)}
                      onRenamed={(id, title) => onConversationRenamed?.(id, title)}
                      onPinned={(id, pinned) => onConversationPinned?.(id, pinned)}
                      onDeleted={(id) => onConversationDeleted?.(id)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 mt-6">
              <button type="button" className="btn-secondary flex-1" onClick={closeCard}>
                Close
              </button>
              <button type="button" className="btn-primary flex-1" onClick={startNewAnalysis}>
                Start new analysis &rarr;
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
