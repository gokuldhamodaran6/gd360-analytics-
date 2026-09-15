import { useEffect, useRef, useState } from "react";

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
  insight?: string | null;
  needsClarification?: boolean;
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
        <div className="text-xs text-muted mt-0.5">Describe what you want to see. GD360 writes and runs the analysis itself.</div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {turns.length === 0 && (
          <div className="text-sm text-muted">
            Try: <span className="text-text">"Show me monthly revenue trend"</span>,{" "}
            <span className="text-text">"Which region has the highest churn?"</span>, or{" "}
            <span className="text-text">"Break down total sales like a waterfall"</span>.
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`max-w-[90%] ${t.role === "user" ? "ml-auto" : ""}`}>
            <div
              className={`rounded-2xl px-4 py-2.5 text-sm ${
                t.role === "user" ? "bg-primary text-white rounded-br-sm" : "bg-surface2 border border-border rounded-bl-sm"
              } ${t.needsClarification ? "border-accent/60" : ""}`}
            >
              {t.content}
            </div>
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
            GD360 is analyzing...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="p-4 border-t border-border flex gap-2">
        <input
          className="input"
          placeholder="Ask a question about your data..."
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
