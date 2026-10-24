import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CommentAnchor, CommentThread, DashboardComment } from "../../api/client";
import { Button, CheckIcon, CloseIcon, CommentIcon, EditIcon, Sheet, TrashIcon, cn } from "../../ui";
import { relativeTime } from "../runState";
import { CommentBody, MentionComposer } from "./MentionComposer";
import type { CommentsApi } from "./useComments";
import { PersonAvatar } from "./people";

// 2026-10-07 (analyst canvas round, OptionC.dc.html's thread card): a
// comment thread pinned to a cell - or to one mark on its chart.
// 2026-10-12 (round 38, team comments): the card the Comments panel, the
// canvas and the grid all use -
//   - @mentions resolved to people are set off in the words;
//   - where it is pinned ("on 3 Oct") - a button that shows it on the chart;
//   - replies (the last two, the rest behind "N earlier replies"), Reply,
//     Resolve / Reopen ("Resolved by Maya"), Edit and Delete for whoever
//     may (the server says, per comment: can_edit / can_resolve /
//     can_delete);
//   - GD360's suggestion, when the thread has one: a card that says what
//     accepting would change, accepted only by someone who can edit the
//     dashboard, with Undo.

function anchorLabel(anchor: CommentAnchor | null | undefined): string | null {
  if (!anchor || anchor.key === undefined) return null;
  if (anchor.label) return String(anchor.label);
  return anchor.key === null ? "(Blanks)" : String(anchor.key);
}

export function anchorShort(anchor: CommentAnchor | null | undefined): string | null {
  const l = anchorLabel(anchor);
  return l ? `on ${l}` : null;
}

function readError(e: any, fallback: string): string {
  return typeof e?.message === "string" && e.message ? e.message : fallback;
}

