import { useEffect, useRef, useState } from "react";
import { DatasetVersion, DataSourceSummary, datasourceApi } from "../api/client";
import { hasMultipleTables, connectionKindMeta } from "./DataSourceForm";

// The literal id used, on both the client and the server, to mean "the
// original, untouched data" inside a WORKING ON selection - every other
// entry is one of: a real DatasetVersion.id (any datasource the person
// owns - not only the one this chat panel is open on), "sheet:<name>" (one
// specific table/sheet of THIS datasource - the wire name is historical
// (it was first built for multi-sheet Excel), but the backend has always
// resolved it identically for a multi-table Postgres/MySQL/SQL Server/
// Supabase/MongoDB/BigQuery connection too - see routers/chat.py
// _load_selected_tables), or "ds:<other_datasource_id>:original" /
// "ds:<other_datasource_id>:sheet:<name>" (another, separately-connected
// data source added with "+ Add data" - see the WORKING ON picker below
// and the header-level Add data popup, which share this same selection).
export const ORIGINAL_SOURCE_ID = "original";
const TABLE_PREFIX = "sheet:";
const OTHER_DS_PREFIX = "ds:";

export function otherDsSourceId(datasourceId: string, table?: string | null): string {
  return table ? `${OTHER_DS_PREFIX}${datasourceId}:sheet:${table}` : `${OTHER_DS_PREFIX}${datasourceId}:original`;
}

// The inverse of otherDsSourceId: given any sourceId, returns which OTHER
// data source it points at (never THIS chat's own datasource), or null for
// every id that means "a table of this chat's own datasource" (the plain
// ORIGINAL_SOURCE_ID, a "sheet:<name>", or a bare DatasetVersion.id built
// from this datasource's own data). Exported so anything outside this file
// that needs "which connected data sources does the current selection
// actually touch right now" - Workspace.tsx's Data-tab source switcher, so
// far the only caller - can read it straight off `sourceIds` instead of
// re-parsing the "ds:<id>:..." wire format a second time.
export function otherDsIdFromSourceId(id: string): string | null {
  if (!id.startsWith(OTHER_DS_PREFIX)) return null;
  const rest = id.slice(OTHER_DS_PREFIX.length);
  const sep = rest.indexOf(":");
  return sep === -1 ? rest : rest.slice(0, sep);
}

