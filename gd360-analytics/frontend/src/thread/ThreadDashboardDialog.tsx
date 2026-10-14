// 2026-10-12 (round 36): "Create a dashboard from this thread", rebuilt.
//
//   1. Choose: the answers come along (untick any), the person can add anything else it should
//      show, and picks how: GD360 builds the best one (recommended), "Let me arrange it", or
//      "Only my answers".
//   2. Arrange (optional): every block of the checked plan - move it up or down (across pages too,
//      or drag it), rename / add / remove pages, add a block to any page, remove and restore;
//      "Let GD360 arrange it" puts the plan back.
//   3. Build: every block computed on its OWN table; nothing empty is created, and what was left
//      out says why. A one-block dashboard cannot come out of this.
import { DragEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Project, ProjectRun, ProjectSource, projectsApi, ThreadPlan, ThreadPlanBlock, ThreadPlanMode } from "../api/projects";
import { CheckIcon, CloseIcon, Spinner } from "./parts";
import { useFocusTrap } from "./a11y";

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  if (typeof d === "string" && d.trim()) return d;
  if (e?.code === "ECONNABORTED") return "This is taking longer than usual. Check Dashboards in a minute - it may still appear.";
  return fallback;
}

function shortTitle(run: ProjectRun): string {
  const q = (run.question || "").trim().replace(/\s+/g, " ");
  return q.length > 48 ? q.slice(0, 46).trimEnd() + "…" : q || "Answer";
}

function sourcesOf(runs: ProjectRun[], all: ProjectSource[]): ProjectSource[] {
  const counts = new Map<string, number>();
  for (const r of runs) {
    const steps = r.plan?.steps?.length ? r.plan.steps : (r.steps || []).filter((s) => s.kind !== "combine");
    for (const st of steps) if (st.source_id) counts.set(st.source_id, (counts.get(st.source_id) || 0) + 1);
  }
  const used = all.filter((s) => counts.has(s.id)).sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0));
  return used.length ? used : all.slice(0, 1);
}

// ---- icons (stroke, currentColor) -------------------------------------------------------
type IP = { size?: number; className?: string };
const sv = (size: number, className: string, sw = 1.9) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: sw,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className: `shrink-0 ${className}`,
});
const LayersIcon = ({ size = 16, className = "" }: IP) => <svg {...sv(size, className)}><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></svg>;
const SparkIcon = ({ size = 16, className = "" }: IP) => <svg {...sv(size, className)}><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z" /></svg>;
const ListIcon = ({ size = 16, className = "" }: IP) => <svg {...sv(size, className)}><path d="M9 6h12M9 12h12M9 18h12" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></svg>;
const ChatIcon = ({ size = 16, className = "" }: IP) => <svg {...sv(size, className)}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
const ShieldIcon = ({ size = 16, className = "" }: IP) => <svg {...sv(size, className)}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>;
const GripIcon = ({ size = 16, className = "" }: IP) => <svg {...sv(size, className)}><circle cx="9" cy="6" r="1.2" /><circle cx="15" cy="6" r="1.2" /><circle cx="9" cy="12" r="1.2" /><circle cx="15" cy="12" r="1.2" /><circle cx="9" cy="18" r="1.2" /><circle cx="15" cy="18" r="1.2" /></svg>;
const UpIcon = ({ size = 16, className = "" }: IP) => <svg {...sv(size, className, 2.1)}><path d="M12 19V5M6 11l6-6 6 6" /></svg>;
const DownIcon = ({ size = 16, className = "" }: IP) => <svg {...sv(size, className, 2.1)}><path d="M12 5v14M6 13l6 6 6-6" /></svg>;
const PlusIcon = ({ size = 16, className = "" }: IP) => <svg {...sv(size, className, 2.1)}><path d="M12 5v14M5 12h14" /></svg>;
const PenIcon = ({ size = 16, className = "" }: IP) => <svg {...sv(size, className)}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>;
const UndoIcon = ({ size = 16, className = "" }: IP) => <svg {...sv(size, className)}><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>;
const ZapIcon = ({ size = 16, className = "" }: IP) => <svg {...sv(size, className)}><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>;

