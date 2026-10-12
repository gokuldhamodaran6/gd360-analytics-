// 2026-10-11 (Ask Journey, canvas C1-C3): GD360 asks before it builds a
// dashboard from a thread, so two answers never become two dashboards by
// accident.
//
//   - No dashboard yet, two or more answers: "one dashboard, a page per
//     question" (recommended), "both on one page", or "only this answer"
//     (CreateFromThreadDialog).
//   - A dashboard already holds an earlier answer: the next answer is offered
//     as its next page, merged under a page, or as a new dashboard - right in
//     the conversation (AddToDashboardCard). A published dashboard shows where
//     it is live; adding to it can be undone from the toast.
//
// Every dashboard is the same full kind as everywhere in GD360 (built by
// POST /projects/{id}/dashboard); editing, filters and publishing are the
// dashboard builder's, unchanged.
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { MakeDashboardResult, Project, ProjectRun, projectsApi, ThreadDashboard } from "../api/projects";
import { CheckIcon, CloseIcon, GridIcon, Spinner } from "./parts";

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  if (typeof d === "string" && d.trim()) return d;
  if (e?.code === "ECONNABORTED") return "This is taking longer than usual. Check Dashboards in a minute - it may still appear.";
  return fallback;
}

const PHASES = ["Reading the answer…", "Planning the blocks…", "Checking every query against your data…", "Laying it out…"];

function usePhase(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) {
      setI(0);
      return;
    }
    const t = window.setInterval(() => setI((p) => Math.min(PHASES.length - 1, p + 1)), 2600);
    return () => window.clearInterval(t);
  }, [active]);
  return PHASES[i];
}

/** A short page name for an answer: its plan's title, else its question. */
export function shortTitle(run: ProjectRun): string {
  const t = (run.plan?.title || run.question || "").trim().replace(/\?$/, "");
  return t.length > 48 ? `${t.slice(0, 46).trimEnd()}…` : t || "Answer";
}

export const isAnswered = (r: ProjectRun) => r.status === "done" && Boolean(r.result?.answer) && !r.result?.answer_stale;

/** The dashboard a thread's next answer is offered to: the one its answers
 *  went to most recently (that this person can edit), else the newest one
 *  made from the thread. */
export function primaryDashboard(project: Project | null): ThreadDashboard | null {
  if (!project) return null;
  const editable = (project.dashboards || []).filter((d) => d.layout_version === 2 && d.can_edit);
  if (!editable.length) return null;
  const recent = [...(project.placements || [])].sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  for (const p of recent) {
    const d = editable.find((x) => x.id === p.dashboard_id);
    if (d) return d;
  }
  return editable[editable.length - 1];
}

export type DashPrompt =
  | { kind: "add"; run: ProjectRun; dashboard: ThreadDashboard }
  | { kind: "combine"; run: ProjectRun; runs: ProjectRun[] };

/** What GD360 asks in the conversation, after which answer - or nothing. */
export function threadPrompt(project: Project | null, runs: ProjectRun[], canEdit: boolean): DashPrompt | null {
  if (!project || !canEdit) return null;
  const answered = runs.filter(isAnswered);
  const last = answered[answered.length - 1];
  if (!last) return null;
  const placed = new Set((project.placements || []).flatMap((p) => p.run_ids || []));
  const dismissed = new Set(project.dismissed || []);
  if (placed.has(last.id) || dismissed.has(last.id)) return null;
  const primary = primaryDashboard(project);
  if (primary) return { kind: "add", run: last, dashboard: primary };
  if ((project.dashboards || []).length) return null; // a dashboard exists but isn't editable here - stay quiet
  const open = answered.filter((r) => !placed.has(r.id) && !dismissed.has(r.id));
  if (open.length >= 2) return { kind: "combine", run: last, runs: open };
  return null;
}

/** The page an answer is merged under: where this thread's answers went
 *  last on that dashboard, else its first page. */
export function mergeTarget(project: Project | null, dashboard: ThreadDashboard): { id: string; name: string } | null {
  const pages = dashboard.pages || [];
  if (!pages.length) return null;
  const recent = [...(project?.placements || [])]
    .filter((p) => p.dashboard_id === dashboard.id)
    .sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  for (const p of recent) {
    const pg = pages.find((x) => x.id === (p.page_id || (p.page_ids || [])[0]));
    if (pg) return pg;
  }
  return pages[0];
}

