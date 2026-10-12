import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { CommentAuthor, CommentPerson } from "../../api/client";
import { Avatar, Button, cn } from "../../ui";

// 2026-10-12 (round 38, team comments): the comment box with an @ list.
// Typing "@" (or "@ma") opens everyone who can open this dashboard -
// arrows / Enter / Tab pick, Esc closes - and the pick goes in as
// "@Maya". The ids picked travel with the comment (mention_ids), so the
// server never has to guess who "@Maya" was; a name typed by hand is still
// matched server-side when it is unambiguous. Someone who cannot open the
// dashboard is never offered, and the box says so when the search finds
// nobody.

const TRIGGER = /(^|[\s(])@([\p{L}\p{N}._-]{0,40})$/u;

function tokenFor(p: CommentPerson, all: CommentPerson[]): string {
  const parts = p.name.trim().split(/\s+/).filter(Boolean);
  const first = (parts[0] || p.email?.split("@")[0] || "someone").replace(/[^\p{L}\p{N}._-]/gu, "");
  const clash = all.some((o) => o.id !== p.id && o.name.trim().split(/\s+/)[0]?.toLowerCase() === first.toLowerCase());
  return clash && parts.length > 1 ? `${first}.${parts[parts.length - 1]}`.replace(/[^\p{L}\p{N}._-]/gu, "") : first;
}

export type MentionComposerProps = {
  loadPeople: () => Promise<CommentPerson[]>;
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string, mentionIds: string[]) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
  compact?: boolean;
  initialBody?: string;
  initialMentions?: CommentAuthor[];
  hint?: ReactNode;
  // round 38: whether something is typed (the on-chart popover won't close over it)
  onDirtyChange?: (dirty: boolean) => void;
};

