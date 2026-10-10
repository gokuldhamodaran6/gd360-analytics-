// 2026-10-10 (Clarity Blueprint, Option 1): this page is an ANSWER - a
// question asked on Home, labelled as such, living in Library. Its next
// steps are explicit: go deeper on one table in Studio, or create the one
// kind of dashboard (components/CreateDashboardSheet.tsx). ?create=1 opens
// that sheet straight away (Dashboards -> "From an answer").
// 2026-10-08 (round 11): a multi-source Project. Left: the conversation -
// every question and GD360's reply, live while it plans and runs. Right:
// the selected question's Plan, Sources (each query as it runs), Results
// (the answer drawn) and Evidence (every table and the query behind it).
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { ChartThemeProvider } from "../dashboard/theme/ChartThemeContext";
import { projectsApi, Project, ProjectRun } from "../api/projects";
import { EvidenceTab, PlanTab, ResultsTab, SourcesTab } from "../project/RunPanels";
import { autoRunPreference, timeAgo } from "../project/format";
import CreateDashboardSheet, { answerSources } from "../components/CreateDashboardSheet";
import { dashboardHref, KindIcon, KindPill } from "../lib/kinds";

type TabId = "plan" | "sources" | "results" | "evidence";
const ACTIVE = new Set(["planning", "running"]);

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

function defaultTab(run: ProjectRun | null): TabId {
  if (!run) return "plan";
  if (run.status === "done" || run.status === "needs_input") return "results";
  if (run.status === "running" || run.status === "failed" || run.status === "stopped") return "sources";
  return "plan";
}

