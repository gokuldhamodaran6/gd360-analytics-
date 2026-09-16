import { useEffect, useRef, useState } from "react";
import { DatasetVersion } from "../api/client";

// The literal id used, on both the client and the server, to mean "the
// original, untouched data" inside a WORKING ON selection - every other
// entry is a real DatasetVersion.id.
export const ORIGINAL_SOURCE_ID = "original";

export type FollowUpSuggestion = { label: string; prompt: string };

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
  insight?: string | null;
  needsClarification?: boolean;
  action?: "analyze" | "transform" | "clarify" | "explain";
  rowsBefore?: number | null;
  rowsAfter?: number | null;
  nullsBefore?: number | null;
  nullsAfter?: number | null;
  resolved?: boolean;
  // Specific, contextual "what to try next" options tied to this exact
  // result (e.g. an alternative correlation method, or the same
  // relationship shown a different way) - offered as optional buttons
  // right under the answer, the way a senior analyst would proactively
  // suggest the next useful angle. Purely optional: ignoring them (or
  // dismissing the row) is a completely normal way to use the app.
  followUp?: FollowUpSuggestion[] | null;
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

// A chat reply is usually just plain text, but an "explain"-style answer
// (e.g. "give me the python code") can include a fenced ```python code```
// block. This splits a message on those fences and renders the code part
// in its own readable, copyable, monospace block instead of squished into
// one line like plain text would be.
function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be blocked by the browser - the code stays
      // fully visible and selectable either way, so this is a soft failure.
    }
  };
  return (
    <div className="my-1.5 rounded-lg bg-black/85 border border-border overflow-hidden">
      <div className="flex items-center justify-between px-2.5 py-1 bg-black/30 border-b border-white/10">
        <span className="text-[10px] uppercase tracking-wide text-white/50 font-semibold">Python</span>
        <button type="button" className="text-[10px] text-white/70 hover:text-white transition font-medium" onClick={copy}>
          {copied ? "Copied" : "Copy code"}
        </button>
      </div>
      <pre className="text-[12px] leading-relaxed text-white/90 whitespace-pre-wrap break-words px-2.5 py-2 overflow-x-auto font-mono m-0">
        {code}
      </pre>
    </div>
  );
}

function renderMessageContent(content: string) {
  const fenceRe = /```(?:python)?\n?([\s\S]*?)```/g;
  const segments: { type: "text" | "code"; value: string }[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(content)) !== null) {
    if (match.index > lastIndex) segments.push({ type: "text", value: content.slice(lastIndex, match.index) });
    segments.push({ type: "code", value: match[1].trim() });
    lastIndex = fenceRe.lastIndex;
  }
  if (lastIndex < content.length) segments.push({ type: "text", value: content.slice(lastIndex) });
  if (segments.length <= 1) return content;

  return segments.map((seg, i) => {
    if (seg.type === "code") return <CodeBlock key={i} code={seg.value} />;
    const trimmed = seg.value.trim();
    return trimmed ? (
      <p key={i} className="whitespace-pre-wrap m-0">
        {trimmed}
      </p>
    ) : null;
  });
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
  const [dismissedFollowUps, setDismissedFollowUps] = useState<Set<number>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, busy]);

  // The WORKING ON picker below renders as a full-viewport overlay (not a
  // small panel anchored to the button), so it always has room for every
  // table and its own scroll area, on any screen size and with the mobile
  // keyboard open or not - nothing about it depends on where the button
  // happens to sit on screen. Escape is an extra, keyboard-friendly way to
  // close it, in addition to tapping the backdrop or the Done button.
  useEffect(() => {
    if (!workingOnOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWorkingOnOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
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
    <>
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
              {t.action === "explain" && (
                <div className="text-[10px] uppercase tracking-wide text-accent font-semibold mb-1">Answer</div>
              )}
              {renderMessageContent(t.content)}
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
            {t.role === "assistant" && t.followUp && t.followUp.length > 0 && !dismissedFollowUps.has(i) && (
              <div className="mt-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] text-muted">Worth trying next</span>
                  <button
                    className="text-[11px] text-muted hover:text-text transition"
                    disabled={busy}
                    onClick={() => setDismissedFollowUps((s) => new Set(s).add(i))}
                  >
                    Skip
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {t.followUp.map((f, fi) => (
                    <button
                      key={fi}
                      className="text-xs px-2.5 py-1.5 rounded-lg btn-secondary font-medium text-left"
                      disabled={busy}
                      onClick={() => {
                        setDismissedFollowUps((s) => new Set(s).add(i));
                        onSend(f.prompt);
                      }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
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
            <button
              type="button"
              className="input text-sm py-1.5 w-full flex items-center justify-between gap-2 text-left"
              disabled={busy}
              onClick={() => setWorkingOnOpen(true)}
            >
              <span className="truncate">{workingOnSummary()}</span>
              <span className="text-muted shrink-0 text-xs">▼</span>
            </button>
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

    {/* Full-viewport picker (not a panel pinned to the button) so every
        table is always reachable and scrollable, regardless of screen
        size, how far down the button sits, or whether the on-screen
        keyboard is covering half the screen - the exact conditions that
        clipped the old dropdown. Bottom sheet on narrow screens (easiest
        to reach with a thumb), centered modal from "sm" up. */}
    {versions.length > 0 && workingOnOpen && (
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60"
        onClick={() => setWorkingOnOpen(false)}
      >
        <div
          className="card w-full sm:w-96 max-h-[85vh] sm:max-h-[70vh] flex flex-col rounded-b-none sm:rounded-b-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-4 border-b border-border flex items-center justify-between shrink-0">
            <div>
              <div className="font-semibold text-sm">Working on</div>
              <div className="text-xs text-muted mt-0.5">Select one or more tables to analyze together</div>
            </div>
            <button
              type="button"
              className="text-muted hover:text-text text-xl leading-none px-1"
              onClick={() => setWorkingOnOpen(false)}
            >
              &times;
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            <label className="flex items-center gap-2 text-sm px-2 py-2.5 rounded-lg hover:bg-surface2 cursor-pointer">
              <input
                type="checkbox"
                checked={sourceIds.includes(ORIGINAL_SOURCE_ID)}
                onChange={() => toggleSource(ORIGINAL_SOURCE_ID)}
              />
              Original data
            </label>
            {versions.map((v) => (
              <label key={v.id} className="flex items-center gap-2 text-sm px-2 py-2.5 rounded-lg hover:bg-surface2 cursor-pointer">
                <input type="checkbox" checked={sourceIds.includes(v.id)} onChange={() => toggleSource(v.id)} />
                {v.name}
              </label>
            ))}
          </div>
          <div className="p-3 border-t border-border shrink-0">
            <button type="button" className="btn-primary w-full text-sm" onClick={() => setWorkingOnOpen(false)}>
              Done
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
