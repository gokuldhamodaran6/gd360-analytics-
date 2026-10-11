// 2026-10-11 (round 24): what Euliv shows under what it says - in the popup
// (components/Euliv.tsx) and on a saved talk (pages/TalkPage.tsx).
//
//   plan      "So: <what> for <period>, from <data>" - the numbered data list,
//             ticked live as the person speaks ("one and three", "add Shopify"),
//             the period, and Go ahead. Read-only once the talk has moved on.
//   fix_date  "January 20258 - did you mean 2025?" with one-tap years.
//   answer    the answer, right here: numbers, then the whole result (charts,
//             causes) opened in place - no trip to another page. "Open as a
//             page" is there for whoever wants the full thread.
//   connect / explain / mic  as before.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { EulivAnswer, EulivConnect, EulivTurn, PlanCard } from "../api/assistant";
import { projectsApi, type CheckIssue, type CheckPeriod, type ProjectRun } from "../api/projects";
import { ResultsTab } from "../project/RunPanels";
import { Spinner } from "../thread/parts";
import { QuestionEditor, SourceChoiceList } from "./QuestionCheck";

export type Card =
  | { type: "plan"; plan: PlanCard; live: boolean }
  | { type: "fix_date"; issue: CheckIssue; live: boolean }
  | { type: "rephrase"; question: string; live: boolean }
  | { type: "connect"; connect: EulivConnect; opened: boolean; done?: boolean }
  | { type: "answer"; data: EulivAnswer; runId?: string }
  | { type: "explain"; data: NonNullable<EulivTurn["explain"]> }
  | { type: "mic"; reason: string; label: string };

export type CardHandlers = {
  onPick: (text: string) => void;
  onConnect?: (c: EulivConnect) => void;
  onClose?: () => void;
  onToggle?: (id: string) => void;
  onGo?: () => void;
  onPeriod?: (p: CheckPeriod) => void;
  onExpand?: (open: boolean) => void;
  /** the question was edited before running (round 25) */
  onRephrase?: (text: string) => void;
  /** a saved talk: nothing is live, links don't close anything */
  readOnly?: boolean;
};

/** A saved talk's card (backend chart_spec.euliv) -> the card shown. */
export function cardFromSaved(c: any): Card | undefined {
  if (!c || typeof c !== "object") return undefined;
  if (c.type === "plan") return { type: "plan", plan: c as PlanCard, live: false };
  if (c.type === "fix_date" && c.issue) return { type: "fix_date", issue: c.issue, live: false };
  if (c.type === "rephrase") return undefined;
  if (c.type === "connect" && c.connect) return { type: "connect", connect: c.connect, opened: true };
  if (c.type === "explain") return { type: "explain", data: c };
  if (c.type === "answer") return { type: "answer", data: { status: c.status, link: c.link, card: c.card, missing: c.missing }, runId: c.run_id };
  return undefined;
}