// A small colored dot shown before every WORKING ON row - teal for a real,
// untouched source table (this datasource's own tables/sheets, or another
// connected data source's), violet (the same purple already used for every
// "this was built by GD360" surface: the active Data/Chart tab, the guided
// step pills, a saved table's own tab) for a saved table GD360 generated
// from a cleaning/prep prompt. Lets a mixed selection - some original
// tables, some AI-built ones - read at a glance which is which, the same
// distinction the Data tab's own tab strip now makes (see DataTable.tsx).
export function SourceDot({ generated }: { generated: boolean }) {
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${generated ? "bg-primary" : "bg-sky-400"}`}
      aria-hidden
    />
  );
}

// Mirrors the exact generated-vs-original distinction every WORKING ON row
// already renders with its own explicit `generated={...}` prop (see every
// SourceDot call site below) - a bare id that is none of the three
// ORIGINAL/TABLE_PREFIX/OTHER_DS_PREFIX forms can only be a real
// DatasetVersion.id, i.e. a saved table GD360 built. Used by the chip row
// (2026-09-23, round nine) to color each chip's own dot the same way
// without duplicating that three-way check inline at the render site.
function isGeneratedSourceId(id: string): boolean {
  return !(id === ORIGINAL_SOURCE_ID || id.startsWith(TABLE_PREFIX) || id.startsWith(OTHER_DS_PREFIX));
}

function PlusIcon({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function ChipCloseIcon({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

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
  // Set only in step-by-step ("guided") analysis mode, right after this
  // turn prepared a table but has NOT yet run the actual analysis on it -
  // rendered as a single prominent "Continue" button (see
  // onContinueAnalysis). Cleared client-side (continuedInto set instead)
  // once that button has been used, so it cannot be clicked twice.
  continueAction?: { label: string; prompt: string; version_id: string } | null;
  continuedInto?: boolean;
  // The backend Message.id this turn corresponds to - present on every
  // assistant turn that computed something (analyze/transform), used to
  // trigger a "Double-check this" re-verification of that specific answer.
  messageId?: string | null;
  verifyStatus?: "confirmed" | "corrected" | "unavailable";
  verifyMessage?: string;
};

export type CustomizeSeed = { text: string; nonce: number };

// Resolves any sourceId (see the forms documented on ORIGINAL_SOURCE_ID
// above) to a short, human-readable label for the WORKING ON summary line
// and the picker itself. `otherVersionsById` is only populated for another
// data source once its own saved tables have actually been fetched (see
// the picker's "+ Add more data" section below) - a cross-datasource
// version id that has not been resolved yet (e.g. right after restoring an
// old conversation, before its other data source has been expanded) falls
// back to a plain "Saved table" rather than the misleading "Removed
// table", since it has not been confirmed missing, only not looked up yet.
function labelForSource(
  id: string,
  versions: DatasetVersion[],
  otherDataSources: DataSourceSummary[],
  otherVersionsById: Record<string, DatasetVersion[]>
): string {
  if (id === ORIGINAL_SOURCE_ID) return "Original data";
  if (id.startsWith(TABLE_PREFIX)) return id.slice(TABLE_PREFIX.length);
  if (id.startsWith(OTHER_DS_PREFIX)) {
    const rest = id.slice(OTHER_DS_PREFIX.length);
    const sepIndex = rest.indexOf(":");
    const otherId = sepIndex === -1 ? rest : rest.slice(0, sepIndex);
    const selector = sepIndex === -1 ? "" : rest.slice(sepIndex + 1);
    const otherName = otherDataSources.find((d) => d.id === otherId)?.name || "Another data source";
    if (selector.startsWith(TABLE_PREFIX)) return `${otherName} — ${selector.slice(TABLE_PREFIX.length)}`;
    return `${otherName} (original)`;
  }
  const own = versions.find((v) => v.id === id);
  if (own) return own.name;
  for (const [otherId, vs] of Object.entries(otherVersionsById)) {
    const found = vs.find((v) => v.id === id);
    if (found) {
      const otherName = otherDataSources.find((d) => d.id === otherId)?.name || "Another data source";
      return `${otherName} — ${found.name}`;
    }
  }
  return "Saved table";
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

// Turns "**bold**" markers into real bold text instead of showing the
// literal asterisks - used for both the narrative/answer bubble and the
// Insight box, since a structured answer (e.g. "**Key insight:** ...
// **Implication:** ... **Next step:** ...") reads as a data analyst would
// actually format it only once those markers render as real emphasis.
function renderInlineBold(text: string, keyPrefix: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
    }
    return part ? <span key={`${keyPrefix}-${i}`}>{part}</span> : null;
  });
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

  return segments.map((seg, i) => {
    if (seg.type === "code") return <CodeBlock key={i} code={seg.value} />;
    const trimmed = seg.value.trim();
    return trimmed ? (
      <p key={i} className="whitespace-pre-wrap m-0">
        {renderInlineBold(trimmed, `t${i}`)}
      </p>
    ) : null;
  });
}

export default function ChatPanel({
  turns, onSend, busy, onApproveTransform, onRejectTransform, onCustomizeTransform, onContinueAnalysis, customizeSeed,
  versions, sourceIds, onSourceIdsChange, onVerify, verifyingIndex, analysisMode, onAnalysisModeChange,
  datasourceKind, datasourceSchema, otherDataSources, conversationId,
}: {
  turns: ChatTurn[];
  onSend: (prompt: string) => void;
  busy: boolean;
  onApproveTransform?: (index: number) => void;
  onRejectTransform?: (index: number) => void;
  onCustomizeTransform?: (index: number) => void;
  // "Continue -> run the analysis": the button on a paused, step-by-step
  // preparation turn (see ChatTurn.continueAction).
  onContinueAnalysis?: (index: number) => void;
  customizeSeed?: CustomizeSeed | null;
  versions: DatasetVersion[];
  sourceIds: string[];
  onSourceIdsChange: (ids: string[]) => void;
  // "Double-check this": re-verifies the computed answer for a given turn
  // on demand. verifyingIndex is which turn (if any) is currently being
  // checked, so only that row shows a loading state and every button is
  // disabled while a check is in flight.
  onVerify?: (index: number) => void;
  verifyingIndex?: number | null;
  // How much control the person wants over an analysis question that needs
  // its own data-preparation step first - "auto" (one smooth explained
  // answer) or "guided" (pause after preparation for a confirm). Shown as
  // a small toggle at the top of the chat so it is available from the very
  // first question, and switchable any time after.
  analysisMode?: "auto" | "guided";
  onAnalysisModeChange?: (mode: "auto" | "guided") => void;
  // This datasource's own kind/schema_cache - used only to detect whether
  // it is a multi-sheet Excel workbook, in which case WORKING ON offers
  // one checkbox per sheet instead of a single "Original data" row.
  datasourceKind?: string;
  datasourceSchema?: Record<string, unknown> | null;
  // Every OTHER data source this person has connected (never including the
  // one this chat panel is open on). WORKING ON no longer offers its own
  // "browse and add" section (that duplicated the header-level "+ Add
  // data" popup and got unreadable once someone had many sources - see
  // AddDataPicker.tsx) - this list is only used here to label/resolve a
  // cross-datasource table that "+ Add data" has already added to
  // `sourceIds`, so WORKING ON can still show and toggle it.
  otherDataSources?: DataSourceSummary[];
  // This Project's own conversation id (null before its first message) -
  // used only to scope which of an OTHER connected data source's saved
  // tables the picker offers to add (see the otherSources render block
  // below). Mirrors the exact filter Workspace.tsx already applies to
  // THIS datasource's own `versions` before they ever reach this
  // component (see its visibleVersions) - without it, picking a second
  // data source here used to dump every AI-built table anyone has EVER
  // saved against it, from every unrelated Project that happened to touch
  // it, into one flat list - precisely the confusion visibleVersions was
  // already built to prevent for this chat's own primary data source.
  conversationId?: string | null;
}) {
  const [text, setText] = useState("");
  const [workingOnOpen, setWorkingOnOpen] = useState(false);
  const [dismissedFollowUps, setDismissedFollowUps] = useState<Set<number>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const otherSources = otherDataSources || [];
  const anchorMultiSheet = hasMultipleTables(datasourceKind || "", datasourceSchema);
  const anchorSheets = anchorMultiSheet ? Object.keys(datasourceSchema || {}) : [];

  // Saved tables for an OTHER data source, fetched lazily (only once that
  // data source is actually expanded in the picker, or once an already-
  // selected sourceId turns out to need resolving - see the effect below) -
  // never fetched eagerly for every connected data source on every render,
  // since most prompts never touch more than the one data source already
  // open here.
  const [otherVersionsById, setOtherVersionsById] = useState<Record<string, DatasetVersion[]>>({});
  const [loadingOtherDs, setLoadingOtherDs] = useState<Set<string>>(new Set());
  const [expandedOtherDs, setExpandedOtherDs] = useState<Set<string>>(new Set());

  const fetchOtherVersions = (dsId: string) => {
    if (otherVersionsById[dsId] || loadingOtherDs.has(dsId)) return;
    setLoadingOtherDs((s) => new Set(s).add(dsId));
    datasourceApi
      .listVersions(dsId)
      .then((vs) => setOtherVersionsById((m) => (m[dsId] ? m : { ...m, [dsId]: vs })))
      .catch(() => setOtherVersionsById((m) => (m[dsId] ? m : { ...m, [dsId]: [] })))
      .finally(() => setLoadingOtherDs((s) => { const n = new Set(s); n.delete(dsId); return n; }));
  };

  // Keeps the picker (and the WORKING ON summary line) correct even when
  // the current selection already points at another data source before
  // the person has opened the picker this session - most commonly right
  // after restoring a past conversation that combined sources. A
  // "ds:<id>:..." entry names its data source directly, so that one is
  // expanded precisely; a bare id this panel cannot find among its OWN
  // versions might belong to another data source instead of simply being
  // gone, so every other connected data source's versions are fetched once
  // to find out for sure, rather than guessing from silence.
  useEffect(() => {
    const directIds = new Set<string>();
    for (const id of sourceIds) {
      const otherId = otherDsIdFromSourceId(id);
      if (otherId) directIds.add(otherId);
    }
    const ownVersionIds = new Set(versions.map((v) => v.id));
    const hasUnresolvedBareId = sourceIds.some(
      (id) => id !== ORIGINAL_SOURCE_ID && !id.startsWith(TABLE_PREFIX) && !id.startsWith(OTHER_DS_PREFIX) && !ownVersionIds.has(id)
    );
    const toExpand = hasUnresolvedBareId ? otherSources.map((d) => d.id) : Array.from(directIds);
    if (toExpand.length === 0) return;
    setExpandedOtherDs((s) => new Set([...s, ...toExpand]));
    toExpand.forEach(fetchOtherVersions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceIds.join("|"), versions.map((v) => v.id).join("|"), otherSources.map((d) => d.id).join("|")]);

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

  // Collapses an added data source and drops every one of its tables
  // (original data, any sheet, any saved version) out of the current
  // selection - a clean, single "undo" for the "+ Add" click above, rather
  // than making the person uncheck each box it added one at a time.
  const removeOtherDs = (dsId: string) => {
    setExpandedOtherDs((s) => { const n = new Set(s); n.delete(dsId); return n; });
    const ownedVersionIds = new Set((otherVersionsById[dsId] || []).map((v) => v.id));
    const next = sourceIds.filter((id) => {
      if (id === otherDsSourceId(dsId)) return false;
      if (id.startsWith(`${OTHER_DS_PREFIX}${dsId}:${TABLE_PREFIX}`)) return false;
      if (ownedVersionIds.has(id)) return false;
      return true;
    });
    onSourceIdsChange(next.length ? next : [ORIGINAL_SOURCE_ID]);
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

  // The most recent turn that created (or is in the middle of creating) a
  // saved table - a "clean this data" transform, or an analyze question
  // that had to prepare its own table first - is the only one that still
  // shows Approve/Reject/Customize further, so an older, already-superseded
  // result never gets confused for the current one.
  const lastVersionTurnIndex = turns.reduce((last, t, i) => (t.newVersionId ? i : last), -1);

  return (
    <>
    <div className="card flex flex-col h-full">
      <div className="p-4 border-b border-border">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-semibold">Ask GD360</div>
            <div className="text-xs text-muted mt-0.5">Clean, explore, visualize, or just ask a question. GD360 writes and runs the work itself.</div>
          </div>
          {onAnalysisModeChange && (
            <div className="shrink-0 flex rounded-lg border border-border overflow-hidden text-[11px] font-medium" role="group" aria-label="How much control do you want over analysis">
              <button
                type="button"
                title="Explain preparation and show the result in one smooth answer"
                className={`px-2 py-1 transition ${analysisMode !== "guided" ? "bg-primary text-white" : "bg-surface2 text-muted hover:text-text"}`}
                onClick={() => onAnalysisModeChange("auto")}
              >
                One-click
              </button>
              <button
                type="button"
                title="Pause after each table is prepared so you can confirm before the analysis runs"
                className={`px-2 py-1 transition border-l border-border ${analysisMode === "guided" ? "bg-primary text-white" : "bg-surface2 text-muted hover:text-text"}`}
                onClick={() => onAnalysisModeChange("guided")}
              >
                Step-by-step
              </button>
            </div>
          )}
        </div>
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
              {t.action === "analyze" && t.newVersionId && (
                <div className="text-[10px] uppercase tracking-wide text-accent font-semibold mb-1">
                  {t.continueAction ? "Table prepared" : "Table prepared for this analysis"}
                </div>
              )}
              {t.action === "explain" && (
                <div className="text-[10px] uppercase tracking-wide text-accent font-semibold mb-1">Answer</div>
              )}
              {renderMessageContent(t.content)}
            </div>
            {t.rowsBefore != null && (
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
              <div className="mt-2 text-sm bg-accent/10 border border-accent/30 rounded-xl px-4 py-2.5 whitespace-pre-wrap">
                <span className="font-semibold text-accent">Insight: </span>
                {renderInlineBold(t.insight, "insight")}
              </div>
            )}
            {t.role === "assistant" && (t.action === "analyze" || t.action === "transform") && t.messageId && !t.continueAction && (
              <div className="mt-1.5">
                {!t.verifyStatus ? (
                  <button
                    type="button"
                    className="text-[11px] px-2.5 py-1 rounded-lg btn-secondary font-medium"
                    disabled={busy || verifyingIndex != null}
                    onClick={() => onVerify?.(i)}
                  >
                    {verifyingIndex === i ? "Double-checking..." : "Double-check this"}
                  </button>
                ) : t.verifyStatus === "confirmed" ? (
                  <div className="text-[11px] text-accent flex items-start gap-1">
                    <span className="shrink-0">&#10003;</span>
                    <span>{t.verifyMessage || "Verified correct."}</span>
                  </div>
                ) : t.verifyStatus === "corrected" ? (
                  <div className="text-[11px] text-accent flex items-start gap-1">
                    <span className="shrink-0">&#9888;</span>
                    <span>{t.verifyMessage || "An issue was found and corrected."}</span>
                  </div>
                ) : (
                  <div className="text-[11px] text-muted flex items-start gap-1">
                    <span>{t.verifyMessage || "Could not verify this right now."}</span>
                  </div>
                )}
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
            {t.newVersionId && i === lastVersionTurnIndex && (
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
            {t.continueAction && (
              <div className="mt-2">
                {t.continuedInto ? (
                  <div className="text-[11px] text-accent flex items-center gap-1">
                    <span>&#10003;</span> Continued into the analysis below
                  </div>
                ) : (
                  <button
                    type="button"
                    className="text-xs px-3 py-1.5 rounded-lg bg-primary text-white font-semibold hover:opacity-90 transition disabled:opacity-60"
                    disabled={busy}
                    onClick={() => onContinueAnalysis?.(i)}
                  >
                    {t.continueAction.label}
                  </button>
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
        {/* ---- WORKING ON: one chip per selected table, not a single
            cramped, truncated text summary (Gokul's own explicit bug
            report, round nine: "it has to show properly like how it will
            show in chat gpt" - referencing the row of attached-file chips
            a chat interface shows above its input). Every table already
            in the mix is its own small removable card here; "+ Add" opens
            the exact same full picker as before (unchanged - it already
            supports checking off any number of tables across any number
            of data sources at once) to browse and add more. Wraps onto a
            second line rather than scrolling sideways once there are
            enough chips to need it - nothing gets clipped or hidden. ---- */}
        <div className="px-4 pt-3">
          <label className="text-[11px] font-semibold tracking-wide text-muted block mb-1.5">
            WORKING ON
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            {sourceIds.map((id) => {
              const label = labelForSource(id, versions, otherSources, otherVersionsById);
              const removable = sourceIds.length > 1;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1.5 max-w-[180px] pl-2 pr-1 py-1 rounded-lg border border-border bg-surface2 text-xs"
                  title={label}
                >
                  <SourceDot generated={isGeneratedSourceId(id)} />
                  <span className="truncate">{label}</span>
                  <button
                    type="button"
                    className={`shrink-0 rounded p-0.5 transition ${
                      removable ? "text-muted hover:text-text hover:bg-border/60" : "text-muted/30 cursor-not-allowed"
                    }`}
                    disabled={busy || !removable}
                    title={removable ? "Remove from this analysis" : "At least one table must stay selected"}
                    onClick={() => toggleSource(id)}
                  >
                    <ChipCloseIcon />
                  </button>
                </span>
              );
            })}
            <button
              type="button"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-dashed border-border text-xs font-medium text-muted hover:text-text hover:border-primary/50 transition disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={busy}
              onClick={() => setWorkingOnOpen(true)}
            >
              <PlusIcon /> Add
            </button>
          </div>
        </div>

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
    {workingOnOpen && (
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
            {anchorMultiSheet ? (
              anchorSheets.map((sheet) => {
                const id = `${TABLE_PREFIX}${sheet}`;
                return (
                  <label key={id} className="flex items-center gap-2 text-sm px-2 py-2.5 rounded-lg hover:bg-surface2 cursor-pointer">
                    <input type="checkbox" checked={sourceIds.includes(id)} onChange={() => toggleSource(id)} />
                    <SourceDot generated={false} />
                    {sheet}
                  </label>
                );
              })
            ) : (
              <label className="flex items-center gap-2 text-sm px-2 py-2.5 rounded-lg hover:bg-surface2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sourceIds.includes(ORIGINAL_SOURCE_ID)}
                  onChange={() => toggleSource(ORIGINAL_SOURCE_ID)}
                />
                <SourceDot generated={false} />
                Original data
              </label>
            )}
            {versions.map((v) => (
              <label key={v.id} className="flex items-center gap-2 text-sm px-2 py-2.5 rounded-lg hover:bg-surface2 cursor-pointer">
                <input type="checkbox" checked={sourceIds.includes(v.id)} onChange={() => toggleSource(v.id)} />
                <SourceDot generated={true} />
                {v.name}
              </label>
            ))}

            {/* Only data sources ALREADY part of this question's selection
                (added earlier via the header-level "+ Add data" popup, or
                inherited from a restored conversation) show up here, each
                with its own tables still toggleable and a "Remove" to drop
                it from the mix - this is WORKING ON's whole job: showing
                and adjusting exactly what you're working on right now, not
                a second place to go browse and add a source you haven't
                touched yet. That belongs to the "+ Add data" button up top
                (see the hint below when nothing else is added). */}
            {otherSources.filter((ds) => expandedOtherDs.has(ds.id)).map((ds) => {
              const dsMultiSheet = hasMultipleTables(ds.kind, ds.schema_cache);
              const dsSheets = dsMultiSheet ? Object.keys(ds.schema_cache || {}) : [];
              // Only THIS Project's own saved tables for this other source
              // (or one never tied to any conversation at all) are offered
              // here to add - the exact same conversation-scoped rule
              // Workspace.tsx already applies to this chat's own primary
              // data source (see its visibleVersions), now applied to an
              // OTHER connected source too. Without this, picking a second
              // data source dumped every AI-built table anyone had EVER
              // saved against it - from every unrelated past Project - into
              // one flat, ever-growing list: real confusion once a person
              // has used this app for a while. An already-selected table is
              // always kept visible regardless (so resuming an old combined
              // conversation never makes its own active pick silently
              // vanish from the list), even on the rare chance it came from
              // a genuinely different Project.
              const dsVersions = (otherVersionsById[ds.id] || []).filter(
                (v) => v.conversation_id == null || v.conversation_id === conversationId || sourceIds.includes(v.id)
              );
              const meta = connectionKindMeta(ds.kind);
              return (
                <div key={ds.id} className="rounded-lg bg-surface2/60 my-1 py-1.5">
                  <div className="flex items-center justify-between px-2 pb-1">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="shrink-0" style={{ color: meta.color }}>
                        <meta.Logo className="w-3.5 h-3.5" />
                      </span>
                      <span className="text-xs font-semibold truncate">{ds.name}</span>
                    </span>
                    <button
                      type="button"
                      className="text-[11px] text-muted hover:text-text transition shrink-0 ml-2"
                      onClick={() => removeOtherDs(ds.id)}
                    >
                      Remove
                    </button>
                  </div>
                  {dsMultiSheet ? (
                    dsSheets.map((sheet) => {
                      const id = otherDsSourceId(ds.id, sheet);
                      return (
                        <label key={id} className="flex items-center gap-2 text-sm px-2 py-2 rounded-lg hover:bg-surface2 cursor-pointer">
                          <input type="checkbox" checked={sourceIds.includes(id)} onChange={() => toggleSource(id)} />
                          <SourceDot generated={false} />
                          {sheet}
                        </label>
                      );
                    })
                  ) : (
                    <label className="flex items-center gap-2 text-sm px-2 py-2 rounded-lg hover:bg-surface2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={sourceIds.includes(otherDsSourceId(ds.id))}
                        onChange={() => toggleSource(otherDsSourceId(ds.id))}
                      />
                      <SourceDot generated={false} />
                      Original data
                    </label>
                  )}
                  {loadingOtherDs.has(ds.id) && (
                    <div className="text-[11px] text-muted px-2 py-1">Loading saved tables…</div>
                  )}
                  {dsVersions.map((v) => (
                    <label key={v.id} className="flex items-center gap-2 text-sm px-2 py-2 rounded-lg hover:bg-surface2 cursor-pointer">
                      <input type="checkbox" checked={sourceIds.includes(v.id)} onChange={() => toggleSource(v.id)} />
                      <SourceDot generated={true} />
                      {v.name}
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="px-4 pt-3 pb-1 shrink-0 border-t border-border">
            <div className="text-[11px] text-muted text-center">
              Want to bring in another data source? Use <span className="font-semibold text-text">+ Add data</span> up top.
            </div>
          </div>
          <div className="p-3 pt-2 shrink-0">
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
