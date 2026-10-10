// 2026-10-08 (round 11): the signed-in home page.
// 2026-10-09 (round 15): the scope chip asks one Space, chosen sources or
// everything (spaces/ScopePicker.tsx). ?space=<id> preselects a Space.
// 2026-10-10 (Clarity Blueprint, Option 1 - "one front door, three
// intents"): Home asks what you want to DO, not where to go:
//   Ask a question   -> an Answer across any sources (/p/:id)
//   Analyze a table  -> Studio on one source (/workspace/:id, ?draft= runs
//                       the first instruction)
//   Build a dashboard -> the full dashboard, drafted from a description
//                       (/dashboards/new?datasource=&goal=&auto=1)
// ?intent=ask|analyze|build preselects one. Everything made from here lands
// in Library (answers, analyses) or Dashboards, each labelled by kind.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { conversationApi, ConversationSummary, dashboardApi, DashboardSummary } from "../api/client";
import { projectsApi, ProjectSource } from "../api/projects";
import { timeAgo, autoRunPreference } from "../project/format";
import { useAuth } from "../api/AuthContext";
import { Space, spacesApi } from "../api/spaces";
import ScopePicker, { Scope, loadScope, saveScope, scopeSummary, startersFor } from "../spaces/ScopePicker";
import { conversationHref, conversationKind, dashboardHref, Kind, KindIcon, KindPill, KindTile } from "../lib/kinds";

type Tab = "recent" | "pinned" | "shared";
type Intent = "ask" | "analyze" | "build";

const INTENTS: { id: Intent; kind: Kind; title: string; sub: string }[] = [
  { id: "ask", kind: "answer", title: "Ask a question", sub: "An answer in seconds, from any source" },
  { id: "analyze", kind: "analysis", title: "Analyze a table", sub: "Hands-on in Studio, step by step" },
  { id: "build", kind: "dashboard", title: "Build a dashboard", sub: "Live, with filters. You refine it" },
];

const ANALYZE_STARTERS = ["Profile this table and point out anything unusual", "Find gaps, duplicates and outliers", "Show the main measure by month"];
const BUILD_STARTERS = ["Weekly revenue health with a trend and the top segments", "Bookings, cancellations and average rate by month", "Top customers and where they come from"];

// Sources people analyze or build dashboards on first: warehouses, databases
// and files before connected apps.
const CORE_KINDS = new Set(["bigquery", "snowflake", "postgres", "mysql", "redshift", "sqlserver", "databricks", "supabase", "csv", "excel", "file"]);

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

const lastSourceKey = (ws: string) => `gd360_home_source:${ws}`;

function loadLastSource(ws: string): string | null {
  try {
    return localStorage.getItem(lastSourceKey(ws));
  } catch {
    return null;
  }
}

function saveLastSource(ws: string, id: string) {
  try {
    localStorage.setItem(lastSourceKey(ws), id);
  } catch {
    /* per-browser convenience only */
  }
}

type RecentItem =
  | { type: "conv"; id: string; at: string; c: ConversationSummary }
  | { type: "dash"; id: string; at: string; d: DashboardSummary };