export function VisualIcon({ visual, size = 15 }: { visual: string; size?: number }) {
  const p = sv(size, "");
  switch (visual) {
    case "kpi": return <svg {...p}><path d="M4 19V9M10 19V5M16 19v-7M22 19H2" /></svg>;
    case "trend": return <svg {...p}><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></svg>;
    case "map": return <svg {...p}><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z" /><path d="M9 4v14M15 6v14" /></svg>;
    case "donut": return <svg {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="M12 3v5" /></svg>;
    case "split": return <svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /><path d="M14 5v4M10 10v4M16 15v4" /></svg>;
    case "table": return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" /></svg>;
    default: return <svg {...p}><path d="M4 6h10M4 12h16M4 18h7" /></svg>;
  }
}

/** Where a block comes from: an answer (Q2), GD360's addition, or the person's own. */
export function originTone(origin: string): { fg: string; bg: string; label: string } {
  if (/^Q\d+$/.test(origin)) return { fg: "rgb(var(--color-kind-answer))", bg: "rgb(var(--color-kind-answer-fill))", label: `From ${origin}` };
  if (origin === "you") return { fg: "rgb(var(--color-kind-dashboard))", bg: "rgb(var(--color-kind-dashboard-fill))", label: "You" };
  return { fg: "rgb(var(--color-series-1))", bg: "rgb(var(--color-series-1) / 0.12)", label: "GD360" };
}

function Modal({ open, onClose, busy, children, width }: { open: boolean; onClose: () => void; busy: boolean; children: ReactNode; width: number }) {
  // 2026-10-13 (R45): focus moves in, Tab stays inside, focus returns on close
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(open, box);
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
      className="fixed inset-0 z-[60] bg-[rgb(3_5_5/0.72)] backdrop-blur-[2px] flex items-start justify-center overflow-y-auto px-3 py-6 sm:py-[6vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="thread-dash-title" data-thread-dashboard-dialog=""
        className="outline-none w-full rounded-[24px] border border-border-strong bg-surface shadow-pop flex flex-col transition-[max-width] duration-200" style={{ maxWidth: width }}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

const BUILD_PHASES = ["Reading your answers", "Planning the blocks", "Checking every block on its own table", "Laying out the pages"];

type Page = { key: string; title: string; ids: string[] };
type Step = "choose" | "arrange" | "building";

const MODES: { id: ThreadPlanMode; title: string; icon: ReactNode; tone: string }[] = [
  { id: "auto", title: "GD360 builds the best one", icon: <SparkIcon size={17} />, tone: "brand" },
  { id: "arrange", title: "Let me arrange it", icon: <ListIcon size={17} />, tone: "blue" },
  { id: "answers", title: "Only my answers", icon: <ChatIcon size={17} />, tone: "orange" },
];
const TONE: Record<string, { fg: string; bg: string; bd: string }> = {
  brand: { fg: "rgb(var(--color-brand-ink))", bg: "rgb(var(--color-tint))", bd: "rgb(var(--color-tint-border))" },
  blue: { fg: "rgb(var(--color-series-1))", bg: "rgb(var(--color-series-1) / 0.14)", bd: "rgb(var(--color-series-1) / 0.35)" },
  orange: { fg: "rgb(var(--color-series-2))", bg: "rgb(var(--color-series-2) / 0.14)", bd: "rgb(var(--color-series-2) / 0.35)" },
};

function Badge({ tone, children, size = 34 }: { tone: string; children: ReactNode; size?: number }) {
  const t = TONE[tone];
  return (
    <span className="grid place-items-center shrink-0" style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), color: t.fg, background: t.bg, boxShadow: `inset 0 0 0 1px ${t.bd}` }}>
      {children}
    </span>
  );
}

let pageSeq = 0;
const pagesFromPlan = (plan: ThreadPlan): Page[] => plan.pages.map((pg) => ({ key: `p${++pageSeq}`, title: pg.title, ids: pg.blocks.map((b) => b.id) }));

