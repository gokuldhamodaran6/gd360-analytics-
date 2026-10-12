// 2026-10-12 (round 32): when the data can't answer a question, the answer
// never stops there - it says why in one line and offers the closest things
// the data CAN answer (from the planner's own alternatives), one tap each,
// plus connecting data that has what's missing.
import { createContext, useContext } from "react";
import { Link } from "react-router-dom";
import type { Answer } from "../api/projects";

/** How a tap on a way forward asks its question in this thread (provided by the thread page). */
export const AskContext = createContext<((question: string) => void) | null>(null);
export const useAsk = () => useContext(AskContext);

export default function WaysForward({ answer, onAsk, busy, compact = false }: {
  answer: Answer; onAsk?: ((q: string) => void) | null; busy?: boolean; compact?: boolean;
}) {
  const ctxAsk = useAsk();
  const ask = onAsk || ctxAsk;
  const opts = answer.options || [];
  const asks = opts.filter((o) => o.kind === "ask" && o.question);
  const connect = opts.find((o) => o.kind === "connect" && o.href);
  return (
    <div className={`rounded-card border border-border-strong bg-surface flex flex-col ${compact ? "gap-3 p-4" : "gap-4 p-5"}`} data-ways-forward="">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 w-7 h-7 rounded-full grid place-items-center shrink-0 bg-kind-analysis/15 text-kind-analysis" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></svg>
        </span>
        <span className="flex flex-col gap-1 min-w-0">
          <b className={`${compact ? "text-[14.5px]" : "text-section"} font-semibold text-text leading-snug`}>{answer.headline}</b>
          {answer.answer && <span className="text-ui text-secondary leading-relaxed">{answer.answer}</span>}
        </span>
      </div>
      {(asks.length > 0 || connect) && (
        <div className="flex flex-col gap-2 sm:pl-10">
          {asks.length > 0 && <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">Here's what I can do instead</span>}
          {asks.map((o, i) => (
            <button
              key={o.id}
              type="button"
              disabled={!ask || busy}
              onClick={(e) => { e.stopPropagation(); if (ask && o.question) ask(o.question); }}
              className={`ui-focus min-h-11 py-2.5 px-4 rounded-[12px] text-left text-[14.5px] leading-snug inline-flex items-center justify-between gap-3 transition-colors disabled:opacity-50 ${
                i === 0 ? "bg-kind-answer text-[rgb(var(--color-base))] font-semibold hover:opacity-95" : "border border-border-strong text-text hover:border-kind-answer-border hover:bg-kind-answer-fill/40"
              }`}
              data-way-forward={o.id}
            >
              <span>{o.label}</span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </button>
          ))}
          {connect && (
            <Link to={connect.href as string} onClick={(e) => e.stopPropagation()} className="ui-focus self-start mt-1 h-9 px-3 rounded-full text-[13px] text-secondary hover:text-text hover:bg-subtle/60 inline-flex items-center gap-2" data-way-forward="connect">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              {connect.label}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
