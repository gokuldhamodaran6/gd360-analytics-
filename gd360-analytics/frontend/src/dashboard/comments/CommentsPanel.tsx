import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CommentThread } from "../../api/client";
import { useIsNarrow } from "../../components/DashboardBlocks";
import { Button, CloseIcon, CommentIcon, EyeIcon, EyeOffIcon, IconButton, cn } from "../../ui";
import { CommentThreadCard } from "./CommentThread";
import { useCommentsUi, type CommentsUi, type PanelTab } from "./CommentsUi";
import { MentionComposer } from "./MentionComposer";
import { CommentPopover } from "./CommentPopover";
import { PersonAvatar } from "./people";

// 2026-10-12 (round 38, team comments): the Comments panel - one place for
// every conversation on the dashboard. Docked beside the charts on a wide
// screen (so the chart being talked about stays in view), a sheet on a
// phone. Open / For you / Resolved; threads grouped by chart, in the
// dashboard's order, each with "Show on chart". "Comment on a chart" turns
// the next click on any chart, bar, day, slice, row or KPI into a pinned
// comment; the composer says where it is pinned and lets the writer @ a
// teammate. The footer says who can read it.

const TABS: { value: PanelTab; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "mine", label: "For you" },
  { value: "resolved", label: "Resolved" },
];

function inTab(t: CommentThread, tab: PanelTab): boolean {
  if (tab === "resolved") return t.resolved;
  if (tab === "mine") return !t.resolved && Boolean(t.involves_me || t.mentions_me);
  return !t.resolved;
}

function latest(t: CommentThread): number {
  const last = t.replies.length ? t.replies[t.replies.length - 1].created_at : t.created_at;
  return new Date(last).getTime() || 0;
}

function Draft({ ui }: { ui: CommentsUi }) {
  const draft = ui.draft!;
  const info = ui.blocks.get(draft.blockId);
  const title = info?.title || "This chart";
  const label = draft.anchor ? String(draft.anchor.label ?? draft.anchor.key ?? "") : null;
  const pickable = info ? !["kpi", "text", "heading"].includes(info.type) : true;
  return (
    <div className="rounded-card border border-primary/50 bg-tint/40 p-3 shadow-card" data-comment-draft={draft.blockId}>
      <div className="mb-2 flex min-w-0 items-start gap-2 text-caption">
        <CommentIcon size={13} className="mt-0.5 shrink-0 text-brand-ink" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-text" title={title}>{title}</div>
          {label ? (
            <div className="text-secondary" data-draft-anchor="">
              Pinned to <span className="font-medium text-brand-ink">{label}</span>
              <span aria-hidden="true"> · </span>
              <button type="button" className="ui-focus rounded px-0.5 text-muted hover:text-text hover:underline" onClick={() => ui.setDraftAnchor(null)}>comment on the whole chart</button>
            </div>
          ) : (
            <div className="text-muted" data-draft-anchor="">
              On the whole chart{pickable ? <> · <span className="text-secondary">or click a point on it to pin this there</span></> : null}
            </div>
          )}
        </div>
        <button type="button" aria-label="Show this chart" className="ui-focus shrink-0 rounded px-0.5 text-muted hover:text-text hover:underline" onClick={() => ui.showBlock(draft.blockId)}>Show</button>
      </div>
      <MentionComposer
        key={`${draft.blockId}:${label ?? ""}`}
        loadPeople={ui.api.loadPeople}
        placeholder="Write a comment… @ to mention"
        submitLabel="Comment"
        autoFocus
        onCancel={ui.clearDraft}
        onSubmit={async (body, ids) => {
          const t = await ui.api.addThread(draft.blockId, body, draft.anchor, ids);
          if (t) window.setTimeout(() => ui.focus(t.id, { scroll: false }), 50);
        }}
      />
    </div>
  );
}

