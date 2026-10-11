// 2026-10-10: Guided Analysis - the step notebook (Clarity mockup A).
//
// The Instant Answers engine, one step at a time (backend
// services/project_engine/guided.py). GD360 writes the plan and runs the
// first step; the person reads each result and then:
//   - changes it in plain English (the sentence, or a quick-change chip) -
//     only that step's query is rewritten, then it re-runs;
//   - edits its SQL, re-runs it, or removes it;
//   - approves it, which runs the next step.
// Steps can be added; a change marks every step built on it (and the
// written answer) out of date. "Write the answer" uses the same analysis,
// answer writer and number checks as Instant Answers.
//
// 2026-10-11 (Ask Journey, canvas B1-B3, C1-C3): a Guided Analysis is a
// conversation, laid out like an Instant Answer - the conversation on the
// left, the work on the right.
//   - Follow-up questions continue the same analysis: each is a new question
//     in the thread (Q1, Q2 …), planned with the earlier answers in mind and
//     reusing any step that already ran (the same query on the same source).
//     Ask it step by step (Guided) or straight through (Quick answer), and on
//     any sources, with the same picker as Home.
//   - Each answer is shown in the same format as an Instant Answer.
//   - GD360 asks before building a dashboard: a page per question, everything
//     on one page, or - when a dashboard already holds an earlier answer -
//     "add this as page 2?" (thread/DashboardFlow.tsx).
//
// /g/:projectId - a Conversation with kind "guided"; ?run=<id> opens one question.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { ChartThemeProvider, useChartTheme } from "../dashboard/theme/ChartThemeContext";
import { resolveWorkspaceChart } from "../lib/workspaceChart";
import { guidedApi, Project, ProjectRun, ProjectSource, projectsApi, RunStep } from "../api/projects";
import { Space, spacesApi } from "../api/spaces";
import { EvidenceTab, layoutSql, ResultsTab } from "../project/RunPanels";
import { DataTable } from "../project/Visuals";
import ChartWithControls from "../project/ChartControls";
import { ms, timeAgo } from "../project/format";
import { dashboardHref, KindPill } from "../lib/kinds";
import ScopePicker, { Scope } from "../spaces/ScopePicker";
import { AskMode, CheckIcon, ContinueIcon, GdMark, GridIcon, Spinner, StepsIcon, BoltIcon, ThreadComposer } from "../thread/parts";
import {
  AddToDashboardCard, AddToDashboardDialog, CombineNudgeCard, CreateFromThreadDialog, isAnswered, PlacementToast,
  primaryDashboard, shortTitle, threadPrompt, useDashboardFlow,
} from "../thread/DashboardFlow";

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

const isWorking = (run: ProjectRun | null) =>
  Boolean(run && (run.status === "planning" || run.status === "running" || run.busy || (run.steps || []).some((s) => s.status === "running")));

/** The step the person is on: the first one not yet approved that has run
 *  (or is running, failed, or out of date); else the first that has not run. */
function currentStepId(steps: RunStep[]): string | null {
  const live = steps.find((s) => !s.approved && ["done", "running", "failed", "stale"].includes(s.status));
  if (live) return live.id;
  return steps.find((s) => !s.approved && s.status === "pending")?.id || null;
}

type View = "steps" | "answer" | "evidence";