// ---- placing an answer on a dashboard ------------------------------------------

export type Toast = {
  text: ReactNode;
  dashboardId: string;
  actionId?: string;
  undoable: boolean;
};

export function useDashboardFlow(projectId: string, project: Project | null, reload: () => Promise<unknown>) {
  const [placing, setPlacing] = useState<string | null>(null); // the run being added
  const [error, setError] = useState<{ runId: string; text: string } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [undoing, setUndoing] = useState(false);
  const phase = usePhase(Boolean(placing));

  const place = useCallback(
    async (run: ProjectRun, dashboard: ThreadDashboard, how: "page" | "merge", pageId?: string) => {
      if (placing) return;
      setPlacing(run.id);
      setError(null);
      const pageName = shortTitle(run);
      try {
        const out: MakeDashboardResult = await projectsApi.makeDashboard(projectId, {
          run_id: run.id,
          add_to_dashboard_id: dashboard.id,
          datasource_id: dashboard.datasource_id || undefined,
          ...(how === "page" ? { pages: 1 as const, page_name: pageName } : { merge_into_page_id: pageId }),
        });
        const pages = dashboard.pages || [];
        const where = how === "page"
          ? <>“{pageName}” is page {pages.length + 1} of <b className="font-semibold">{out.name}</b></>
          : <>Added under “{pages.find((p) => p.id === pageId)?.name || "the page"}” on <b className="font-semibold">{out.name}</b></>;
        setToast({
          text: (
            <>
              {where}
              {out.live ? <span className="text-muted"> · live on {out.live.label}</span> : null}
            </>
          ),
          dashboardId: out.dashboard_id,
          actionId: out.action_id,
          undoable: Boolean(out.action_id),
        });
        await reload();
      } catch (e: any) {
        setError({ runId: run.id, text: errorText(e, "Couldn't add it to the dashboard. Please try again.") });
      } finally {
        setPlacing(null);
      }
    },
    [placing, projectId, reload],
  );

  const undo = useCallback(async () => {
    if (!toast?.actionId || undoing) return;
    setUndoing(true);
    try {
      await projectsApi.undoPlacement(projectId, toast.actionId);
      setToast({ text: "Undone - the dashboard is back as it was.", dashboardId: toast.dashboardId, undoable: false });
      await reload();
    } catch (e: any) {
      setToast({ text: errorText(e, "Couldn't undo that. Open the dashboard to change it."), dashboardId: toast.dashboardId, undoable: false });
    } finally {
      setUndoing(false);
    }
  }, [projectId, reload, toast, undoing]);

  const dismiss = useCallback(
    async (runIds: string[]) => {
      try {
        await projectsApi.dismissDashboardPrompt(projectId, runIds);
        await reload();
      } catch {
        /* the prompt simply stays */
      }
    },
    [projectId, reload],
  );

  return { placing, phase, error, place, toast, setToast, undo, undoing, dismiss, project };
}

// ---- in the conversation: "add this as page 2?" -----------------------------------

