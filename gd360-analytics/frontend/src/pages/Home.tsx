// 2026-10-08 (round 11): the signed-in home page. One question box, the
// sources it will use, and your recent projects - nothing else competes
// for attention. Asking creates a multi-source Project and opens it
// (pages/ProjectWorkspace.tsx), where the plan, the live run and the answer
// appear. The full Projects library (folders, bulk actions) is /projects.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { conversationApi, ConversationSummary } from "../api/client";
import { projectsApi, ProjectSource } from "../api/projects";
import { timeAgo, MODE_LABEL } from "../project/format";
import { useAuth } from "../api/AuthContext";

const STARTERS = [
  "Why did revenue change this month?",
  "Which channels bring the most revenue?",
  "Show revenue per week for the last quarter",
];

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
  const [sources, setSources] = useState<ProjectSource[] | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null); // null = all
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projects, setProjects] = useState<ConversationSummary[] | null>(null);
  const [tab, setTab] = useState<Tab>("recent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    setSources(null);
    setPicked(null);
    projectsApi.sources(activeWorkspaceId).then(setSources).catch(() => setSources([]));
    conversationApi.list(activeWorkspaceId).then(setProjects).catch(() => setProjects([]));
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!pickerOpen) return;
    const close = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [pickerOpen]);

  const chosen = useMemo(() => {
    if (!sources) return [];
    return picked === null ? sources : sources.filter((s) => picked.includes(s.id));
  }, [sources, picked]);

  const listed = useMemo(() => {
    const all = projects || [];
    const rows =
      tab === "pinned" ? all.filter((p) => p.pinned) : tab === "shared" ? all.filter((p) => !p.is_own) : all;
    return rows.slice(0, 6);
  }, [projects, tab]);

  const ask = async (text?: string) => {
    const q = (text ?? question).trim();
    if (q.length < 2 || busy) return;
    if (!chosen.length) {
      setError("Pick at least one source to ask about.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const out = await projectsApi.create({
        question: q,
        source_ids: picked === null ? undefined : picked,
        workspace_id: activeWorkspaceId || undefined,
      });
      navigate(`/p/${out.project_id}?run=${out.run_id}`);
    } catch (e: any) {
      setError(errorText(e, "Couldn't start that question. Please try again."));
      setBusy(false);
    }
  };

  const toggle = (id: string) => {
    const all = (sources || []).map((s) => s.id);
    const cur = picked === null ? all : picked;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    setPicked(next.length === all.length ? null : next);
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
              Ask about anything in your business. GD360 finds the right data across all your sources, queries each one where it lives, and shows its work.
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
                  <div className="relative" ref={pickerRef}>
                    <button
                      type="button"
                      onClick={() => setPickerOpen((v) => !v)}
                      className="ui-focus inline-flex items-center gap-2 h-8 px-3 rounded-full border border-tint-border bg-base text-ui text-secondary hover:text-text"
                      aria-expanded={pickerOpen}
                    >
                      <span className="w-[7px] h-[7px] rounded-full bg-good" />
                      {sources === null
                        ? "Loading sources…"
                        : picked === null
                          ? `All sources · ${sources.length} connected`
                          : `${chosen.length} of ${sources.length} sources`}
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                    </button>
                    {pickerOpen && sources && (
                      <div className="absolute z-30 mt-2 w-[min(360px,80vw)] rounded-card border border-border bg-surface shadow-pop p-2">
                        <div className="flex items-center justify-between px-2 py-1.5">
                          <span className="text-caption uppercase tracking-caps text-muted">Ask across</span>
                          <button type="button" className="text-caption text-brand-ink hover:underline" onClick={() => setPicked(null)}>
                            Select all
                          </button>
                        </div>
                        <div className="max-h-72 overflow-auto">
                          {sources.map((s) => {
                            const on = picked === null || picked.includes(s.id);
                            return (
                              <label key={s.id} className="flex items-center gap-3 px-2 py-2 rounded-ctl hover:bg-subtle cursor-pointer">
                                <input type="checkbox" checked={on} onChange={() => toggle(s.id)} className="w-4 h-4 accent-[rgb(var(--color-primary))]" />
                                <span className="flex-1 min-w-0">
                                  <span className="block text-ui text-text truncate">{s.name}</span>
                                  <span className="block text-caption text-muted">{s.label} · {s.freshness}</span>
                                </span>
                                <span className="font-mono text-[10px] text-muted">{MODE_LABEL[s.mode]}</span>
                              </label>
                            );
                          })}
                        </div>
                        <Link to="/data" className="block px-2 py-2 text-ui text-brand-ink hover:underline">+ Connect another source</Link>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label="Ask"
                    onClick={() => ask()}
                    disabled={busy || question.trim().length < 2}
                    className="ui-focus w-11 h-11 rounded-[13px] bg-primary text-white grid place-items-center disabled:opacity-40"
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
                {STARTERS.map((s) => (
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
