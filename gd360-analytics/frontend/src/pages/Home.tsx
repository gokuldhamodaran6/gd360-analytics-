// 2026-10-08 (round 11): the signed-in home page. One question box, the
// sources it will use, and your recent projects - nothing else competes
// for attention. Asking creates a multi-source Project and opens it
// (pages/ProjectWorkspace.tsx), where the plan, the live run and the answer
// appear. The full Projects library (folders, bulk actions) is /projects.
// 2026-10-09 (round 15): the scope chip asks one Space, chosen sources or
// everything (spaces/ScopePicker.tsx, HomePicker.dc.html). ?space=<id>
// preselects a Space (the Data page's "Ask this Space"); the last scope is
// remembered per workspace in this browser.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { conversationApi, ConversationSummary } from "../api/client";
import { projectsApi, ProjectSource } from "../api/projects";
import { timeAgo, autoRunPreference } from "../project/format";
import { useAuth } from "../api/AuthContext";
import { Space, spacesApi } from "../api/spaces";
import ScopePicker, { Scope, loadScope, saveScope, scopeSummary, startersFor } from "../spaces/ScopePicker";

type Tab = "recent" | "pinned" | "shared";

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

export default function Home() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [question, setQuestion] = useState("");
  const [searchParams] = useSearchParams();
  const spaceParam = searchParams.get("space");
  const [sources, setSources] = useState<ProjectSource[] | null>(null);
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [scope, setScopeState] = useState<Scope>({ kind: "all" });
  const [projects, setProjects] = useState<ConversationSummary[] | null>(null);
  const [tab, setTab] = useState<Tab>("recent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // 2026-10-09: the first question picked on the public "Get started" page
  // waits here after sign-up.
  // (kept until the question box shows - a new account first sees
  // "Connect your first source")
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

  const chosenSpace = scope.kind === "space" ? (spaces || []).find((s) => s.id === scope.spaceId) || null : null;
  const summary = scopeSummary(scope, sources, spaces);
  const starters = useMemo(() => startersFor(chosenSpace), [chosenSpace]);

  const listed = useMemo(() => {
    const all = projects || [];
    const rows =
      tab === "pinned" ? all.filter((p) => p.pinned) : tab === "shared" ? all.filter((p) => !p.is_own) : all;
    return rows.slice(0, 6);
  }, [projects, tab]);

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

  const firstName = (user?.full_name || "").split(" ")[0];
  const noSources = sources !== null && sources.length === 0;

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
        <main className="flex flex-col items-center px-4 sm:px-8 pt-14 sm:pt-20 pb-16 gap-12">
          <div className="w-full max-w-[760px] flex flex-col items-center gap-5 text-center">
            <h1 className="m-0 text-[34px] sm:text-[40px] font-semibold tracking-tight text-text text-balance">
              {firstName ? `What do you want to know, ${firstName}?` : "What do you want to know?"}
            </h1>
            <p className="m-0 text-body text-muted max-w-[56ch]">
              Ask one Space, a few sources, or everything you have connected. GD360 queries each source where it lives and shows its work.
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
              <div className="w-full text-left rounded-[20px] border border-tint-border bg-surface shadow-pop p-4 sm:p-[18px]">
                <label htmlFor="home-ask" className="sr-only">Ask anything</label>
                <textarea
                  id="home-ask"
                  ref={boxRef}
                  rows={3}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      ask();
                    }
                  }}
                  placeholder="e.g. Why is our revenue lower this month?"
                  className="w-full resize-none bg-transparent border-0 outline-none text-[18px] leading-relaxed text-text placeholder:text-faint"
                  disabled={busy}
                />
                <div className="mt-2 flex items-center justify-between gap-3 flex-wrap">
                  <ScopePicker scope={scope} onChange={setScope} sources={sources} spaces={spaces} />
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
                </div>
              </div>
            )}
            {error && <div role="alert" className="text-ui text-danger">{error}</div>}
            {!noSources && (
              <div className="flex gap-2 flex-wrap justify-center">
                {starters.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => { setQuestion(s); boxRef.current?.focus(); }}
                    className="ui-focus h-[34px] px-3.5 rounded-full border border-border bg-surface text-ui text-muted hover:text-text"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          <section aria-label="Your projects" className="w-full max-w-[860px] flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
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
              <Link to="/projects" className="text-ui text-muted hover:text-text">All projects →</Link>
            </div>
            <div className="rounded-card border border-border overflow-hidden bg-surface">
              {projects === null && <div className="p-5 text-ui text-muted">Loading…</div>}
              {projects !== null && listed.length === 0 && (
                <div className="p-6 text-ui text-muted">
                  {tab === "recent" ? "Nothing yet - your questions and analyses will appear here." : tab === "pinned" ? "No pinned projects." : "Nothing shared with you yet."}
                </div>
              )}
              {listed.map((p) => {
                const isProject = (p as any).kind === "project";
                const to = isProject ? `/p/${p.id}` : p.datasource_id ? `/workspace/${p.datasource_id}?conversation=${p.id}` : "/projects";
                return (
                  <Link key={p.id} to={to} className="grid grid-cols-[36px_1fr_auto] gap-3.5 items-center px-4 py-3.5 border-t first:border-t-0 border-border hover:bg-subtle">
                    <span className={`w-9 h-9 rounded-[10px] grid place-items-center text-[15px] ${isProject ? "bg-tint text-brand-ink" : "bg-subtle text-secondary"}`} aria-hidden="true">
                      {isProject ? "?" : "▦"}
                    </span>
                    <span className="min-w-0 flex flex-col gap-0.5">
                      <span className="text-body text-text truncate">{p.title}</span>
                      <span className="text-caption text-muted truncate">{p.datasource_name || "No source"}</span>
                    </span>
                    <span className="font-mono text-caption text-muted">{timeAgo(p.updated_at)}</span>
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
