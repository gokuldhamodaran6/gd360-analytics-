import { useEffect, useRef, useState } from "react";

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
  insight?: string | null;
  needsClarification?: boolean;
  action?: "analyze" | "transform" | "clarify";
  rowsBefore?: number | null;
  rowsAfter?: number | null;
  nullsBefore?: number | null;
  nullsAfter?: number | null;
};

export default function ChatPanel({
  turns, onSend, busy,
}: {
  turns: ChatTurn[];
  onSend: (prompt: string) => void;
  busy: boolean;
}) {
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, busy]);

  const send = () => {
    if (!text.trim() || busy) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <div className="card flex flex-col h-full">
      <div className="p-4 border-b border-border">
        <div className="font-semibold">Ask GD360</div>
        <div className="text-xs text-muted mt-0.5">Clean, explore, visualize, or just ask a question. GD360 writes and runs the work itself.</div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {turns.length === 0 && (
          <div className="text-sm text-muted">
            Try: <span className="text-text">"Clean and prepare this data"</span>,{" "}
            <span className="text-text">"Show me monthly revenue trend"</span>, or{" "}
            <span className="text-text">"Find patterns in this data"</span>.
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`max-w-[90%] ${t.role === "user" ? "ml-auto" : ""}`}>
            <div
              className={`rounded-2xl px-4 py-2.5 text-sm ${
                t.role === "user" ? "bg-primary text-white rounded-br-sm" : "bg-surface2 border border-border rounded-bl-sm"
              } ${t.needsClarification ? "border-accent/60" : ""}`}
            >
              {t.action === "transform" && (
                <div className="text-[10px] uppercase tracking-wide text-accent font-semibold mb-1">Data cleaned</div>
              )}
              {t.content}
            </div>
            {t.action === "transform" && t.rowsBefore != null && (
              <div className="mt-1.5 flex flex-wrap gap-2 text-[11px]">
                <span className="bg-surface2 border border-border rounded-full px-2.5 py-1">
                  Rows: {t.rowsBefore} &rarr; {t.rowsAfter}
                </span>
                <span className="bg-surface2 border border-border rounded-full px-2.5 py-1">
                  Missing values: {t.nullsBefore} &rarr; {t.nullsAfter}
                </span>
              </div>
            )}
            {t.insight && (
              <div className="mt-2 text-sm bg-accent/10 border border-accent/30 rounded-xl px-4 py-2.5">
                <span className="font-semibold text-accent">Insight: </span>{t.insight}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="text-sm text-muted flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" />
            GD360 is working...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="p-4 border-t border-border flex gap-2">
        <input
          className="input"
          placeholder="Ask a question, or describe how to clean/prepare your data..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          disabled={busy}
        />
        <button className="btn-primary shrink-0" onClick={send} disabled={busy || !text.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
