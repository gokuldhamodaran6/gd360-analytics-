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
// answer writer and number checks as Instant Answers, and the answer can
// become a dashboard like any other.
//
// /g/:projectId - a Conversation with kind "guided" and one run.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import CreateDashboardSheet from "../components/CreateDashboardSheet";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { ChartThemeProvider, useChartTheme } from "../dashboard/theme/ChartThemeContext";
import { resolveWorkspaceChart } from "../lib/workspaceChart";
import { guidedApi, Project, ProjectRun, ProjectSource, projectsApi, RunStep } from "../api/projects";
import { layoutSql, ResultsTab } from "../project/RunPanels";
import { DataTable } from "../project/Visuals";
import ChartWithControls from "../project/ChartControls";
import { ms } from "../project/format";
import { dashboardHref, KindIcon, KindPill } from "../lib/kinds";

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

export default function GuidedAnalysis() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [project, setProject] = useState<Project | null>(null);
  const [run, setRun] = useState<ProjectRun | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null); // which action is waiting on the server
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const stepRefs = useRef<Record<string, HTMLElement | null>>({});
  const [params, setParams] = useSearchParams();

  // Dashboards -> "From an analysis" lands here with ?create=1.
  useEffect(() => {
    if (params.get("create") !== "1" || !run || !project) return;
    if (run.status === "done" && project.can_edit) setCreateOpen(true);
    const next = new URLSearchParams(params);
    next.delete("create");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.status, project]);

  const loadProject = useCallback(async () => {
    try {
      const p = await projectsApi.get(projectId);
      if (p.kind && p.kind !== "guided") {
        navigate(`/p/${projectId}`, { replace: true });
        return;
      }
      setProject(p);
      const last = p.runs[p.runs.length - 1];
      if (last) setRun(await projectsApi.run(last.id));
    } catch (e: any) {
      if (e?.response?.status === 404) setNotFound(true);
      else setError(errorText(e, "Couldn't load this analysis. Please refresh."));
    }
  }, [projectId, navigate]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  // Follow the work while GD360 is planning, running a step or writing.
  useEffect(() => {
    if (!run || !isWorking(run)) return;
    const t = window.setTimeout(async () => {
      try {
        const next = await projectsApi.run(run.id);
        setRun(next);
        if (!isWorking(next) && next.status !== run.status) loadProject();
      } catch {
        /* the next tick tries again */
      }
    }, 1200);
    return () => window.clearTimeout(t);
  }, [run, loadProject]);

  const steps = run?.steps || [];
  const current = currentStepId(steps);
  const working = isWorking(run);
  const canEdit = Boolean(project?.can_edit);
  const approvedCount = steps.filter((s) => s.approved).length;
  const doneCount = steps.filter((s) => s.status === "done").length;
  const waitingCount = steps.filter((s) => s.status !== "done").length;
  const answer = run?.result?.answer || null;
  const answerStale = Boolean(run?.result?.answer_stale);

  const act = async (label: string, fn: () => Promise<ProjectRun>) => {
    setPending(label);
    setError("");
    try {
      const next = await fn();
      setRun(next);
      return next;
    } catch (e: any) {
      setError(errorText(e, "That didn't work. Please try again."));
      return null;
    } finally {
      setPending(null);
    }
  };

  const toggle = (id: string) =>
    setOpen((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const jumpTo = (id: string) => {
    setOpen((cur) => new Set(cur).add(id));
    window.setTimeout(() => stepRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
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

  return (
    <ChartThemeProvider localScope={`guided:${projectId}`}>
      {project && run && (
        <CreateDashboardSheet open={createOpen} onClose={() => setCreateOpen(false)} projectId={projectId} run={run} sources={project.sources} />
      )}
      <div className="dash-shell flex min-h-screen">
        <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
        <div className="flex-1 min-w-0 flex flex-col">
          <header className="flex flex-wrap justify-between items-start gap-4 px-4 sm:px-8 pt-16 lg:pt-5 pb-4 border-b border-border" data-guided-header="">
            <div className="flex flex-col gap-2 min-w-0 flex-[1_1_420px]">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
                <Link to="/library?type=analysis" className="hover:text-text">Library</Link> / Guided Analysis
              </span>
              <div className="flex items-center gap-2.5 flex-wrap min-w-0">
                <KindPill kind="analysis">Guided Analysis</KindPill>
                <h1 className="m-0 text-[22px] sm:text-[24px] font-semibold tracking-tight text-text text-balance">{title}</h1>
              </div>
              {project && (
                <SourcesLine project={project} canEdit={canEdit} onChanged={loadProject} />
              )}
            </div>
            <div className="flex gap-2 flex-wrap items-center">
              {(project?.dashboards || []).slice(-1).map((d) => (
                <Link key={d.id} to={dashboardHref(d)} className="text-ui text-muted hover:text-text mr-1">Open “{d.name}” →</Link>
              ))}
              {canEdit && (
                <button
                  type="button"
                  className="btn-secondary text-sm"
                  disabled={!run || working || waitingCount === 0 || pending !== null}
                  onClick={() => run && act("rest", () => guidedApi.runRest(run.id))}
                  data-run-rest=""
                  title="Run every step that hasn't run yet, then write the answer"
                >
                  Run the rest
                </button>
              )}
              <button
                type="button"
                className="ui-focus inline-flex items-center gap-2 h-10 px-4 rounded-ctl border border-kind-dashboard-border bg-kind-dashboard-fill text-kind-dashboard text-sm font-semibold disabled:opacity-45 disabled:cursor-not-allowed"
                disabled={!run || run.status !== "done" || !canEdit}
                onClick={() => setCreateOpen(true)}
                title={run?.status === "done" ? "Build a live dashboard from this analysis" : "Write the answer first - the dashboard is built from it"}
                data-guided-create-dashboard=""
              >
                <KindIcon kind="dashboard" size={15} /> Create dashboard
              </button>
            </div>
          </header>

          {error && (
            <div role="alert" className="mx-4 sm:mx-8 mt-4 rounded-card border border-danger-border bg-danger-fill px-4 py-3 text-ui text-danger flex justify-between gap-3">
              <span>{error}</span>
              <button type="button" className="text-caption underline" onClick={() => setError("")}>Dismiss</button>
            </div>
          )}

          <div className="flex flex-wrap gap-7 px-4 sm:px-8 pt-6 pb-16 items-start">
            <PlanRail
              steps={steps}
              current={current}
              approved={approvedCount}
              planning={run?.status === "planning" || !run}
              answerState={run?.status === "done" ? (answerStale ? "stale" : "done") : run?.status === "running" ? "writing" : "waiting"}
              onJump={jumpTo}
              onAdd={canEdit ? () => { setAddOpen(true); window.setTimeout(() => document.getElementById("guided-add")?.scrollIntoView({ behavior: "smooth", block: "center" }), 40); } : undefined}
            />

            <main className="flex-[999_1_560px] min-w-0 flex flex-col gap-3" data-guided-steps="">
              {(!run || run.status === "planning") && <PlanningCard question={run?.question || project?.title || ""} />}
              {run && run.status === "failed" && !steps.length && (
                <div className="rounded-card border border-danger-border bg-danger-fill p-5">
                  <div className="text-section font-semibold text-text">GD360 couldn't plan this analysis</div>
                  <p className="m-0 mt-1.5 text-ui text-secondary">{run.error || "Something went wrong."}</p>
                  <Link to="/?intent=guided" className="btn-secondary text-sm mt-4 inline-flex">Try another question</Link>
                </div>
              )}
              {run && run.status === "needs_input" && answer && (
                <div className="rounded-card border border-warning-border bg-warning-fill p-5">
                  <div className="text-section font-semibold text-text">{answer.headline}</div>
                  <p className="m-0 mt-1.5 text-ui text-secondary">{answer.answer}</p>
                </div>
              )}
              {run && (run.plan?.assumptions || []).length > 0 && steps.length > 0 && (
                <details className="rounded-card border border-border bg-surface px-4 py-3 text-ui text-secondary">
                  <summary className="cursor-pointer text-muted">How GD360 read your question · {run.plan!.assumptions.length} assumption{run.plan!.assumptions.length === 1 ? "" : "s"}</summary>
                  <ul className="m-0 mt-2 pl-5 flex flex-col gap-1">
                    {run.plan!.assumptions.map((a, i) => <li key={i}>{a}</li>)}
                  </ul>
                </details>
              )}
              {run && steps.map((s, i) => (
                <StepCard
                  key={s.id}
                  refEl={(el) => { stepRefs.current[s.id] = el; }}
                  run={run}
                  step={s}
                  number={i + 1}
                  isCurrent={s.id === current}
                  expanded={s.id === current || open.has(s.id)}
                  onToggle={() => toggle(s.id)}
                  canEdit={canEdit}
                  locked={working || pending !== null}
                  pending={pending}
                  act={act}
                />
              ))}
              {run && canEdit && steps.length > 0 && (
                <AddStep
                  open={addOpen}
                  setOpen={setAddOpen}
                  disabled={working || pending !== null}
                  busy={pending === "add"}
                  onAdd={async (text) => {
                    const next = await act("add", () => guidedApi.add(run.id, text));
                    if (next) setAddOpen(false);
                  }}
                />
              )}
              {run && steps.length > 0 && (
                <AnswerCard
                  run={run}
                  stale={answerStale}
                  canEdit={canEdit}
                  doneCount={doneCount}
                  disabled={working || pending !== null}
                  writing={run.status === "running"}
                  onWrite={() => act("finish", () => guidedApi.finish(run.id))}
                  onCreate={() => setCreateOpen(true)}
                />
              )}
            </main>
          </div>
        </div>
      </div>
    </ChartThemeProvider>
  );
}

// ---- header: the sources this analysis works on --------------------------------

function SourcesLine({ project, canEdit, onChanged }: { project: Project; canEdit: boolean; onChanged: () => void }) {
  const [menu, setMenu] = useState(false);
  const [all, setAll] = useState<ProjectSource[] | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    if (all === null) projectsApi.sources(project.workspace_id || undefined).then(setAll).catch(() => setAll([]));
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setMenu(false);
        return;
      }
      if (!ref.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu, all, project.workspace_id]);
  const add = async (id: string) => {
    setSaving(true);
    try {
      await projectsApi.update(project.id, { source_ids: [...project.source_ids, id] });
      setMenu(false);
      onChanged();
    } finally {
      setSaving(false);
    }
  };
  const others = (all || []).filter((s) => !project.source_ids.includes(s.id));
  return (
    <div className="relative flex items-center gap-2 flex-wrap" ref={ref} data-guided-sources="">
      <span className="text-caption text-muted">Working on</span>
      {project.sources.map((s) => (
        <span key={s.id} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-border-strong bg-surface text-ui text-text max-w-[260px]">
          <span className="truncate">{s.name}</span>
          <span className="text-caption text-muted shrink-0">{s.label}</span>
        </span>
      ))}
      {canEdit && (
        <button type="button" onClick={() => setMenu((v) => !v)} aria-expanded={menu} className="ui-focus h-7 px-2.5 rounded-full border border-dashed border-border-strong text-ui text-muted hover:text-text">
          + Add source
        </button>
      )}
      {menu && (
        <div role="menu" className="absolute left-0 top-[calc(100%+6px)] z-30 w-[320px] max-w-[calc(100vw-48px)] max-h-[320px] overflow-y-auto rounded-card border border-border bg-surface shadow-pop p-1.5">
          {all === null && <div className="px-3 py-2 text-caption text-muted">Loading…</div>}
          {all !== null && others.length === 0 && <div className="px-3 py-2 text-caption text-muted">Every source you can use is already here.</div>}
          {others.map((s) => (
            <button key={s.id} type="button" role="menuitem" disabled={saving} onClick={() => add(s.id)} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-ctl text-left hover:bg-subtle disabled:opacity-50">
              <span className="min-w-0 flex-1 truncate text-ui text-text">{s.name}</span>
              <span className="text-caption text-muted shrink-0">{s.label}</span>
            </button>
          ))}
          <p className="m-0 px-3 pt-2 pb-1 text-caption text-muted">New and changed steps can use it — the steps you have stay as they are.</p>
        </div>
      )}
    </div>
  );
}

// ---- the plan rail ----------------------------------------------------------------

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

function PlanRail({
  steps, current, approved, planning, answerState, onJump, onAdd,
}: {
  steps: RunStep[]; current: string | null; approved: number; planning: boolean;
  answerState: "waiting" | "writing" | "done" | "stale"; onJump: (id: string) => void; onAdd?: () => void;
}) {
  const total = steps.length;
  const pct = total ? Math.round((approved / total) * 100) : 0;
  const currentNo = current ? steps.findIndex((s) => s.id === current) + 1 : total;
  return (
    <aside aria-label="The plan" className="flex-[1_1_250px] max-w-[300px] lg:sticky lg:top-4 flex flex-col gap-3.5" data-guided-plan="">
      <div className="flex justify-between items-baseline">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">The plan</span>
        {total > 0 && <span className="text-caption text-muted">{answerState === "done" ? "Answered" : `Step ${Math.max(1, currentNo)} of ${total}`}</span>}
      </div>
      <div className="h-1 rounded bg-border overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Steps approved">
        <div className="h-full bg-kind-analysis transition-[width] duration-300" style={{ width: `${answerState === "done" ? 100 : pct}%` }} />
      </div>
      {planning ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-9 rounded-ctl bg-surface animate-pulse" />)}
        </div>
      ) : (
        <ol className="list-none m-0 p-0 flex flex-col gap-1">
          {steps.map((s, i) => {
            const active = s.id === current;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onJump(s.id)}
                  className={`ui-focus w-full flex gap-2.5 items-center px-2.5 py-2 rounded-ctl text-left text-ui transition-colors ${
                    active ? "bg-surface border border-kind-analysis-border text-text" : s.approved || s.status === "done" ? "text-secondary hover:bg-surface" : "text-muted hover:bg-surface"
                  }`}
                  aria-current={active ? "step" : undefined}
                >
                  <StepDot step={s} number={i + 1} active={active} />
                  <span className="min-w-0 truncate">{s.title}</span>
                </button>
              </li>
            );
          })}
          <li>
            <span className={`flex gap-2.5 items-center px-2.5 py-2 text-ui ${answerState === "done" ? "text-secondary" : "text-muted"}`}>
              <span className={`w-5 h-5 rounded-full grid place-items-center shrink-0 ${answerState === "done" ? "bg-kind-answer text-[rgb(var(--color-base))]" : answerState === "writing" ? "border-2 border-kind-analysis/40 border-t-kind-analysis animate-spin" : "border-2 border-dashed border-border-strong"}`} aria-hidden="true">
                {answerState === "done" && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>}
              </span>
              The answer{answerState === "stale" ? " · out of date" : ""}
            </span>
          </li>
        </ol>
      )}
      {onAdd && !planning && (
        <button type="button" onClick={onAdd} className="ui-focus h-9 rounded-ctl border border-dashed border-border-strong text-ui text-muted hover:text-text">
          + Add a step
        </button>
      )}
      <p className="m-0 text-caption text-muted leading-relaxed">
        Planned by the same engine as Instant Answers. Every step runs on all your rows, inside your source.
      </p>
    </aside>
  );
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
  refEl, run, step, number, isCurrent, expanded, onToggle, canEdit, locked, pending, act,
}: {
  refEl: (el: HTMLElement | null) => void;
  run: ProjectRun;
  step: RunStep;
  number: number;
  isCurrent: boolean;
  expanded: boolean;
  onToggle: () => void;
  canEdit: boolean;
  locked: boolean;
  pending: string | null;
  act: (label: string, fn: () => Promise<ProjectRun>) => Promise<ProjectRun | null>;
}) {
  const steps = run.steps || [];
  const pill = STATUS_PILL[step.approved ? "approved" : step.status] || STATUS_PILL.pending;
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
  const meta = step.status === "done"
    ? [where, step.rows_returned != null ? `${step.rows_returned.toLocaleString("en-US")} row${step.rows_returned === 1 ? "" : "s"}` : null, step.duration_ms != null ? `ran in ${ms(step.duration_ms)}` : null].filter(Boolean).join(" · ")
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

// ---- the answer -----------------------------------------------------------------

function AnswerCard({
  run, stale, canEdit, doneCount, disabled, writing, onWrite, onCreate,
}: {
  run: ProjectRun; stale: boolean; canEdit: boolean; doneCount: number; disabled: boolean; writing: boolean;
  onWrite: () => void; onCreate: () => void;
}) {
  const answer = run.result?.answer;
  const has = Boolean(answer && (run.status === "done" || stale));
  return (
    <section className={`rounded-[16px] border p-4 sm:p-6 flex flex-col gap-4 ${has ? "border-kind-answer-border bg-surface" : "border-dashed border-border-strong"}`} data-guided-answer="">
      <div className="flex justify-between items-start gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-kind-answer">The answer</span>
          {has ? (
            <h2 className="m-0 text-[20px] font-semibold text-text leading-snug text-balance">{answer!.headline}</h2>
          ) : (
            <span className="text-ui text-muted">
              {writing ? "Writing the answer from your steps…" : "Written from the steps that ran — the same checked numbers as Instant Answers."}
            </span>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {canEdit && (!has || stale) && (
            <button type="button" className="btn-primary text-sm" disabled={disabled || doneCount === 0} onClick={onWrite} data-write-answer="">
              {writing ? "Writing…" : stale ? "Rewrite the answer" : "Write the answer"}
            </button>
          )}
          {has && !stale && canEdit && (
            <button type="button" onClick={onCreate} className="ui-focus inline-flex items-center gap-2 h-10 px-4 rounded-ctl border border-kind-dashboard-border bg-kind-dashboard-fill text-kind-dashboard text-sm font-semibold">
              <KindIcon kind="dashboard" size={15} /> Create dashboard
            </button>
          )}
        </div>
      </div>
      {stale && (
        <div className="rounded-ctl border border-warning-border bg-warning-fill px-4 py-3 text-ui text-warning">
          A step changed after this answer was written. Rewrite it to include the change.
        </div>
      )}
      {has && answer!.answer && answer!.answer !== answer!.headline && <p className="m-0 text-body text-secondary leading-relaxed max-w-[75ch]">{answer!.answer}</p>}
      {has && <ResultsTab run={{ ...run, status: "done" }} />}
    </section>
  );
}