export default function ProjectWorkspace() {
  const { projectId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<Record<string, ProjectRun>>({});
  const [selected, setSelected] = useState<string | null>(params.get("run"));
  const [tab, setTab] = useState<TabId | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [dashMenuOpen, setDashMenuOpen] = useState(false);
  const dashMenuRef = useRef<HTMLDivElement>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // "Change" on an assumption opens the Plan tab's change box with it filled in
  const [replanSeed, setReplanSeed] = useState<{ text: string; n: number } | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);
  const threadPane = useRef<HTMLDivElement>(null);
  const shareRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!shareOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setShareOpen(false);
        return;
      }
      if (shareRef.current && !shareRef.current.contains(e.target as Node)) setShareOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [shareOpen]);

  useEffect(() => {
    if (!dashMenuOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setDashMenuOpen(false);
        return;
      }
      if (dashMenuRef.current && !dashMenuRef.current.contains(e.target as Node)) setDashMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [dashMenuOpen]);

  const loadProject = useCallback(async () => {
    try {
      const p = await projectsApi.get(projectId);
      setProject(p);
      return p;
    } catch (e: any) {
      if (e?.response?.status === 404) setNotFound(true);
      else setError(errorText(e, "Couldn't load this project."));
      return null;
    }
  }, [projectId]);

  const loadRun = useCallback(async (id: string) => {
    try {
      const r = await projectsApi.run(id);
      setRuns((prev) => ({ ...prev, [id]: r }));
      return r;
    } catch {
      return null;
    }
  }, []);

  // first load: the project, then every question in it
  useEffect(() => {
    let alive = true;
    (async () => {
      const p = await loadProject();
      if (!p || !alive) return;
      await Promise.all(p.runs.map((r) => loadRun(r.id)));
      if (!selected && p.runs.length) setSelected(p.runs[p.runs.length - 1].id);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const ordered = useMemo(() => {
    const ids = project?.runs.map((r) => r.id) || [];
    for (const id of Object.keys(runs)) if (!ids.includes(id) && runs[id].status !== "replaced") ids.push(id);
    return ids
      .map((id) => runs[id])
      .filter(Boolean)
      .filter((r) => r.status !== "replaced")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }, [project, runs]);

  const activeRun = ordered.find((r) => ACTIVE.has(r.status)) || null;
  const current = (selected && runs[selected]) || ordered[ordered.length - 1] || null;
  const currentTab: TabId = tab || defaultTab(current);

  // live polling while anything is planning or running
  useEffect(() => {
    const live = ordered.filter((r) => ACTIVE.has(r.status) || (r.status === "planned" && r.auto_run));
    if (!live.length) return;
    const t = setInterval(async () => {
      for (const r of live) {
        const next = await loadRun(r.id);
        if (next && next.status !== r.status) {
          if (selected === r.id) setTab(null); // follow the run to its natural tab
          if (!ACTIVE.has(next.status)) loadProject();
        }
      }
    }, 900);
    return () => clearInterval(t);
  }, [ordered, loadRun, loadProject, selected]);

  useEffect(() => {
    if (selected) {
      const next = new URLSearchParams(params);
      next.set("run", selected);
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // keep the newest reply in view inside the conversation pane (never by
  // scrolling the whole page, so the header and tabs stay put)
  useEffect(() => {
    const pane = threadPane.current;
    if (pane && pane.scrollHeight > pane.clientHeight) pane.scrollTo({ top: pane.scrollHeight, behavior: "smooth" });
  }, [ordered.length]);

  const select = (id: string) => {
    setSelected(id);
    setTab(null);
  };

  const ask = async (text: string, autoRun = autoRunPreference()) => {
    const q = text.trim();
    if (q.length < 2 || busy || activeRun) return;
    setBusy(true);
    setError("");
    try {
      const out = await projectsApi.ask(projectId, q, autoRun);
      setFollowUp("");
      const r = await loadRun(out.run_id);
      await loadProject();
      if (r) select(r.id);
    } catch (e: any) {
      setError(errorText(e, "Couldn't ask that. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const runPlan = async (id: string) => {
    setBusy(true);
    try {
      await projectsApi.execute(id);
      setRuns((prev) => ({ ...prev, [id]: { ...prev[id], status: "running" } }));
      setTab("sources");
    } catch (e: any) {
      setError(errorText(e, "Couldn't start the plan."));
    } finally {
      setBusy(false);
    }
  };

  const replan = async (id: string, note: string) => {
    setBusy(true);
    try {
      const out = await projectsApi.replan(id, note);
      const r = await loadRun(out.run_id);
      setRuns((prev) => ({ ...prev, [id]: { ...prev[id], status: "replaced" } }));
      if (r) select(r.id);
      setTab("plan");
    } catch (e: any) {
      setError(errorText(e, "Couldn't change the plan."));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    try {
      await projectsApi.stop(id);
      await loadRun(id);
    } catch {
      /* the next poll shows the real state */
    }
  };

  // "Go deeper in Studio": the source this answer leaned on most, opened in
  // Studio with the same question ready to run.
  const deeperSource = useMemo(
    () => (current && project ? answerSources(current, project.sources)[0]?.source || null : null),
    [current, project],
  );
  const studioHref = deeperSource && current ? `/workspace/${deeperSource.id}?draft=${encodeURIComponent(current.question)}` : null;
  const canCreate = !!project?.can_edit && current?.status === "done";

  // Dashboards -> "From an answer" lands here with ?create=1.
  useEffect(() => {
    if (params.get("create") === "1" && canCreate) {
      setCreateOpen(true);
      const next = new URLSearchParams(params);
      next.delete("create");
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCreate]);

  const dashboards = project?.dashboards || [];

  if (notFound) {
    return (
      <div className="min-h-screen grid place-items-center bg-base px-6">
        <div className="text-center">
          <div className="text-section font-semibold text-text">This answer doesn't exist or isn't shared with you.</div>
          <Link to="/" className="btn-primary text-sm mt-4 inline-flex">Go home</Link>
        </div>
      </div>
    );
  }

  return (
    <ChartThemeProvider localScope={`project:${projectId}`}>
      <CreateDashboardSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projectId={projectId}
        run={current}
        sources={project?.sources || []}
      />
      <div className="dash-shell flex min-h-screen">
        <AppSidebar
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onWorkspaceSwitch={switchWorkspace}
          onWorkspaceCreated={handleWorkspaceCreated}
        />
        <div className="flex-1 min-w-0 flex flex-col lg:h-screen">
          <header className="flex items-center justify-between gap-4 pl-14 pr-4 sm:pr-6 lg:pl-6 py-3 border-b border-border bg-base flex-wrap">
            <div className="flex flex-col gap-1 min-w-0 flex-[1_1_320px]">
              <span className="font-mono text-[11px] text-muted uppercase tracking-[0.06em]">
                <Link to="/library?type=answer" className="hover:text-text">Library</Link> / Answer · {crumb(activeRun, current)}
              </span>
              <span className="flex items-center gap-2.5 min-w-0">
                <KindPill kind="answer" className="shrink-0" />
                <h1 className="m-0 text-section font-semibold text-text truncate">{project?.title || "…"}</h1>
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {activeRun ? (
                <button type="button" className="btn-secondary text-sm" onClick={() => stop(activeRun.id)}>Stop</button>
              ) : (
                <>
                  <div className="relative" ref={shareRef}>
                    <button type="button" className="btn-secondary text-sm" aria-expanded={shareOpen} onClick={() => setShareOpen((v) => !v)}>
                      Share
                    </button>
                    {shareOpen && (
                      <div role="dialog" aria-label="Share this project" className="absolute right-0 top-[calc(100%+6px)] z-30 w-[300px] max-w-[calc(100vw-32px)] rounded-card border border-border bg-surface shadow-pop p-4 flex flex-col gap-3">
                        <p className="m-0 text-ui text-secondary leading-snug">
                          Anyone in your workspace who can see {project?.sources?.[0]?.name || "this project's first source"} can open this project and its answers.
                        </p>
                        <button
                          type="button"
                          className="btn-primary text-sm self-start"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(window.location.href);
                              setCopied(true);
                              setTimeout(() => setCopied(false), 1600);
                            } catch {
                              setCopied(false);
                            }
                          }}
                        >
                          {copied ? "Link copied" : "Copy link"}
                        </button>
                        <span className="text-caption text-muted break-all select-all">{typeof window !== "undefined" ? window.location.href : ""}</span>
                      </div>
                    )}
                  </div>
                  {project?.can_edit && current?.status === "done" && (
                    <Link to={`/automations/new?project=${projectId}&run=${current.id}`} className="btn-secondary text-sm">
                      Set an alert
                    </Link>
                  )}
                  {dashboards.length === 1 ? (
                    <Link to={dashboardHref(dashboards[0])} className="btn-secondary text-sm inline-flex items-center gap-1.5" data-open-dashboard="">
                      <KindIcon kind="dashboard" size={14} className="text-kind-dashboard" /> Open dashboard
                    </Link>
                  ) : dashboards.length > 1 ? (
                    <div className="relative" ref={dashMenuRef}>
                      <button type="button" className="btn-secondary text-sm inline-flex items-center gap-1.5" aria-expanded={dashMenuOpen} onClick={() => setDashMenuOpen((v) => !v)}>
                        <KindIcon kind="dashboard" size={14} className="text-kind-dashboard" /> Dashboards ({dashboards.length})
                      </button>
                      {dashMenuOpen && (
                        <div role="menu" className="absolute right-0 top-[calc(100%+6px)] z-30 w-[280px] max-w-[calc(100vw-32px)] rounded-card border border-border bg-surface shadow-pop p-1.5">
                          {[...dashboards].reverse().map((d) => (
                            <Link key={d.id} role="menuitem" to={dashboardHref(d)} className="block px-3 py-2 rounded-ctl text-ui text-text hover:bg-subtle truncate">
                              {d.name}
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="btn-primary text-sm inline-flex items-center gap-1.5"
                    onClick={() => setCreateOpen(true)}
                    disabled={!canCreate}
                    data-answer-create-dashboard=""
                    title={current?.status === "done" ? "A live dashboard with filters, made from this answer" : "Available once the answer is ready"}
                  >
                    <KindIcon kind="dashboard" size={15} /> Create dashboard
                  </button>
                </>
              )}
            </div>
          </header>
          {activeRun && (
            <div className="h-[2px] bg-border overflow-hidden" aria-hidden="true">
              <div
                className="h-full bg-[rgb(var(--color-accent))] transition-all duration-500"
                style={{ width: `${progressPct(activeRun)}%` }}
              />
            </div>
          )}

          <div className="flex-1 flex flex-wrap lg:flex-nowrap min-h-0">
            <section aria-label="Conversation" className="flex-[1_1_360px] max-w-full lg:max-w-[440px] lg:h-full border-r border-border bg-base flex flex-col min-h-[60vh] lg:min-h-0">
              <div ref={threadPane} className="flex-1 overflow-auto px-5 py-6 flex flex-col gap-6">
                {!project && <div className="text-ui text-muted">Loading…</div>}
                {ordered.map((r) => (
                  <ThreadItem
                    key={r.id}
                    run={r}
                    selected={current?.id === r.id}
                    onSelect={() => select(r.id)}
                    onRun={() => runPlan(r.id)}
                    onAsk={(q) => ask(q)}
                    onRetry={() => ask(r.question)}
                    onChangeAssumption={(a) => {
                      select(r.id);
                      setTab("plan");
                      setReplanSeed({ text: `Instead of "${a}": `, n: Date.now() });
                    }}
                    canEdit={!!project?.can_edit}
                    busy={busy || !!activeRun}
                    next={
                      current?.id === r.id && r.status === "done" && project?.can_edit ? (
                        <WhatNext studioHref={studioHref} studioSource={deeperSource?.name || null} onCreate={() => setCreateOpen(true)} />
                      ) : null
                    }
                  />
                ))}
                <div ref={threadEnd} />
              </div>
              {project?.can_edit && (
                <form
                  className="p-3.5 border-t border-border"
                  onSubmit={(e) => {
                    e.preventDefault();
                    ask(followUp);
                  }}
                >
                  {error && <div role="alert" className="text-ui text-danger mb-2">{error}</div>}
                  <label className="flex items-center gap-2.5 bg-surface border border-border rounded-card px-3 py-2.5">
                    <span className="sr-only">Ask a follow-up</span>
                    <input
                      value={followUp}
                      onChange={(e) => setFollowUp(e.target.value)}
                      placeholder={activeRun ? "GD360 is working on the last question…" : "Ask a follow-up…"}
                      disabled={busy || !!activeRun}
                      className="flex-1 bg-transparent border-0 outline-none text-body text-text placeholder:text-faint"
                    />
                    <button type="submit" disabled={busy || !!activeRun || followUp.trim().length < 2} className="text-caption font-mono text-muted disabled:opacity-40" aria-label="Send">
                      ↵
                    </button>
                  </label>
                </form>
              )}
            </section>

            <section aria-label="Work" className="flex-[999_1_560px] min-w-0 flex flex-col lg:h-full lg:overflow-auto">
              <div role="tablist" className="sticky top-0 z-10 shrink-0 bg-base flex gap-6 px-5 sm:px-7 border-b border-border overflow-x-auto">
                {(["plan", "sources", "results", "evidence"] as TabId[]).map((t) => (
                  <button
                    key={t}
                    role="tab"
                    type="button"
                    aria-selected={currentTab === t}
                    onClick={() => setTab(t)}
                    className={`h-11 text-body border-b-2 -mb-px whitespace-nowrap ${currentTab === t ? "text-text border-[rgb(var(--color-accent))]" : "text-muted border-transparent hover:text-text"}`}
                  >
                    {t === "plan" ? "Plan" : t === "sources" ? (current?.status === "running" ? "Sources · live" : "Sources") : t === "results" ? "Results" : `Evidence${current?.result?.queries ? ` · ${current.result.queries} queries` : ""}`}
                  </button>
                ))}
              </div>
              <div className="shrink-0 p-5 sm:p-7 max-w-[1100px] w-full">
                {!current && project && <div className="text-ui text-muted">Ask a question to start.</div>}
                {current && currentTab === "plan" && (
                  <PlanTab run={current} canEdit={!!project?.can_edit} busy={busy} seed={replanSeed} onRun={() => runPlan(current.id)} onReplan={(n) => replan(current.id, n)} />
                )}
                {current && currentTab === "sources" && <SourcesTab run={current} />}
                {current && currentTab === "results" && <ResultsTab run={current} />}
                {current && currentTab === "evidence" && <EvidenceTab run={current} />}
              </div>
            </section>
          </div>
        </div>
      </div>
    </ChartThemeProvider>
  );
}

function progressPct(run: ProjectRun): number {
  if (run.status === "planning") return 12;
  const steps = run.steps || [];
  if (!steps.length) return 20;
  const done = steps.filter((s) => s.status === "done" || s.status === "failed").length;
  return Math.min(95, 20 + (done / steps.length) * 75);
}

function crumb(active: ProjectRun | null, current: ProjectRun | null): string {
  if (active) return active.status === "planning" ? "Planning" : "Running";
  if (!current) return "New";
  if (current.status === "done") return current.duration_seconds ? `Done in ${Math.max(1, Math.round(current.duration_seconds))} s` : "Done";
  if (current.status === "planned") return "Plan ready";
  if (current.status === "needs_input") return "Needs a source";
  if (current.status === "failed") return "Could not finish";
  if (current.status === "stopped") return "Stopped";
  return "Project";
}

// The two ways forward from an answer - always the same two, always named
// for what they do.
function WhatNext({ studioHref, studioSource, onCreate }: { studioHref: string | null; studioSource: string | null; onCreate: () => void }) {
  return (
    <div className="flex flex-col gap-2" data-what-next="">
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-kind-answer">What next?</span>
      {studioHref && (
        <Link
          to={studioHref}
          onClick={(e) => e.stopPropagation()}
          className="ui-focus flex flex-col items-start gap-1.5 p-3 rounded-ctl border border-border bg-base hover:border-kind-analysis-border text-left"
        >
          <KindPill kind="analysis">Guided Analysis</KindPill>
          <span className="flex flex-col gap-0.5 min-w-0">
            <span className="text-ui font-semibold text-text">Go deeper{studioSource ? ` on ${studioSource}` : ""}</span>
            <span className="text-caption text-muted leading-snug">Continue this question step by step — clean, slice and chart it, changing any step.</span>
          </span>
        </Link>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onCreate(); }}
        className="ui-focus flex flex-col items-start gap-1.5 p-3 rounded-ctl border border-border bg-base hover:border-kind-dashboard-border text-left"
      >
        <KindPill kind="dashboard" />
        <span className="flex flex-col gap-0.5 min-w-0">
          <span className="text-ui font-semibold text-text">Create a dashboard</span>
          <span className="text-caption text-muted leading-snug">Live, with filters — the same kind as every dashboard in GD360.</span>
        </span>
      </button>
    </div>
  );
}

function ThreadItem({
  run, selected, onSelect, onRun, onAsk, onRetry, onChangeAssumption, canEdit, busy, next,
}: {
  run: ProjectRun; selected: boolean; onSelect: () => void; onRun: () => void; onAsk: (q: string) => void; onRetry: () => void;
  onChangeAssumption: (a: string) => void; canEdit: boolean; busy: boolean; next?: ReactNode;
}) {
  const steps = run.steps || [];
  const ans = run.result?.answer;
  return (
    <div className="flex flex-col gap-3">
      <div className="self-end max-w-[85%] bg-surface2 rounded-[16px_16px_4px_16px] px-4 py-3 text-body text-text">{run.question}</div>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
        className={`rounded-card p-3.5 -mx-1 flex flex-col gap-3 cursor-pointer border ${selected ? "border-tint-border bg-surface" : "border-transparent hover:bg-surface/60"}`}
      >
        <div className="flex items-center gap-2">
          <span className="w-[22px] h-[22px] rounded-[7px] bg-tint grid place-items-center text-brand-ink text-[11px]" aria-hidden="true">✦</span>
          <span className="text-ui font-semibold text-text">GD360</span>
          <span className="text-caption text-muted">
            {run.status === "planning" && "· planning"}
            {run.status === "running" && `· working${run.duration_seconds ? ` · ${Math.round(run.duration_seconds)} s` : ""}`}
            {run.status === "done" && `· ${timeAgo(run.finished_at)}${run.duration_seconds ? ` · done in ${Math.round(run.duration_seconds)} s` : ""}`}
          </span>
        </div>

        {run.status === "planning" && (
          <div className="flex items-center gap-2.5 text-ui text-muted">
            <span className="w-4 h-4 rounded-full border-2 border-border border-t-[rgb(var(--color-accent))] animate-spin" />
            Reading your sources and planning the queries…
          </div>
        )}

        {run.status === "planned" && run.plan && Array.isArray(run.plan.steps) && (
          <>
            <p className="m-0 text-body text-secondary leading-relaxed">
              {run.plan.understanding?.method ? `${run.plan.understanding.method}. ` : ""}
              Here is the plan — {run.plan.steps.length} queries across {new Set(run.plan.steps.map((s) => s.source_id)).size} sources.
            </p>
            {(run.plan.assumptions || []).length > 0 && (
              <div className="rounded-card border border-border bg-base p-3.5 flex flex-col gap-2.5">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">I assumed</span>
                {run.plan.assumptions.map((a, i) => (
                  <div key={i} className="flex items-center justify-between gap-3">
                    <span className="text-ui text-text leading-snug">{a}</span>
                    {canEdit && (
                      <button
                        type="button"
                        className="shrink-0 h-7 px-2.5 rounded-ctl border border-border-strong text-caption text-text hover:bg-subtle"
                        onClick={(e) => { e.stopPropagation(); onChangeAssumption(a); }}
                        disabled={busy}
                      >
                        Change
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {canEdit && (
              <div className="flex gap-2">
                <button type="button" className="btn-primary text-sm" onClick={(e) => { e.stopPropagation(); onRun(); }} disabled={busy}>Run plan</button>
                <span className="text-caption text-muted self-center">or change it in the Plan tab</span>
              </div>
            )}
          </>
        )}

        {(run.status === "running" || (run.status === "stopped" && steps.length > 0)) && (
          <div className="flex flex-col gap-2">
            {steps.map((s) => (
              <div key={s.id} className="grid grid-cols-[18px_1fr] gap-2.5 items-start">
                <span
                  className={`mt-[3px] w-3.5 h-3.5 rounded-full border-2 ${
                    s.status === "done" ? "border-good bg-good" : s.status === "running" ? "border-[rgb(var(--color-series-1))] animate-pulse" : s.status === "failed" ? "border-danger bg-danger" : "border-border-strong"
                  }`}
                />
                <span className="flex flex-col">
                  <span className={`text-ui ${s.status === "pending" || s.status === "skipped" ? "text-muted" : "text-text"}`}>{s.title}</span>
                  <span className="text-caption text-muted">
                    {s.kind === "combine" ? "Combining results" : s.source_name}
                    {s.status === "done" && s.duration_ms != null ? ` · ${(s.duration_ms / 1000).toFixed(1)} s` : ""}
                    {s.status === "failed" ? " · could not run" : ""}
                  </span>
                </span>
              </div>
            ))}
            {run.status === "stopped" && <span className="text-ui text-muted">Stopped.</span>}
          </div>
        )}

        {run.status === "done" && ans && (
          <>
            <p className="m-0 text-body text-text leading-relaxed">{ans.headline}</p>
            {ans.answer && ans.answer !== ans.headline && <p className="m-0 text-ui text-secondary leading-relaxed">{ans.answer}</p>}
            {ans.causes.length > 0 && (
              <ol className="m-0 pl-5 flex flex-col gap-2 text-ui text-secondary leading-relaxed">
                {ans.causes.slice(0, 3).map((c, i) => (
                  <li key={i}>
                    <span className="text-text font-semibold">{c.title}</span>{c.detail ? ` — ${c.detail}` : ""}
                    {c.amount && <span className="text-muted font-mono"> ≈ {c.amount}</span>}
                  </li>
                ))}
              </ol>
            )}
            <div className="flex gap-1.5 flex-wrap">
              {(run.result?.sources_used || []).map((s) => (
                <span key={s} className="inline-flex items-center h-[22px] px-2 rounded-md bg-subtle text-caption text-secondary">{s}</span>
              ))}
            </div>
            {next}
            {ans.next_questions.length > 0 && canEdit && (
              <div className="flex flex-col gap-1.5">
                <span className="text-caption uppercase tracking-caps text-muted">Ask next</span>
                {ans.next_questions.map((q) => (
                  <button
                    key={q}
                    type="button"
                    disabled={busy}
                    onClick={(e) => { e.stopPropagation(); onAsk(q); }}
                    className="text-left px-3 py-2 rounded-ctl border border-border bg-base text-ui text-secondary hover:text-text disabled:opacity-50"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {run.status === "needs_input" && ans && (
          <div className="rounded-ctl border border-warning-border bg-warning-fill p-3 text-ui text-text">
            <div className="font-medium">{ans.headline}</div>
            <div className="text-secondary mt-1">{ans.answer}</div>
          </div>
        )}

        {run.status === "failed" && (
          <div className="flex flex-col gap-2">
            <div className="rounded-ctl border border-danger-border bg-danger-fill p-3 text-ui text-text">{run.error || "Something went wrong."}</div>
            {canEdit && (
              <button type="button" className="btn-secondary text-sm self-start" disabled={busy} onClick={(e) => { e.stopPropagation(); onRetry(); }}>
                Ask again
              </button>
            )}
          </div>
        )}
        {run.status === "stopped" && canEdit && (
          <button type="button" className="btn-secondary text-sm self-start" disabled={busy} onClick={(e) => { e.stopPropagation(); onRetry(); }}>
            Ask again
          </button>
        )}
      </div>
    </div>
  );
}