export function CreateFromThreadDialog({
  open, onClose, projectId, project, answered, numberOf, focusRunId,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  project: Project;
  answered: ProjectRun[];
  numberOf: (runId: string) => number;
  focusRunId?: string | null;
  startLayout?: string;
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("choose");
  const [mode, setMode] = useState<ThreadPlanMode>("auto");
  const [purpose, setPurpose] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState(0);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<ThreadPlan | null>(null);
  const [blocks, setBlocks] = useState<Record<string, ThreadPlanBlock>>({});
  const [pages, setPages] = useState<Page[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<{ key: string; text: string } | null>(null);
  const dragId = useRef<string | null>(null);
  const purposeRef = useRef<HTMLTextAreaElement>(null);

  const recent = useMemo(() => answered.slice(-6), [answered]);
  const several = recent.length >= 2;

  useEffect(() => {
    if (!open) return;
    setStep("choose");
    setMode("auto");
    setPurpose("");
    setPicked(several ? recent.map((r) => r.id) : (focusRunId ? [focusRunId] : recent.slice(-1).map((r) => r.id)));
    setBusy(false);
    setError("");
    setPlan(null);
    setRemoved([]);
    setDrafts({});
    setAddError(null);
    const t = window.setTimeout(() => purposeRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!busy) return;
    setPhase(0);
    const t = window.setInterval(() => setPhase((p) => Math.min(p + 1, BUILD_PHASES.length - 1)), 2600);
    return () => window.clearInterval(t);
  }, [busy]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 1400);
    return () => window.clearTimeout(t);
  }, [flash]);

  const chosen = useMemo(() => recent.filter((r) => picked.includes(r.id)), [recent, picked]);
  const candidates = useMemo(() => sourcesOf(chosen.length ? chosen : recent, project.sources), [chosen, recent, project.sources]);
  useEffect(() => {
    if (!candidates.some((c) => c.id === sourceId)) setSourceId(candidates[0]?.id || "");
  }, [candidates, sourceId]);

  const total = pages.reduce((n, p) => n + p.ids.length, 0);
  const viewsInAnswers = chosen.reduce((n, r) => n + ((r.result?.visuals || []).filter((v: any) => v?.type !== "kpis").length || 1), 0);

  const loadPlan = (p: ThreadPlan) => {
    setPlan(p);
    const map: Record<string, ThreadPlanBlock> = {};
    p.pages.forEach((pg) => pg.blocks.forEach((b) => { map[b.id] = b; }));
    setBlocks(map);
    setPages(pagesFromPlan(p));
    setRemoved([]);
  };

  const build = async (p: ThreadPlan, arrangement?: Page[]) => {
    setStep("building");
    setBusy(true);
    setError("");
    try {
      const out = await projectsApi.buildThreadDashboard(projectId, {
        plan_id: p.plan_id,
        pages: arrangement ? arrangement.filter((pg) => pg.ids.length).map((pg) => ({ title: pg.title.trim() || "Page", block_ids: pg.ids })) : undefined,
      });
      onClose();
      navigate(`/dashboard-builder/${out.dashboard_id}`);
    } catch (e: any) {
      setError(errorText(e, "Couldn't build the dashboard. Please try again."));
      setBusy(false);
      setStep(arrangement ? "arrange" : "choose");
    }
  };

  const go = async () => {
    if (busy || !chosen.length || !sourceId) return;
    setBusy(true);
    setError("");
    if (mode !== "arrange") setStep("building");
    try {
      const p = await projectsApi.planThreadDashboard(projectId, {
        run_ids: chosen.map((r) => r.id), purpose: purpose.trim() || undefined, mode, datasource_id: sourceId,
      });
      loadPlan(p);
      if (mode === "arrange") {
        setBusy(false);
        setStep("arrange");
      } else {
        await build(p);
      }
    } catch (e: any) {
      setError(errorText(e, "Couldn't plan the dashboard. Please try again."));
      setBusy(false);
      setStep("choose");
    }
  };

  // ---- arranging ------------------------------------------------------------------------
  const move = (pi: number, ri: number, dir: -1 | 1) => {
    setPages((cur) => {
      const np = cur.map((p) => ({ ...p, ids: p.ids.slice() }));
      const id = np[pi].ids[ri];
      if (dir < 0) {
        if (ri > 0) { np[pi].ids.splice(ri, 1); np[pi].ids.splice(ri - 1, 0, id); }
        else if (pi > 0) { np[pi].ids.splice(ri, 1); np[pi - 1].ids.push(id); }
        else return cur;
      } else if (ri < np[pi].ids.length - 1) { np[pi].ids.splice(ri, 1); np[pi].ids.splice(ri + 1, 0, id); }
      else if (pi < np.length - 1) { np[pi].ids.splice(ri, 1); np[pi + 1].ids.unshift(id); }
      else return cur;
      setFlash(id);
      return np;
    });
  };
  const dropAt = (pi: number, before: string | null) => {
    const id = dragId.current;
    dragId.current = null;
    if (!id || id === before) return;
    setPages((cur) => {
      const np = cur.map((p) => ({ ...p, ids: p.ids.filter((x) => x !== id) }));
      const at = before ? np[pi].ids.indexOf(before) : -1;
      if (at < 0) np[pi].ids.push(id);
      else np[pi].ids.splice(at, 0, id);
      return np;
    });
    setFlash(id);
  };
  const removeBlock = (pi: number, id: string) => {
    setPages((cur) => cur.map((p, i) => (i === pi ? { ...p, ids: p.ids.filter((x) => x !== id) } : p)));
    setRemoved((r) => [...r, id]);
  };
  const restore = (id: string) => {
    setRemoved((r) => r.filter((x) => x !== id));
    setPages((cur) => cur.map((p, i) => (i === cur.length - 1 ? { ...p, ids: [...p.ids, id] } : p)));
    setFlash(id);
  };
  const addPage = () => setPages((cur) => [...cur, { key: `p${++pageSeq}`, title: `Page ${cur.length + 1}`, ids: [] }]);
  const removePage = (pi: number) =>
    setPages((cur) => {
      if (cur.length < 2) return cur;
      const np = cur.map((p) => ({ ...p, ids: p.ids.slice() }));
      const [gone] = np.splice(pi, 1);
      np[Math.max(0, pi - 1)].ids.push(...gone.ids);
      return np;
    });
  const rename = (pi: number, title: string) => setPages((cur) => cur.map((p, i) => (i === pi ? { ...p, title } : p)));
  const resuggest = () => {
    if (!plan) return;
    setPages(pagesFromPlan(plan));
    setRemoved([]);
  };
  const addBlock = async (pi: number) => {
    const page = pages[pi];
    const text = (drafts[page.key] || "").trim();
    if (!plan || text.length < 3 || adding) return;
    setAdding(page.key);
    setAddError(null);
    try {
      const out = await projectsApi.addToThreadPlan(projectId, plan.plan_id, { text, page_index: Math.min(pi, plan.pages.length - 1) });
      setBlocks((b) => ({ ...b, ...Object.fromEntries(out.blocks.map((x) => [x.id, x])) }));
      setPages((cur) => cur.map((p, i) => (i === pi ? { ...p, ids: [...p.ids, ...out.blocks.map((x) => x.id)] } : p)));
      setDrafts((d) => ({ ...d, [page.key]: "" }));
      setFlash(out.blocks[0]?.id || null);
    } catch (e: any) {
      setAddError({ key: page.key, text: errorText(e, "Couldn't add that block.") });
    } finally {
      setAdding(null);
    }
  };

  // ---- views ----------------------------------------------------------------------------
  const header = (title: string, sub: ReactNode) => (
    <div className="px-6 sm:px-7 pt-6 pb-4 flex gap-4 items-start">
      <span className="w-11 h-11 rounded-[12px] bg-kind-dashboard-fill text-kind-dashboard grid place-items-center shrink-0" style={{ boxShadow: "inset 0 0 0 1px rgb(var(--color-kind-dashboard-border))" }}>
        <LayersIcon size={20} />
      </span>
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <h2 id="thread-dash-title" className="m-0 text-[22px] leading-tight font-semibold tracking-[-0.01em] text-text">{title}</h2>
        <div className="m-0 text-[14.5px] text-secondary leading-relaxed">{sub}</div>
      </div>
      <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="ui-focus w-9 h-9 rounded-[10px] grid place-items-center text-muted hover:text-text disabled:opacity-40">
        <CloseIcon size={18} />
      </button>
    </div>
  );
  const alert = error && (
    <div role="alert" className="mx-6 sm:mx-7 mt-4 rounded-ctl border border-danger-border bg-danger-fill px-3.5 py-2.5 text-ui text-text">{error}</div>
  );
  const primaryBtn = "ui-focus inline-flex items-center gap-2 h-10 px-4 rounded-ctl font-semibold text-sm bg-kind-dashboard text-[rgb(var(--color-base))] hover:opacity-90 disabled:opacity-50";
  const iconBtn = "ui-focus w-8 h-8 rounded-[9px] grid place-items-center text-muted hover:text-text hover:bg-subtle disabled:opacity-30 disabled:pointer-events-none";

  if (step === "building") {
    return (
      <Modal open={open} onClose={onClose} busy={busy} width={620}>
        {header("Building your dashboard", "Every block is computed on its own table. Anything empty is left out, with the reason.")}
        <div className="px-6 sm:px-7 pb-2 flex flex-col gap-3" aria-live="polite" data-thread-dash-building="">
          <div className="h-1.5 rounded-full bg-subtle overflow-hidden">
            <div className="h-1.5 rounded-full bg-kind-dashboard transition-[width] duration-500" style={{ width: `${((phase + 1) / (BUILD_PHASES.length + 1)) * 100}%` }} />
          </div>
          <ul className="m-0 p-0 list-none flex flex-col gap-2">
            {BUILD_PHASES.map((t, i) => (
              <li key={t} className={`flex items-center gap-3 text-ui ${i <= phase ? "text-text" : "text-muted"}`}>
                {i < phase ? (
                  <span className="w-5 h-5 rounded-full grid place-items-center text-good bg-good-fill"><CheckIcon size={11} /></span>
                ) : i === phase ? (
                  <span className="w-5 h-5 grid place-items-center"><Spinner /></span>
                ) : (
                  <span className="w-5 h-5 rounded-full border border-border-strong" />
                )}
                {t}
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-5 px-6 sm:px-7 py-4 border-t border-border text-caption text-muted">It opens as soon as it’s ready.</div>
      </Modal>
    );
  }

  if (step === "arrange" && plan) {
    const flat = pages.flatMap((p) => p.ids);
    return (
      <Modal open={open} onClose={onClose} busy={busy} width={900}>
        {header("Arrange your dashboard", (
          <span className="flex items-center gap-1.5 flex-wrap">
            <span className="tabular-nums" data-arrange-total="">{total} {total === 1 ? "block" : "blocks"} on {pages.length} {pages.length === 1 ? "page" : "pages"}</span>
            <span className="text-faint">·</span>
            <span className="inline-flex items-center gap-1 text-good"><ShieldIcon size={14} />each checked on its own table</span>
          </span>
        ))}
        <div className="px-6 sm:px-7 pb-3 flex items-center gap-x-4 gap-y-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-caption text-secondary"><span className="w-2 h-2 rounded-full bg-kind-answer" />From your answers</span>
          <span className="inline-flex items-center gap-1.5 text-caption text-secondary"><span className="w-2 h-2 rounded-full" style={{ background: "rgb(var(--color-series-1))" }} />Added by GD360</span>
          <span className="flex-1" />
          <button type="button" onClick={resuggest} data-resuggest="" className="ui-focus inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-border text-caption text-secondary hover:text-text hover:border-border-strong">
            <SparkIcon size={13} />Let GD360 arrange it
          </button>
          <button type="button" onClick={addPage} data-add-page="" className="ui-focus inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-border text-caption text-secondary hover:text-text hover:border-border-strong">
            <PlusIcon size={13} />Add page
          </button>
        </div>
        <div className="px-6 sm:px-7 flex flex-col gap-3 overflow-y-auto" style={{ maxHeight: "min(62vh, 680px)" }}>
          {pages.map((pg, pi) => (
            <section key={pg.key} data-arrange-page={pi} className="rounded-[16px] border border-border bg-base overflow-hidden"
              onDragOver={(e: DragEvent) => e.preventDefault()} onDrop={(e: DragEvent) => { e.preventDefault(); dropAt(pi, null); }}>
              <div className="flex items-center gap-2.5 pl-4 pr-2 py-2 border-b border-border bg-surface/60">
                <span className="w-6 h-6 rounded-[7px] grid place-items-center text-[12px] font-semibold tabular-nums bg-subtle text-secondary">{pi + 1}</span>
                <label className="flex-1 min-w-0 flex items-center gap-1.5">
                  <span className="sr-only">Page {pi + 1} name</span>
                  <input className="min-w-0 flex-1 bg-transparent border-0 outline-none rounded-[6px] px-1 -mx-1 h-8 text-[15px] font-semibold text-text focus:bg-subtle"
                    value={pg.title} maxLength={80} onChange={(e) => rename(pi, e.target.value)} data-page-name="" />
                  <PenIcon size={13} className="text-faint" />
                </label>
                <span className="text-caption text-muted tabular-nums whitespace-nowrap">{pg.ids.length} {pg.ids.length === 1 ? "block" : "blocks"}</span>
                <button type="button" aria-label={`Remove page ${pi + 1}`} title={pages.length > 1 ? "Remove page (its blocks move up)" : "A dashboard needs a page"} disabled={pages.length < 2} onClick={() => removePage(pi)} className={iconBtn}>
                  <CloseIcon size={14} />
                </button>
              </div>
              {!pg.ids.length && <div className="px-4 py-5 text-caption text-muted text-center">Empty page. Move blocks here with the arrows or by dragging, or add one below.</div>}
              {pg.ids.map((id, ri) => {
                const b = blocks[id];
                if (!b) return null;
                const tone = originTone(b.origin);
                const gi = flat.indexOf(id);
                return (
                  <div key={id} draggable data-arrange-block={b.title}
                    onDragStart={(e: DragEvent) => { dragId.current = id; e.dataTransfer.effectAllowed = "move"; }}
                    onDragOver={(e: DragEvent) => e.preventDefault()}
                    onDrop={(e: DragEvent) => { e.preventDefault(); e.stopPropagation(); dropAt(pi, id); }}
                    className="flex items-center gap-3 pl-2 pr-2 py-1.5 border-b border-subtle hover:bg-subtle/40 transition-colors"
                    style={{ background: flash === id ? "rgb(var(--color-kind-dashboard-fill) / 0.5)" : undefined }}>
                    <span className="text-faint cursor-grab" title="Drag to move"><GripIcon size={15} /></span>
                    <span className="w-8 h-8 shrink-0 rounded-[9px] grid place-items-center" style={{ color: tone.fg, background: tone.bg }}><VisualIcon visual={b.visual} /></span>
                    <span className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-baseline sm:gap-2">
                      <span className="text-ui font-medium text-text truncate">{b.title}</span>
                      <span className="text-caption text-muted truncate">{b.how}</span>
                    </span>
                    <span className="hidden sm:inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium whitespace-nowrap" style={{ color: tone.fg }} data-origin={b.origin}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: tone.fg }} />{tone.label}
                    </span>
                    <span className="flex items-center">
                      <button type="button" aria-label={`Move ${b.title} up`} disabled={gi === 0} onClick={() => move(pi, ri, -1)} className={iconBtn} data-move-up=""><UpIcon size={14} /></button>
                      <button type="button" aria-label={`Move ${b.title} down`} disabled={gi === flat.length - 1} onClick={() => move(pi, ri, 1)} className={iconBtn} data-move-down=""><DownIcon size={14} /></button>
                      <button type="button" aria-label={`Remove ${b.title}`} onClick={() => removeBlock(pi, id)} className={iconBtn} data-remove-block=""><CloseIcon size={14} /></button>
                    </span>
                  </div>
                );
              })}
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="w-8 h-8 shrink-0 rounded-[9px] grid place-items-center text-muted border border-dashed border-border-strong">
                  {adding === pg.key ? <Spinner /> : <PlusIcon size={14} />}
                </span>
                <label className="flex-1 min-w-0">
                  <span className="sr-only">Add a block to page {pi + 1}</span>
                  <input className="w-full bg-transparent border-0 outline-none text-ui text-text placeholder:text-faint h-8" data-add-block-input=""
                    placeholder="Add a block to this page, e.g. engaged sessions by device" value={drafts[pg.key] || ""} maxLength={300} disabled={Boolean(adding)}
                    onChange={(e) => setDrafts((d) => ({ ...d, [pg.key]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addBlock(pi); } }} />
                </label>
                {(drafts[pg.key] || "").trim().length > 2 && (
                  <button type="button" onClick={() => void addBlock(pi)} disabled={Boolean(adding)} data-add-block=""
                    className="ui-focus h-8 px-3 rounded-[9px] text-caption font-semibold bg-kind-dashboard-fill text-kind-dashboard border border-kind-dashboard-border disabled:opacity-50">
                    {adding === pg.key ? "Checking…" : "Add"}
                  </button>
                )}
              </div>
              {addError?.key === pg.key && <div role="alert" className="px-4 pb-3 text-caption text-danger">{addError.text}</div>}
            </section>
          ))}
          {(plan.skipped.length > 0 || removed.length > 0) && (
            <div className="flex items-start gap-2 flex-wrap text-caption text-muted px-1 pb-1" data-skipped="">
              {plan.skipped.length > 0 && (
                <span className="inline-flex items-start gap-1.5 min-w-0">
                  <ZapIcon size={13} className="mt-[2px] text-warning" />
                  <span>Left out: {plan.skipped.map((s, i) => (
                    <span key={s.title}>{i > 0 && "; "}<b className="text-secondary font-medium">{s.title}</b>, {s.reason.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}</span>
                  ))}.</span>
                </span>
              )}
              {removed.map((id) => blocks[id] && (
                <button key={id} type="button" onClick={() => restore(id)} data-restore=""
                  className="ui-focus inline-flex items-center gap-1 h-6 px-2 rounded-full border border-border text-[11.5px] text-secondary hover:text-text">
                  <UndoIcon size={11} />{blocks[id].title}
                </button>
              ))}
            </div>
          )}
        </div>
        {alert}
        <div className="mt-4 px-6 sm:px-7 py-4 border-t border-border flex items-center gap-3 flex-wrap">
          <button type="button" className="btn-secondary text-sm" onClick={() => { setStep("choose"); setError(""); }} disabled={busy}>← Back</button>
          <span className="flex-1" />
          <button type="button" onClick={() => void build(plan, pages)} disabled={busy || total === 0} className={primaryBtn} data-build-thread-dashboard="">
            <LayersIcon size={15} />Build dashboard · {total} {total === 1 ? "block" : "blocks"}
          </button>
        </div>
      </Modal>
    );
  }

  // ---- step 1: choose -----------------------------------------------------------------------
  const source = candidates.find((c) => c.id === sourceId);
  const subs: Record<ThreadPlanMode, string> = {
    auto: "Your answers plus what they miss, each in the chart that reads best. Built straight away.",
    arrange: "See the plan first: move blocks between pages, rename pages, add your own.",
    answers: `Just the ${viewsInAnswers} ${viewsInAnswers === 1 ? "chart" : "charts"} from ${chosen.length === 1 ? "this answer" : "these answers"}. Nothing added.`,
  };
  return (
    <Modal open={open} onClose={onClose} busy={busy} width={760}>
      {header(several ? "Create a dashboard from this thread" : "Create a dashboard from this answer", "Your answers come along. Add anything else you want on it.")}
      <div className="px-6 sm:px-7 pt-1 flex flex-col gap-4">
        <div className={`rounded-[18px] border border-border-strong bg-base transition-[border-color,opacity] focus-within:border-kind-dashboard-border ${mode === "answers" ? "opacity-60" : ""}`}>
          <label className="sr-only" htmlFor="thread-dash-purpose">Anything else it should show?</label>
          <textarea id="thread-dash-purpose" ref={purposeRef} rows={2} maxLength={600} value={purpose} onChange={(e) => setPurpose(e.target.value)} disabled={busy || mode === "answers"}
            placeholder="Anything else it should show? e.g. revenue by channel, top landing pages"
            className="block w-full min-h-[56px] resize-none bg-transparent border-0 outline-none px-4 pt-3.5 pb-1 text-[15.5px] leading-[23px] text-text placeholder:text-faint" />
          <div className="flex items-center gap-2 px-3 pb-3 pt-1 flex-wrap">
            {recent.map((r) => {
              const on = picked.includes(r.id);
              return (
                <button key={r.id} type="button" aria-pressed={on} disabled={busy} data-answer-chip={`Q${numberOf(r.id)}`}
                  onClick={() => setPicked((cur) => (cur.includes(r.id) ? (cur.length > 1 ? cur.filter((x) => x !== r.id) : cur) : [...cur, r.id]))}
                  title={on ? "On the dashboard - click to leave it out" : "Left out - click to include"}
                  className={`ui-focus inline-flex items-center gap-1.5 h-8 pl-2 pr-2.5 rounded-full border text-caption transition-colors max-w-full ${on ? "border-kind-answer-border bg-kind-answer-fill/60 text-text" : "border-border text-muted line-through"}`}>
                  <span className="w-4 h-4 rounded-[4px] grid place-items-center text-[rgb(var(--color-base))]" style={{ background: on ? "rgb(var(--color-kind-answer))" : "transparent", boxShadow: on ? undefined : "inset 0 0 0 1.5px rgb(var(--color-border-strong))" }}>
                    {on && <CheckIcon size={10} />}
                  </span>
                  <span className="truncate max-w-[220px]">{shortTitle(r)}</span>
                </button>
              );
            })}
            <span className="flex-1" />
            {candidates.length > 1 ? (
              <select aria-label="Computes live on" className="h-8 rounded-full border border-border bg-transparent px-2.5 text-caption text-secondary" value={sourceId} onChange={(e) => setSourceId(e.target.value)} disabled={busy}>
                {candidates.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-caption text-muted truncate max-w-[220px]" title="Computes live on">{source?.name}</span>
            )}
          </div>
        </div>
        <div role="radiogroup" aria-label="How should it be built?" className="flex flex-col gap-2">
          {MODES.map((m) => {
            const on = mode === m.id;
            return (
              <button key={m.id} type="button" role="radio" aria-checked={on} disabled={busy} onClick={() => setMode(m.id)} data-mode={m.id}
                className={`ui-focus flex items-center gap-3.5 px-4 py-3 rounded-[14px] border text-left transition-[border-color,background-color,box-shadow] ${on ? "border-kind-dashboard-border bg-kind-dashboard-fill/35 shadow-[0_0_0_4px_rgb(var(--color-kind-dashboard)/0.07)]" : "border-border bg-base/40 hover:border-border-strong"}`}>
                <span className="w-[18px] h-[18px] rounded-full shrink-0 transition-shadow" style={{ boxShadow: `inset 0 0 0 ${on ? 5 : 1.5}px rgb(var(--color-kind-dashboard))` }} />
                <Badge tone={m.tone}>{m.icon}</Badge>
                <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="flex items-center gap-2 flex-wrap">
                    <b className="text-[15px] font-semibold text-text">{m.title}</b>
                    {m.id === "auto" && <span className="inline-flex items-center h-5 px-2 rounded-full text-[11px] font-semibold border border-kind-dashboard-border bg-kind-dashboard-fill text-kind-dashboard">Recommended</span>}
                  </span>
                  <span className="text-caption text-muted">{subs[m.id]}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {alert}
      <div className="mt-5 px-6 sm:px-7 py-3.5 border-t border-border flex items-center gap-3 flex-wrap">
        <span className="flex-1 min-w-[180px] text-caption text-muted" aria-live="polite">
          {busy ? "Planning the blocks…" : `${chosen.length} of ${recent.length} ${recent.length === 1 ? "answer" : "answers"} · private to you until you share it`}
        </span>
        <button type="button" className="btn-secondary text-sm" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" onClick={() => void go()} disabled={busy || !chosen.length || !sourceId} className={primaryBtn} data-create-thread-dashboard="">
          {busy ? <Spinner /> : <LayersIcon size={15} />}
          {busy ? "Planning…" : mode === "arrange" ? "Review the plan  →" : "Build dashboard  →"}
        </button>
      </div>
    </Modal>
  );
}