export default function Home() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [searchParams, setSearchParams] = useSearchParams();
  const spaceParam = searchParams.get("space");
  const intentParam = searchParams.get("intent");
  const intent: Intent = intentParam === "analyze" || intentParam === "build" ? intentParam : "ask";
  const [question, setQuestion] = useState("");
  const [instruction, setInstruction] = useState("");
  const [goal, setGoal] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [sources, setSources] = useState<ProjectSource[] | null>(null);
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [scope, setScopeState] = useState<Scope>({ kind: "all" });
  const [projects, setProjects] = useState<ConversationSummary[] | null>(null);
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null);
  const [tab, setTab] = useState<Tab>("recent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const setIntent = (next: Intent) => {
    const p = new URLSearchParams(searchParams);
    if (next === "ask") p.delete("intent");
    else p.set("intent", next);
    setSearchParams(p, { replace: true });
    setError("");
  };

  // 2026-10-09: the first question picked on the public "Get started" page
  // waits here after sign-up.
  useEffect(() => {
    if (!activeWorkspaceId || !sources || sources.length === 0) return;
    try {
      const q = sessionStorage.getItem("gd360_first_question");
      if (q) {
        setQuestion(q);
        sessionStorage.removeItem("gd360_first_question");
      }
    } catch {
      /* storage may be blocked */
    }
  }, [activeWorkspaceId, sources]);

  const setScope = (next: Scope) => {
    setScopeState(next);
    if (activeWorkspaceId) saveScope(activeWorkspaceId, next);
  };

  useEffect(() => {
    if (!activeWorkspaceId) return;
    setSources(null);
    setSpaces(null);
    projectsApi.sources(activeWorkspaceId).then(setSources).catch(() => setSources([]));
    spacesApi.list(activeWorkspaceId).then(setSpaces).catch(() => setSpaces([]));
    conversationApi.list(activeWorkspaceId).then(setProjects).catch(() => setProjects([]));
    dashboardApi.list().then(setDashboards).catch(() => setDashboards([]));
  }, [activeWorkspaceId]);

  // The starting scope: ?space=<id> wins, else the last one used here.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (spaceParam) setScope({ kind: "space", spaceId: spaceParam });
    else setScopeState(loadScope(activeWorkspaceId) || { kind: "all" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId, spaceParam]);

  // Drop a remembered Space or sources that are gone (or not in this workspace).
  useEffect(() => {
    if (!sources || !spaces) return;
    if (scope.kind === "space" && !spaces.some((s) => s.id === scope.spaceId)) setScopeState({ kind: "all" });
    if (scope.kind === "sources") {
      const known = new Set(sources.map((s) => s.id));
      const ids = scope.ids.filter((id) => known.has(id));
      if (ids.length !== scope.ids.length) setScopeState(ids.length ? { kind: "sources", ids } : { kind: "all" });
    }
  }, [sources, spaces, scope]);

  // The one source Analyze / Build work on: the last one used here, else the
  // first warehouse, database or file.
  const orderedSources = useMemo(() => {
    const list = [...(sources || [])];
    list.sort((a, b) => Number(CORE_KINDS.has(b.kind)) - Number(CORE_KINDS.has(a.kind)));
    return list;
  }, [sources]);
  useEffect(() => {
    if (!activeWorkspaceId || !orderedSources.length) return;
    setSourceId((cur) => {
      if (cur && orderedSources.some((s) => s.id === cur)) return cur;
      const last = loadLastSource(activeWorkspaceId);
      if (last && orderedSources.some((s) => s.id === last)) return last;
      return orderedSources[0].id;
    });
  }, [activeWorkspaceId, orderedSources]);
  const chooseSource = (id: string) => {
    setSourceId(id);
    if (activeWorkspaceId) saveLastSource(activeWorkspaceId, id);
  };

  const chosenSpace = scope.kind === "space" ? (spaces || []).find((s) => s.id === scope.spaceId) || null : null;
  const summary = scopeSummary(scope, sources, spaces);
  const askStarters = useMemo(() => startersFor(chosenSpace), [chosenSpace]);

  const recent = useMemo<RecentItem[]>(() => {
    const convs = projects || [];
    const dashes = dashboards || [];
    let items: RecentItem[] = [];
    if (tab === "pinned") {
      items = convs.filter((c) => c.pinned).map((c) => ({ type: "conv" as const, id: c.id, at: c.updated_at, c }));
    } else {
      const cs = tab === "shared" ? convs.filter((c) => !c.is_own) : convs;
      const ds = tab === "shared" ? dashes.filter((d) => !d.is_own) : dashes;
      items = [
        ...cs.map((c) => ({ type: "conv" as const, id: c.id, at: c.updated_at, c })),
        ...ds.map((d) => ({ type: "dash" as const, id: d.id, at: d.created_at, d })),
      ];
      items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    }
    return items.slice(0, 6);
  }, [projects, dashboards, tab]);

  const ask = async (text?: string) => {
    const q = (text ?? question).trim();
    if (q.length < 2 || busy) return;
    if (!summary.count) {
      setError(chosenSpace ? `${chosenSpace.name} has no sources you can use yet.` : "Pick at least one source to ask about.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // A Space sends space_id, picked sources send source_ids - never both.
      const all = (sources || []).length;
      const out = await projectsApi.create({
        question: q,
        space_id: scope.kind === "space" && chosenSpace ? chosenSpace.id : undefined,
        source_ids: scope.kind === "sources" && scope.ids.length < all ? scope.ids : undefined,
        workspace_id: activeWorkspaceId || undefined,
        auto_run: autoRunPreference(),
      });
      navigate(`/p/${out.project_id}?run=${out.run_id}`);
    } catch (e: any) {
      setError(errorText(e, "Couldn't start that question. Please try again."));
      setBusy(false);
    }
  };

  const openStudio = () => {
    if (!sourceId) {
      setError("Pick a source to analyze.");
      return;
    }
    const draft = instruction.trim();
    navigate(`/workspace/${sourceId}${draft.length >= 2 ? `?draft=${encodeURIComponent(draft)}` : ""}`);
  };

  const buildDashboard = () => {
    if (!sourceId) {
      setError("Pick a source for the dashboard.");
      return;
    }
    const g = goal.trim();
    if (g.length < 4) {
      setError("Describe what the dashboard should show - a sentence is enough.");
      return;
    }
    const q = new URLSearchParams({ datasource: sourceId, goal: g, auto: "1" });
    navigate(`/dashboards/new?${q.toString()}`);
  };

  const firstName = (user?.full_name || "").split(" ")[0];
  const noSources = sources !== null && sources.length === 0;
  const starters = intent === "ask" ? askStarters : intent === "analyze" ? ANALYZE_STARTERS : BUILD_STARTERS;
  const pickStarter = (s: string) => {
    if (intent === "ask") setQuestion(s);
    else if (intent === "analyze") setInstruction(s);
    else setGoal(s);
    boxRef.current?.focus();
  };

  const submit = () => (intent === "ask" ? ask() : intent === "analyze" ? openStudio() : buildDashboard());
  const tone =
    intent === "ask"
      ? { border: "border-kind-answer-border", label: "text-kind-answer" }
      : intent === "analyze"
      ? { border: "border-kind-analysis-border", label: "text-kind-analysis" }
      : { border: "border-kind-dashboard-border", label: "text-kind-dashboard" };

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
        <main className="flex flex-col items-center px-4 sm:px-8 pt-12 sm:pt-16 pb-16 gap-10">
          <div className="w-full max-w-[820px] flex flex-col items-center gap-5 text-center">
            <h1 className="m-0 text-[32px] sm:text-[40px] font-semibold tracking-tight text-text text-balance">
              {firstName ? `What do you want to do, ${firstName}?` : "What do you want to do?"}
            </h1>
            <p className="m-0 text-body text-muted max-w-[56ch]">
              Pick one — everything you make lands in <Link to="/library" className="text-text underline-offset-2 hover:underline">Library</Link>.
            </p>

            {noSources ? (
              <div className="w-full rounded-card border border-border bg-surface p-6 text-left flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
                <div>
                  <div className="text-section font-semibold text-text">Connect your first source</div>
                  <div className="text-ui text-muted mt-1">
                    A warehouse, a database, a spreadsheet, or an app like Shopify, Google Analytics or your ad accounts.
                  </div>
                </div>
                <Link to="/data" className="btn-primary text-sm shrink-0">Connect data</Link>
              </div>
            ) : (
              <>
                <div role="tablist" aria-label="What do you want to do" className="w-full grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-left" data-home-intents="">
                  {INTENTS.map((it) => {
                    const on = it.id === intent;
                    return (
                      <button
                        key={it.id}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        data-intent={it.id}
                        onClick={() => setIntent(it.id)}
                        className={`ui-focus text-left flex items-center gap-3 min-h-[64px] px-3.5 py-3 rounded-[14px] border transition-colors ${
                          on
                            ? `bg-surface shadow-card ring-1 ${it.kind === "answer" ? "border-kind-answer-border ring-kind-answer-border" : it.kind === "analysis" ? "border-kind-analysis-border ring-kind-analysis-border" : "border-kind-dashboard-border ring-kind-dashboard-border"}`
                            : "border-border bg-transparent opacity-80 hover:opacity-100 hover:bg-surface/60"
                        }`}
                      >
                        <KindTile kind={it.kind} size={34} />
                        <span className="min-w-0 flex flex-col items-start">
                          <span className="text-body font-semibold text-text">{it.title}</span>
                          <span className="text-caption text-muted">{it.sub}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className={`w-full text-left rounded-[20px] border bg-surface shadow-pop p-4 sm:p-[18px] flex flex-col gap-3 ${tone.border}`} data-home-composer={intent}>
                  {intent === "analyze" && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-mono text-[11px] uppercase tracking-[0.12em] ${tone.label}`}>Analyze in Studio</span>
                      <SourceSelect sources={orderedSources} value={sourceId} onChange={chooseSource} label="Table to analyze" />
                    </div>
                  )}
                  {intent === "build" && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-mono text-[11px] uppercase tracking-[0.12em] ${tone.label}`}>Build a dashboard</span>
                      <SourceSelect sources={orderedSources} value={sourceId} onChange={chooseSource} label="Data source for the dashboard" />
                    </div>
                  )}
                  {intent === "ask" && <span className={`font-mono text-[11px] uppercase tracking-[0.12em] ${tone.label}`}>Ask</span>}
                  <label htmlFor="home-box" className="sr-only">
                    {intent === "ask" ? "Your question" : intent === "analyze" ? "What do you want to do with it (optional)" : "Describe the dashboard"}
                  </label>
                  <textarea
                    id="home-box"
                    ref={boxRef}
                    rows={3}
                    value={intent === "ask" ? question : intent === "analyze" ? instruction : goal}
                    onChange={(e) => (intent === "ask" ? setQuestion : intent === "analyze" ? setInstruction : setGoal)(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        submit();
                      }
                    }}
                    placeholder={
                      intent === "ask"
                        ? "e.g. Why is our revenue lower this month?"
                        : intent === "analyze"
                        ? "What do you want to do with it? (optional) e.g. clean the dates, then compare revenue by year"
                        : "Describe it, e.g. bookings, average rate and cancellations by hotel and month"
                    }
                    className="w-full resize-none bg-transparent border-0 outline-none text-[18px] leading-relaxed text-text placeholder:text-faint"
                    disabled={busy}
                  />
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    {intent === "ask" ? (
                      <ScopePicker scope={scope} onChange={setScope} sources={sources} spaces={spaces} />
                    ) : (
                      <span className="text-caption text-muted">
                        {intent === "analyze"
                          ? "Opens Studio: chat, data, charts and SQL side by side."
                          : "GD360 drafts it with filters from your real data. You review, then publish."}
                      </span>
                    )}
                    {intent === "ask" ? (
                      <button
                        type="button"
                        aria-label="Ask"
                        onClick={() => ask()}
                        disabled={busy || question.trim().length < 2}
                        className="ui-focus w-11 h-11 rounded-[13px] bg-primary text-on-primary grid place-items-center disabled:opacity-40"
                      >
                        {busy ? (
                          <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                        ) : (
                          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        )}
                      </button>
                    ) : intent === "analyze" ? (
                      <button type="button" onClick={openStudio} disabled={!sourceId} className="btn-primary text-sm inline-flex items-center gap-2" data-open-studio="">
                        <KindIcon kind="analysis" size={15} /> Open in Studio
                      </button>
                    ) : (
                      <button type="button" onClick={buildDashboard} disabled={!sourceId || goal.trim().length < 4} className="btn-primary text-sm inline-flex items-center gap-2" data-build-dashboard="">
                        <KindIcon kind="dashboard" size={15} /> Build dashboard
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
            {error && <div role="alert" className="text-ui text-danger">{error}</div>}
            {!noSources && (
              <div className="flex gap-2 flex-wrap justify-center">
                {starters.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => pickStarter(s)}
                    className="ui-focus h-[34px] px-3.5 rounded-full border border-border bg-surface text-ui text-muted hover:text-text"
                  >
                    {s}
                  </button>
                ))}
                {intent === "build" && (
                  <Link to="/dashboards?start=1" className="ui-focus h-[34px] px-3.5 rounded-full border border-dashed border-border text-ui text-muted hover:text-text inline-flex items-center">
                    Or start from an answer or analysis →
                  </Link>
                )}
              </div>
            )}
          </div>

          <section aria-label="Pick up where you left off" className="w-full max-w-[880px] flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Pick up where you left off</span>
                <div className="flex gap-0.5 rounded-ctl border border-border bg-surface p-[3px]" role="tablist">
                  {(["recent", "pinned", "shared"] as Tab[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      aria-selected={tab === t}
                      onClick={() => setTab(t)}
                      className={`h-8 px-3 rounded-[7px] text-ui ${tab === t ? "bg-subtle text-text" : "text-muted hover:text-text"}`}
                    >
                      {t === "recent" ? "Recent" : t === "pinned" ? "Pinned" : "Shared with me"}
                    </button>
                  ))}
                </div>
              </div>
              <Link to="/library" className="text-ui text-muted hover:text-text">Open Library →</Link>
            </div>
            <div className="rounded-card border border-border overflow-hidden bg-surface">
              {(projects === null || dashboards === null) && <div className="p-5 text-ui text-muted">Loading…</div>}
              {projects !== null && dashboards !== null && recent.length === 0 && (
                <div className="p-6 text-ui text-muted">
                  {tab === "recent" ? "Nothing yet — your answers, analyses and dashboards will appear here." : tab === "pinned" ? "Nothing pinned yet." : "Nothing shared with you yet."}
                </div>
              )}
              {projects !== null && dashboards !== null && recent.map((item) => {
                if (item.type === "conv") {
                  const c = item.c;
                  const kind = conversationKind(c);
                  const to = conversationHref(c) || "/library";
                  const n = c.dashboard_count || 0;
                  return (
                    <Link key={`c-${c.id}`} to={to} data-recent-kind={kind} className="grid grid-cols-[36px_minmax(0,1fr)_auto] gap-3.5 items-center px-4 py-3 border-t first:border-t-0 border-border hover:bg-subtle">
                      <KindTile kind={kind} />
                      <span className="min-w-0 flex flex-col gap-0.5">
                        <span className="text-body text-text truncate">{c.title}</span>
                        <span className="text-caption text-muted truncate">
                          <KindPill kind={kind} className="h-[18px] px-1.5 text-[10.5px] mr-1.5 align-[1px]" />
                          {c.datasource_name || "No source"}
                          {n > 0 ? ` · ${n} dashboard${n === 1 ? "" : "s"}` : ""}
                        </span>
                      </span>
                      <span className="font-mono text-caption text-muted whitespace-nowrap">{timeAgo(c.updated_at)}</span>
                    </Link>
                  );
                }
                const d = item.d;
                return (
                  <Link key={`d-${d.id}`} to={dashboardHref(d)} data-recent-kind="dashboard" className="grid grid-cols-[36px_minmax(0,1fr)_auto] gap-3.5 items-center px-4 py-3 border-t first:border-t-0 border-border hover:bg-subtle">
                    <KindTile kind="dashboard" />
                    <span className="min-w-0 flex flex-col gap-0.5">
                      <span className="text-body text-text truncate">{d.name}</span>
                      <span className="text-caption text-muted truncate">
                        <KindPill kind="dashboard" className="h-[18px] px-1.5 text-[10.5px] mr-1.5 align-[1px]" />
                        {d.source_kind && d.source_title ? `From ${d.source_kind} “${d.source_title}”` : d.workspace_name ? `Shared with ${d.workspace_name}` : "Personal"}
                      </span>
                    </span>
                    <span className="font-mono text-caption text-muted whitespace-nowrap">{timeAgo(d.created_at)}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

function SourceSelect({ sources, value, onChange, label }: { sources: ProjectSource[]; value: string; onChange: (id: string) => void; label: string }) {
  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-source-select=""
        className="ui-focus appearance-none h-8 pl-3 pr-8 rounded-full border border-border-strong bg-base text-ui font-medium text-text max-w-[min(420px,80vw)] truncate cursor-pointer"
      >
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} · {s.label}
          </option>
        ))}
      </select>
      <svg className="pointer-events-none absolute right-3 text-muted" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </label>
  );
}
