// 2026-10-11 (Explain & Alerts, canvas A2/A3): "explain this chart" without
// starting the analysis again.
//
//   - Every chart and every cause card in an answer has an Explain button.
//     The explanation is written from the numbers that answer already
//     computed (backend services/explain.py - no plan, no queries, about two
//     seconds) and opens right under what it explains.
//   - "Ask about this" puts the chart in the follow-up box as a chip, so the
//     next question is about it.
//   - A typed follow-up is read first: an "explain" is answered the same way
//     and shows in the conversation as a reply (no new question tab); a
//     question that needs new data starts a run, as before.
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Explanation, ExplainTarget, projectsApi } from "../api/projects";
import { CloseIcon, GdMark, Spinner } from "./parts";

type IconProps = { size?: number; className?: string };

export function SparkIcon({ size = 14, className = "" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" opacity=".7" />
    </svg>
  );
}

export function ChatIcon({ size = 14, className = "" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
    </svg>
  );
}

export const targetKey = (t: ExplainTarget) => `${t.kind}:${t.index}`;

export type AboutChip = { runId: string; target: ExplainTarget; title: string };

type Slot = { loading: boolean; error: string; data: Explanation | null; open: boolean };

export type ExplainController = {
  runId: string;
  slot: (t: ExplainTarget) => Slot;
  explain: (t: ExplainTarget) => void;
  toggle: (t: ExplainTarget) => void;
  close: (t: ExplainTarget) => void;
  askAbout?: (t: ExplainTarget, title: string) => void;
  onFollowup?: (q: string) => void;
};

const EMPTY: Slot = { loading: false, error: "", data: null, open: false };

/** Explanations for one answer. `stored` = what the thread already holds
 *  (so an explanation is still there after a reload). */
export function useExplainController({
  runId, stored, onSaved, askAbout, onFollowup,
}: {
  runId: string | null;
  stored: Explanation[];
  onSaved?: (e: Explanation) => void;
  askAbout?: (t: ExplainTarget, title: string) => void;
  onFollowup?: (q: string) => void;
}): ExplainController | null {
  const [slots, setSlots] = useState<Record<string, Slot>>({});
  useEffect(() => setSlots({}), [runId]);
  const latest = useMemo(() => {
    const m: Record<string, Explanation> = {};
    for (const e of stored) if (e.run_id === runId && !e.question) m[targetKey(e.target)] = e;
    return m;
  }, [stored, runId]);
  const slot = useCallback(
    (t: ExplainTarget): Slot => {
      const k = targetKey(t);
      const s = slots[k];
      if (s) return s.data || s.loading || s.error ? s : { ...s, data: latest[k] || null };
      return latest[k] ? { ...EMPTY, data: latest[k] } : EMPTY;
    },
    [slots, latest],
  );
  const set = (t: ExplainTarget, patch: Partial<Slot>) =>
    setSlots((cur) => ({ ...cur, [targetKey(t)]: { ...(cur[targetKey(t)] || EMPTY), ...patch } }));
  const explain = useCallback(
    async (t: ExplainTarget) => {
      if (!runId) return;
      set(t, { loading: true, error: "", open: true });
      try {
        const e = await projectsApi.explain(runId, t);
        set(t, { loading: false, data: e, open: true });
        onSaved?.(e);
      } catch (err: any) {
        const d = err?.response?.data?.detail;
        set(t, { loading: false, error: typeof d === "string" ? d : "Couldn't explain this right now. Please try again." });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runId, onSaved],
  );
  if (!runId) return null;
  return {
    runId,
    slot,
    explain,
    toggle: (t) => {
      const s = slot(t);
      if (!s.data && !s.loading) explain(t);
      else set(t, { open: !s.open, data: s.data });
    },
    close: (t) => set(t, { open: false, data: slot(t).data }),
    askAbout,
    onFollowup,
  };
}

/** Lets ResultsTab reach the controller without threading a prop through every card. */
const Ctx = createContext<ExplainController | null>(null);
export const ExplainProvider = ({ value, children }: { value: ExplainController | null; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export const useExplain = () => useContext(Ctx);

export function ExplainButton({ target, title, compact = false }: { target: ExplainTarget; title: string; compact?: boolean }) {
  const c = useExplain();
  if (!c) return null;
  const s = c.slot(target);
  const on = s.open && (s.data || s.loading);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        c.toggle(target);
      }}
      aria-expanded={Boolean(on)}
      title={s.data ? (s.open ? "Hide the explanation" : "Show the explanation") : `Explain “${title}” from the numbers already here - nothing is re-run`}
      className={`ui-focus inline-flex items-center gap-1.5 shrink-0 rounded-full border text-[12.5px] font-medium transition-colors ${
        compact ? "h-7 px-2.5" : "h-8 px-3"
      } ${on ? "border-kind-answer-border bg-kind-answer-fill text-kind-answer" : "border-border-strong text-secondary hover:text-text hover:border-kind-answer-border"}`}
      data-explain-button={targetKey(target)}
    >
      {s.loading ? <Spinner className="!w-3 !h-3" /> : <SparkIcon size={13} className="text-kind-answer" />}
      {s.data && !s.loading ? (s.open ? "Explained" : "Explanation") : "Explain"}
    </button>
  );
}

