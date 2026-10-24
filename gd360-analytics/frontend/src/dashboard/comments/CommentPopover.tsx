import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { CommentThread, DashboardComment } from "../../api/client";
import { Button, CheckIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, cn } from "../../ui";
import { relativeTime } from "../runState";
import { blockElement, threadKey, useCommentsUi, type CommentsUi } from "./CommentsUi";
import { CommentBody, MentionComposer } from "./MentionComposer";
import { PersonAvatar, personColor } from "./people";

// 2026-10-12 (round 38, team comments): the conversation, right where it
// is about. A click on a pin opens its thread beside the point - who said
// it, on which day, the replies, GD360's suggestion with what accepting it
// changes ("The forecast drops by 64 sessions"), and Yes / Reply in one
// row. A click on a point after "Comment" opens the composer in the same
// place. Esc or a click elsewhere closes it (never while something typed
// would be lost). On a phone it rises from the bottom of the screen.

const WIDTH = 348;
const GAP = 14;

function anchorFor(ui: CommentsUi): Element | null {
  const p = ui.popover;
  if (!p) return null;
  const card = blockElement(p.blockId);
  const scope = card || document;
  let key: string | null = null;
  if (p.threadId === null) key = ui.draft?.anchor ? threadKey({ anchor: ui.draft.anchor }) : null;
  else key = threadKey(ui.api.threads.find((t) => t.id === p.threadId) || {});
  if (key !== null) {
    const pin = scope.querySelector(`[data-comment-pin="${CSS.escape(key)}"]`);
    if (pin) return pin;
  }
  return scope.querySelector(`[data-comment-control]`) || card;
}

function usePlacement(ui: CommentsUi, box: React.RefObject<HTMLDivElement | null>, phone: boolean) {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", left: -9999, top: 0 });
  const last = useRef("");
  useLayoutEffect(() => {
    if (!ui?.popover || phone) return;
    let raf = 0;
    const place = () => {
      raf = window.requestAnimationFrame(place);
      const a = anchorFor(ui);
      const el = box.current;
      if (!a || !el) return;
      const r = a.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const h = el.offsetHeight || 200;
      const offscreen = r.bottom < 0 || r.top > vh || (r.width === 0 && r.height === 0);
      let left = r.right + GAP;
      if (left + WIDTH > vw - 12) left = r.left - GAP - WIDTH;
      let top = r.top + r.height / 2 - 34;
      if (left < 12) {
        left = Math.min(Math.max(12, r.left + r.width / 2 - WIDTH / 2), vw - WIDTH - 12);
        top = r.bottom + GAP;
      }
      top = Math.min(Math.max(12, top), Math.max(12, vh - h - 12));
      const key = `${Math.round(left)}:${Math.round(top)}:${offscreen}`;
      if (key === last.current) return;
      last.current = key;
      setStyle({ left, top, visibility: offscreen ? "hidden" : "visible" });
    };
    place();
    return () => window.cancelAnimationFrame(raf);
  }, [ui, box, phone]);
  return style;
}

function ReplyRow({ c }: { c: DashboardComment }) {
  return (
    <div className="flex gap-2" data-comment-id={c.id}>
      <PersonAvatar name={c.author.name} initials={c.author.initials} size="xs" className="mt-0.5" />
      <div className="min-w-0 flex-1 text-[12.5px] leading-snug">
        <span className="font-medium text-text">{c.author.name}</span>
        <span className="text-faint"> · {relativeTime(c.created_at) || ""}</span>
        <div className="whitespace-pre-wrap break-words text-secondary"><CommentBody body={c.body} mentioned={c.mentioned} /></div>
      </div>
    </div>
  );
}