function defaultView(run: ProjectRun | null): View {
  if (run && run.status === "done" && run.result?.answer && !run.result?.answer_stale) return "answer";
  return "steps";
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

export default function GuidedAnalysis() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [params, setParams] = useSearchParams();
  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<Record<string, ProjectRun>>({});
  const [selected, setSelected] = useState<string | null>(params.get("run"));
  const [view, setView] = useState<View | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null); // which action is waiting on the server
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const [mode, setMode] = useState<AskMode>("guided");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState("");
  const [scope, setScope] = useState<Scope | null>(null);
  const [allSources, setAllSources] = useState<ProjectSource[] | null>(null);
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createFocus, setCreateFocus] = useState<string | null>(null);
  const [createLayout, setCreateLayout] = useState<"pages" | "merge" | "latest" | undefined>(undefined);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const stepRefs = useRef<Record<string, HTMLElement | null>>({});
  const threadPane = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const loadProject = useCallback(async () => {
    try {
      const p = await projectsApi.get(projectId);
      if (p.kind && p.kind !== "guided") {
        navigate(`/p/${projectId}`, { replace: true });
        return null;
      }
      setProject(p);
      return p;
    } catch (e: any) {
      if (e?.response?.status === 404) setNotFound(true);
      else setError(errorText(e, "Couldn't load this analysis. Please refresh."));
      return null;
    }
  }, [projectId, navigate]);

  const loadRun = useCallback(async (id: string) => {
    try {
      const r = await projectsApi.run(id);
      setRuns((prev) => ({ ...prev, [id]: r }));
      return r;
    } catch {
      return null;
    }
  }, []);

  // first load: the thread, then every question in it
  useEffect(() => {
    let alive = true;
    (async () => {
      const p = await loadProject();
      if (!p || !alive) return;
      await Promise.all(p.runs.map((r) => loadRun(r.id)));
      if (!alive) return;
      setSelected((cur) => (cur && p.runs.some((r) => r.id === cur) ? cur : p.runs[p.runs.length - 1]?.id || null));
    })();
    return () => {
      alive = false;
    };
  }, [projectId, loadProject, loadRun]);

  // the follow-up box asks across the thread's sources (the same picker as Home)
  const pickerLoaded = useRef(false);
  useEffect(() => {
    if (!project) return;
    setScope((cur) => cur || (project.space_id ? { kind: "space", spaceId: project.space_id } : { kind: "sources", ids: project.source_ids }));
    if (pickerLoaded.current) return;
    pickerLoaded.current = true;
    projectsApi.sources(project.workspace_id || undefined).then(setAllSources).catch(() => setAllSources(project.sources));
    if (project.workspace_id) spacesApi.list(project.workspace_id).then(setSpaces).catch(() => setSpaces([]));
    else setSpaces([]);
  }, [project]);

  const ordered = useMemo(() => {
    const ids = project?.runs.map((r) => r.id) || [];
    for (const id of Object.keys(runs)) if (!ids.includes(id)) ids.push(id);
    return ids
      .map((id) => runs[id])
      .filter(Boolean)
      .filter((r) => r.status !== "replaced")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }, [project, runs]);
  const numberOf = useCallback((id: string) => ordered.findIndex((r) => r.id === id) + 1, [ordered]);

  const run = (selected && runs[selected]) || ordered[ordered.length - 1] || null;
  const currentView: View = view || defaultView(run);

  useEffect(() => {
    if (!run) return;
    if (params.get("run") === run.id) return;
    const next = new URLSearchParams(params);
    next.set("run", run.id);
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id]);

  // Follow the work while GD360 is planning, running a step or writing.
  const working = ordered.filter(isWorking);
  useEffect(() => {
    if (!working.length) return;
    const t = window.setTimeout(async () => {
      for (const r of working) {
        const next = await loadRun(r.id);
        if (next && !isWorking(next) && (next.status !== r.status || next.result?.answer !== r.result?.answer)) {
          loadProject();
          if (selected === next.id || (!selected && next.id === ordered[ordered.length - 1]?.id)) setView(null);
        }
      }
    }, 1200);
    return () => window.clearTimeout(t);
  }, [working, loadRun, loadProject, selected, ordered]);


  const flow = useDashboardFlow(projectId, project, loadProject);
  const canEdit = Boolean(project?.can_edit);
  const answered = ordered.filter(isAnswered);
  const prompt = threadPrompt(project, ordered, canEdit);
  const primary = primaryDashboard(project);
  const placedRuns = new Set((project?.placements || []).flatMap((p) => p.run_ids || []));
  const latestDash = (project?.dashboards || []).slice(-1)[0] || null;

  // keep the newest question - and GD360's dashboard question - in view
  // inside the conversation pane
  const promptKey = prompt ? `${prompt.kind}:${prompt.run.id}` : "";
  const lastStatus = ordered[ordered.length - 1]?.status || "";
  useEffect(() => {
    const pane = threadPane.current;
    if (pane && pane.scrollHeight > pane.clientHeight) pane.scrollTo({ top: pane.scrollHeight, behavior: "smooth" });
  }, [ordered.length, promptKey, lastStatus]);

  // Dashboards -> "From an analysis" lands here with ?create=1.
  useEffect(() => {
    if (params.get("create") !== "1" || !project || !answered.length) return;
    if (canEdit) openCreate(answered[answered.length - 1].id);
    const next = new URLSearchParams(params);
    next.delete("create");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, answered.length]);

  const openCreate = (focusId?: string | null, layout?: "pages" | "merge" | "latest") => {
    setCreateFocus(focusId || null);
    setCreateLayout(layout);
    setCreateOpen(true);
  };

  const steps = run?.steps || [];
  // an answered question opens with every step closed
  const current = run && isAnswered(run) ? null : currentStepId(steps);
  const runWorking = isWorking(run);
  const threadBusy = ordered.some((r) => r.status === "planning" || r.status === "running");

  const act = async (label: string, fn: () => Promise<ProjectRun>) => {
    setPending(label);
    setError("");
    try {
      const next = await fn();
      setRuns((prev) => ({ ...prev, [next.id]: next }));
      return next;
    } catch (e: any) {
      setError(errorText(e, "That didn't work. Please try again."));
      return null;
    } finally {
      setPending(null);
    }
  };

  const select = (id: string, v: View | null = null) => {
    setSelected(id);
    setView(v);
  };

  const toggle = (id: string) =>
    setOpen((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const jumpTo = (runId: string, stepId: string) => {
    select(runId, "steps");
    setOpen((cur) => new Set(cur).add(stepId));
    window.setTimeout(() => stepRefs.current[stepId]?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  };

  const ask = async () => {
    const q = followUp.trim();
    if (q.length < 2 || asking || threadBusy || !project || !scope) return;
    setAsking(true);
    setAskError("");
    try {
      // the thread's sources change only when the picker changed them
      const all = (allSources || []).map((s) => s.id);
      let extra: { source_ids?: string[]; space_id?: string } = {};
      if (scope.kind === "space" && scope.spaceId !== project.space_id) extra = { space_id: scope.spaceId };
      else if (scope.kind === "sources" && (project.space_id || !sameIds(scope.ids, project.source_ids))) {
        if (!scope.ids.length) {
          setAskError("Pick at least one source.");
          setAsking(false);
          return;
        }
        extra = { source_ids: scope.ids };
      } else if (scope.kind === "all" && !sameIds(all, project.source_ids)) extra = { source_ids: all };
      const out = await projectsApi.ask(projectId, q, mode === "quick", { mode: mode === "quick" ? "answer" : "guided", ...extra });
      setFollowUp("");
      await loadRun(out.run_id);
      const p = await loadProject();
      if (p && extra.space_id === undefined && extra.source_ids === undefined) {
        /* sources unchanged */
      } else if (p) {
        setScope(p.space_id ? { kind: "space", spaceId: p.space_id } : { kind: "sources", ids: p.source_ids });
      }
      select(out.run_id, "steps");
    } catch (e: any) {
      setAskError(errorText(e, "Couldn't ask that. Please try again."));
    } finally {
      setAsking(false);
    }
  };

  const suggest = (q: string) => {
    setFollowUp(q);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  if (notFound) {
    return (
      <div className="dash-shell flex min-h-screen">
        <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
        <div className="flex-1 grid place-items-center p-8 text-center">
          <div>
            <div className="text-section font-semibold text-text">This analysis wasn't found</div>
            <p className="text-ui text-muted mt-1">It may have been deleted, or it isn't shared with you.</p>
            <Link to="/?intent=guided" className="btn-primary text-sm mt-4 inline-flex">Start a Guided Analysis</Link>
          </div>
        </div>
      </div>
    );
  }

  const title = project?.title || run?.plan?.title || run?.question || "Guided Analysis";
  const sources = project?.sources || [];
  const runPlaced = run ? placedRuns.has(run.id) : false;
  const canCreate = canEdit && answered.length > 0;
  const headerCreate = () => {
    if (!run || !isAnswered(run)) {
      openCreate(answered[answered.length - 1]?.id);
      return;
    }
    if (primary && !runPlaced) setAddDialogOpen(true);
    else openCreate(run.id);
  };

  return (
    <ChartThemeProvider localScope={`guided:${projectId}`}>
      {project && (
        <>
          <CreateFromThreadDialog
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            projectId={projectId}
            project={project}
            answered={answered}
            numberOf={numberOf}
            focusRunId={createFocus}
            startLayout={createLayout}
          />
          <AddToDashboardDialog
            open={addDialogOpen}
            onClose={() => setAddDialogOpen(false)}
            project={project}
            run={run}
            dashboard={primary}
            flow={flow}
            numberOf={numberOf}
            onNew={() => openCreate(run?.id, "latest")}
          />
        </>
      )}
      <PlacementToast flow={flow} />
      <div className="dash-shell flex min-h-screen">
        <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
        <div className="flex-1 min-w-0 flex flex-col lg:h-screen">
          <header className="flex flex-wrap justify-between items-center gap-4 pl-14 pr-4 sm:pr-7 lg:pl-7 py-4 border-b border-border bg-base" data-guided-header="">
            <div className="flex flex-col gap-2 min-w-0 flex-[1_1_420px]">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
                <Link to="/library?type=analysis" className="hover:text-text">Library</Link> / Guided Analysis
                {ordered.length > 1 ? ` · ${ordered.length} questions` : ""}
              </span>
              <div className="flex items-center gap-2.5 flex-wrap min-w-0">
                <KindPill kind="analysis">Guided</KindPill>
                <h1 className="m-0 text-[21px] sm:text-[22px] font-semibold tracking-[-0.01em] text-text truncate max-w-full">{title}</h1>
              </div>
              {sources.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap text-caption text-muted" data-guided-sources="">
                  Working on
                  {sources.slice(0, 3).map((s) => (
                    <span key={s.id} className="inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-full border border-border-strong text-ui text-text max-w-[260px]">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.mode === "live" ? "bg-good" : "bg-kind-analysis"}`} aria-hidden="true" />
                      <span className="truncate">{s.name}</span>
                      <span className="text-caption text-muted shrink-0">{s.label}</span>
                    </span>
                  ))}
                  {sources.length > 3 && <span className="text-caption text-muted">+{sources.length - 3} more</span>}
                  {project?.space_name && <span className="text-caption text-muted">· in {project.space_name}</span>}
                </div>
              )}
            </div>
            <div className="flex gap-2 flex-wrap items-center">
              <button
                type="button"
                className="btn-secondary text-sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(window.location.href);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1600);
                  } catch {
                    setCopied(false);
                  }
                }}
                title="Copy a link to this analysis - anyone in your workspace who can see its sources can open it"
              >
                {copied ? "Link copied" : "Share"}
              </button>
              {latestDash && (
                <Link to={dashboardHref(latestDash)} className="btn-secondary text-sm inline-flex items-center gap-1.5" data-open-dashboard="">
                  <GridIcon size={14} className="text-kind-dashboard" /> Open dashboard
                </Link>
              )}
              <button
                type="button"
                className="ui-focus inline-flex items-center gap-2 h-10 px-4 rounded-ctl border border-kind-dashboard-border bg-kind-dashboard-fill text-kind-dashboard text-sm font-semibold disabled:opacity-45 disabled:cursor-not-allowed"
                disabled={!canCreate}
                onClick={headerCreate}
                title={canCreate ? "Build a live dashboard from this analysis" : "Write an answer first - the dashboard is built from it"}
                data-guided-create-dashboard=""
              >
                <GridIcon size={15} /> {primary && run && isAnswered(run) && !runPlaced ? "Add to dashboard" : "Create dashboard"}
              </button>
            </div>
          </header>

          <div className="flex-1 flex flex-wrap lg:flex-nowrap min-h-0">
            <section aria-label="Conversation" className="flex-[1_1_360px] max-w-full lg:max-w-[420px] lg:h-full border-r border-border bg-[rgb(var(--color-base))] flex flex-col min-h-[60vh] lg:min-h-0" data-guided-conversation="">
              <div ref={threadPane} className="flex-1 overflow-auto px-5 py-6 flex flex-col gap-7">
                {!project && <div className="text-ui text-muted">Loading…</div>}
                {ordered.map((r, i) => {
                  const isLast = i === ordered.length - 1;
                  return (
                    <div key={r.id} className="flex flex-col gap-3.5">
                      <Turn
                        run={r}
                        number={i + 1}
                        selected={run?.id === r.id}
                        onSelect={() => select(r.id)}
                        onOpenAnswer={() => select(r.id, "answer")}
                        onJump={(stepId) => jumpTo(r.id, stepId)}
                        onRetry={() => suggest(r.question)}
                        reusedFrom={(r.steps || []).filter((s) => s.reused).map((s) => s.reused!.question)}
                      />
                      {prompt && prompt.run.id === r.id && project && prompt.kind === "add" && (
                        <AddToDashboardCard project={project} run={r} dashboard={prompt.dashboard} flow={flow} onNew={() => openCreate(r.id, "latest")} />
                      )}
                      {prompt && prompt.run.id === r.id && prompt.kind === "combine" && (
                        <CombineNudgeCard count={prompt.runs.length} onSetup={() => openCreate(r.id, "pages")} onDismiss={() => flow.dismiss(prompt.runs.map((x) => x.id))} />
                      )}
                      {isLast && canEdit && isAnswered(r) && (r.result?.answer?.next_questions || []).length > 0 && (
                        <div className="flex flex-col gap-2" data-ask-next="">
                          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Ask next</span>
                          {(r.result?.answer?.next_questions || []).slice(0, 3).map((q) => (
                            <button
                              key={q}
                              type="button"
                              onClick={() => suggest(q)}
                              className={`ui-focus text-left px-3.5 py-2.5 rounded-[12px] border text-ui leading-snug transition-colors ${
                                followUp === q ? "border-kind-analysis-border bg-kind-analysis-fill/50 text-text" : "border-border bg-surface text-secondary hover:text-text hover:border-border-strong"
                              }`}
                            >
                              {q}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {canEdit && (
                <ThreadComposer
                  value={followUp}
                  onChange={setFollowUp}
                  onSubmit={ask}
                  inputRef={composerRef}
                  busy={asking}
                  locked={threadBusy}
                  mode={mode}
                  onMode={setMode}
                  error={askError}
                  placeholder={ordered.length ? "Ask a follow-up…" : "Ask a question…"}
                  picker={
                    scope && (
                      <ScopePicker scope={scope} onChange={setScope} sources={allSources} spaces={spaces} variant="compact" placement="above" disabled={asking} />
                    )
                  }
                  context={
                    answered.length > 0 && followUp.trim().length > 0 ? (
                      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-[10px] bg-kind-analysis-fill/60 text-[12px] leading-snug text-kind-analysis" data-continue-strip="">
                        <ContinueIcon size={13} />
                        <span className="flex-1 min-w-0">
                          Continues this analysis · {mode === "guided" ? "step by step, reusing the steps that already ran" : "runs every step and writes the answer"}
                        </span>
                        <Link to="/?intent=guided" className="text-muted hover:text-text shrink-0">New analysis</Link>
                      </div>
                    ) : null
                  }
                />
              )}
            </section>

            <section aria-label="Work" className="flex-[999_1_560px] min-w-0 flex flex-col lg:h-full lg:overflow-auto" data-guided-work="">
              <div className="sticky top-0 z-10 shrink-0 bg-base/95 backdrop-blur border-b border-border px-5 sm:px-7 flex items-center gap-4 min-h-[56px] flex-wrap py-2">
                {ordered.length > 1 && (
                  <div role="tablist" aria-label="Questions in this thread" className="flex items-center gap-1 p-[3px] rounded-[12px] border border-border bg-surface max-w-full overflow-x-auto" data-question-switcher="">
                    {ordered.map((r, i) => {
                      const on = run?.id === r.id;
                      const done = isAnswered(r);
                      return (
                        <button
                          key={r.id}
                          type="button"
                          role="tab"
                          aria-selected={on}
                          onClick={() => select(r.id)}
                          title={r.question}
                          className={`ui-focus h-8 px-3 rounded-[9px] inline-flex items-center gap-2 text-ui whitespace-nowrap transition-colors ${on ? "bg-subtle text-text font-semibold" : "text-muted hover:text-text"}`}
                        >
                          <span className={`font-mono text-[11px] ${on ? "text-kind-analysis" : "text-faint"}`}>Q{i + 1}</span>
                          <span className="max-w-[160px] truncate">{shortTitle(r)}</span>
                          {done ? <CheckIcon size={11} className="text-kind-answer" /> : isWorking(r) ? <Spinner className="text-kind-analysis !w-3 !h-3" /> : null}
                        </button>
                      );
                    })}
                  </div>
                )}
                <span className="flex-1" />
                {run && (
                  <div role="tablist" aria-label="This question" className="flex items-center gap-5 text-[14px]">
                    {(["answer", "steps", "evidence"] as View[]).map((v) => {
                      const has = v === "steps" || (v === "answer" ? Boolean(run.result?.answer) && run.status !== "needs_input" : (run.result?.evidence || []).length > 0);
                      if (!has) return null;
                      const on = currentView === v;
                      return (
                        <button
                          key={v}
                          type="button"
                          role="tab"
                          aria-selected={on}
                          onClick={() => setView(v)}
                          className={`h-10 border-b-2 -mb-[9px] pb-2 transition-colors ${on ? "text-text border-[rgb(var(--color-kind-analysis))]" : "text-muted border-transparent hover:text-text"}`}
                        >
                          {v === "answer" ? "Answer" : v === "steps" ? `Steps · ${steps.length || "…"}` : `Evidence · ${(run.result?.evidence || []).length}`}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {error && (
                <div role="alert" className="mx-5 sm:mx-7 mt-4 rounded-card border border-danger-border bg-danger-fill px-4 py-3 text-ui text-danger flex justify-between gap-3">
                  <span>{error}</span>
                  <button type="button" className="text-caption underline" onClick={() => setError("")}>Dismiss</button>
                </div>
              )}

              <div className="shrink-0 px-5 sm:px-7 pt-6 pb-16 max-w-[1120px] w-full flex flex-col gap-3" data-guided-steps="">
                {!run && project && <div className="text-ui text-muted">Ask a question to start.</div>}
                {run && currentView === "answer" && (
                  <AnswerView
                    run={run}
                    number={numberOf(run.id)}
                    canEdit={canEdit}
                    placed={runPlaced}
                    onCreate={() => (primary && !runPlaced ? setAddDialogOpen(true) : openCreate(run.id))}
                    onSteps={() => setView("steps")}
                  />
                )}
                {run && currentView === "evidence" && <EvidenceTab run={run} />}
                {run && currentView === "steps" && (
                  <>
                    {(run.status === "planning" || !run.steps) && <PlanningCard question={run.question} />}
                    {run.status === "failed" && !steps.length && (
                      <div className="rounded-card border border-danger-border bg-danger-fill p-5">
                        <div className="text-section font-semibold text-text">GD360 couldn't plan this question</div>
                        <p className="m-0 mt-1.5 text-ui text-secondary">{run.error || "Something went wrong."}</p>
                        {canEdit && <button type="button" className="btn-secondary text-sm mt-4" onClick={() => suggest(run.question)}>Ask it again</button>}
                      </div>
                    )}
                    {run.status === "needs_input" && run.result?.answer && (
                      <div className="rounded-card border border-warning-border bg-warning-fill p-5">
                        <div className="text-section font-semibold text-text">{run.result.answer.headline}</div>
                        <p className="m-0 mt-1.5 text-ui text-secondary">{run.result.answer.answer}</p>
                      </div>
                    )}
                    {(run.plan?.assumptions || []).length > 0 && steps.length > 0 && (
                      <details className="rounded-card border border-border bg-surface px-4 py-3 text-ui text-secondary">
                        <summary className="cursor-pointer text-muted">How GD360 read this question · {run.plan!.assumptions.length} assumption{run.plan!.assumptions.length === 1 ? "" : "s"}</summary>
                        <ul className="m-0 mt-2 pl-5 flex flex-col gap-1">
                          {run.plan!.assumptions.map((a, i) => <li key={i}>{a}</li>)}
                        </ul>
                      </details>
                    )}
                    {steps.map((s, i) => (
                      <StepCard
                        key={s.id}
                        refEl={(el) => { stepRefs.current[s.id] = el; }}
                        run={run}
                        step={s}
                        number={i + 1}
                        isCurrent={s.id === current}
                        answered={isAnswered(run)}
                        expanded={s.id === current || open.has(s.id)}
                        onToggle={() => toggle(s.id)}
                        canEdit={canEdit}
                        locked={runWorking || pending !== null}
                        pending={pending}
                        act={act}
                      />
                    ))}
                    {canEdit && steps.length > 0 && (
                      <AddStep
                        open={addOpen}
                        setOpen={setAddOpen}
                        disabled={runWorking || pending !== null}
                        busy={pending === "add"}
                        onAdd={async (text) => {
                          const next = await act("add", () => guidedApi.add(run.id, text));
                          if (next) setAddOpen(false);
                        }}
                      />
                    )}
                    {steps.length > 0 && (
                      <AnswerBar
                        run={run}
                        canEdit={canEdit}
                        disabled={runWorking || pending !== null}
                        onWrite={() => act("finish", () => guidedApi.finish(run.id))}
                        onRest={() => act("rest", () => guidedApi.runRest(run.id))}
                        onOpen={() => setView("answer")}
                      />
                    )}
                  </>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </ChartThemeProvider>
  );
}

// ---- the conversation ------------------------------------------------------------

function Turn({
  run, number, selected, onSelect, onOpenAnswer, onJump, onRetry, reusedFrom,
}: {
  run: ProjectRun; number: number; selected: boolean; onSelect: () => void; onOpenAnswer: () => void;
  onJump: (stepId: string) => void; onRetry: () => void; reusedFrom: number[];
}) {
  const steps = run.steps || [];
  const ans = run.result?.answer;
  const stale = Boolean(run.result?.answer_stale);
  const approved = steps.filter((s) => s.approved).length;
  const current = currentStepId(steps);
  const currentNo = current ? steps.findIndex((s) => s.id === current) + 1 : steps.length;
  const pct = steps.length ? Math.round((approved / steps.length) * 100) : 0;
  const working = isWorking(run);
  const writing = run.status === "running";
  const done = run.status === "done" && Boolean(ans);
  const reused = Array.from(new Set(reusedFrom)).sort((a, b) => a - b);
  return (
    <div className="flex flex-col gap-3" data-turn={number}>
      <div className="self-end max-w-[88%] flex flex-col items-end gap-1">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-faint inline-flex items-center gap-1.5">
          Q{number}
          {run.auto_run ? <><BoltIcon size={10} /> Quick</> : <><StepsIcon size={10} /> Guided</>}
        </span>
        <div className="bg-surface2 rounded-[16px_16px_4px_16px] px-4 py-3 text-[15px] leading-[22px] text-text">{run.question}</div>
      </div>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
        className={`rounded-[16px] p-3.5 -mx-1 flex flex-col gap-3 cursor-pointer border transition-colors ${selected ? "border-border-strong bg-surface" : "border-transparent hover:bg-surface/60"}`}
        aria-current={selected ? "true" : undefined}
      >
        <div className="flex items-center gap-2 text-caption text-muted">
          <GdMark />
          <span className="text-ui font-semibold text-text">GD360</span>
          <span className="truncate">
            {run.status === "planning" && "· writing the plan"}
            {run.status === "planned" && steps.length > 0 && (working ? "· working" : `· step ${Math.max(1, currentNo)} of ${steps.length}`)}
            {writing && "· writing the answer"}
            {done && `· ${timeAgo(run.finished_at)}${run.duration_seconds ? ` · ${Math.max(1, Math.round(run.duration_seconds))} s` : ""}`}
          </span>
        </div>

        {run.status === "planning" && (
          <div className="flex items-center gap-2.5 text-ui text-secondary">
            <Spinner className="text-kind-analysis" /> Reading your sources and splitting the question into steps…
          </div>
        )}

        {(run.status === "planned" || writing || (run.status === "done" && stale)) && steps.length > 0 && (
          <div className="rounded-[14px] border border-border bg-base p-3.5 flex flex-col gap-2.5" data-plan-card="">
            <div className="flex justify-between items-baseline">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">The plan</span>
              <span className="text-caption text-muted">{run.auto_run ? (writing || working ? "running every step" : "") : `${approved} of ${steps.length} approved`}</span>
            </div>
            <div className="h-[3px] rounded-full bg-border overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Steps approved">
              <div className="h-full bg-kind-analysis transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
            <ol className="list-none m-0 p-0 flex flex-col gap-0.5">
              {steps.map((s, i) => {
                const active = s.id === current;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onJump(s.id); }}
                      className={`ui-focus w-full flex items-center gap-2.5 px-1.5 py-1.5 rounded-[8px] text-left text-ui hover:bg-surface ${active ? "text-text font-medium" : s.approved || s.status === "done" ? "text-secondary" : "text-faint"}`}
                    >
                      <StepDot step={s} number={i + 1} active={active} />
                      <span className="min-w-0 flex-1 truncate">{s.title}</span>
                      {s.reused ? (
                        <span className="text-[11px] text-kind-analysis shrink-0">reused · Q{s.reused.question}</span>
                      ) : active && s.status === "done" && !s.approved ? (
                        <span className="text-[11px] text-kind-analysis shrink-0">your check</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {writing && (
          <div className="flex items-center gap-2.5 text-ui text-secondary">
            <Spinner className="text-kind-answer" /> Writing the answer from {steps.filter((s) => s.status === "done").length} steps…
          </div>
        )}

        {done && ans && (
          <>
            {stale && <span className="self-start h-6 px-2.5 rounded-full bg-warning-fill text-warning text-[12px] inline-flex items-center">A step changed - rewrite the answer</span>}
            <p className="m-0 text-[15px] leading-[23px] text-text font-medium">{ans.headline}</p>
            {ans.answer && ans.answer !== ans.headline && <p className="m-0 text-ui text-secondary leading-relaxed line-clamp-4">{ans.answer}</p>}
            <div className="flex items-center gap-2 flex-wrap text-caption text-muted">
              <span>{steps.length} step{steps.length === 1 ? "" : "s"}</span>
              {reused.length > 0 && <span>· built on {reused.map((n) => `Q${n}`).join(", ")}</span>}
              {(run.result?.sources_used || []).slice(0, 2).map((s) => (
                <span key={s} className="inline-flex items-center h-[22px] px-2 rounded-md bg-subtle text-secondary">{s}</span>
              ))}
            </div>
            <button type="button" onClick={(e) => { e.stopPropagation(); onOpenAnswer(); }} className="ui-focus self-start text-ui font-medium text-kind-answer hover:underline">
              View the answer →
            </button>
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
            <button type="button" className="btn-secondary text-sm self-start" onClick={(e) => { e.stopPropagation(); onRetry(); }}>Ask again</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- the answer, in the same format as an Instant Answer ---------------------------

function AnswerView({
  run, number, canEdit, placed, onCreate, onSteps,
}: {
  run: ProjectRun; number: number; canEdit: boolean; placed: boolean; onCreate: () => void; onSteps: () => void;
}) {
  const ans = run.result?.answer;
  if (!ans) return null;
  const stale = Boolean(run.result?.answer_stale);
  const reused = Array.from(new Set((run.steps || []).filter((s) => s.reused).map((s) => s.reused!.question)));
  return (
    <section className="flex flex-col gap-5" data-guided-answer="">
      <div className="flex justify-between items-start gap-4 flex-wrap">
        <div className="flex flex-col gap-2 min-w-0 flex-[1_1_480px]">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-kind-answer">Q{number} · The answer</span>
          <h2 className="m-0 text-[24px] sm:text-[27px] leading-[1.25] font-semibold tracking-[-0.015em] text-text text-balance max-w-[820px]">{ans.headline}</h2>
          {ans.answer && ans.answer !== ans.headline && <p className="m-0 text-body text-secondary leading-relaxed max-w-[75ch]">{ans.answer}</p>}
          {reused.length > 0 && (
            <span className="inline-flex items-center gap-1.5 text-caption text-muted">
              <ContinueIcon size={12} /> Built on {reused.map((n) => `Q${n}`).join(", ")} - steps that already ran were reused, not queried again.
            </span>
          )}
        </div>
        {canEdit && !stale && (
          <button
            type="button"
            onClick={onCreate}
            className="ui-focus inline-flex items-center gap-2 h-10 px-4 rounded-ctl border border-kind-dashboard-border bg-kind-dashboard-fill text-kind-dashboard text-sm font-semibold shrink-0"
          >
            <GridIcon size={15} /> {placed ? "Add to another dashboard" : "Put on a dashboard"}
          </button>
        )}
      </div>
      {stale && (
        <div className="rounded-ctl border border-warning-border bg-warning-fill px-4 py-3 text-ui text-warning flex items-center justify-between gap-3 flex-wrap">
          A step changed after this answer was written.
          <button type="button" className="text-ui underline" onClick={onSteps}>Go to the steps</button>
        </div>
      )}
      <ResultsTab run={{ ...run, status: "done" }} />
    </section>
  );
}

function AnswerBar({
  run, canEdit, disabled, onWrite, onRest, onOpen,
}: {
  run: ProjectRun; canEdit: boolean; disabled: boolean; onWrite: () => void; onRest: () => void; onOpen: () => void;
}) {
  const steps = run.steps || [];
  const doneCount = steps.filter((s) => s.status === "done").length;
  const waiting = steps.filter((s) => s.status !== "done").length;
  const stale = Boolean(run.result?.answer_stale);
  const has = run.status === "done" && Boolean(run.result?.answer) && !stale;
  const writing = run.status === "running";
  return (
    <section className={`mt-2 rounded-[16px] border p-4 sm:p-5 flex items-center justify-between gap-4 flex-wrap ${has ? "border-kind-answer-border bg-surface" : "border-dashed border-border-strong"}`} data-answer-bar="">
      <div className="flex flex-col gap-1 min-w-0 flex-[1_1_320px]">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-kind-answer">The answer</span>
        <span className="text-ui text-secondary">
          {has
            ? run.result!.answer!.headline
            : writing
              ? "Writing the answer from your steps…"
              : stale
                ? "A step changed after the answer was written - rewrite it to include the change."
                : "Written from the steps that ran - the same checked numbers as an Instant Answer."}
        </span>
      </div>
      <div className="flex gap-2 flex-wrap">
        {has && <button type="button" className="btn-secondary text-sm" onClick={onOpen}>View the answer</button>}
        {canEdit && !has && waiting > 0 && (
          <button type="button" className="btn-secondary text-sm" disabled={disabled} onClick={onRest} data-run-rest="" title="Run every step that hasn't run yet, then write the answer">
            Run the rest
          </button>
        )}
        {canEdit && !has && (
          <button type="button" className="btn-primary text-sm" disabled={disabled || doneCount === 0} onClick={onWrite} data-write-answer="">
            {writing ? "Writing…" : stale ? "Rewrite the answer" : "Write the answer"}
          </button>
        )}
      </div>
    </section>
  );
}

// ---- the plan's steps ------------------------------------------------------------

function StepDot({ step, number, active }: { step: RunStep; number: number; active: boolean }) {
  if (step.status === "running") return <span className="w-5 h-5 rounded-full border-2 border-kind-analysis/40 border-t-kind-analysis animate-spin shrink-0" aria-label="Running" />;
  if (step.approved) {
    return (
      <span className="w-5 h-5 rounded-full bg-kind-answer text-[rgb(var(--color-base))] grid place-items-center shrink-0" aria-label="Approved">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
      </span>
    );
  }
  const tone =
    step.status === "failed" ? "border-danger text-danger" :
    step.status === "stale" ? "border-warning text-warning" :
    step.status === "done" || active ? "border-kind-analysis text-kind-analysis" : "border-border-strong text-muted";
  return <span className={`w-5 h-5 rounded-full border-2 grid place-items-center text-[10.5px] font-semibold shrink-0 ${tone}`}>{number}</span>;
}

function PlanningCard({ question }: { question: string }) {
  return (
    <section className="rounded-card border border-kind-analysis-border bg-surface p-6 flex flex-col gap-3" aria-busy="true" data-guided-planning="">
      <div className="flex items-center gap-3">
        <span className="w-5 h-5 rounded-full border-2 border-kind-analysis/40 border-t-kind-analysis animate-spin" aria-hidden="true" />
        <span className="text-section font-semibold text-text">Writing the plan</span>
      </div>
      {question && <p className="m-0 text-ui text-secondary">“{question}”</p>}
      <p className="m-0 text-caption text-muted">GD360 reads your sources, splits the question into steps you can check, and runs the first one. You decide every step after that.</p>
    </section>
  );
}

// ---- one step --------------------------------------------------------------------

const STATUS_PILL: Record<string, { text: string; cls: string }> = {
  approved: { text: "Approved", cls: "bg-kind-answer-fill text-kind-answer" },
  done: { text: "Waiting for you", cls: "bg-kind-analysis-fill text-kind-analysis" },
  running: { text: "Running…", cls: "bg-kind-analysis-fill text-kind-analysis" },
  failed: { text: "Didn't run", cls: "bg-danger-fill text-danger" },
  stale: { text: "Out of date", cls: "bg-warning-fill text-warning" },
  pending: { text: "Not run yet", cls: "bg-subtle text-muted" },
  skipped: { text: "Skipped", cls: "bg-subtle text-muted" },
};

function StepCard({
  refEl, run, step, number, isCurrent, answered = false, expanded, onToggle, canEdit, locked, pending, act,
}: {
  refEl: (el: HTMLElement | null) => void;
  run: ProjectRun;
  step: RunStep;
  number: number;
  isCurrent: boolean;
  // the question is answered: a step that ran is part of the answer
  answered?: boolean;
  expanded: boolean;
  onToggle: () => void;
  canEdit: boolean;
  locked: boolean;
  pending: string | null;
  act: (label: string, fn: () => Promise<ProjectRun>) => Promise<ProjectRun | null>;
}) {
  const steps = run.steps || [];
  const pill = step.reused && step.status === "done"
    ? { text: `Reused · Q${step.reused.question}`, cls: "bg-kind-analysis-fill text-kind-analysis" }
    : answered && step.status === "done" && !step.approved
      ? { text: "In the answer", cls: "bg-kind-answer-fill text-kind-answer" }
      : STATUS_PILL[step.approved ? "approved" : step.status] || STATUS_PILL.pending;
  const sentence = step.purpose || step.title;
  const [text, setText] = useState(sentence);
  const [sqlOpen, setSqlOpen] = useState(false);
  const [sqlEdit, setSqlEdit] = useState(false);
  const [sql, setSql] = useState(step.sql);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => setText(step.purpose || step.title), [step.purpose, step.title]);
  useEffect(() => { if (!sqlEdit) setSql(step.sql); }, [step.sql, sqlEdit]);

  const idx = steps.findIndex((s) => s.id === step.id);
  const later = steps.slice(idx + 1).find((s) => !s.approved && (s.status === "pending" || s.status === "stale"));
  const laterNo = later ? steps.findIndex((s) => s.id === later.id) + 1 : null;
  const othersApproved = steps.every((s) => s.id === step.id || s.approved || s.status !== "done");
  const approveLabel = laterNo ? `Approve · run step ${laterNo}` : othersApproved ? "Approve · write the answer" : "Approve";
  const changed = text.trim() !== sentence.trim() && text.trim().length >= 4;
  const where = step.kind === "combine" ? "Combined from earlier steps" : step.source_name || "Source";
  // 2026-10-11: a result taken from an earlier question says so - no query ran
  const meta = step.status === "done"
    ? [
        where,
        step.rows_returned != null ? `${step.rows_returned.toLocaleString("en-US")} row${step.rows_returned === 1 ? "" : "s"}` : null,
        step.reused ? `reused from Q${step.reused.question} · step ${step.reused.step}, no new query` : step.duration_ms != null ? `ran in ${ms(step.duration_ms)}` : null,
      ].filter(Boolean).join(" · ")
    : where;
  const busy = (label: string) => pending === `${label}:${step.id}`;
  const revise = (instruction: string) => act(`revise:${step.id}`, () => guidedApi.revise(run.id, step.id, instruction));

  // Approved (or simply not open): one quiet line.
  if (!expanded) {
    const ran = step.status === "done";
    return (
      <section ref={refEl} data-step={step.id} data-step-status={step.approved ? "approved" : step.status}
        className={`rounded-card border ${ran || step.approved ? "border-border bg-surface" : "border-dashed border-border-strong"} scroll-mt-4`}>
        <button type="button" onClick={onToggle} className="ui-focus w-full flex justify-between items-center gap-3 flex-wrap px-4 sm:px-5 py-3.5 text-left" aria-expanded={false}>
          <span className="flex gap-3 items-center min-w-0">
            <span className="font-mono text-caption text-muted w-6 shrink-0">{String(number).padStart(2, "0")}</span>
            <span className="flex flex-col gap-0.5 min-w-0">
              <span className={`text-ui font-semibold ${ran || step.approved ? "text-text" : "text-secondary"} truncate`}>{step.title}</span>
              <span className="text-caption text-muted truncate">
                {ran ? meta : step.status === "pending" ? (later && later.id === step.id ? "Runs when you approve the step before" : `${where} · not run yet`) : step.error || meta}
              </span>
            </span>
          </span>
          <span className={`h-6 px-2.5 rounded-full text-[12px] inline-flex items-center shrink-0 ${pill.cls}`}>{pill.text}</span>
        </button>
      </section>
    );
  }

  return (
    <section
      ref={refEl}
      data-step={step.id}
      data-step-status={step.approved ? "approved" : step.status}
      data-step-current={isCurrent ? "" : undefined}
      className={`rounded-[16px] border bg-surface p-4 sm:p-5 flex flex-col gap-4 scroll-mt-4 ${
        isCurrent ? "border-kind-analysis-border shadow-[0_0_0_4px_rgb(var(--color-kind-analysis)/0.07)]" : "border-border"
      }`}
    >
      <div className="flex justify-between items-start gap-3 flex-wrap">
        <button type="button" onClick={onToggle} className="ui-focus flex gap-3 items-start text-left min-w-0" aria-expanded={true} title="Collapse">
          <span className={`font-mono text-caption pt-1 w-6 shrink-0 ${isCurrent ? "text-kind-analysis" : "text-muted"}`}>{String(number).padStart(2, "0")}</span>
          <span className="flex flex-col gap-1 min-w-0">
            <span className="text-[17px] font-semibold text-text leading-snug">{step.title}</span>
            <span className="text-caption text-muted">{meta}{step.repaired ? " · GD360 fixed the query once" : ""}</span>
          </span>
        </button>
        <span className={`h-6 px-2.5 rounded-full text-[12px] inline-flex items-center shrink-0 ${pill.cls}`}>{pill.text}</span>
      </div>

      {canEdit ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={`step-text-${step.id}`} className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">What this step does</label>
          <textarea
            id={`step-text-${step.id}`}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && changed && !locked) {
                e.preventDefault();
                revise(`Change this step so it does this: ${text.trim()}`);
              }
            }}
            disabled={locked}
            className="w-full resize-y rounded-ctl border border-border-strong bg-base text-text text-[15px] leading-relaxed px-3.5 py-2.5 outline-none focus:border-kind-analysis disabled:opacity-60"
            data-step-text=""
          />
          <div className="flex items-center gap-2 flex-wrap">
            {changed && (
              <button type="button" className="btn-primary text-sm" disabled={locked} onClick={() => revise(`Change this step so it does this: ${text.trim()}`)} data-step-update="">
                {busy("revise") ? "Updating…" : "Update and re-run"}
              </button>
            )}
            {changed && <button type="button" className="text-caption text-muted hover:text-text" onClick={() => setText(sentence)}>Undo</button>}
            {!changed && (step.tweaks || []).length > 0 && <span className="text-caption text-muted">Quick changes</span>}
            {!changed && (step.tweaks || []).map((t) => (
              <button key={t} type="button" disabled={locked} onClick={() => revise(t)} className="ui-focus h-7 px-2.5 rounded-full border border-border bg-base text-caption text-secondary hover:text-text hover:border-border-strong disabled:opacity-50" data-step-tweak="">
                {t}
              </button>
            ))}
            {busy("revise") && <span className="text-caption text-muted">GD360 is rewriting this step…</span>}
          </div>
          {(step.edits || []).length > 0 && (
            <span className="text-caption text-muted">Changed by you: {(step.edits || []).slice(-2).join(" · ")}</span>
          )}
        </div>
      ) : (
        <p className="m-0 text-ui text-secondary">{sentence}</p>
      )}

      {step.status === "running" && (
        <div className="rounded-ctl border border-border bg-base px-4 py-6 flex items-center gap-3 text-ui text-secondary" aria-busy="true">
          <span className="w-4 h-4 rounded-full border-2 border-kind-analysis/40 border-t-kind-analysis animate-spin" aria-hidden="true" />
          Running on {where}…
        </div>
      )}
      {step.status === "failed" && (
        <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-4 py-3 flex flex-col gap-2">
          <span className="text-ui text-danger">{step.error || "This step didn't run."}</span>
          {canEdit && (
            <span className="flex gap-2 flex-wrap">
              <button type="button" className="btn-secondary text-sm" disabled={locked} onClick={() => revise(`It failed with this error - fix it: ${step.error || "unknown error"}`)} data-step-fix="">
                Fix it for me
              </button>
              <button type="button" className="text-ui text-secondary hover:text-text px-2" onClick={() => { setSqlOpen(true); setSqlEdit(true); }}>Edit the SQL</button>
            </span>
          )}
        </div>
      )}
      {step.status === "stale" && (
        <div className="rounded-ctl border border-warning-border bg-warning-fill px-4 py-3 text-ui text-warning">
          A step this one builds on changed. Re-run it to bring the result up to date.
        </div>
      )}
      {step.status === "pending" && (
        <div className="rounded-ctl border border-dashed border-border-strong px-4 py-4 text-ui text-muted">
          Not run yet. Change it above if you like, then run it.
        </div>
      )}
      {step.status === "done" && step.columns && step.preview && <StepResult run={run} step={step} />}

      <details open={sqlOpen} onToggle={(e) => setSqlOpen((e.target as HTMLDetailsElement).open)} className="rounded-ctl border border-border bg-base">
        <summary className="cursor-pointer px-3.5 py-2.5 text-caption text-secondary">How it's computed · {step.kind === "combine" ? "DuckDB" : (step.dialect || "SQL")}</summary>
        {sqlEdit ? (
          <div className="px-3.5 pb-3.5 flex flex-col gap-2">
            <label htmlFor={`step-sql-${step.id}`} className="sr-only">SQL</label>
            <textarea
              id={`step-sql-${step.id}`}
              rows={8}
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              spellCheck={false}
              className="w-full rounded-ctl border border-border-strong bg-surface text-text font-mono text-[12.5px] leading-relaxed p-3 outline-none focus:border-kind-analysis"
            />
            <span className="flex gap-2">
              <button type="button" className="btn-primary text-sm" disabled={locked || sql.trim().length < 6}
                onClick={async () => { const r = await act(`sql:${step.id}`, () => guidedApi.setSql(run.id, step.id, sql)); if (r) setSqlEdit(false); }}>
                Save and run
              </button>
              <button type="button" className="btn-secondary text-sm" onClick={() => { setSqlEdit(false); setSql(step.sql); }}>Cancel</button>
            </span>
          </div>
        ) : (
          <pre className="m-0 px-3.5 pb-3.5 font-mono text-[12.5px] leading-relaxed text-secondary whitespace-pre-wrap break-words">{layoutSql(step.sql)}</pre>
        )}
      </details>

      {canEdit && (
        <div className="flex justify-between items-center gap-3 flex-wrap pt-1">
          <span className="flex gap-1 items-center">
            {confirmRemove ? (
              <>
                <button type="button" className="text-ui text-danger hover:underline px-2" disabled={locked}
                  onClick={() => act(`remove:${step.id}`, () => guidedApi.remove(run.id, step.id))}>Remove this step</button>
                <button type="button" className="text-ui text-muted hover:text-text px-2" onClick={() => setConfirmRemove(false)}>Keep it</button>
              </>
            ) : (
              <button type="button" className="text-ui text-muted hover:text-text px-2" onClick={() => setConfirmRemove(true)} disabled={locked}>Remove</button>
            )}
            {!sqlEdit && (
              <button type="button" className="text-ui text-muted hover:text-text px-2" onClick={() => { setSqlOpen(true); setSqlEdit(true); }} disabled={locked}>Edit SQL</button>
            )}
          </span>
          <span className="flex gap-2 flex-wrap">
            {step.status !== "running" && (
              <button type="button" className="btn-secondary text-sm" disabled={locked} onClick={() => act(`run:${step.id}`, () => guidedApi.runStep(run.id, step.id))} data-step-run="">
                {step.status === "pending" ? "Run this step" : "Re-run"}
              </button>
            )}
            {step.status === "done" && !step.approved && (
              <button type="button" className="btn-primary text-sm" disabled={locked} onClick={() => act(`approve:${step.id}`, () => guidedApi.approve(run.id, step.id))} data-step-approve="">
                {approveLabel}
              </button>
            )}
          </span>
        </div>
      )}
    </section>
  );
}

function StepResult({ run, step }: { run: ProjectRun; step: RunStep }) {
  const theme = useChartTheme();
  const rows = step.preview || [];
  // A year, a week number or an id is a label, not a quantity: shown as written.
  const columns = useMemo(
    () => (step.columns || []).map((c) => (c.dtype === "number" && c.role === "dimension" ? { ...c, dtype: "string", format: undefined } : c)),
    [step.columns],
  );
  const truncated = Boolean(step.rows_returned && step.rows_returned > rows.length);
  const visual = useMemo(() => ({ type: "chart" as const, title: step.title, columns, rows, truncated: false }), [step.title, columns, rows]);
  // Drawn only when the shared chart engine would draw it - never a second table.
  const resolved = useMemo(
    () => (rows.length > 1 ? resolveWorkspaceChart({ columns: step.columns as any, rows: rows as any, truncated, chartType: null, title: step.title, id: `${run.id}:${step.id}`, theme }) : null),
    [step.columns, rows, truncated, step.title, run.id, step.id, theme],
  );
  const chart = resolved && resolved.path !== "table" ? resolved : null;
  return (
    <div className="flex flex-wrap gap-4" data-step-result="">
      <div className={`${chart ? "flex-[1_1_340px]" : "flex-1"} min-w-0 rounded-ctl border border-border max-h-[360px] overflow-auto`}>
        <DataTable visual={visual} />
      </div>
      {chart && (
        <div className="flex-[1_1_320px] min-w-0 rounded-ctl border border-border p-3 [&>div.card]:border-0 [&>div.card]:bg-transparent [&>div.card]:p-0 [&>div.card]:shadow-none" data-step-chart="">
          <ChartWithControls id={`${run.id}:${step.id}`} title={step.title} columns={step.columns || []} rows={rows} truncated={truncated} minHeight={240} tableAlongside />
        </div>
      )}
      {truncated && <p className="m-0 w-full text-caption text-muted">The first {rows.length} of {step.rows_returned!.toLocaleString("en-US")} rows are shown here; every row is used by the steps after this one and by the answer.</p>}
    </div>
  );
}

// ---- adding a step -------------------------------------------------------------

function AddStep({ open, setOpen, disabled, busy, onAdd }: { open: boolean; setOpen: (v: boolean) => void; disabled: boolean; busy: boolean; onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} disabled={disabled} className="ui-focus h-11 rounded-card border border-dashed border-border-strong text-ui text-muted hover:text-text disabled:opacity-50" data-add-step="">
        + Add a step
      </button>
    );
  }
  return (
    <section id="guided-add" className="rounded-card border border-kind-analysis-border bg-surface p-4 sm:p-5 flex flex-col gap-3">
      <label htmlFor="guided-add-text" className="text-ui font-semibold text-text">What should the new step do?</label>
      <textarea
        id="guided-add-text"
        rows={2}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Cancellation rate by hotel and month — or: join the ad spend with the monthly revenue"
        className="w-full resize-y rounded-ctl border border-border-strong bg-base text-text text-[15px] px-3.5 py-2.5 outline-none focus:border-kind-analysis"
      />
      <div className="flex gap-2 flex-wrap items-center">
        <button type="button" className="btn-primary text-sm" disabled={disabled || text.trim().length < 3} onClick={() => onAdd(text.trim())} data-add-step-go="">
          {busy ? "Writing the step…" : "Add and run"}
        </button>
        <button type="button" className="btn-secondary text-sm" onClick={() => setOpen(false)}>Cancel</button>
        <span className="text-caption text-muted">It goes at the end; it can combine the results of earlier steps.</span>
      </div>
    </section>
  );
}
