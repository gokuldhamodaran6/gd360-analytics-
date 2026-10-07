import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { CommentAnchor, CommentThread, DashboardComment } from "../../api/client";
import { Avatar, Button, CheckIcon, CloseIcon, CommentIcon, Sheet, Textarea, TrashIcon, cn } from "../../ui";
import { relativeTime } from "../runState";
import type { CommentsApi } from "./useComments";

// 2026-10-07 (analyst canvas round, OptionC.dc.html's thread card): a
// comment thread pinned to a cell - or to one mark on its chart ("Gokul ·
// on the Groups bar · 2 h ago"). Avatar initials, body, "2 replies", the
// Reply composer, Resolve (author / editor) and Delete (author / owner,
// `can_delete`). @mentions stay plain text - the backend records them.
// BlockComments stacks every thread for one cell plus the new-thread
// composer; CommentsSheet is the same list in a side panel, for the
// dashboard grid's "N comments" menu row.

function anchorLabel(anchor: CommentAnchor | null | undefined): string | null {
  if (!anchor || anchor.key === undefined) return null;
  const key = anchor.key === null ? "(Blanks)" : String(anchor.key);
  const kind = anchor.kind === "slice" ? "slice" : anchor.kind === "row" ? "row" : anchor.kind === "point" ? "point" : anchor.kind === "cell" ? "cell" : "bar";
  return `on the ${key} ${kind}`;
}

export function anchorShort(anchor: CommentAnchor | null | undefined): string | null {
  if (!anchor || anchor.key === undefined) return null;
  return `on ${anchor.key === null ? "(Blanks)" : String(anchor.key)}`;
}

function Composer({ placeholder, submitLabel, onSubmit, onCancel, autoFocus, compact }: { placeholder: string; submitLabel: string; onSubmit: (body: string) => Promise<void>; onCancel?: () => void; autoFocus?: boolean; compact?: boolean }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text);
      setBody("");
      onCancel?.();
    } catch (err: any) {
      setError(err?.message || "Couldn't post this.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={submit} data-comment-composer="">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        rows={compact ? 2 : 3}
        autoFocus={autoFocus}
        aria-label={placeholder}
        maxLength={5000}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
          if (e.key === "Escape" && onCancel) { e.stopPropagation(); onCancel(); }
        }}
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!body.trim()}>{submitLabel}</Button>
        {onCancel && <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <span className="ml-auto text-[11px] text-faint">@name to mention · ⌘↵ to post</span>
      </div>
      {error && <div role="alert" className="text-caption text-danger">{error}</div>}
    </form>
  );
}

function CommentRow({ comment, meta, onDelete, children }: { comment: DashboardComment; meta?: ReactNode; onDelete?: () => void; children?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex gap-2.5" data-comment-id={comment.id}>
      <Avatar name={comment.author.name || comment.author.initials} size="sm" tone={comment.author.id === "me" ? "tint" : "brand"} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-caption text-muted">
          <span className="font-medium text-text">{comment.author.name}</span>
          {meta}
          <span>{relativeTime(comment.created_at) || ""}</span>
          {comment.id.startsWith("tmp-") && <span className="text-faint">· posting…</span>}
          {onDelete && comment.can_delete && (
            <button
              type="button"
              aria-label="Delete comment"
              title="Delete comment"
              disabled={busy}
              className="ui-focus ml-auto inline-flex h-5 w-5 items-center justify-center rounded text-faint hover:bg-subtle hover:text-danger disabled:opacity-50"
              onClick={async () => { setBusy(true); try { await onDelete(); } finally { setBusy(false); } }}
            >
              <TrashIcon size={12} />
            </button>
          )}
        </div>
        <div className="mt-0.5 whitespace-pre-wrap break-words text-ui text-text">{comment.body}</div>
        {children}
      </div>
    </div>
  );
}

export function CommentThreadCard({ thread, comments, defaultOpen = false, className }: { thread: CommentThread; comments: CommentsApi; defaultOpen?: boolean; className?: string }) {
  const [replying, setReplying] = useState(false);
  const [showReplies, setShowReplies] = useState(defaultOpen);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = anchorLabel(thread.anchor);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e: any) { setError(e?.message || "That didn't work."); } finally { setBusy(false); }
  };
  return (
    <article
      data-comment-thread={thread.id}
      data-resolved={thread.resolved ? "" : undefined}
      aria-label={`Comment by ${thread.author.name}`}
      className={cn("flex flex-col gap-2.5 rounded-card border border-border bg-surface p-3 shadow-card", thread.resolved && "opacity-70", className)}
    >
      <CommentRow
        comment={thread}
        meta={label ? <span className="font-medium text-brand-ink" data-comment-anchor="">{label}</span> : undefined}
        onDelete={thread.can_delete ? () => act(() => comments.remove(thread.id)) : undefined}
      >
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
          {thread.replies.length > 0 && (
            <button type="button" className="ui-focus rounded px-0.5 text-muted hover:text-text hover:underline" onClick={() => setShowReplies((o) => !o)} aria-expanded={showReplies}>
              {showReplies ? "Hide replies" : `${thread.replies.length} ${thread.replies.length === 1 ? "reply" : "replies"}`}
            </button>
          )}
          {!thread.resolved && (
            <button type="button" className="ui-focus rounded px-0.5 font-medium text-brand-ink hover:underline" onClick={() => setReplying(true)}>Reply</button>
          )}
          {thread.can_resolve && (
            <>
              <span aria-hidden="true" className="text-faint">·</span>
              <button type="button" disabled={busy} className="ui-focus inline-flex items-center gap-1 rounded px-0.5 text-muted hover:text-text hover:underline disabled:opacity-50" onClick={() => act(() => comments.resolve(thread.id, !thread.resolved))}>
                {thread.resolved ? <><CloseIcon size={11} /> Reopen</> : <><CheckIcon size={11} /> Resolve</>}
              </button>
            </>
          )}
          {thread.resolved && <span className="inline-flex items-center gap-1 rounded-full bg-good-fill px-1.5 text-[11px] font-medium text-good"><CheckIcon size={10} /> Resolved</span>}
        </div>
      </CommentRow>
      {showReplies && thread.replies.length > 0 && (
        <div className="ml-4 flex flex-col gap-2.5 border-l border-subtle pl-3" data-comment-replies="">
          {thread.replies.map((r) => (
            <CommentRow key={r.id} comment={r} onDelete={r.can_delete ? () => act(() => comments.remove(r.id)) : undefined} />
          ))}
        </div>
      )}
      {replying && (
        <div className="ml-4 border-l border-subtle pl-3">
          <Composer placeholder="Reply…" submitLabel="Reply" autoFocus compact onCancel={() => setReplying(false)} onSubmit={async (b) => { await comments.reply(thread.id, b); setShowReplies(true); }} />
        </div>
      )}
      {error && <div role="alert" className="text-caption text-danger">{error}</div>}
    </article>
  );
}

