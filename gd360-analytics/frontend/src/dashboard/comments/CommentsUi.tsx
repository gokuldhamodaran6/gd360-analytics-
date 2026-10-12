import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CommentAnchor, CommentThread } from "../../api/client";
import type { ChartPin } from "../charts/CartesianChart";
import { personColor } from "./people";
import type { CommentsApi } from "./useComments";

// 2026-10-12 (round 38, team comments): what the dashboard knows about
// comments beyond the threads themselves. One provider per dashboard
// (DashboardShell); every card, KPI tile, the on-chart popover and the
// panel read it, so a click on a point, the bell's link and the panel all
// move the same state.
//
//   - The ON-CHART popover is where a conversation happens: a click on a
//     pin opens its thread right beside the point; a click on a point
//     (after "Comment") opens the composer there. The panel is the list of
//     everything, opened when the reader wants the overview.
//   - "Show comments on charts" (on by default, remembered per browser):
//     off, the charts are clean - no pins, chips or badges - and the
//     Comments button still says how many are open.

export type CommentDraft = { blockId: string; anchor: CommentAnchor | null; where: "chart" | "panel" };
export type CommentBlockInfo = { id: string; title: string; type: string; pageId: string; pageName: string };
export type PanelTab = "open" | "mine" | "resolved";
export type CommentPopover = { blockId: string; threadId: string | null };

export type CommentsUi = {
  api: CommentsApi;
  blocks: Map<string, CommentBlockInfo>;
  activePageId: string | null;
  panelOpen: boolean;
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
  openPanel: (opts?: { blockId?: string | null; threadId?: string | null }) => void;
  closePanel: () => void;
  commentMode: boolean;
  setCommentMode: (on: boolean) => void;
  draft: CommentDraft | null;
  startDraft: (blockId: string, anchor?: CommentAnchor | null, where?: "chart" | "panel") => void;
  setDraftAnchor: (anchor: CommentAnchor | null) => void;
  clearDraft: () => void;
  popover: CommentPopover | null;
  // blockId: a thread just posted (not in the list this render yet)
  openThread: (threadId: string, blockId?: string) => void;
  closePopover: () => void;
  showOnCharts: boolean;
  setShowOnCharts: (on: boolean) => void;
  // A click on a mark pins a comment right now (comment mode, or a draft
  // on this block that has no point yet).
  pickingFor: (blockId: string) => boolean;
  focusId: string | null;
  focusBlockId: string | null;
  focus: (threadId: string, opts?: { scroll?: boolean; popover?: boolean; panel?: boolean }) => void;
  showBlock: (blockId: string) => void;
  pinsFor: (blockId: string) => ChartPin[];
  countFor: (blockId: string) => { open: number; total: number; initials: string[]; people: { name: string; initials: string }[] };
  onChartChanged?: (blockId: string) => void;
};

const Ctx = createContext<CommentsUi | null>(null);

export function useCommentsUi(): CommentsUi | null {
  return useContext(Ctx);
}

const SHOW_KEY = "gd360_comments_on_charts";
function readShow(): boolean {
  try { return localStorage.getItem(SHOW_KEY) !== "0"; } catch { return true; }
}

function flash(el: Element | null) {
  if (!el) return;
  el.removeAttribute("data-comment-flash");
  void (el as HTMLElement).offsetWidth;
  el.setAttribute("data-comment-flash", "");
  window.setTimeout(() => el.removeAttribute("data-comment-flash"), 1800);
}

export function blockElement(blockId: string): Element | null {
  return document.querySelector(`#block-${CSS.escape(blockId)}, [data-kpi-block="${CSS.escape(blockId)}"]`);
}

export function threadKey(t: { anchor?: CommentAnchor | null }): string | null {
  if (!t.anchor || t.anchor.key === undefined) return null;
  return t.anchor.key === null ? "(Blanks)" : String(t.anchor.key);
}

