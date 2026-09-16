import { useEffect, useRef, useState } from "react";
import { DatasetVersion } from "../api/client";

// The literal id used, on both the client and the server, to mean "the
// original, untouched data" inside a WORKING ON selection - every other
// entry is a real DatasetVersion.id.
export const ORIGINAL_SOURCE_ID = "original";

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
  // Which table(s) this prompt ran against, and - for a cleaning/prep
  // prompt - the new table it created, so "Reject, undo this" can delete
  // exactly that one and restore exactly what was selected before it ran.
  sourceIds?: string[];
  priorActiveVersionId?: string | null;
  newVersionId?: string | null;
};

export type CustomizeSeed = { text: string; nonce: number };

function labelForSource(id: string, versions: DatasetVersion[]): string {
  if (id === ORIGINAL_SOURCE_ID) return "Original data";
  return versions.find((v) => v.id === id)?.name || "Removed table";
}

export default function ChatPanel({
  turns, onSend, busy, onApproveTransform, onRejectTransform, onCustomizeTransform, customizeSeed,
  versions, sourceIds, onSourceIdsChange,
}: {
  turns: ChatTurn[];
  onSend: (prompt: string) => void;
  busy: boolean;
  onApproveTransform?: (index: number) => void;
  onRejectTransform?: (index: number) => void;
  onCustomizeTransform?: (index: number) => void;
  customizeSeed?: CustomizeSeed | null;
  versions: DatasetVersion[];
  sourceIds: string[];
  onSourceIdsChange: (ids: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [workingOnOpen, setWorkingOnOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const workingOnRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, busy]);

  // Closes the WORKING ON panel on a click anywhere else on the page.
  useEffect(() => {
    if (!workingOnOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (workingOnRef.current && !workingOnRef.current.contains(e.target as Node)) {
        setWorkingOnOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [workingOnOpen]);

  const toggleSource = (id: string) => {
    if (sourceIds.includes(id)) {
      if (sourceIds.length === 1) return; // always keep at least one table selected
      onSourceIdsChange(sourceIds.filter((x) => x !== id));
    } else {
      onSourceIdsChange([...sourceIds, id]);
    }
  };

  const workingOnSummary = () => {
    const labels = sourceIds.map((id) => labelForSource(id, versions));
    if (labels.length === 0) return "Original data";
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return labels.join(" + ");
    return `${labels[0]} + ${labels.length - 1} more`;
  };

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
          <div className="px-4 pt-3 relative" ref={workingOnRef}>
            <label className="text-[11px] font-semibold tracking-wide text-muted block mb-1">
              WORKING ON
            </label>
            <button
              type="button"
              className="input text-sm py-1.5 w-full flex items-center justify-between gap-2 text-left"
              disabled={busy}
              onClick={() => setWorkingOnOpen((o) => !o)}
            >
              <span className="truncate">{workingOnSummary()}</span>
              <span className="text-muted shrink-0 text-xs">{workingOnOpen ? "▲" : "▼"}</span>
            </button>

            {workingOnOpen && (
              <div className="absolute z-20 left-4 right-4 mt-1 card p-2 space-y-0.5 shadow-xl max-h-52 overflow-y-auto">
                <div className="text-[10px] uppercase tracking-wide text-muted px-2 pb-1">
                  Select one or more tables to analyze together
                </div>
                <label className="flex items-center gap-2 text-sm px-2 py-1.5 rounded-lg hover:bg-surface2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sourceIds.includes(ORIGINAL_SOURCE_ID)}
                    onChange={() => toggleSource(ORIGINAL_SOURCE_ID)}
                  />
                  Original data
                </label>
                {versions.map((v) => (
                  <label key={v.id} className="flex items-center gap-2 text-sm px-2 py-1.5 rounded-lg hover:bg-surface2 cursor-pointer">
                    <input type="checkbox" checked={sourceIds.includes(v.id)} onChange={() => toggleSource(v.id)} />
                    {v.name}
                  </label>
                ))}
              </div>
            )}
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
