import { useEffect, useRef, useState } from "react";
import { gokuApi, GokuMessage } from "../api/client";

// Goku: the guided, beginner-friendly AI helper that lives ONLY inside the
// Workspace page - a separate, dedicated helper from the main "Ask GD360"
// analysis chat next to it. Its whole job is to take someone with zero
// data-analytics background and walk them, step by step in plain
// language, from "I have this data" to the result they actually want -
// telling them what to clean first, what to explore next, and handing
// them a ready-to-run question for the main chat when that helps. Goku
// never computes anything itself - see backend routers/goku.py and
// services/ai_engine.py goku_chat.
export default function GokuChat({
  datasourceId, sourceIds, busy, onRunInMainChat,
}: {
  datasourceId: string;
  // The same WORKING ON selection driving the main chat, so Goku reasons
  // about whichever table(s) are currently selected, not stale data.
  sourceIds: string[];
  // True while the main Ask GD360 chat is busy running something - Goku
  // avoids sending a new prompt into it at the same time.
  busy: boolean;
  // Runs a prompt in the main "Ask GD360" chat and resolves once it has
  // genuinely finished, true on success / false on failure - so Goku can
  // wait for the real result before following up, instead of guessing.
  onRunInMainChat: (prompt: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<GokuMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // The prompt behind an action-prompt click that did not complete, so the
  // Retry button (shown alongside the error) knows exactly what to redo.
  const [retryPrompt, setRetryPrompt] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A different data source means a different Goku conversation entirely -
  // drop whatever was loaded so reopening fetches the right one instead of
  // showing the previous data source history.
  useEffect(() => {
    setMessages([]);
    setLoaded(false);
    setError("");
  }, [datasourceId]);

  useEffect(() => {
    if (!open || loaded) return;
    gokuApi
      .getMessages(datasourceId)
      .then((data) => {
        setMessages(data.messages);
        setLoaded(true);
      })
      .catch(() => setError("Could not load Goku right now. Please try again."));
  }, [open, loaded, datasourceId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const send = async (message?: string) => {
    const toSend = (message ?? text).trim();
    if (!toSend || sending) return;
    setError("");
    setRetryPrompt(null);
    setText("");
    setMessages((m) => [
      ...m,
      { id: `local-${Date.now()}`, role: "user", content: toSend, action_prompts: null, created_at: new Date().toISOString() },
    ]);
    setSending(true);
    try {
      const reply = await gokuApi.chat(datasourceId, toSend, sourceIds.length ? sourceIds : null);
      setMessages((m) => [...m, reply]);
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Goku could not respond. Please try again.");
    } finally {
      setSending(false);
    }
  };

  // Clicking one of Goku's suggested next-step buttons used to just fire
  // the prompt into the main chat silently, with no sign in Goku's own
  // conversation that anything happened, and no automatic follow-up once
  // it finished - the person had to come back and ask Goku again to find
  // out. This instead: (1) echoes the click as a sent message right here
  // in Goku's own pane, exactly like typing it would, (2) waits for the
  // main chat to genuinely finish, then (3) automatically asks Goku the
  // same thing for real - which persists it and, because the main-chat
  // step has now genuinely completed, lets Goku open with a real "Done"
  // confirmation and hand over the next step (see GOKU_SYSTEM_PROMPT /
  // main_chat_status on the backend). Any failure along the way leaves a
  // Retry button in place rather than silently going nowhere.
  const runActionPrompt = async (prompt: string) => {
    if (sending || busy) return;
    setError("");
    setRetryPrompt(null);
    setMessages((m) => [
      ...m,
      { id: `local-${Date.now()}`, role: "user", content: prompt, action_prompts: null, created_at: new Date().toISOString() },
    ]);
    setSending(true);
    try {
      const ranOk = await onRunInMainChat(prompt);
      if (!ranOk) {
        setError("That did not complete in the main chat, so I have not followed up yet.");
        setRetryPrompt(prompt);
        return;
      }
      try {
        const reply = await gokuApi.chat(datasourceId, prompt, sourceIds.length ? sourceIds : null);
        setMessages((m) => [...m, reply]);
      } catch (err: any) {
        // The main-chat step itself succeeded - only Goku's own follow-up
        // failed - so say that precisely rather than implying the result
        // itself is in doubt.
        setError(err?.response?.data?.detail || "That finished in the main chat, but Goku could not follow up just now.");
        setRetryPrompt(prompt);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label={open ? "Close Goku" : "Open Goku, your data assistant"}
        className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full bg-gradient-to-br from-primary to-accent text-white shadow-lg flex items-center justify-center hover:opacity-90 transition"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <span className="text-2xl leading-none">&times;</span>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        )}
      </button>

      {open && (
        <div className="fixed bottom-24 right-6 z-40 w-[92vw] max-w-sm h-[70vh] max-h-[560px] card flex flex-col shadow-xl">
          <div className="p-4 border-b border-border flex items-center gap-2.5 shrink-0">
            <span className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white font-bold text-sm shrink-0">
              G
            </span>
            <div className="min-w-0">
              <div className="font-semibold text-sm">Goku</div>
              <div className="text-[11px] text-muted">Your guide for this data</div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
            {!loaded && !error && <div className="text-sm text-muted px-1">Loading Goku...</div>}
            {messages.map((m, i) => (
              <div key={m.id || i} className={`max-w-[92%] ${m.role === "user" ? "ml-auto" : ""}`}>
                <div
                  className={`rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap ${
                    m.role === "user" ? "bg-primary text-white rounded-br-sm" : "bg-surface2 border border-border rounded-bl-sm"
                  }`}
                >
                  {m.content}
                </div>
                {m.role === "assistant" && m.action_prompts && m.action_prompts.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {m.action_prompts.map((a, ai) => (
                      <button
                        key={ai}
                        type="button"
                        className="text-xs px-2.5 py-1.5 rounded-lg btn-secondary font-medium text-left"
                        disabled={busy || sending}
                        onClick={() => runActionPrompt(a.prompt)}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {sending && (
              <div className="text-sm text-muted flex items-center gap-2 px-1">
                <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" />
                Goku is thinking...
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {error && (
            <div className="px-3 pb-1.5 flex items-center gap-2">
              <span className="text-xs text-red-400">{error}</span>
              {retryPrompt && (
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded-lg btn-secondary font-medium shrink-0"
                  disabled={sending || busy}
                  onClick={() => runActionPrompt(retryPrompt)}
                >
                  Retry
                </button>
              )}
            </div>
          )}

          <div className="p-3 border-t border-border flex gap-2 shrink-0">
            <input
              ref={inputRef}
              className="input text-sm"
              placeholder="Ask Goku about this data..."
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") send(); }}
              disabled={sending}
            />
            <button className="btn-primary shrink-0 text-sm px-3" onClick={() => send()} disabled={sending || !text.trim()}>
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