function ThreadView({ ui, thread, siblings, onPick, setDirty }: { ui: CommentsUi; thread: CommentThread; siblings: CommentThread[]; onPick: (id: string) => void; setDirty: (d: boolean) => void }) {
  const api = ui.api;
  const [replying, setReplying] = useState(false);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<"" | "apply" | "undo" | "resolve">("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setReplying(false); setAll(false); setError(null); }, [thread.id]);
  const label = thread.anchor ? String(thread.anchor.label ?? thread.anchor.key ?? "") : null;
  const s = thread.suggestion;
  const run = async (kind: "apply" | "undo" | "resolve", fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try { await fn(); } catch (e: any) { setError(e?.message || "That didn't work."); } finally { setBusy(""); }
  };
  const hidden = all ? 0 : Math.max(0, thread.replies.length - 2);
  const idx = siblings.findIndex((t) => t.id === thread.id);
  return (
    <div className="flex flex-col gap-3" data-comment-thread={thread.id} data-resolved={thread.resolved ? "" : undefined} data-focused="">
      <div className="flex items-start gap-2.5">
        <PersonAvatar name={thread.author.name} initials={thread.author.initials} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-1.5 pr-6 text-[13px]">
            <span className="font-semibold text-text">{thread.author.name}</span>
            {label && <span className="text-muted">· {label}</span>}
            <span className="text-[11.5px] text-faint">{relativeTime(thread.created_at) || ""}{thread.edited ? " · edited" : ""}</span>
          </div>
          <div className="mt-0.5 whitespace-pre-wrap break-words text-[13.5px] leading-[1.45] text-text" data-comment-body="">
            <CommentBody body={thread.body} mentioned={thread.mentioned} />
          </div>
        </div>
      </div>

      {thread.replies.length > 0 && (
        <div className="ml-[42px] flex flex-col gap-2" data-comment-replies="">
          {hidden > 0 && (
            <button type="button" className="ui-focus self-start rounded text-[12px] text-muted hover:text-text hover:underline" onClick={() => setAll(true)}>
              {hidden} earlier {hidden === 1 ? "reply" : "replies"}
            </button>
          )}
          {thread.replies.slice(hidden).map((r) => <ReplyRow key={r.id} c={r} />)}
        </div>
      )}

      {s && (
        <div className="flex gap-2.5 rounded-[12px] border border-border bg-subtle/60 p-2.5" data-comment-suggestion={s.kind} data-applied={s.applied ? "" : undefined}>
          <span aria-hidden="true" className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-tint-border bg-tint text-[12px] text-brand-ink">✦</span>
          <div className="min-w-0 flex-1 text-[12.5px] leading-snug">
            <div><span className="font-semibold text-text">Euliv</span><span className="text-muted"> · suggestion</span></div>
            {s.applied ? (
              <div className="mt-0.5 text-secondary">
                <CheckIcon size={11} className="mr-1 inline text-good" />
                Marked as a one-off{s.applied_by ? ` by ${s.applied_by}` : ""}. It is left out of the forecast.
                {s.can_apply && (
                  <button type="button" disabled={busy !== ""} className="ui-focus ml-1.5 rounded font-medium text-brand-ink hover:underline disabled:opacity-50" data-undo-suggestion=""
                    onClick={() => run("undo", async () => { await api.applySuggestion(thread.id, false); ui.onChartChanged?.(thread.block_id!); })}>Undo</button>
                )}
              </div>
            ) : (
              <div className="mt-0.5 text-secondary">{s.text}</div>
            )}
          </div>
        </div>
      )}

      {replying ? (
        <MentionComposer
          loadPeople={api.loadPeople}
          placeholder="Reply… @ to mention"
          submitLabel="Reply"
          autoFocus
          compact
          onDirtyChange={setDirty}
          onCancel={() => { setReplying(false); setDirty(false); }}
          onSubmit={async (b, ids) => { await api.reply(thread.id, b, ids); setAll(true); setDirty(false); }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {s && !s.applied && s.can_apply && (
            <Button size="sm" variant="primary" loading={busy === "apply"} data-apply-suggestion=""
              onClick={() => run("apply", async () => { await api.applySuggestion(thread.id, true); ui.onChartChanged?.(thread.block_id!); })}>
              Yes, treat as one-off
            </Button>
          )}
          {!thread.resolved && <Button size="sm" variant="secondary" onClick={() => setReplying(true)} data-reply="">Reply</Button>}
          {s && !s.applied && !s.can_apply && <span className="text-[11.5px] text-faint">An editor can accept Euliv's suggestion.</span>}
        </div>
      )}
      {error && <div role="alert" className="text-caption text-danger">{error}</div>}

      <div className="-mx-4 -mb-3 flex items-center gap-3 border-t border-subtle px-4 py-2 text-[12px]">
        {thread.resolved && (
          <span className="inline-flex items-center gap-1 text-good"><CheckIcon size={11} /> {thread.resolved_by ? `Resolved by ${thread.resolved_by}` : "Resolved"}</span>
        )}
        {thread.can_resolve && (
          <button type="button" disabled={busy !== ""} data-resolve=""
            className="ui-focus inline-flex items-center gap-1 rounded text-muted hover:text-text hover:underline disabled:opacity-50"
            onClick={() => run("resolve", () => api.resolve(thread.id, !thread.resolved))}>
            {thread.resolved ? "Reopen" : <><CheckIcon size={11} /> Resolve</>}
          </button>
        )}
        {siblings.length > 1 && (
          <span className="inline-flex items-center gap-0.5 text-muted" data-popover-pager="">
            <button type="button" aria-label="Previous comment here" className="ui-focus rounded p-0.5 hover:bg-subtle hover:text-text disabled:opacity-40" disabled={idx <= 0} onClick={() => onPick(siblings[idx - 1].id)}><ChevronLeftIcon size={13} /></button>
            <span className="tabular-nums">{idx + 1} of {siblings.length}</span>
            <button type="button" aria-label="Next comment here" className="ui-focus rounded p-0.5 hover:bg-subtle hover:text-text disabled:opacity-40" disabled={idx >= siblings.length - 1} onClick={() => onPick(siblings[idx + 1].id)}><ChevronRightIcon size={13} /></button>
          </span>
        )}
        <button type="button" className="ui-focus ml-auto rounded text-muted hover:text-text hover:underline" data-open-in-panel=""
          onClick={() => ui.openPanel({ threadId: thread.id })}>All comments →</button>
      </div>
    </div>
  );
}

function DraftView({ ui, setDirty }: { ui: CommentsUi; setDirty: (d: boolean) => void }) {
  const d = ui.draft!;
  const me = ui.api.people?.people.find((p) => p.is_me);
  const info = ui.blocks.get(d.blockId);
  const label = d.anchor ? String(d.anchor.label ?? d.anchor.key ?? "") : null;
  const pickable = info ? !["kpi", "text", "heading"].includes(info.type) : false;
  return (
    <div className="flex flex-col gap-3" data-comment-draft={d.blockId}>
      <div className="flex items-start gap-2.5 pr-6">
        <PersonAvatar name={me?.name || "You"} initials={me?.initials} size="lg" />
        <div className="min-w-0 flex-1 text-[13px]">
          <div className="font-semibold text-text">New comment</div>
          <div className="truncate text-muted" data-draft-anchor="">
            {label ? <>on <span className="font-medium text-brand-ink">{label}</span> · {info?.title || "this chart"}</> : <>on {info?.title || "this chart"}{pickable ? <span className="text-faint"> · or click a point to pin it</span> : null}</>}
          </div>
        </div>
      </div>
      <MentionComposer
        key={`${d.blockId}:${label ?? ""}`}
        loadPeople={ui.api.loadPeople}
        placeholder="Say what you see… @ to bring someone in"
        submitLabel="Comment"
        autoFocus
        compact
        onDirtyChange={setDirty}
        onCancel={() => { setDirty(false); ui.clearDraft(); }}
        onSubmit={async (body, ids) => {
          const t = await ui.api.addThread(d.blockId, body, d.anchor, ids);
          setDirty(false);
          if (t) ui.openThread(t.id, d.blockId);
          else ui.clearDraft();
        }}
      />
      {label && (
        <button type="button" className="ui-focus -mt-1 self-start rounded text-[12px] text-muted hover:text-text hover:underline" onClick={() => ui.setDraftAnchor(null)}>
          Comment on the whole chart instead
        </button>
      )}
    </div>
  );
}

export function CommentPopover() {
  const ui = useCommentsUi();
  const box = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.innerWidth < 560);
  useEffect(() => {
    const on = () => setPhone(window.innerWidth < 560);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const style = usePlacement(ui as CommentsUi, box, phone);
  const open = Boolean(ui?.popover && ui.api.enabled);

  useEffect(() => {
    if (!open || !ui) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[data-mention-list]")) return;
      if (dirty.current) return;
      ui.closePopover();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || box.current?.contains(t)) return;
      if (t.closest("[data-comment-pin], [data-comments-panel], [data-comment-control], [data-popover-portal]")) return;
      // a chart still waiting for its point keeps the composer open
      if (ui.popover && ui.popover.threadId === null && blockElement(ui.popover.blockId)?.contains(t)) return;
      if (dirty.current) return;
      ui.closePopover();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown, true);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown, true); };
  }, [open, ui]);

  if (!ui || !open) return null;
  const p = ui.popover!;
  let thread: CommentThread | null = null;
  let siblings: CommentThread[] = [];
  if (p.threadId) {
    thread = ui.api.threads.find((t) => t.id === p.threadId) || null;
    if (!thread) return null;
    const key = threadKey(thread);
    siblings = ui.api.threads.filter((t) => t.block_id === thread!.block_id && threadKey(t) === key && (key !== null || t.id === thread!.id) && (!t.resolved || t.id === thread!.id));
  } else if (!ui.draft) {
    return null;
  }
  const color = personColor(thread ? thread.author.name : ui.api.people?.people.find((x) => x.is_me)?.name);
  const setDirty = (d: boolean) => { dirty.current = d; };

  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label={thread ? `Comment by ${thread.author.name}` : "New comment"}
      data-comment-popover={thread ? "thread" : "draft"}
      className={cn(
        "fixed z-[58] rounded-[16px] border bg-surface px-4 pb-3 pt-3.5 shadow-[0_28px_70px_-24px_rgb(0_0_0/0.85)] print:hidden",
        phone ? "inset-x-2 bottom-2 max-h-[72vh] overflow-y-auto" : "max-h-[min(560px,calc(100vh-24px))] overflow-y-auto",
      )}
      style={phone ? { borderColor: `${color}66` } : { ...style, width: WIDTH, borderColor: `${color}66` }}
    >
      <button type="button" aria-label="Close" onClick={() => { dirty.current = false; ui.closePopover(); }}
        className="ui-focus absolute right-2.5 top-2.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-faint hover:bg-subtle hover:text-text">
        <CloseIcon size={13} />
      </button>
      {thread ? <ThreadView ui={ui} thread={thread} siblings={siblings} onPick={(id) => ui.openThread(id)} setDirty={setDirty} /> : <DraftView ui={ui} setDirty={setDirty} />}
    </div>,
    document.body
  );
}
