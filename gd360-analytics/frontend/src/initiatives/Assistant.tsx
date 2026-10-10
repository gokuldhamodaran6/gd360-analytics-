// The initiative assistant: answers from the plan, the team's updates,
// tracking and results; acts when asked (tasks, reminders, logging, drafts);
// points to connected data with a ready question.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { errorText, Initiative, initiativesApi } from "../api/initiatives";
import { askHref } from "./OverviewTab";

type Msg = { role: string; content: string; actions?: { type: string; text: string; source_id?: string; question?: string }[] };

const SUGGEST: Record<string, string[]> = {
  event: ["What's happening today?", "Who still needs a follow-up?", "Are we on pace for registrations?", "Draft a reminder for people who haven't registered"],
  webinar: ["How is registration pacing?", "Draft a follow-up for no-shows", "What should we post this week?"],
  hiring: ["Where is the pipeline stuck?", "Which roles are at risk?", "Remind me to chase interview feedback on Friday"],
  product: ["What's blocking launch?", "What's waiting for approval?", "Summarise this week for leadership"],
  default: ["What's happening today?", "What's at risk?", "Summarise progress for my manager"],
};

export default function Assistant({ open, onClose, i, onActed }: { open: boolean; onClose: () => void; i: Initiative; onActed: () => void }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || msgs) return;
    initiativesApi.assistantHistory(i.id).then((h) => setMsgs(h.map((m) => ({ role: m.role, content: m.content, actions: m.actions })))).catch(() => setMsgs([]));
  }, [open, msgs, i.id]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs, busy]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);

  const send = async (m?: string) => {
    const q = (m ?? text).trim();
    if (!q || busy) return;
    setText(""); setErr("");
    setMsgs((x) => [...(x || []), { role: "user", content: q }]);
    setBusy(true);
    try {
      const r = await initiativesApi.ask(i.id, q);
      setMsgs((x) => [...(x || []), { role: "assistant", content: r.reply, actions: r.actions }]);
      if (r.actions.some((a) => a.type !== "ask_data")) onActed();
    } catch (e) { setErr(errorText(e, "The assistant couldn't answer just now.")); } finally { setBusy(false); }
  };

  if (!open) return null;
  const sugg = SUGGEST[i.kind] || SUGGEST.default;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Assistant">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative h-full w-full sm:w-[460px] bg-surface border-l border-border shadow-pop flex flex-col" data-assistant="">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="min-w-0">
            <div className="text-section font-semibold text-text">Assistant</div>
            <div className="text-caption text-muted truncate">Knows this initiative's plan, team, tracking and results</div>
          </div>
          <button type="button" className="ui-focus w-8 h-8 grid place-items-center rounded-ctl text-muted hover:text-text hover:bg-surface2" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
          {msgs && msgs.length === 0 && (
            <div className="flex flex-col gap-3">
              <p className="m-0 text-ui text-secondary">Ask anything about this initiative, or tell it what happened - “LinkedIn post live, reach 4k”, “remind me Friday to book the photographer”, “add a task to order badges”.</p>
              <div className="flex flex-col gap-1.5">{sugg.map((s) => <button key={s} type="button" className="ui-focus text-left text-ui text-text rounded-ctl border border-border px-3 py-2 hover:border-border-strong" onClick={() => send(s)}>{s}</button>)}</div>
            </div>
          )}
          {(msgs || []).map((m, k) => (
            <div key={k} className={`flex flex-col gap-1.5 ${m.role === "user" ? "items-end" : "items-start"}`}>
              <div className={`max-w-[92%] rounded-card px-3.5 py-2.5 text-ui leading-relaxed whitespace-pre-wrap ${m.role === "user" ? "bg-primary text-on-primary" : "bg-surface2 text-text"}`}>{m.content}</div>
              {(m.actions || []).map((a, j) => a.type === "ask_data" && a.source_id && a.question ? (
                <Link key={j} to={askHref(a.source_id, a.question)} className="text-caption text-primary hover:underline">Ask your data: {a.question} →</Link>
              ) : (
                <span key={j} className="text-caption text-good inline-flex items-center gap-1.5"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>{a.text}</span>
              ))}
            </div>
          ))}
          {busy && <div className="self-start rounded-card bg-surface2 px-3.5 py-2.5 text-ui text-muted animate-pulse">Thinking…</div>}
          {err && <div className="text-caption text-danger">{err}</div>}
          <div ref={end} />
        </div>
        <form className="p-4 border-t border-border flex gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input className="input text-ui" value={text} onChange={(e) => setText(e.target.value)} placeholder={i.can_edit ? "Ask or tell…" : "Ask…"} aria-label="Message" data-assistant-input="" maxLength={4000} disabled={!i.can_edit} />
          <button type="submit" className="btn-primary text-sm shrink-0" disabled={busy || !text.trim() || !i.can_edit}>Send</button>
        </form>
      </div>
    </div>
  );
}
