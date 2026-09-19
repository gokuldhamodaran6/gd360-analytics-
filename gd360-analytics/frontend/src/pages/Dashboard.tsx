import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, conversationApi, ConversationSummary } from "../api/client";
import TopNav from "../components/TopNav";
import DataSourceForm from "../components/DataSourceForm";
import StoredDataSection from "../components/StoredDataSection";

// Widened to include schema_cache (present on every real /datasources
// response, since the backend's DataSourceOut always returns it) so it can
// be handed straight to StoredDataSection, which needs it to show each
// source's real tables/columns.
type DataSource = { id: string; name: string; kind: string; created_at: string; schema_cache?: Record<string, unknown> | null };
type DashboardSummary = { id: string; name: string; chart_count: number; created_at: string };

// A curated, representative slice of the chart types GD360 can actually
// render (the full engine supports many more specialized ones - see
// chart_builder.py) - kept to a number that reads as impressive on the
// landing page without turning the strip into visual noise. The count
// shown in the badge/heading is always this array's real length, so it
// can never drift out of sync with what is actually displayed.
const CHART_TYPES = [
  "Bar", "Horizontal Bar", "Grouped Bar", "Stacked Bar",
  "Line", "Step Line", "Area", "Stacked Area",
  "Pie", "Donut", "Scatter", "Bubble",
  "Histogram", "Box", "Violin", "Heatmap",
  "Waterfall", "Funnel", "Sankey", "Treemap",
  "Sunburst", "Radar", "Gauge", "Candlestick",
];

function SparkIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l1.8 5.6L19.5 9l-5.7 1.4L12 16l-1.8-5.6L4.5 9l5.7-1.4L12 2z" />
    </svg>
  );
}

function PromptToChartIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 12l2-2 2 2 4-4" />
    </svg>
  );
}

function CleanPrepIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h16M7 12h10M10 19h4" />
    </svg>
  );
}

function VerifiedIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function GuidedIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9l-2 5-5 2 2-5z" />
    </svg>
  );
}

const FEATURES = [
  {
    title: "Prompt to chart",
    body: "Describe what you want in plain English. GD360 picks the right chart from 24+ types, transforms the data, and renders it live.",
    Icon: PromptToChartIcon,
  },
  {
    title: "AI cleaning, fully explained",
    body: "Every prep step - duplicates removed, missing values handled, types fixed - is explained in plain English with real row counts. Never a black box.",
    Icon: CleanPrepIcon,
  },
  {
    title: "Verified, not guessed",
    body: "Every number in an insight traces back to a real computation. Hit “Double-check this” and an independent AI audit re-checks the answer before you trust it.",
    Icon: VerifiedIcon,
  },
  {
    title: "Guided by Goku",
    body: "New to data analysis? Goku walks you through what to clean, what to explore, and what to ask next - one clear step at a time.",
    Icon: GuidedIcon,
  },
];

// "Saved dashboards" still caps its own height and scrolls internally
// (it sits inside the already-tall "Add a data source" column, so it
// shouldn't push that column even taller). "Recent conversations" no
// longer has a fixed cap - see the grid below - it now stretches to
// match whatever height the "Add a data source" column ends up being,
// so the two columns always look like a matched pair instead of one
// trailing off with empty space beside it.
const DASHBOARDS_MAX_HEIGHT = "360px";

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