export type BlockCommentsProps = {
  blockId: string;
  comments: CommentsApi;
  // A chart mark the next new thread is pinned to (set by the cell when
  // the person clicked a bar after "Comment"), plus a way to clear it.
  anchor?: CommentAnchor | null;
  onClearAnchor?: () => void;
  // Start with the new-thread composer open.
  composing?: boolean;
  onDoneComposing?: () => void;
  // Hint shown above the composer while a mark can still be picked.
  pickHint?: ReactNode;
  showResolved?: boolean;
  className?: string;
};

export function BlockComments({ blockId, comments, anchor = null, onClearAnchor, composing = false, onDoneComposing, pickHint, showResolved = true, className }: BlockCommentsProps) {
  const threads = comments.threadsFor(blockId, { includeResolved: showResolved });
  const open = threads.filter((t) => !t.resolved), resolved = threads.filter((t) => t.resolved);
  const [showResolvedList, setShowResolvedList] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (composing) composerRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [composing]);
  return (
    <div className={cn("flex flex-col gap-2.5", className)} data-block-comments={blockId}>
      {open.map((t) => <CommentThreadCard key={t.id} thread={t} comments={comments} />)}
      {resolved.length > 0 && (
        <button type="button" className="ui-focus self-start rounded px-0.5 text-caption text-muted hover:text-text hover:underline" onClick={() => setShowResolvedList((o) => !o)} aria-expanded={showResolvedList}>
          {showResolvedList ? "Hide resolved" : `${resolved.length} resolved`}
        </button>
      )}
      {showResolvedList && resolved.map((t) => <CommentThreadCard key={t.id} thread={t} comments={comments} />)}
      {composing && (
        <div ref={composerRef} className="rounded-card border border-tint-border bg-tint/40 p-3" data-new-thread="">
          <div className="mb-2 flex flex-wrap items-center gap-x-1.5 text-caption text-secondary">
            <CommentIcon size={13} className="text-brand-ink" />
            {anchor ? (
              <>
                <span>New comment <span className="font-medium text-brand-ink">{anchorShort(anchor)}</span></span>
                {onClearAnchor && <button type="button" className="ui-focus rounded px-0.5 text-muted hover:underline" onClick={onClearAnchor}>comment on the whole cell instead</button>}
              </>
            ) : (
              pickHint || <span>New comment on this cell</span>
            )}
          </div>
          <Composer
            placeholder="Write a comment…"
            submitLabel="Comment"
            autoFocus
            onCancel={onDoneComposing}
            onSubmit={async (b) => { await comments.addThread(blockId, b, anchor); }}
          />
        </div>
      )}
      {!composing && threads.length === 0 && (
        <div className="text-caption text-muted">No comments on this cell yet.</div>
      )}
    </div>
  );
}

// The dashboard grid's thread panel: the same list in a kit Sheet.
export function CommentsSheet({ open, onClose, blockId, title, comments }: { open: boolean; onClose: () => void; blockId: string | null; title: ReactNode; comments: CommentsApi }) {
  const [composing, setComposing] = useState(false);
  useEffect(() => { if (!open) setComposing(false); }, [open]);
  if (!blockId) return null;
  const count = comments.countFor(blockId);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Comments"
      subtitle={<span className="truncate">{title}{count.total ? ` · ${count.total} comment${count.total === 1 ? "" : "s"} · ${count.open} open` : ""}</span>}
      size="md"
      id={`comments-${blockId}`}
      footer={!composing ? <Button variant="primary" icon={<CommentIcon size={14} />} onClick={() => setComposing(true)}>New comment</Button> : undefined}
    >
      {comments.error && <div role="alert" className="mb-3 rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-ui text-danger">{comments.error}</div>}
      <BlockComments blockId={blockId} comments={comments} composing={composing} onDoneComposing={() => setComposing(false)} />
    </Sheet>
  );
}
