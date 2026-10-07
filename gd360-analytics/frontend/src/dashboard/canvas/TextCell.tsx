import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, ClockIcon, SparkleIcon, Textarea, cn } from "../../ui";
import { FINDING_RE, isFinding, slimConfig } from "./cells";
import type { CellBodyProps } from "./types";

// 2026-10-07 (analyst canvas round, OptionC.dc.html cells 1 and 9): a
// text cell. Markdown-lite: "# " / "## " / "### " headings, blank-line
// paragraphs, "- " bullets, **bold** and `code`. A body that starts with
// "Finding:" renders as the Finding callout with "Turn into a watch" -
// watches arrive in a later layer, so the button opens a small dialog that
// says so and saves the intent as a comment on the cell (the backend
// records it like any other thread). Owner: Edit -> a textarea, Save
// (PATCH config.text) / Cancel; Esc leaves.

type Node = { kind: "h1" | "h2" | "h3" | "p" | "li"; text: string };

export function parseMarkdownLite(text: string): Node[][] {
  const out: Node[][] = [];
  let current: Node[] = [];
  const flush = () => { if (current.length) { out.push(current); current = []; } };
  for (const raw of (text || "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flush(); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flush(); out.push([{ kind: `h${h[1].length}` as Node["kind"], text: h[2] }]); continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { if (current.length && current[0].kind !== "li") flush(); current.push({ kind: "li", text: li[1] }); continue; }
    if (current.length && current[0].kind === "li") flush();
    if (current.length) current[current.length - 1].text += ` ${line.trim()}`;
    else current.push({ kind: "p", text: line.trim() });
  }
  flush();
  return out;
}

// **bold** and `code` inside a line.
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, i = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const tok = m[1];
    if (tok.startsWith("**")) out.push(<strong key={i++} className="font-semibold text-text">{tok.slice(2, -2)}</strong>);
    else out.push(<code key={i++} className="rounded-[3px] bg-subtle px-1 font-mono text-[12.5px]">{tok.slice(1, -1)}</code>);
    last = start + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownLite({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdownLite(text), [text]);
  return (
    <div className={cn("flex flex-col gap-2.5 text-body leading-[1.55] text-secondary", className)} data-markdown-lite="">
      {blocks.map((group, gi) => {
        const first = group[0];
        if (first.kind === "li") return <ul key={gi} className="list-disc pl-5">{group.map((n, i) => <li key={i}>{renderInline(n.text)}</li>)}</ul>;
        if (first.kind === "h1") return <h2 key={gi} className="text-title font-semibold text-text">{renderInline(first.text)}</h2>;
        if (first.kind === "h2") return <h3 key={gi} className="text-section font-semibold text-text">{renderInline(first.text)}</h3>;
        if (first.kind === "h3") return <h4 key={gi} className="text-body font-semibold text-text">{renderInline(first.text)}</h4>;
        return <p key={gi}>{renderInline(first.text)}</p>;
      })}
    </div>
  );
}

function WatchDialog({ open, onClose, onSave, saving, saved, error, canSave }: { open: boolean; onClose: () => void; onSave: () => void; saving: boolean; saved: boolean; error: string | null; canSave: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) ref.current?.querySelector<HTMLElement>("button")?.focus(); }, [open]);
  if (!open) return null;
  return (
    <div ref={ref} role="dialog" aria-label="Turn into a watch" data-watch-dialog="" className="mx-4 mb-3 rounded-card border border-border bg-surface p-4 shadow-pop" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-tint text-brand-ink"><ClockIcon size={15} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-body font-semibold text-text">Watches arrive in a later layer</div>
          <p className="mt-1 text-ui text-secondary">
            A watch is a standing alert: GD360 re-runs the cells this finding depends on every refresh and tells you when the number moves. Scheduling and notifications are not wired yet.
            {canSave ? " Save the intent as a comment on this cell so it is not lost - it will be picked up when watches ship." : " Comments are not available on this view, so the intent can't be saved from here yet."}
          </p>
          {error && <div role="alert" className="mt-2 text-caption text-danger">{error}</div>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {canSave && !saved && <Button size="sm" variant="primary" loading={saving} onClick={onSave} data-watch-save="">Save as a comment</Button>}
            {saved && <span className="text-caption text-good">Saved as a comment on this cell.</span>}
            <Button size="sm" variant="ghost" onClick={onClose}>{saved ? "Done" : "Not now"}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TextCell({ cell, owner, comments, editing, onStartEdit, onStopEdit }: CellBodyProps) {
  const block = cell.block;
  const stored: string = typeof block.config?.text === "string" ? block.config.text : "";
  const [draft, setDraft] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [watchOpen, setWatchOpen] = useState(false);
  const [watchSaving, setWatchSaving] = useState(false);
  const [watchSaved, setWatchSaved] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setDraft(stored); }, [stored]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const finding = isFinding(stored);
  const body = finding ? stored.replace(FINDING_RE, "") : stored;

  const save = async () => {
    if (!owner) return;
    setSaving(true);
    setSaveError(null);
    try {
      await owner.updateBlock(block.id, { config: { ...slimConfig(block.config), text: draft } });
      onStopEdit();
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setSaveError(typeof detail === "string" ? detail : "Couldn't save this text.");
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => { setDraft(stored); setSaveError(null); onStopEdit(); };

  const saveWatch = async () => {
    setWatchSaving(true);
    setWatchError(null);
    try {
      await comments.addThread(block.id, `Watch request: ${body.split("\n")[0].slice(0, 300)}\n\nTurn this finding into a standing alert when watches ship.`);
      setWatchSaved(true);
    } catch (e: any) {
      setWatchError(e?.message || "Couldn't save the intent.");
    } finally {
      setWatchSaving(false);
    }
  };

  if (editing && owner) {
    return (
      <div className="px-4 pb-3" data-text-editor="">
        <Textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(16, Math.max(4, draft.split("\n").length + 1))}
          aria-label={`Text for ${cell.label}`}
          placeholder={"Write a note. # Heading, **bold**, - bullets. Start with \"Finding:\" for a callout."}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.stopPropagation(); cancel(); }
            else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); save(); }
            else if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter") e.stopPropagation();
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="primary" onClick={save} loading={saving} disabled={draft === stored} data-save-text="">Save</Button>
          <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
          <span className="ml-auto text-[11px] text-faint">⌘↵ to save · Esc to leave</span>
        </div>
        {saveError && <div role="alert" className="mt-2 text-caption text-danger">{saveError}</div>}
      </div>
    );
  }

  if (finding) {
    return (
      <div className="px-4 pb-3" data-finding="">
        <div className="rounded-card border border-tint-border bg-tint/50 p-4">
          <div className="mb-2 flex items-center gap-1.5 text-caption font-medium uppercase tracking-caps text-brand-ink">
            <SparkleIcon size={13} /> Finding
          </div>
          {body.trim() ? <MarkdownLite text={body} className="text-text" /> : <div className="text-caption text-muted">Describe what you found.</div>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" icon={<ClockIcon size={14} />} onClick={() => { setWatchOpen(true); setWatchSaved(false); setWatchError(null); }} data-turn-into-watch="">Turn into a watch</Button>
            <span className="text-caption text-muted">A standing alert that re-checks this on every run.</span>
          </div>
        </div>
        <div className="-mx-4 mt-3">
          <WatchDialog open={watchOpen} onClose={() => setWatchOpen(false)} onSave={saveWatch} saving={watchSaving} saved={watchSaved} error={watchError} canSave={comments.enabled} />
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pb-3" onDoubleClick={owner ? onStartEdit : undefined}>
      {stored.trim() ? (
        <MarkdownLite text={stored} />
      ) : (
        <div className="text-caption text-muted">{owner ? "Empty note - press Enter or Edit to write." : "Empty note."}</div>
      )}
    </div>
  );
}