export function CommentsUiProvider({
  api, blocks, activePageId, onOpenPage, onChartChanged, initialThreadId, children,
}: {
  api: CommentsApi;
  blocks: CommentBlockInfo[];
  activePageId: string | null;
  onOpenPage?: (pageId: string) => void;
  onChartChanged?: (blockId: string) => void;
  initialThreadId?: string | null;
  children: ReactNode;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>("open");
  const [commentMode, setCommentModeState] = useState(false);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [popover, setPopover] = useState<CommentPopover | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null);
  const [showOnCharts, setShowState] = useState(readShow);
  const blockMap = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);
  const pending = useRef<{ blockId: string } | null>(null);

  const setShowOnCharts = useCallback((on: boolean) => {
    setShowState(on);
    try { localStorage.setItem(SHOW_KEY, on ? "1" : "0"); } catch { /* private window */ }
  }, []);

  const scrollToBlock = useCallback((blockId: string) => {
    const el = blockElement(blockId);
    if (!el) return false;
    el.scrollIntoView?.({ behavior: "smooth", block: "center" });
    flash(el);
    return true;
  }, []);

  // A block on another page: switch page first, scroll once it is drawn.
  const reveal = useCallback((blockId: string) => {
    const info = blockMap.get(blockId);
    if (info && activePageId && info.pageId !== activePageId && onOpenPage) {
      pending.current = { blockId };
      onOpenPage(info.pageId);
      return;
    }
    window.requestAnimationFrame(() => scrollToBlock(blockId));
  }, [blockMap, activePageId, onOpenPage, scrollToBlock]);

  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    const info = blockMap.get(p.blockId);
    if (info && info.pageId === activePageId) {
      pending.current = null;
      window.setTimeout(() => scrollToBlock(p.blockId), 350);
    }
  }, [activePageId, blockMap, scrollToBlock]);

  const setCommentMode = useCallback((on: boolean) => {
    setCommentModeState(on);
    if (on) { setPopover(null); setDraft((d) => (d?.where === "chart" ? null : d)); }
  }, []);

  useEffect(() => {
    if (!commentMode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCommentModeState(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [commentMode]);

  const focus = useCallback((threadId: string, opts: { scroll?: boolean; popover?: boolean; panel?: boolean } = {}) => {
    const t = api.threads.find((x) => x.id === threadId);
    setFocusId(threadId);
    if (opts.panel) {
      setPanelOpen(true);
      if (t?.resolved) setTab("resolved");
      else setTab((cur) => (cur === "resolved" ? "open" : cur));
      window.setTimeout(() => {
        const card = document.querySelector(`[data-comments-panel] [data-comment-thread="${CSS.escape(threadId)}"]`);
        card?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
        flash(card);
      }, 120);
    }
    if (t?.block_id) {
      setFocusBlockId(t.block_id);
      if (opts.scroll !== false) reveal(t.block_id);
      if (opts.popover) {
        setDraft((d) => (d?.where === "chart" ? null : d));
        setPopover({ blockId: t.block_id, threadId });
      }
    }
  }, [api.threads, reveal]);

  const openThread = useCallback((threadId: string, blockId?: string) => {
    if (blockId) {
      setFocusId(threadId);
      setFocusBlockId(blockId);
      setDraft((d) => (d?.where === "chart" ? null : d));
      setPopover({ blockId, threadId });
      return;
    }
    focus(threadId, { scroll: false, popover: true });
  }, [focus]);

  // The bell's link (?comment=<id>): the thread opens on its chart, right
  // beside its point, once the threads are in.
  const deepLinked = useRef<string | null>(null);
  useEffect(() => {
    if (!initialThreadId || deepLinked.current === initialThreadId) return;
    if (!api.threads.some((t) => t.id === initialThreadId)) return;
    deepLinked.current = initialThreadId;
    focus(initialThreadId, { popover: true });
  }, [initialThreadId, api.threads, focus]);

  const startDraft = useCallback((blockId: string, anchor: CommentAnchor | null = null, where: "chart" | "panel" = "chart") => {
    setDraft({ blockId, anchor, where });
    setCommentModeState(false);
    setFocusId(null);
    setFocusBlockId(blockId);
    if (where === "panel") { setPanelOpen(true); setTab("open"); setPopover(null); }
    else setPopover({ blockId, threadId: null });
    api.loadPeople();
  }, [api]);

  const me = api.people?.people.find((p) => p.is_me) || null;

  const pinsFor = useCallback((blockId: string): ChartPin[] => {
    const out: ChartPin[] = [];
    const draftKey = draft && draft.blockId === blockId && draft.where === "chart" && draft.anchor ? threadKey({ anchor: draft.anchor }) : null;
    {
      // the open thread keeps its pin even with comments hidden on charts
      const groups = new Map<string, CommentThread[]>();
      for (const t of api.threads) {
        const key = t.block_id === blockId ? threadKey(t) : null;
        if (key === null) continue;
        if (!showOnCharts && t.id !== popover?.threadId) continue;
        if (t.resolved && t.id !== focusId) continue;
        groups.set(key, [...(groups.get(key) || []), t]);
      }
      for (const [key, ts] of groups) {
        if (key === draftKey) continue;
        const first = ts.find((t) => t.id === focusId) || ts[0];
        const count = ts.reduce((n, t) => n + 1 + t.replies.length, 0);
        const label = String(first.anchor?.label ?? key);
        const who = first.author.id === "me" && me ? me.name : first.author.name;
        out.push({
          key, label, count, open: ts.some((t) => !t.resolved),
          active: Boolean(popover && popover.blockId === blockId && ts.some((t) => t.id === popover.threadId)) || ts.some((t) => t.id === focusId),
          initials: first.author.initials || "?",
          color: personColor(who),
          title: `${who} on ${label}: ${first.body.slice(0, 90)}${count > 1 ? ` (${count} comments)` : ""}`,
          onClick: () => focus(first.id, { scroll: false, popover: true }),
        });
      }
    }
    // the comment being written sits on its point, whatever the toggle says
    if (draftKey !== null && draft?.anchor) {
      out.push({
        key: draftKey, label: String(draft.anchor.label ?? draftKey), count: 0, open: true, active: true, pending: true,
        initials: me?.initials || "+", color: personColor(me?.name), title: "Your comment", onClick: () => setPopover({ blockId, threadId: null }),
      });
    }
    return out;
  }, [api.threads, focusId, focus, draft, popover, showOnCharts, me]);

  const countFor = useCallback((blockId: string) => {
    let open = 0, total = 0;
    const initials: string[] = [];
    const people: { name: string; initials: string }[] = [];
    for (const t of api.threads) {
      if (t.block_id !== blockId) continue;
      const n = 1 + t.replies.length;
      total += n;
      if (!t.resolved) {
        open += n;
        for (const p of t.participants || [t.author]) {
          if (initials.includes(p.initials)) continue;
          initials.push(p.initials);
          people.push({ name: p.id === "me" && me ? me.name : p.name, initials: p.initials });
        }
      }
    }
    return { open, total, initials, people };
  }, [api.threads, me]);

  const value = useMemo<CommentsUi>(() => ({
    api, blocks: blockMap, activePageId, panelOpen, tab, setTab,
    openPanel: (opts = {}) => {
      setPanelOpen(true);
      if (opts.threadId) focus(opts.threadId, { panel: true });
      else if (opts.blockId) { setFocusBlockId(opts.blockId); setFocusId(null); }
    },
    closePanel: () => { setPanelOpen(false); setCommentModeState(false); setDraft((d) => (d?.where === "panel" ? null : d)); setFocusBlockId(null); },
    commentMode, setCommentMode,
    draft, startDraft,
    setDraftAnchor: (anchor) => { setDraft((d) => (d ? { ...d, anchor } : d)); },
    clearDraft: () => { setDraft(null); setPopover((p) => (p && p.threadId === null ? null : p)); },
    popover, openThread,
    closePopover: () => { setPopover(null); setDraft((d) => (d?.where === "chart" ? null : d)); },
    showOnCharts, setShowOnCharts,
    pickingFor: (blockId) => commentMode || Boolean(draft && draft.blockId === blockId && !draft.anchor && draft.where === "chart"),
    focusId, focusBlockId, focus,
    showBlock: (blockId) => reveal(blockId),
    pinsFor, countFor, onChartChanged,
  }), [api, blockMap, activePageId, panelOpen, tab, commentMode, setCommentMode, draft, startDraft, popover, openThread, showOnCharts, setShowOnCharts, focusId, focusBlockId, focus, reveal, pinsFor, countFor, onChartChanged]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// What a card does with a click on one of its marks while a comment is
// being placed: the draft lands on that point (and its popover with it).
let anchoredAt = 0;
export function anchorHandler(ui: CommentsUi | null, blockId: string): ((a: CommentAnchor) => void) | undefined {
  if (!ui || !ui.api.enabled || !ui.pickingFor(blockId)) return undefined;
  return (a) => {
    anchoredAt = Date.now();
    if (ui.draft && ui.draft.blockId === blockId && ui.draft.where === "chart") ui.setDraftAnchor(a);
    else ui.startDraft(blockId, a, "chart");
  };
}

// A click anywhere else on a card in comment mode: a comment on the whole
// chart - unless that same click already landed on a mark (the mark's
// handler runs first; React state has not caught up yet, hence the stamp).
export function cardClickHandler(ui: CommentsUi | null, blockId: string): ((e: { target: EventTarget | null }) => void) | undefined {
  if (!ui || !ui.api.enabled || !ui.commentMode) return undefined;
  return (e) => {
    if (Date.now() - anchoredAt < 120) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest?.("[data-comment-pin], button, a, input, select, textarea, [role='menu']")) return;
    ui.startDraft(blockId, null, "chart");
  };
}