function Audience({ ui }: { ui: CommentsUi }) {
  const p = ui.api.people;
  useEffect(() => { ui.api.loadPeople(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  if (!p) return null;
  const n = p.people.length;
  const who = p.workspace_name ? `${p.workspace_name} · ${n} ${n === 1 ? "person" : "people"}` : n <= 1 ? "Only you" : `${n} people`;
  return (
    <div className="flex items-center gap-2 border-t border-subtle px-4 py-2.5 text-[11.5px] text-muted" data-comments-audience="">
      <span className="flex shrink-0 -space-x-1" aria-hidden="true">
        {p.people.slice(0, 4).map((x) => (
          <PersonAvatar key={x.id} name={x.name} initials={x.initials} size="sm" ring />
        ))}
      </span>
      <span className="min-w-0 truncate">Visible to everyone who can open this dashboard: {who}</span>
    </div>
  );
}

function PanelBody({ ui, onClose }: { ui: CommentsUi; onClose: () => void }) {
  const { api, tab } = ui;
  const [scopeBlock, setScopeBlock] = useState<string | null>(null);
  // Opened from one chart's comment chip: show that chart's threads first.
  useEffect(() => { setScopeBlock(ui.focusId ? null : ui.focusBlockId); }, [ui.focusBlockId, ui.focusId]);
  const counts = useMemo(() => ({
    open: api.threads.filter((t) => inTab(t, "open")).length,
    mine: api.threads.filter((t) => inTab(t, "mine")).length,
    resolved: api.threads.filter((t) => inTab(t, "resolved")).length,
  }), [api.threads]);
  const order = useMemo(() => Array.from(ui.blocks.keys()), [ui.blocks]);
  const groups = useMemo(() => {
    const list = api.threads.filter((t) => inTab(t, tab) && (!scopeBlock || t.block_id === scopeBlock));
    const by = new Map<string, CommentThread[]>();
    for (const t of list) {
      const k = t.block_id || "";
      by.set(k, [...(by.get(k) || []), t]);
    }
    const keys = Array.from(by.keys()).sort((a, b) => {
      // the active page's charts first, then the dashboard's order
      const ia = order.indexOf(a), ib = order.indexOf(b);
      const pa = ui.blocks.get(a)?.pageId === ui.activePageId ? 0 : 1, pb = ui.blocks.get(b)?.pageId === ui.activePageId ? 0 : 1;
      return pa - pb || (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
    });
    return keys.map((k) => ({
      blockId: k || null,
      threads: by.get(k)!.sort((a, b) => (tab === "resolved" ? latest(b) - latest(a) : (Number(b.mentions_me) - Number(a.mentions_me)) || latest(b) - latest(a))),
    }));
  }, [api.threads, tab, scopeBlock, order, ui.blocks, ui.activePageId]);
  const scopeTitle = scopeBlock ? ui.blocks.get(scopeBlock)?.title || "this chart" : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-comments-panel-body="">
      <div className="flex flex-col gap-3 border-b border-subtle px-4 pb-3 pt-4">
        <div className="flex items-center gap-2">
          <CommentIcon size={16} className="text-brand-ink" />
          <h2 className="text-ui font-semibold text-text">Comments</h2>
          <span className="text-caption text-muted tabular-nums">{counts.open} open</span>
          <ShowOnChartsToggle ui={ui} className="ml-auto" />
          <IconButton size="sm" aria-label="Close comments" title="Close" icon={<CloseIcon size={15} />} onClick={onClose} />
        </div>
        <div role="tablist" aria-label="Which comments" className="flex rounded-ctl bg-subtle p-0.5">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={tab === t.value}
              data-comments-tab={t.value}
              onClick={() => ui.setTab(t.value)}
              className={cn("ui-focus flex-1 rounded-[7px] px-2 py-1 text-caption font-medium transition-colors", tab === t.value ? "bg-surface text-text shadow-card" : "text-muted hover:text-text")}
            >
              {t.label}
              {counts[t.value] > 0 && <span className={cn("ml-1 tabular-nums", tab === t.value ? "text-brand-ink" : "text-faint")}>{counts[t.value]}</span>}
            </button>
          ))}
        </div>
        {!(ui.draft?.where === "panel") && (
          <Button
            variant={ui.commentMode ? "primary" : "secondary"}
            size="sm"
            icon={<CommentIcon size={14} />}
            onClick={() => ui.setCommentMode(!ui.commentMode)}
            aria-pressed={ui.commentMode}
            data-comment-mode-toggle=""
          >
            {ui.commentMode ? "Click a chart… (Esc to stop)" : "Comment on a chart"}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-comments-scroll="">
        <div className="flex flex-col gap-3">
          {ui.draft?.where === "panel" && <Draft ui={ui} />}
          {api.error && <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-caption text-danger">{api.error}</div>}
          {scopeBlock && (
            <div className="flex items-center gap-2 text-caption text-muted" data-comments-scope="">
              <span className="min-w-0 truncate">Showing <span className="font-medium text-text">{scopeTitle}</span></span>
              {ui.draft?.where !== "panel" && <button type="button" className="ui-focus ml-auto shrink-0 rounded px-0.5 font-medium text-brand-ink hover:underline" onClick={() => ui.startDraft(scopeBlock, null, "panel")} data-comment-scope-new="">New comment</button>}
              <button type="button" className={cn("ui-focus shrink-0 rounded px-0.5 text-muted hover:text-text hover:underline", ui.draft?.where === "panel" && "ml-auto")} onClick={() => setScopeBlock(null)}>Show all</button>
            </div>
          )}
          {groups.map((g) => {
            const info = g.blockId ? ui.blocks.get(g.blockId) : null;
            const otherPage = info && ui.activePageId && info.pageId !== ui.activePageId;
            return (
              <section key={g.blockId || "dashboard"} className="flex flex-col gap-2" data-comments-group={g.blockId || "dashboard"}>
                <div className="flex min-w-0 items-baseline gap-1.5 pt-1 text-[11.5px] font-medium uppercase tracking-caps text-muted">
                  {g.blockId ? (
                    <button type="button" className="ui-focus min-w-0 truncate rounded text-left hover:text-text" onClick={() => ui.showBlock(g.blockId!)} title="Show this chart">
                      {info?.title || g.threads[0]?.block_title || "Chart"}
                    </button>
                  ) : <span>This dashboard</span>}
                  {otherPage && <span className="shrink-0 normal-case tracking-normal text-faint">· {info!.pageName}</span>}
                </div>
                {g.threads.map((t) => (
                  <CommentThreadCard
                    key={t.id}
                    thread={t}
                    comments={api}
                    focused={ui.focusId === t.id}
                    defaultOpen={ui.focusId === t.id}
                    onShowOnChart={t.block_id ? () => ui.focus(t.id, { popover: true }) : undefined}
                    onChartChanged={t.block_id && ui.onChartChanged ? () => ui.onChartChanged!(t.block_id!) : undefined}
                  />
                ))}
              </section>
            );
          })}
          {groups.length === 0 && ui.draft?.where !== "panel" && (
            <EmptyState tab={tab} loading={api.loading && api.threads.length === 0} scoped={Boolean(scopeBlock)} onStart={() => (scopeBlock ? ui.startDraft(scopeBlock, null, "panel") : ui.setCommentMode(true))} />
          )}
        </div>
      </div>
      <Audience ui={ui} />
    </div>
  );
}

function EmptyState({ tab, loading, scoped, onStart }: { tab: PanelTab; loading: boolean; scoped: boolean; onStart: () => void }) {
  if (loading) return <div className="flex flex-col gap-2" aria-busy="true">{[0, 1].map((i) => <div key={i} className="ui-shimmer h-20 !rounded-card" />)}</div>;
  const text: Record<PanelTab, ReactNode> = {
    open: scoped ? "No open comments on this chart." : "No open comments. Pin one to a chart - a day, a bar, a row - and @ the person who should look.",
    mine: "Nothing for you. Threads you start, reply to or are @mentioned in show here.",
    resolved: "Nothing resolved yet.",
  };
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center" data-comments-empty={tab}>
      <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-tint text-brand-ink"><CommentIcon size={18} /></span>
      <p className="max-w-[260px] text-caption text-muted">{text[tab]}</p>
      {tab === "open" && <Button size="sm" variant="secondary" onClick={onStart}>{scoped ? "Comment on this chart" : "Comment on a chart"}</Button>}
    </div>
  );
}

// The panel itself. Wide screens: docked beside the charts (render it in
// the shell's content row, after <main>) so the chart being discussed stays
// in view. Narrower: it floats over the right edge, and steps aside while
// "Comment on a chart" waits for a click.
const DOCK_MIN = 1180;

export function CommentsPanel() {
  const ui = useCommentsUi();
  const narrow = useIsNarrow(DOCK_MIN);
  if (!ui || !ui.api.enabled) return null;
  return (
    <>
      <CommentPopover />
      {ui.commentMode && <CommentModeBanner ui={ui} />}
      {ui.panelOpen && !(narrow && ui.commentMode) && (
        <aside
          aria-label="Comments"
          data-comments-panel={narrow ? "overlay" : "docked"}
          className={cn(
            "flex flex-col bg-surface print:hidden",
            narrow
              ? "fixed inset-y-0 right-0 z-[55] w-full max-w-[400px] border-l border-border shadow-pop"
              : "sticky top-0 h-screen w-[376px] shrink-0 self-start border-l border-border",
          )}
        >
          <PanelBody ui={ui} onClose={ui.closePanel} />
        </aside>
      )}
    </>
  );
}

function CommentModeBanner({ ui }: { ui: CommentsUi }) {
  return (
    <div role="status" data-comment-mode-banner="" className="fixed bottom-5 left-1/2 z-[56] inline-flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-2.5 rounded-full border border-primary/60 bg-surface py-2 pl-4 pr-2 text-ui text-text shadow-pop print:hidden">
      <CommentIcon size={14} className="shrink-0 text-brand-ink" />
      <span className="min-w-0 truncate">Click any chart, bar, day or row to pin a comment</span>
      <Button size="sm" variant="ghost" onClick={() => ui.setCommentMode(false)}>Stop · Esc</Button>
    </div>
  );
}

// Show / hide the team's comments on the charts (pins, chips, badges).
// Remembered in this browser; the Comments button keeps counting either way.
export function ShowOnChartsToggle({ ui, className }: { ui: CommentsUi; className?: string }) {
  const on = ui.showOnCharts;
  return (
    <IconButton
      size="sm"
      variant="ghost"
      className={className}
      aria-pressed={!on}
      aria-label={on ? "Hide comments on charts" : "Show comments on charts"}
      title={on ? "Hide comments on charts - clean charts, the comments stay here" : "Show comments on charts"}
      icon={on ? <EyeIcon size={15} /> : <EyeOffIcon size={15} />}
      onClick={() => ui.setShowOnCharts(!on)}
      data-comments-visibility={on ? "shown" : "hidden"}
    />
  );
}

// The header's "Comments" button - the open count, a dot when someone
// @mentioned you - and, beside it, the switch that clears the charts.
export function CommentsButton() {
  const ui = useCommentsUi();
  if (!ui || !ui.api.enabled) return null;
  const open = ui.api.threads.filter((t) => !t.resolved);
  const forMe = open.filter((t) => t.mentions_me).length;
  return (
    <span className="inline-flex items-center rounded-ctl border border-border bg-surface" data-comments-controls="">
      <span className="relative inline-flex">
        <button
          type="button"
          className={cn("ui-focus inline-flex h-9 items-center gap-2 rounded-l-ctl px-3 text-ui font-medium transition-colors", ui.panelOpen ? "bg-tint text-brand-ink" : "text-text hover:bg-subtle")}
          onClick={() => (ui.panelOpen ? ui.closePanel() : ui.openPanel())}
          aria-expanded={ui.panelOpen}
          data-comments-button=""
          title={forMe ? `${forMe} ${forMe === 1 ? "thread mentions" : "threads mention"} you` : undefined}
        >
          <CommentIcon size={15} />
          Comments
          {open.length > 0 && <span className="tabular-nums text-muted">{open.length}</span>}
        </button>
        {forMe > 0 && !ui.panelOpen && <span aria-hidden="true" className="pointer-events-none absolute right-1 top-1 h-2 w-2 rounded-full bg-primary" data-comments-for-me="" />}
      </span>
      <span aria-hidden="true" className="h-5 w-px bg-border" />
      <span className="px-0.5"><ShowOnChartsToggle ui={ui} /></span>
    </span>
  );
}

// A chart card's chip: whose comments are on it (their colours), how many
// are open. Opens that chart's threads. Gone when comments are hidden on
// charts - the card keeps a quiet "Comment" button instead.
export function BlockCommentChip({ blockId }: { blockId: string }) {
  const ui = useCommentsUi();
  if (!ui || !ui.api.enabled || !ui.showOnCharts) return null;
  const c = ui.countFor(blockId);
  if (!c.total) return null;
  return (
    <button
      type="button"
      className={cn("ui-focus inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-1 pr-2 text-caption hover:border-border-strong hover:bg-subtle", c.open ? "text-text" : "text-muted")}
      onClick={() => ui.openPanel({ blockId })}
      aria-label={`${c.open} open comment${c.open === 1 ? "" : "s"} on this chart`}
      title={c.open ? `${c.people.map((p) => p.name).join(", ")} · ${c.open} open` : `${c.total} resolved`}
      data-block-comment-chip={blockId}
      data-comment-control=""
    >
      {c.open > 0 ? (
        <span className="flex -space-x-1.5" aria-hidden="true">
          {c.people.slice(0, 3).map((p) => <PersonAvatar key={p.initials} name={p.name} initials={p.initials} size="xs" ring />)}
        </span>
      ) : <CommentIcon size={14} />}
      <span className="font-medium tabular-nums">{c.open || c.total}</span>
    </button>
  );
}