function CommentRow({ comment, comments, meta, children, onEdited }: { comment: DashboardComment; comments: CommentsApi; meta?: ReactNode; children?: ReactNode; onEdited?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mine = comment.author.id === "me" || comment.author.id === comments.me;
  return (
    <div className="group/comment flex gap-2.5" data-comment-id={comment.id}>
      <PersonAvatar name={comment.author.name} initials={comment.author.initials} size="md" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-caption text-muted">
          <span className="font-medium text-text">{mine ? "You" : comment.author.name}</span>
          {meta}
          <span>{relativeTime(comment.created_at) || ""}</span>
          {comment.edited && <span className="text-faint" title={`Edited ${relativeTime(comment.updated_at) || ""}`}>· edited</span>}
          {comment.id.startsWith("tmp-") && <span className="text-faint">· posting…</span>}
          <span className="ml-auto inline-flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/comment:opacity-100">
            {comment.can_edit && !comment.id.startsWith("tmp-") && (
              <button type="button" aria-label="Edit comment" title="Edit" className="ui-focus inline-flex h-5 w-5 items-center justify-center rounded text-faint hover:bg-subtle hover:text-text" onClick={() => setEditing(true)}>
                <EditIcon size={12} />
              </button>
            )}
            {comment.can_delete && !comment.id.startsWith("tmp-") && (
              <button type="button" aria-label="Delete comment" title="Delete" disabled={busy} className="ui-focus inline-flex h-5 w-5 items-center justify-center rounded text-faint hover:bg-subtle hover:text-danger disabled:opacity-50" onClick={() => setConfirmDelete(true)}>
                <TrashIcon size={12} />
              </button>
            )}
          </span>
        </div>
        {editing ? (
          <div className="mt-1.5">
            <MentionComposer
              loadPeople={comments.loadPeople}
              placeholder="Edit your comment…"
              submitLabel="Save"
              autoFocus
              compact
              initialBody={comment.body}
              initialMentions={comment.mentioned || []}
              onCancel={() => setEditing(false)}
              onSubmit={async (b, ids) => { await comments.editBody(comment.id, b, ids); onEdited?.(); }}
            />
          </div>
        ) : (
          <div className="mt-0.5 whitespace-pre-wrap break-words text-ui text-text" data-comment-body="">
            <CommentBody body={comment.body} mentioned={comment.mentioned} />
          </div>
        )}
        {confirmDelete && (
          <div role="alertdialog" aria-label="Delete this comment?" className="mt-2 flex flex-wrap items-center gap-2 rounded-ctl border border-danger-border bg-danger-fill px-2.5 py-1.5 text-caption text-danger">
            {comment.parent_id ? "Delete this reply?" : "Delete this thread and its replies?"}
            <Button size="sm" variant="danger" loading={busy} onClick={async () => { setBusy(true); try { await comments.remove(comment.id); } finally { setBusy(false); setConfirmDelete(false); } }}>Delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function SuggestionCard({ thread, comments, onApplied }: { thread: CommentThread; comments: CommentsApi; onApplied?: () => void }) {
  const s = thread.suggestion!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  if (hidden && !s.applied) return null;
  const act = async (apply: boolean) => {
    setBusy(true);
    setError(null);
    try { await comments.applySuggestion(thread.id, apply); onApplied?.(); } catch (e: any) { setError(readError(e, "That didn't work.")); } finally { setBusy(false); }
  };
  return (
    <div data-comment-suggestion={s.kind} data-applied={s.applied ? "" : undefined} className="flex gap-2.5 rounded-ctl border border-tint-border bg-tint/50 p-2.5">
      <span aria-hidden="true" className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-surface text-[11px] text-brand-ink">✦</span>
      <div className="min-w-0 flex-1 text-caption">
        <div className="text-muted"><span className="font-medium text-text">Euliv</span> · suggestion</div>
        {s.applied ? (
          <div className="mt-0.5 text-secondary">
            <CheckIcon size={11} className="mr-1 inline text-good" />
            {s.label} is marked as a one-off{s.applied_by ? ` by ${s.applied_by}` : ""}: shown on the chart and left out of its forecast.
          </div>
        ) : (
          <div className="mt-0.5 text-secondary">{s.text}</div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!s.applied && s.can_apply && <Button size="sm" variant="primary" loading={busy} onClick={() => act(true)} data-apply-suggestion="">Yes, treat as one-off</Button>}
          {!s.applied && s.can_apply && <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>Not now</Button>}
          {!s.applied && !s.can_apply && <span className="text-faint">Someone who can edit this dashboard can accept it.</span>}
          {s.applied && s.can_apply && <button type="button" disabled={busy} className="ui-focus rounded px-0.5 font-medium text-brand-ink hover:underline disabled:opacity-50" onClick={() => act(false)} data-undo-suggestion="">Undo</button>}
        </div>
        {error && <div role="alert" className="mt-1 text-danger">{error}</div>}
      </div>
    </div>
  );
}

export function CommentThreadCard({
  thread, comments, defaultOpen = false, focused = false, className, onShowOnChart, onChartChanged, showWhere = false,
}: {
  thread: CommentThread;
  comments: CommentsApi;
  defaultOpen?: boolean;
  focused?: boolean;
  className?: string;
  onShowOnChart?: () => void;
  onChartChanged?: () => void;
  // The panel's flat list: say which chart the thread is on.
  showWhere?: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const [showAll, setShowAll] = useState(defaultOpen);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = anchorLabel(thread.anchor);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e: any) { setError(readError(e, "That didn't work.")); } finally { setBusy(false); }
  };
  const replies = thread.replies;
  const hiddenCount = showAll || focused ? 0 : Math.max(0, replies.length - 2);
  const shown = replies.slice(hiddenCount);
  return (
    <article
      data-comment-thread={thread.id}
      data-resolved={thread.resolved ? "" : undefined}
      data-focused={focused ? "" : undefined}
      aria-label={`Comment by ${thread.author.name}${label ? ` on ${label}` : ""}`}
      className={cn("flex flex-col gap-2.5 rounded-card border bg-surface p-3 transition-colors", focused ? "border-primary shadow-pop" : "border-border shadow-card", thread.resolved && !focused && "opacity-75", className)}
    >
      {showWhere && (thread.block_title || label) && (
        <div className="-mb-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted">
          <span className="truncate">{thread.block_title || "This dashboard"}</span>
          {label && <><span aria-hidden="true">·</span><span className="shrink-0 font-medium text-brand-ink">{label}</span></>}
        </div>
      )}
      <CommentRow
        comment={thread}
        comments={comments}
        meta={!showWhere && label ? (
          onShowOnChart
            ? <button type="button" className="ui-focus rounded font-medium text-brand-ink hover:underline" data-comment-anchor="" onClick={onShowOnChart}>on {label}</button>
            : <span className="font-medium text-brand-ink" data-comment-anchor="">on {label}</span>
        ) : undefined}
      >
        {thread.suggestion && <div className="mt-2"><SuggestionCard thread={thread} comments={comments} onApplied={onChartChanged} /></div>}
      </CommentRow>
      {replies.length > 0 && (
        <div className="ml-4 flex flex-col gap-2.5 border-l border-subtle pl-3" data-comment-replies="">
          {hiddenCount > 0 && (
            <button type="button" className="ui-focus self-start rounded px-0.5 text-caption text-muted hover:text-text hover:underline" onClick={() => setShowAll(true)}>
              {hiddenCount} earlier {hiddenCount === 1 ? "reply" : "replies"}
            </button>
          )}
          {shown.map((r) => <CommentRow key={r.id} comment={r} comments={comments} />)}
        </div>
      )}
      {replying && (
        <div className="ml-4 border-l border-subtle pl-3">
          <MentionComposer loadPeople={comments.loadPeople} placeholder="Reply… @ to mention" submitLabel="Reply" autoFocus compact onCancel={() => setReplying(false)}
            onSubmit={async (b, ids) => { await comments.reply(thread.id, b, ids); setShowAll(true); }} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-caption">
        {!thread.resolved && !replying && (
          <button type="button" className="ui-focus rounded px-0.5 font-medium text-brand-ink hover:underline" onClick={() => setReplying(true)} data-reply="">Reply</button>
        )}
        {thread.can_resolve && (
          <button type="button" disabled={busy} className="ui-focus inline-flex items-center gap-1 rounded px-0.5 text-muted hover:text-text hover:underline disabled:opacity-50" onClick={() => act(() => comments.resolve(thread.id, !thread.resolved))} data-resolve="">
            {thread.resolved ? <><CloseIcon size={11} /> Reopen</> : <><CheckIcon size={11} /> Resolve</>}
          </button>
        )}
        {onShowOnChart && thread.block_id && (
          <button type="button" className="ui-focus rounded px-0.5 text-muted hover:text-text hover:underline" onClick={onShowOnChart} data-show-on-chart="">Show on chart</button>
        )}
        {thread.resolved && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-good-fill px-1.5 text-[11px] font-medium text-good">
            <CheckIcon size={10} /> {thread.resolved_by ? `Resolved by ${thread.resolved_by}` : "Resolved"}
          </span>
        )}
      </div>
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

// The canvas cell's thread list (and the narrow-screen sheet): every
// thread on one block plus the new-thread composer.
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
          <MentionComposer
            loadPeople={comments.loadPeople}
            placeholder="Write a comment… @ to mention"
            submitLabel="Comment"
            autoFocus
            onCancel={onDoneComposing}
            onSubmit={async (b, ids) => { await comments.addThread(blockId, b, anchor, ids); }}
          />
        </div>
      )}
      {!composing && threads.length === 0 && (
        <div className="text-caption text-muted">No comments on this cell yet.</div>
      )}
    </div>
  );
}

// A narrow screen's thread panel for one block: the same list in a kit Sheet.
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
