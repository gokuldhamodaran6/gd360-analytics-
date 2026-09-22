import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api, conversationApi, ConversationSummary } from "../api/client";
import TopNav from "../components/TopNav";
import DataSourceForm from "../components/DataSourceForm";
import StoredDataSection from "../components/StoredDataSection";
import ConversationRow from "../components/ConversationRow";

// Widened to include schema_cache (present on every real /datasources
// response, since the backend's DataSourceOut always returns it) so it can
// be handed straight to StoredDataSection, which needs it to show each
// source's real tables/columns.
type DataSource = { id: string; name: string; kind: string; created_at: string; schema_cache?: Record<string, unknown> | null };
type DashboardSummary = { id: string; name: string; chart_count: number; created_at: string };

// "Saved dashboards" caps its own height and scrolls internally, same idea
// as "Recent conversations" below it - neither panel should grow the page
// without bound as work accumulates.
const PANEL_MAX_HEIGHT = "26rem";

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
  if (t.includes("scatter") === false && (t.includes("line") || t.includes("area"))) {
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

function ArrowRightIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

// A small, real-numbers-only status tile - no marketing copy, just what's
// actually true right now, in the same "verification mark" visual language
// (thin left accent bar, monospace figure) used on the public landing page.
function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="verify-bar card px-5 py-4 pl-6">
      <div className="mono-figure text-2xl sm:text-3xl font-bold leading-none">{value}</div>
      <div className="text-xs text-muted mt-1.5">{label}</div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [datasources, setDatasources] = useState<DataSource[]>([]);
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // "Add a data source" now lives in a focused popup instead of an
  // always-open, page-length form - the home page's job is to show what's
  // already here (your data, your recent work), not to keep the connect
  // form permanently on screen. Same DataSourceForm component as always,
  // just presented as a portaled overlay (see AddDataPicker.tsx for the
  // identical pattern already used inside the workspace).
  const [showConnectModal, setShowConnectModal] = useState(false);

  const load = async () => {
    setLoading(true);
    const [ds, db, convos] = await Promise.all([
      api.get("/datasources"),
      api.get("/dashboards"),
      conversationApi.list().catch(() => []),
    ]);
    setDatasources(ds.data);
    setDashboards(db.data);
    setConversations(convos as ConversationSummary[]);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!showConnectModal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowConnectModal(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showConnectModal]);

  const sortedDatasources = useMemo(
    () => [...datasources].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [datasources]
  );

  const openConnectFlow = () => setShowConnectModal(true);

  const startAnalyzing = () => {
    if (sortedDatasources.length > 0) {
      navigate(`/workspace/${sortedDatasources[0].id}`);
    } else {
      openConnectFlow();
    }
  };

  const openConversation = (c: ConversationSummary) => {
    if (!c.datasource_id) return;
    navigate(`/workspace/${c.datasource_id}?conversation=${c.id}`);
  };

  // Keeps a rename made here (or, via the exact same component, inside a
  // data source's own popup or the Workspace page) reflected instantly in
  // this list too, without a full refetch.
  const renameConversation = (id: string, title: string) => {
    setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, title } : c)));
  };

  // Same idea for pin/delete - update locally so the pinned-to-top order
  // and the removed row both show immediately, without waiting on a
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
  // DataSourceForm's own "Connected" panel, close this modal and jump
  // straight into its workspace - otherwise a brand new data source (with
  // no conversation yet) would have no way to be opened at all.
  const handleDataSourceCreated = (ds: { id: string }) => {
    setShowConnectModal(false);
    if (ds?.id) navigate(`/workspace/${ds.id}`);
  };

  // Fires as soon as a connect/upload actually succeeds, before the person
  // has clicked "Try it out" in the confirmation panel - refreshes this
  // page's own lists quietly in the background so they're already current
  // if the person closes the modal and stays here instead of proceeding.
  const handleDataSourceConnected = () => {
    load();
  };

  return (
    <div>
      <TopNav onConnectData={openConnectFlow} />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        {/* ---- Welcome strip: no marketing copy, just the two things a
            returning person actually wants to do next. ---- */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-8">
          <div>
            <div className="text-sm text-muted mb-1">Welcome back</div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Your workspace</h1>
          </div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <button className="btn-secondary text-sm px-4 py-2.5 inline-flex items-center gap-1.5" onClick={openConnectFlow}>
              <PlusIcon className="w-4 h-4" /> Connect data
            </button>
            <button className="btn-primary text-sm px-4 py-2.5 inline-flex items-center gap-1.5" onClick={startAnalyzing}>
              Start analyzing <ArrowRightIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ---- Real-numbers status strip ---- */}
        <div className="grid grid-cols-3 gap-3 mb-10">
          <StatTile label={`Data source${datasources.length === 1 ? "" : "s"}`} value={datasources.length} />
          <StatTile label={`Conversation${conversations.length === 1 ? "" : "s"}`} value={conversations.length} />
          <StatTile label={`Saved dashboard${dashboards.length === 1 ? "" : "s"}`} value={dashboards.length} />
        </div>

        {/* ---- Your data sources: the primary panel - everything already
            connected/uploaded, searchable and sortable, click-through to
            resume a conversation or start a new one. ---- */}
        <StoredDataSection
          datasources={datasources}
          conversations={conversations}
          loading={loading}
          onOpenConversation={openConversation}
          onAddNew={openConnectFlow}
          onConversationRenamed={renameConversation}
          onConversationPinned={pinConversation}
          onConversationDeleted={deleteConversation}
        />

        {/* ---- Recent conversations + Saved dashboards: secondary,
            side-by-side panels below the data - each capped and internally
            scrollable so neither grows the page without bound. ---- */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-10">
          <div>
            <h2 className="text-lg font-bold mb-4">Recent conversations</h2>
            {!loading && conversations.length === 0 && (
              <div className="card p-8 text-center text-muted text-sm leading-relaxed">
                Your recent chats and analyses will show up here once you start asking GD360 questions
                about your data.
              </div>
            )}
            {conversations.length > 0 && (
              <div className="space-y-3 pr-1 overflow-y-auto" style={{ maxHeight: PANEL_MAX_HEIGHT }}>
                {conversations.map((c) => (
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

          <div>
            <h2 className="text-lg font-bold mb-4">Saved dashboards</h2>
            {!loading && dashboards.length === 0 && (
              <div className="card p-8 text-center text-muted text-sm leading-relaxed">
                Save any chart from a conversation to a dashboard, and it'll show up here for quick
                access later.
              </div>
            )}
            {dashboards.length > 0 && (
              <div className="space-y-3 pr-1 overflow-y-auto" style={{ maxHeight: PANEL_MAX_HEIGHT }}>
                {dashboards.map((d) => (
                  <div
                    key={d.id}
                    className="card p-4 hover:shadow-glow transition cursor-pointer"
                    onClick={() => navigate(`/dashboards/${d.id}`)}
                  >
                    <div className="font-semibold">{d.name}</div>
                    <div className="text-sm text-muted mt-1">
                      <span className="mono-figure">{d.chart_count}</span> chart{d.chart_count === 1 ? "" : "s"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---- "Connect data" popup ----
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
              <h2 className="text-lg font-bold mb-1">Connect a data source</h2>
              <p className="text-xs text-muted mb-5 leading-relaxed">
                A database, a warehouse, or a file — it'll appear here and in Recent conversations once
                you ask something.
              </p>
              <DataSourceForm onCreated={handleDataSourceCreated} onConnected={handleDataSourceConnected} />
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