export default function Dashboard() {
  const navigate = useNavigate();
  const [datasources, setDatasources] = useState<DataSource[]>([]);
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const formRef = useRef<HTMLDivElement>(null);

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

  // Still needed even without a datasets grid on screen: "Start analyzing"
  // (below) jumps straight into the most recently added data source when
  // one already exists.
  const sortedDatasources = useMemo(
    () => [...datasources].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [datasources]
  );

  const scrollToForm = () => {
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  };

  // The "Add a data source" panel is always on-screen now (no more
  // click-to-reveal), so "connecting data" just means scrolling to it.
  const openConnectFlow = () => {
    scrollToForm();
  };

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

  // There is no dataset grid to click into any more, so once a data source
  // is added and the person confirms it in DataSourceForm's "Connected"
  // panel, jump straight into its workspace the same way clicking a card
  // used to - otherwise a brand new data source (with no conversation yet)
  // would have no way to be opened at all.
  const handleDataSourceCreated = (ds: { id: string }) => {
    if (ds?.id) navigate(`/workspace/${ds.id}`);
  };

  // Fires as soon as a connect/upload actually succeeds, before the person
  // has clicked "Try it out" in the confirmation panel - refreshes this
  // page's own lists quietly in the background so they're already current
  // if the person closes the panel and stays here instead of proceeding.
  const handleDataSourceConnected = () => {
    load();
  };

  return (
    <div>
      <TopNav onConnectData={openConnectFlow} />

      {/* ---- Hero ---- */}
      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute -top-24 -left-24 w-96 h-96 rounded-full bg-primary/20 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -top-10 -right-24 w-96 h-96 rounded-full bg-accent/15 blur-3xl" aria-hidden />

        <div className="relative max-w-5xl mx-auto px-6 pt-16 pb-14 text-center">
          <div className="pill mx-auto mb-6 w-fit">
            <SparkIcon className="w-3.5 h-3.5 text-accent" /> AI-native analytics, verified every step
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold leading-tight tracking-tight">
            Ask your data anything.
            <br />
            <span className="gradient-text">Get analyst-grade answers you can trust.</span>
          </h1>
          <p className="text-muted text-base sm:text-lg mt-6 max-w-2xl mx-auto leading-relaxed">
            GD360 connects straight to your databases and files, cleans and prepares the data with a
            plain-English explanation of every step, picks the right chart for what you asked, and writes
            the insight from real computed numbers - never a guess. No SQL. No Python. No code.
          </p>
          <div className="flex items-center justify-center gap-3 mt-8 flex-wrap">
            <button className="btn-primary text-base px-6 py-3" onClick={startAnalyzing}>
              Start analyzing &rarr;
            </button>
            <button className="btn-secondary text-base px-6 py-3" onClick={openConnectFlow}>
              Open studio
            </button>
          </div>
          <div className="flex items-center justify-center gap-6 mt-8 text-sm text-muted flex-wrap">
            <span className="flex items-center gap-1.5">
              <span className="text-accent">🛡</span> Read-only. Your data is never modified.
            </span>
            <span className="hidden sm:inline text-border">|</span>
            <span className="flex items-center gap-1.5">
              <span className="text-accent">✓</span> Every answer independently verified
            </span>
            <span className="hidden sm:inline text-border">|</span>
            <span className="flex items-center gap-1.5">
              <span>🗄</span> Postgres &middot; MySQL &middot; MongoDB &middot; CSV &middot; Excel &middot; JSON
            </span>
            <span className="hidden sm:inline text-border">|</span>
            <span className="flex items-center gap-1.5">
              <span>📈</span> {CHART_TYPES.length} chart types
            </span>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-16">
        {/* ---- Feature cards ---- */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {FEATURES.map((f) => (
            <div key={f.title} className="card p-6">
              <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center text-primary mb-4">
                <f.Icon />
              </div>
              <div className="font-semibold mb-1.5">{f.title}</div>
              <div className="text-sm text-muted leading-relaxed">{f.body}</div>
            </div>
          ))}
        </div>

        {/* ---- Chart type chip strip ---- */}
        <div className="card p-6 mb-10 text-center">
          <div className="text-xs font-semibold tracking-wide text-muted mb-4">
            {CHART_TYPES.length}+ WAYS TO SEE YOUR DATA
          </div>
          <div className="flex flex-wrap justify-center gap-2.5">
            {CHART_TYPES.map((c) => (
              <span key={c} className="pill">
                <ChartTypeIcon chartType={c} /> {c}
              </span>
            ))}
          </div>
        </div>

        {/* ---- Add a data source + Recent conversations ---- */}
        <div ref={formRef} className="grid grid-cols-1 lg:grid-cols-[1fr_1.3fr] gap-8">
          <div>
            <h2 className="text-xl font-bold mb-1">Add a data source</h2>
            <p className="text-xs text-muted mb-4 leading-relaxed">
              Connect a database or upload a file — it'll appear in Recent conversations once you ask something.
            </p>

            <DataSourceForm onCreated={handleDataSourceCreated} onConnected={handleDataSourceConnected} />

            {dashboards.length > 0 && (
              <>
                <h2 className="text-xl font-bold mt-8 mb-4">Saved dashboards</h2>
                <div className="space-y-3 pr-1 overflow-y-auto" style={{ maxHeight: DASHBOARDS_MAX_HEIGHT }}>
                  {dashboards.map((d) => (
                    <div key={d.id} className="card p-4 hover:shadow-glow transition cursor-pointer" onClick={() => navigate(`/dashboards/${d.id}`)}>
                      <div className="font-semibold">{d.name}</div>
                      <div className="text-sm text-muted mt-1">{d.chart_count} chart{d.chart_count === 1 ? "" : "s"}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* `h-full flex flex-col` + the list below being `flex-1 min-h-0`:
              a CSS Grid row stretches every column to match its tallest
              column's natural height by default, so this column already
              gets stretched to match "Add a data source"'s height - this
              just makes its own content (the list) actually fill that
              stretched height instead of leaving empty space below it. */}
          <div className="flex flex-col h-full">
            <h2 className="text-xl font-bold mb-4">Recent conversations</h2>
            {!loading && conversations.length === 0 && (
              <div className="card p-8 text-center text-muted text-sm leading-relaxed">
                Your recent chats and analyses will show up here once you start asking GD360 questions about your data.
              </div>
            )}
            {conversations.length > 0 && (
              <div className="space-y-3 pr-1 overflow-y-auto flex-1 min-h-0">
                {conversations.map((c) => (
                  <div
                    key={c.id}
                    className="card p-4 hover:shadow-glow transition cursor-pointer"
                    onClick={() => openConversation(c)}
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary/25 to-accent/25 flex items-center justify-center text-primary shrink-0">
                        <ChartTypeIcon chartType={c.last_chart_type} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm truncate">{c.title}</div>
                        <div className="text-xs text-muted mt-0.5 truncate">
                          {c.datasource_name || "Removed data source"} &middot; {timeAgo(c.updated_at)}
                        </div>
                      </div>
                      <div className="text-xs text-muted shrink-0">{c.message_count}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ---- Your data sources: everything already connected/uploaded,
            searchable and sortable, click-through to resume a conversation
            or start a new one. Shown below "Add a data source" / "Recent
            conversations" per Gokul's layout feedback (2026-09-19). ---- */}
        <div className="mt-10">
          <StoredDataSection
            datasources={datasources}
            conversations={conversations}
            loading={loading}
            onOpenConversation={openConversation}
            onAddNew={openConnectFlow}
          />
        </div>
      </div>
    </div>
  );
}