export function AddToDashboardCard({
  project,
  run,
  dashboard,
  flow,
  onNew,
  onDismissed,
}: {
  project: Project;
  run: ProjectRun;
  dashboard: ThreadDashboard;
  flow: ReturnType<typeof useDashboardFlow>;
  onNew: () => void;
  onDismissed?: () => void;
}) {
  const pages = dashboard.pages || [];
  const target = mergeTarget(project, dashboard);
  const busy = flow.placing === run.id;
  const err = flow.error?.runId === run.id ? flow.error.text : "";
  return (
    <section
      aria-label="Add this answer to your dashboard"
      data-dashboard-prompt="add"
      className="relative rounded-[18px] border border-kind-dashboard-border bg-kind-dashboard-fill/40 p-4 flex flex-col gap-3.5 overflow-hidden"
    >
      <div className="flex gap-3 items-start">
        <span className="w-8 h-8 rounded-[9px] bg-kind-dashboard-fill text-kind-dashboard grid place-items-center shrink-0"><GridIcon size={16} /></span>
        <p className="m-0 text-ui text-secondary leading-relaxed">
          You already {dashboard.live ? "published" : "made"} <b className="text-text font-semibold">{dashboard.name}</b>
          {dashboard.live ? (
            <> — live on <span className="text-text">{dashboard.live.label}</span>{dashboard.live.views ? ` · ${dashboard.live.views.toLocaleString("en-US")} views` : ""}</>
          ) : null}
          . Add this answer to it?
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={Boolean(flow.placing)}
          onClick={() => flow.place(run, dashboard, "page")}
          data-add-as-page=""
          className="ui-focus text-left p-3 rounded-[12px] bg-kind-dashboard text-[rgb(var(--color-base))] flex flex-col gap-0.5 hover:opacity-95 disabled:opacity-60"
        >
          <span className="text-ui font-semibold">Add as page {pages.length + 1}</span>
          <span className="text-[12px] leading-snug opacity-75">Keeps every page as it is</span>
        </button>
        <button
          type="button"
          disabled={Boolean(flow.placing) || !target}
          onClick={() => target && flow.place(run, dashboard, "merge", target.id)}
          data-merge-into-page=""
          className="ui-focus text-left p-3 rounded-[12px] border border-border-strong bg-surface flex flex-col gap-0.5 hover:border-[rgb(var(--color-faint))] disabled:opacity-60"
        >
          <span className="text-ui font-semibold text-text truncate">Merge into {target ? `“${target.name}”` : "a page"}</span>
          <span className="text-[12px] leading-snug text-muted">Adds its tiles under that page</span>
        </button>
        <button
          type="button"
          disabled={Boolean(flow.placing)}
          onClick={onNew}
          className="ui-focus text-left p-3 rounded-[12px] border border-border-strong bg-surface flex flex-col gap-0.5 hover:border-[rgb(var(--color-faint))] disabled:opacity-60"
        >
          <span className="text-ui font-semibold text-text">New dashboard</span>
          <span className="text-[12px] leading-snug text-muted">Just this answer, on its own</span>
        </button>
        <button
          type="button"
          disabled={Boolean(flow.placing)}
          onClick={() => {
            flow.dismiss([run.id]);
            onDismissed?.();
          }}
          data-dashboard-not-now=""
          className="ui-focus text-left p-3 rounded-[12px] border border-border bg-transparent flex flex-col gap-0.5 hover:bg-surface disabled:opacity-60"
        >
          <span className="text-ui font-medium text-secondary">Not now</span>
          <span className="text-[12px] leading-snug text-faint">Create dashboard still works</span>
        </button>
      </div>
      <p className="m-0 text-caption text-muted leading-snug">
        {dashboard.live ? "Its viewers see the change straight away - you can undo it." : "Private until you publish it - you can undo it."}
      </p>
      {err && <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-ui text-text">{err}</div>}
      {busy && (
        <div className="absolute inset-0 bg-surface/90 backdrop-blur-[2px] grid place-items-center" aria-live="polite">
          <span className="flex items-center gap-2.5 text-ui text-text">
            <Spinner className="text-kind-dashboard" /> {flow.phase}
          </span>
        </div>
      )}
    </section>
  );
}

/** Two or more answers, no dashboard yet - a quiet offer, never a pop-up. */
export function CombineNudgeCard({ count, onSetup, onDismiss }: { count: number; onSetup: () => void; onDismiss: () => void }) {
  return (
    <div className="rounded-[16px] border border-kind-dashboard-border bg-kind-dashboard-fill/30 p-3.5 flex flex-col gap-3" data-dashboard-prompt="combine">
      <div className="flex items-start gap-3">
        <span className="w-8 h-8 rounded-[9px] bg-kind-dashboard-fill text-kind-dashboard grid place-items-center shrink-0"><GridIcon size={16} /></span>
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="text-ui font-semibold text-text">{count} answers in this thread</span>
          <span className="text-caption text-muted leading-snug">Make one dashboard from them - a page per question, or all on one page?</span>
        </span>
      </div>
      <div className="flex items-center gap-2 justify-end">
        <button type="button" onClick={onDismiss} className="ui-focus h-8 px-3 rounded-[10px] text-ui text-muted hover:text-text" data-dashboard-not-now="">
          Not now
        </button>
        <button type="button" onClick={onSetup} className="ui-focus h-8 px-3.5 rounded-[10px] text-ui font-semibold bg-kind-dashboard text-[rgb(var(--color-base))] hover:opacity-95" data-dashboard-setup="">
          Set it up
        </button>
      </div>
    </div>
  );
}

// ---- the toast after an answer is added -------------------------------------------

export function PlacementToast({ flow }: { flow: ReturnType<typeof useDashboardFlow> }) {
  const { toast, setToast } = flow;
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 16000);
    return () => window.clearTimeout(t);
  }, [toast, setToast]);
  if (!toast) return null;
  return createPortal(
    <div
      role="status"
      data-placement-toast=""
      className="fixed z-[70] bottom-5 left-1/2 -translate-x-1/2 lg:left-auto lg:right-6 lg:translate-x-0 w-[min(600px,calc(100vw-24px))] rounded-[16px] border border-border-strong bg-surface shadow-pop pl-4 pr-2 py-2.5 flex items-center gap-3"
    >
      <span className="w-6 h-6 rounded-full bg-primary text-on-primary grid place-items-center shrink-0"><CheckIcon size={12} /></span>
      <span className="flex-1 min-w-0 text-ui text-text leading-snug">{toast.text}</span>
      <Link to={`/dashboard-builder/${toast.dashboardId}`} className="ui-focus h-8 px-3 rounded-[10px] text-ui font-medium text-kind-dashboard hover:bg-kind-dashboard-fill grid place-items-center shrink-0">
        Open
      </Link>
      {toast.undoable && (
        <button type="button" onClick={flow.undo} disabled={flow.undoing} className="ui-focus h-8 px-3 rounded-[10px] border border-border-strong text-ui text-text hover:bg-subtle shrink-0 disabled:opacity-50">
          {flow.undoing ? "Undoing…" : "Undo"}
        </button>
      )}
      <button type="button" onClick={() => setToast(null)} aria-label="Close" className="ui-focus w-8 h-8 grid place-items-center rounded-[10px] text-faint hover:text-text shrink-0">
        <CloseIcon size={14} />
      </button>
    </div>,
    document.body,
  );
}