export function MentionComposer({ loadPeople, placeholder, submitLabel, onSubmit, onCancel, autoFocus, compact, initialBody = "", initialMentions = [], hint, onDirtyChange }: MentionComposerProps) {
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [people, setPeople] = useState<CommentPerson[] | null>(null);
  const [query, setQuery] = useState<{ text: string; start: number } | null>(null);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<{ id: string; token: string }[]>(() => initialMentions.map((m) => ({ id: m.id, token: m.name.split(/\s+/)[0] })));
  const ref = useRef<HTMLTextAreaElement>(null);
  // The caret after a pick goes right after "@Maya " in the same commit as
  // the new text (a frame later, fast typing would land in the wrong place).
  const caretAfter = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current, at = caretAfter.current;
    if (!el || at === null) return;
    caretAfter.current = null;
    el.focus();
    el.setSelectionRange(at, at);
  }, [body]);
  const listId = useMemo(() => `mention-list-${Math.random().toString(36).slice(2, 8)}`, []);

  const ensurePeople = () => {
    if (people) return;
    loadPeople().then((p) => setPeople(p)).catch(() => setPeople([]));
  };
  useEffect(() => { if (autoFocus) ensurePeople(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const matches = useMemo(() => {
    if (!query || !people) return [];
    const q = query.text.toLowerCase();
    return people
      .filter((p) => !q || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || p.name.toLowerCase().replace(/\s+/g, "").startsWith(q) || (p.email || "").toLowerCase().startsWith(q))
      .slice(0, 6);
  }, [query, people]);

  const readTrigger = (text: string, caret: number) => {
    const m = TRIGGER.exec(text.slice(0, caret));
    if (!m) { setQuery(null); return; }
    ensurePeople();
    setQuery({ text: m[2], start: caret - m[2].length - 1 });
    setIdx(0);
  };

  const choose = (p: CommentPerson) => {
    const el = ref.current;
    if (!query || !el || !people) return;
    const token = tokenFor(p, people);
    const caret = el.selectionStart ?? body.length;
    const next = `${body.slice(0, query.start)}@${token} ${body.slice(caret)}`;
    setBody(next);
    setPicked((cur) => (cur.some((c) => c.id === p.id) ? cur : [...cur, { id: p.id, token }]));
    setQuery(null);
    caretAfter.current = query.start + token.length + 2;
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ids = picked.filter((p) => new RegExp(`(^|[^\\p{L}\\p{N}_@])@${p.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "iu").test(text)).map((p) => p.id);
      await onSubmit(text, ids);
      setBody("");
      setPicked([]);
      onCancel?.();
    } catch (err: any) {
      setError(err?.message || "Couldn't post this.");
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (query && matches.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => (i + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(matches[idx]); return; }
    }
    if (e.key === "Escape") {
      if (query) { e.stopPropagation(); setQuery(null); return; }
      // words typed are never thrown away by a stray Esc - Cancel does that
      if (body.trim()) { e.preventDefault(); e.stopPropagation(); return; }
      if (onCancel) { e.stopPropagation(); onCancel(); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  };

  const nobody = query && people && query.text.length >= 2 && matches.length === 0;
  return (
    <form className="relative flex flex-col gap-2" onSubmit={submit} data-comment-composer="">
      <textarea
        ref={ref}
        value={body}
        rows={compact ? 2 : 3}
        maxLength={5000}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-autocomplete="list"
        aria-controls={query ? listId : undefined}
        aria-expanded={Boolean(query && matches.length)}
        onFocus={ensurePeople}
        onChange={(e) => { setBody(e.target.value); onDirtyChange?.(e.target.value.trim().length > 0); readTrigger(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
        onClick={(e) => readTrigger(body, (e.target as HTMLTextAreaElement).selectionStart ?? body.length)}
        onKeyDown={onKeyDown}
        onBlur={() => window.setTimeout(() => setQuery(null), 150)}
        className="ui-focus w-full resize-y rounded-ctl border border-border bg-surface px-3 py-2 text-ui text-text placeholder:text-faint"
      />
      {query && (matches.length > 0 || nobody) && (
        <div id={listId} role="listbox" aria-label="People who can open this dashboard" data-mention-list=""
          className="absolute left-0 right-0 z-30 overflow-hidden rounded-card border border-border-strong bg-surface shadow-pop" style={{ top: compact ? 62 : 84 }}>
          {matches.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={i === idx}
              data-mention-option={p.name}
              onMouseDown={(e) => { e.preventDefault(); choose(p); }}
              onMouseEnter={() => setIdx(i)}
              className={cn("flex w-full items-center gap-2.5 px-3 py-2 text-left", i === idx ? "bg-subtle" : "")}
            >
              <Avatar name={p.name} size="xs" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui text-text">{p.name}{p.is_me ? " (you)" : ""}</span>
                <span className="block truncate text-[11.5px] text-muted">{p.email}</span>
              </span>
              <span className="text-[11px] capitalize text-faint">{p.role === "viewer" ? "can view" : p.role}</span>
            </button>
          ))}
          {nobody && <div className="px-3 py-2 text-caption text-muted">Nobody called “{query.text}” can open this dashboard. Share it with them first.</div>}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!body.trim()}>{submitLabel}</Button>
        {onCancel && <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <span className="ml-auto text-[11px] text-faint">{hint ?? "@ to mention · ⌘↵ to post"}</span>
      </div>
      {error && <div role="alert" className="text-caption text-danger">{error}</div>}
    </form>
  );
}

// A comment's words with its @mentions set off (only the ones that
// resolved to a person; anything else stays plain text).
export function CommentBody({ body, mentioned = [] }: { body: string; mentioned?: CommentAuthor[] }) {
  if (!mentioned.length) return <>{body}</>;
  const forms = new Map<string, CommentAuthor>();
  for (const m of mentioned) {
    const parts = m.name.toLowerCase().split(/\s+/).filter(Boolean);
    [parts[0], parts.join(""), parts.join("."), parts.join("_"), (m.email || "").split("@")[0]?.toLowerCase()].filter(Boolean).forEach((f) => forms.set(f!, m));
  }
  const out: ReactNode[] = [];
  const re = /(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}._-]+)/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const token = m[2].replace(/\.$/, "");
    const who = forms.get(token.toLowerCase());
    if (!who) continue;
    const at = m.index + m[1].length;
    out.push(body.slice(last, at));
    out.push(<span key={at} className="gd-mention" title={who.email || who.name}>@{who.name.split(/\s+/)[0]}</span>);
    last = at + 1 + token.length;
  }
  out.push(body.slice(last));
  return <>{out}</>;
}