/** The explanation, right under what it explains. */
export function ExplainPanel({ target, title, className = "" }: { target: ExplainTarget; title: string; className?: string }) {
  const c = useExplain();
  if (!c) return null;
  const s = c.slot(target);
  if (!s.open || (!s.loading && !s.data && !s.error)) return null;
  return (
    <div
      className={`rounded-[14px] border border-kind-answer-border/70 bg-[rgb(var(--color-kind-answer-fill)/0.35)] p-4 flex flex-col gap-3 ${className}`}
      role="region"
      aria-label={`Explanation of ${title}`}
      aria-live="polite"
      data-explain-panel={targetKey(target)}
    >
      <div className="flex items-center gap-2 text-caption text-muted">
        <GdMark size={20} />
        <span className="text-ui font-semibold text-text">GD360</span>
        <span className="truncate">
          {s.loading ? "· reading the numbers already here…" : s.data ? `· from the numbers on screen${s.data.seconds != null ? ` · ${Math.max(0.1, s.data.seconds).toFixed(1)} s` : ""} · nothing re-run` : ""}
        </span>
        <span className="flex-1" />
        <button type="button" onClick={() => c.close(target)} className="ui-focus w-7 h-7 rounded-[8px] grid place-items-center text-muted hover:text-text" aria-label="Hide the explanation">
          <CloseIcon size={14} />
        </button>
      </div>
      {s.loading && <ExplainSkeleton />}
      {s.error && <div className="text-ui text-danger">{s.error}</div>}
      {s.data && !s.loading && <ExplainBody e={s.data} onFollowup={c.onFollowup} onAskAbout={c.askAbout ? () => c.askAbout!(target, title) : undefined} />}
    </div>
  );
}

function ExplainSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {[92, 78, 84].map((w, i) => (
        <span key={i} className="h-3.5 rounded bg-border/70 animate-pulse" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

export function ExplainBody({ e, onFollowup, onAskAbout, onRunInstead }: {
  e: Explanation; onFollowup?: (q: string) => void; onAskAbout?: () => void; onRunInstead?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3" data-explain-body="">
      <p className="m-0 text-[15px] leading-[23px] text-text font-medium">{e.headline}</p>
      <ol className="list-none m-0 p-0 flex flex-col gap-2.5">
        {e.points.map((p, i) => (
          <li key={i} className="grid grid-cols-[22px_1fr] gap-2.5 items-start">
            <span className="mt-[1px] w-[22px] h-[22px] rounded-full bg-kind-answer-fill text-kind-answer grid place-items-center font-mono text-[11px]" aria-hidden="true">{i + 1}</span>
            <span className="text-ui text-secondary leading-relaxed">{p.text}</span>
          </li>
        ))}
      </ol>
      {e.takeaway && (
        <p className="m-0 text-ui text-text leading-relaxed border-l-2 border-kind-answer pl-3">{e.takeaway}</p>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {onAskAbout && (
          <button type="button" onClick={onAskAbout} className="ui-focus inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-border-strong text-[12.5px] text-text hover:bg-subtle" data-ask-about="">
            <ChatIcon size={13} /> Ask about this
          </button>
        )}
        {onFollowup &&
          e.followups.slice(0, 2).map((q) => (
            <button key={q} type="button" onClick={() => onFollowup(q)} className="ui-focus h-8 px-3 rounded-full bg-subtle text-[12.5px] text-secondary hover:text-text max-w-full truncate">
              {q}
            </button>
          ))}
        {onRunInstead && (
          <button type="button" onClick={onRunInstead} className="ui-focus h-8 px-3 rounded-full text-[12.5px] text-muted hover:text-text underline-offset-2 hover:underline" data-run-instead="">
            Run a new analysis instead
          </button>
        )}
      </div>
      <span className="text-caption text-faint">
        {e.written_by === "numbers"
          ? "Written from the computed numbers alone."
          : "Every number above is one GD360 already computed - checked before it was shown."}
      </span>
    </div>
  );
}

/** An explanation as a reply in the conversation column. */
export function ExplainTurn({
  e, runNumber, onOpen, onFollowup, onRunInstead, canEdit,
}: {
  e: Explanation; runNumber: number; onOpen: () => void; onFollowup: (q: string) => void; onRunInstead: () => void; canEdit: boolean;
}) {
  const asked = e.question || `Explain ${e.target.kind === "answer" ? "the answer" : `“${e.title}”`}`;
  return (
    <div className="flex flex-col gap-3" data-explain-turn={e.id || ""}>
      <div className="self-end max-w-[88%] flex flex-col items-end gap-1">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-faint inline-flex items-center gap-1.5">
          <SparkIcon size={10} /> About Q{runNumber}
        </span>
        <div className="bg-surface2 rounded-[16px_16px_4px_16px] px-4 py-3 text-[15px] leading-[22px] text-text">{asked}</div>
      </div>
      <div className="rounded-[16px] p-3.5 -mx-1 flex flex-col gap-3 border border-border bg-surface">
        <div className="flex items-center gap-2 text-caption text-muted">
          <GdMark />
          <span className="text-ui font-semibold text-text">GD360</span>
          <span className="truncate">· explained from Q{runNumber}'s numbers{e.seconds != null ? ` · ${Math.max(0.1, e.seconds).toFixed(1)} s` : ""}</span>
        </div>
        <ExplainBody e={e} onFollowup={canEdit ? onFollowup : undefined} onRunInstead={canEdit && e.question ? onRunInstead : undefined} />
        <button type="button" onClick={onOpen} className="ui-focus self-start text-ui font-medium text-kind-answer hover:underline">
          {e.target.kind === "answer" ? "View the answer →" : `Show ${e.target.kind === "cause" ? "the cause" : "the chart"} →`}
        </button>
      </div>
    </div>
  );
}

/** "Ask about: Where the −$341.9k change came from ×" above the follow-up box. */
export function AboutChipView({ chip, onClear }: { chip: AboutChip; onClear: () => void }) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-[10px] bg-kind-answer-fill/60 text-[12px] leading-snug text-kind-answer" data-about-chip="">
      <SparkIcon size={12} />
      <span className="flex-1 min-w-0 truncate">
        About <b className="font-semibold">{chip.title}</b> · answered from the numbers already here
      </span>
      <button type="button" onClick={onClear} className="ui-focus w-6 h-6 rounded-[7px] grid place-items-center text-muted hover:text-text" aria-label="Clear">
        <CloseIcon size={12} />
      </button>
    </div>
  );
}

/** Conversation order: questions and explanations by when they were asked. */
export function timeline<R extends { id: string; created_at: string }>(runs: R[], explains: Explanation[]) {
  const runIds = new Set(runs.map((r) => r.id));
  const items: ({ type: "run"; at: string; run: R } | { type: "explain"; at: string; explain: Explanation })[] = [
    ...runs.map((r) => ({ type: "run" as const, at: (r.created_at || "").replace(/Z$/, ""), run: r })),
    ...explains.filter((e) => runIds.has(e.run_id) && e.question).map((e) => ({ type: "explain" as const, at: (e.created_at || "").replace(/Z$/, ""), explain: e })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

/** Scrolls the answer to what an explanation is about. */
export function scrollToTarget(t: ExplainTarget) {
  window.setTimeout(() => {
    const el = document.querySelector(`[data-explain-anchor="${targetKey(t)}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 120);
}