// ---- the modals --------------------------------------------------------------------

function Modal({ open, onClose, busy, labelledBy, children, width = 720 }: { open: boolean; onClose: () => void; busy: boolean; labelledBy: string; children: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);
  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[60] bg-[rgb(3_5_5/0.72)] backdrop-blur-[2px] flex items-start justify-center overflow-y-auto px-3 py-6 sm:py-[8vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="w-full rounded-[24px] border border-border-strong bg-surface shadow-pop flex flex-col"
        style={{ maxWidth: width }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

// round 36: "Create a dashboard from this thread" lives in ThreadDashboardDialog.tsx (choose, arrange, build).
export { CreateFromThreadDialog } from "./ThreadDashboardDialog";

/** The header's "Create dashboard" when the thread already has one: the same
 *  choice as the card in the conversation, for whichever answer is open. */
export function AddToDashboardDialog({
  open,
  onClose,
  project,
  run,
  dashboard,
  flow,
  onNew,
  numberOf,
}: {
  open: boolean;
  onClose: () => void;
  project: Project;
  run: ProjectRun | null;
  dashboard: ThreadDashboard | null;
  flow: ReturnType<typeof useDashboardFlow>;
  onNew: () => void;
  numberOf: (runId: string) => number;
}) {
  const busy = Boolean(flow.placing);
  // close once the answer has been added (the toast takes over)
  const was = useRef(false);
  useEffect(() => {
    if (busy) was.current = true;
    else if (was.current) {
      was.current = false;
      if (!flow.error) onClose();
    }
  }, [busy, flow.error, onClose]);
  if (!run || !dashboard) return null;
  return (
    <Modal open={open} onClose={onClose} busy={busy} labelledBy="add-dash-title" width={560}>
      <div className="px-6 pt-6 pb-2 flex gap-4 items-start">
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Q{numberOf(run.id)} · {shortTitle(run)}</span>
          <h2 id="add-dash-title" className="m-0 text-[20px] font-semibold text-text">Put this answer on a dashboard</h2>
        </div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="ui-focus w-9 h-9 rounded-[10px] grid place-items-center text-muted hover:text-text disabled:opacity-40">
          <CloseIcon size={18} />
        </button>
      </div>
      <div className="p-6 pt-3">
        <AddToDashboardCard project={project} run={run} dashboard={dashboard} flow={flow} onNew={() => { onClose(); onNew(); }} onDismissed={onClose} />
      </div>
    </Modal>
  );
}