export function EulivCardView({ card, h }: { card: Card; h: CardHandlers }) {
  if (card.type === "plan") return <PlanView card={card} h={h} />;
  if (card.type === "rephrase") {
    return card.live && !h.readOnly ? <QuestionEditor question={card.question} onSave={(t) => h.onRephrase?.(t)} autoFocus /> : null;
  }
  if (card.type === "fix_date") {
    return (
      <div className="flex flex-wrap gap-2" data-euliv-fixdate="">
        {card.issue.options.map((o) => (
          <button key={o.id} type="button" disabled={!card.live || h.readOnly} onClick={() => h.onPick(o.value)}
            className="ui-focus h-10 px-4 rounded-full border border-border-strong bg-base/40 text-[14px] font-medium text-text hover:border-kind-answer-border hover:bg-kind-answer-fill/60 disabled:opacity-50 disabled:hover:bg-transparent"
            data-euliv-year={o.value}>
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  if (card.type === "connect") {
    const c = card.connect;
    if (h.readOnly) {
      return <span className="text-[12.5px] text-muted">Offered to connect {c.label}.</span>;
    }
    return (
      <div className="rounded-[18px] border border-border bg-base/40 p-4 flex flex-wrap items-center gap-3" data-euliv-connect={c.kind || ""}>
        <span className="flex-1 min-w-[180px] text-ui text-secondary leading-snug">
          {card.done ? (
            <><b className="text-kind-answer">{c.label} is connected.</b> Carrying on with your question…</>
          ) : (
            <>{c.kind ? <>Connect <b className="text-text">{c.label}</b></> : <>Add <b className="text-text">{c.label}</b></>} - it opens in a new tab, and Euliv picks up here when it's done.</>
          )}
        </span>
        {!card.done && (
          <>
            <a href={c.url} target="_blank" rel="noopener" onClick={() => h.onConnect?.(c)}
              className="ui-focus h-10 px-4 rounded-full bg-primary text-on-primary text-ui font-medium inline-flex items-center" data-euliv-connect-open="">
              {c.kind ? `Connect ${c.label}` : "Upload a file"}
            </a>
            <button type="button" onClick={() => h.onPick("use what's connected")} className="ui-focus h-10 px-3 rounded-full text-ui text-secondary hover:text-text hover:bg-subtle/60">
              Use what's connected
            </button>
          </>
        )}
      </div>
    );
  }
  if (card.type === "mic") {
    return (
      <div className="rounded-[18px] border border-warning/40 bg-warning/10 p-4 flex flex-col gap-2 text-ui text-secondary" data-euliv-mic={card.reason}>
        <b className="text-warning">Microphone check</b>
        <ul className="m-0 pl-4 flex flex-col gap-1 leading-snug list-disc">
          {card.reason === "blocked" ? (
            <>
              <li>Click the lock (or mic) icon at the left of the address bar.</li>
              <li>Set Microphone to <b className="text-text">Allow</b>, then tap the orb again.</li>
            </>
          ) : card.reason === "in-use" ? (
            <>
              <li>Close Zoom, Teams, Meet or any other app using the microphone.</li>
              <li>Then tap the orb again.</li>
            </>
          ) : (
            <>
              <li>Is the microphone plugged in (or your headset connected)?</li>
              <li>Is it muted - a switch on the headset, or in your computer's sound settings?</li>
              <li>Is the right microphone chosen in your browser's site settings?</li>
            </>
          )}
        </ul>
        {card.label && card.reason !== "silent" && <span className="text-[12px] text-muted">Listening to: {card.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "")}</span>}
        <span className="text-[12px] text-muted">Euliv settings › Test microphone shows whether it can hear you.</span>
      </div>
    );
  }
  if (card.type === "explain") {
    const d = card.data;
    return (
      <div className="rounded-[18px] border border-border bg-base/40 p-4 flex flex-col gap-2.5" data-euliv-explain="">
        {(d.points || []).length > 0 && (
          <ul className="m-0 pl-4 flex flex-col gap-1.5 text-ui text-secondary leading-snug list-disc">
            {d.points.map((p, i) => <li key={i}>{p.text}</li>)}
          </ul>
        )}
        {d.takeaway && <span className="text-ui text-text">{d.takeaway}</span>}
        {!h.readOnly && (d.followups || []).length > 0 && (
          <div className="flex flex-wrap gap-2">
            {d.followups.map((q) => (
              <button key={q} type="button" onClick={() => h.onPick(q)} className="ui-focus h-9 px-3 rounded-full border border-border text-[13px] text-secondary hover:text-text hover:border-border-strong">{q}</button>
            ))}
          </div>
        )}
      </div>
    );
  }
  return <AnswerView card={card} h={h} />;
}

function PlanView({ card, h }: { card: Extract<Card, { type: "plan" }>; h: CardHandlers }) {
  const p = card.plan;
  const live = card.live && !h.readOnly;
  if (!live) {
    // settled: one quiet line - what was agreed at that point, and with which data
    const chosen = p.options.filter((o) => (p.selected || []).includes(o.id));
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-[14px] border border-border bg-base/20 px-3.5 py-2.5" data-euliv-plan="done">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">Agreed</span>
        {chosen.length ? chosen.map((o) => (
          <span key={o.id} className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full bg-subtle text-[12px] text-text">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-kind-answer"><path d="M5 12l5 5L20 7" /></svg>
            {o.name}
          </span>
        )) : <span className="text-[12px] text-muted">No data picked yet</span>}
        {p.period && <span className="text-[12px] text-secondary">· {p.period.text}</span>}
      </div>
    );
  }
  const rows = p.options.map((o) => ({ id: o.id, name: o.name, label: o.label, says: o.says || o.note, fit: o.fit, recommended: o.recommended }));
  const sel = p.selected || [];
  const picked = p.options.filter((o) => sel.includes(o.id));
  const canGo = !p.needs_pick || sel.length > 0 || p.mode === "shift";
  return (
    <div className={`rounded-[20px] border bg-base/30 overflow-hidden ${live ? "border-border-strong" : "border-border opacity-[0.92]"}`} data-euliv-plan={live ? "live" : "done"}>
      {p.question && <AskedLine question={p.question} onSave={h.onRephrase} />}
      <div className="px-4 pt-3.5 pb-3 flex flex-col gap-1 border-b border-border">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">{live ? "What I'll do" : "Agreed"}</span>
        <span className="text-[14.5px] leading-snug text-text" data-euliv-restated="">{p.restated}</span>
      </div>
      <div className="p-3 flex flex-col gap-2.5">
        {rows.length > 0 && (
          <SourceChoiceList rows={rows} selected={sel} onToggle={live ? h.onToggle : undefined} numbered compact disabled={!live} />
        )}
        {live && p.period_options && p.period_options.length > 1 && (
          <div className="flex flex-wrap gap-2 px-0.5" role="group" aria-label="Period">
            {p.period_options.map((o) => {
              const on = p.period?.start === o.start && p.period?.end === o.end;
              return (
                <button key={o.key || o.start} type="button" onClick={() => h.onPeriod?.(o)} aria-pressed={on}
                  className={`ui-focus h-8 px-3 rounded-full border text-[12.5px] ${on ? "border-kind-answer-border bg-kind-answer-fill text-text" : "border-border text-secondary hover:text-text"}`}>
                  {o.text} <span className="text-muted">· {o.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {live && (
        <div className="px-3 pb-3 flex items-center gap-2 flex-wrap">
          <button type="button" onClick={h.onGo} disabled={!canGo}
            className="ui-focus h-10 px-4 rounded-full bg-primary text-on-primary text-[13.5px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-40" data-euliv-go="">
            Go ahead
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
          <button type="button" onClick={() => h.onPick("show all my data")} className="ui-focus h-10 px-3 rounded-full text-[13px] text-secondary hover:text-text hover:bg-subtle/60" data-euliv-showall="">
            Show all my data
          </button>
          <span className="ml-auto text-[11.5px] text-faint hidden sm:inline">
            {picked.length ? `${picked.length} selected · ` : ""}say “one and three”, “add …”, “remove …”
          </span>
        </div>
      )}
    </div>
  );
}

/** "You asked: …  Edit" - the question itself, changeable before anything runs. */
function AskedLine({ question, onSave }: { question: string; onSave?: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing && onSave) {
    return (
      <div className="px-4 pt-3.5 pb-3 border-b border-border">
        <QuestionEditor question={question} autoFocus onSave={(t) => { setEditing(false); onSave(t); }} onCancel={() => setEditing(false)} />
      </div>
    );
  }
  return (
    <div className="px-4 pt-3.5 pb-3 flex items-start gap-3 border-b border-border" data-euliv-asked="">
      <span className="flex-1 min-w-0 flex flex-col gap-1">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">You asked</span>
        <span className="text-[14.5px] leading-snug text-secondary">“{question}”</span>
      </span>
      {onSave && (
        <button type="button" onClick={() => setEditing(true)} className="ui-focus shrink-0 h-8 px-3 rounded-full border border-border text-[12.5px] text-secondary hover:text-text hover:border-border-strong inline-flex items-center gap-1.5" data-euliv-edit-question="">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
          Edit
        </button>
      )}
    </div>
  );
}

function AnswerView({ card, h }: { card: Extract<Card, { type: "answer" }>; h: CardHandlers }) {
  const a = card.data;
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState<ProjectRun | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open || run || !card.runId) return;
    projectsApi.run(card.runId).then(setRun).catch(() => setErr("Couldn't load the full answer - open it as a page instead."));
  }, [open, run, card.runId]);

  if (a.status === "needs_input") {
    return a.missing ? <p className="m-0 text-[13px] text-secondary leading-relaxed border-l-2 border-warning-border pl-3" data-euliv-missing="">{a.missing}</p> : null;
  }
  if (a.status !== "done" || !a.card) {
    return (
      <Link to={a.link} onClick={h.readOnly ? undefined : h.onClose} className="text-ui text-kind-analysis hover:underline" data-euliv-failed="">
        See what happened →
      </Link>
    );
  }
  const c = a.card;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    h.onExpand?.(next);
  };
  return (
    <div className="flex flex-col gap-3" data-euliv-answer="">
      {!open && c.kpis.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {c.kpis.map((k, i) => (
            <div key={i} className="rounded-[14px] border border-border bg-base/40 p-3 flex flex-col gap-0.5 min-w-0">
              <span className="text-[10.5px] uppercase tracking-[0.08em] text-muted truncate">{k.label}</span>
              <span className="text-[20px] font-semibold font-mono tabular-nums text-text truncate">{k.display}</span>
              {k.delta && <span className={`text-[12px] ${k.dir === "up" ? "text-good" : k.dir === "down" ? "text-danger" : "text-secondary"}`}>{k.delta}{k.note ? ` ${k.note}` : ""}</span>}
            </div>
          ))}
        </div>
      )}
      {!open && c.answer && c.answer !== c.headline && !(a.say || "").includes(c.answer.slice(0, 120)) && (
        <p className="m-0 text-ui text-secondary leading-relaxed line-clamp-4">{c.answer}</p>
      )}
      {open && (
        <div className="rounded-[18px] border border-border bg-base/30 p-3 sm:p-4 flex flex-col gap-3" data-euliv-full="">
          {c.answer && <p className="m-0 text-[14.5px] text-secondary leading-relaxed">{c.answer}</p>}
          {run ? <ResultsTab run={run} /> : err ? <span className="text-ui text-warning">{err}</span> : (
            <span className="inline-flex items-center gap-2 text-ui text-secondary"><Spinner /> Loading the charts…</span>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {card.runId && (
          <button type="button" onClick={toggle} aria-expanded={open}
            className="ui-focus h-9 px-4 rounded-full border border-border-strong text-[13px] text-text hover:bg-subtle/60 inline-flex items-center gap-1.5" data-euliv-open-answer="">
            {open ? "Show less" : "See the full answer"}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`transition-transform ${open ? "rotate-180" : ""}`}><path d="M6 9l6 6 6-6" /></svg>
          </button>
        )}
        {!h.readOnly && c.next_questions.map((q) => (
          <button key={q} type="button" onClick={() => h.onPick(q)} className="ui-focus h-9 px-3 rounded-full border border-border text-[13px] text-secondary hover:text-text hover:border-border-strong">{q}</button>
        ))}
        <Link to={a.link} onClick={h.readOnly ? undefined : h.onClose} className="ui-focus h-9 px-2 rounded-full text-[12.5px] text-muted hover:text-text inline-flex items-center gap-1" data-euliv-open-page="">
          Open as a page
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg>
        </Link>
      </div>
      {(c.sources_used.length > 0 || c.period) && (
        <span className="text-[12px] text-muted">
          {c.sources_used.length > 0 ? `From ${c.sources_used.join(", ")}` : ""}
          {c.period ? `${c.sources_used.length ? " · " : ""}${c.period.text}` : ""}
        </span>
      )}
    </div>
  );
}
