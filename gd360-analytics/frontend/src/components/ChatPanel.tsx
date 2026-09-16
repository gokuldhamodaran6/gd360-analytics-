import { useEffect, useRef, useState } from "react";
import { DatasetVersion } from "../api/client";

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
  resolved?: boolean;
  // Which table this prompt ran against, and - for a cleaning/prep prompt -
  // the new table it created, so "Reject, undo this" can delete exactly
  // that one and switch back to exactly what was active before it ran.
  sourceVersionId?: string | null;
  newVersionId?: string | null;
};

export type CustomizeSeed = { text: string; nonce: number };

export default function ChatPanel({
  turns, onSend, busy, onApproveTransform, onRejectTransform, onCustomizeTransform, customizeSeed,
  versions, activeVersionId, onActiveVersionChange,
}: {
  turns: ChatTurn[];
  onSend: (prompt: string) => void;
  busy: boolean;
  onApproveTransform?: (index: number) => void;
  onRejectTransform?: (index: number) => void;
  onCustomizeTransform?: (index: number) => void;
  customizeSeed?: CustomizeSeed | null;
  versions: DatasetVersion[];
  activeVersionId: string | null;
  onActiveVersionChange: (versionId: string | null) => void;
}) {
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, busy]);

  // A "Refine further" click on a data-cleaning result seeds the chat box
  // with a starting phrase and focuses it, so the person can finish typing
  // exactly what else they want done - without losing any text they may
  // already have typed elsewhere.
  useEffect(() => {
    if (!customizeSeed) return;
    setText(customizeSeed.text);
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customizeSeed?.nonce]);

  const send = () => {
    if (!text.trim() || busy) return;
    onSend(text.trim());
    setText("");
  };

  const lastTransformIndex = turns.reduce((last, t, i) => (t.action === "transform" ? i : last), -1);

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
            {t.action === "transform" && i === lastTransformIndex && (
              <div className="mt-2">
                {t.resolved ? (
                  <div className="text-[11px] text-accent flex items-center gap-1">
                    <span>&#10003;</span> Applied to your data
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-muted mr-0.5">Proceed with this?</span>
                    <button
                      className="text-xs px-2.5 py-1 rounded-lg bg-accent text-white font-medium hover:opacity-90 transition"
                      disabled={busy}
                      onClick={() => onApproveTransform?.(i)}
                    >
                      Approve
                    </button>
                    <button
                      className="text-xs px-2.5 py-1 rounded-lg btn-secondary font-medium"
                      disabled={busy}
                      onClick={() => onRejectTransform?.(i)}
                    >
                      Reject, undo this
                    </button>
                    <button
                      className="text-xs px-2.5 py-1 rounded-lg btn-secondary font-medium"
                      disabled={busy}
                      onClick={() => onCustomizeTransform?.(i)}
                    >
                      Customize further
                    </button>
                  </div>
                )}
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

      <div className="border-t border-border">
        {versions.length > 0 && (
          <div className="px-4 pt-3">
            <label className="text-[11px] font-semibold tracking-wide text-muted block mb-1">
              WORKING ON
            </label>
            <select
              className="input text-sm py-1.5"
              value={activeVersionId || ""}
              disabled={busy}
              onChange={(e) => onActiveVersionChange(e.target.value || null)}
            >
              <option value="">Original data</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="p-4 pt-3 flex gap-2">
          <input
            ref={inputRef}
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
    </div>
  );
}
