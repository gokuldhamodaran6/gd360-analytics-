// 2026-10-10 (Clarity Blueprint, Option 1 - one kind of dashboard): every
// dashboard in GD360 is the same full kind - live filters, cross-filter,
// canvas, publish - whatever it was made from. This page says so, offers
// the four ways to start one (describe it, from an answer, from an
// analysis, a blank canvas) and shows on every card where it was made from.
// Older "chart boards" (layout 1) and classic answer dashboards (layout 3)
// still open, carry a "Classic" tag, and upgrade to the full kind in one
// click - same link, name and sharing (POST /dashboards/{id}/upgrade, and
// the answer's Create-dashboard sheet with replace_dashboard_id).
//
// ?start=1 highlights the "Start a dashboard" row (Home's "Or start from an
// answer or analysis", the command palette's "New dashboard").
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  conversationApi, ConversationSummary, dashboardApi, dashboardBuilderApi, DashboardSummary, datasourceApi, DataSourceSummary,
} from "../api/client";
import { relativeTime } from "../dashboard/runState";
import { ArrowRightIcon, ConfirmDialog, CopyIcon, EditIcon, ExternalIcon, MergeIcon, MoreIcon, Popover, ProviderBadge, SearchIcon, ShareIcon, TrashIcon } from "../ui";
import { MenuRow } from "../dashboard/menu";
import { NewDashboardSheet } from "../dashboard/NewDashboardSheet";
import TopNav from "../components/TopNav";
import { ListPage, PageHead } from "../studio/Page";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import ViewToggle, { useViewMode } from "../components/ViewToggle";
import { dashboardHref, Kind, KindIcon, KindPill, KindTile, MadeFromLink, sourceHref } from "../lib/kinds";

type Filter = "all" | "mine" | "shared";
type StartKind = "answer" | "analysis" | "blank";

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

// 2026-10-12 (round 35): everything a card shows comes in the one list call (GET /dashboards):
// its sources and whether they are live, Published, when its numbers were last computed, and its
// first page's tiles for a to-scale thumbnail. Before, the page loaded every dashboard in full, one
// request per card (and stopped at 40), only to draw a badge.

type PreviewTile = { t: string; x: number; y: number; w: number; h: number; c?: string | null };

const LINE_KINDS = new Set(["line", "area", "stacked_area", "stacked_area_100", "forecast", "sparkline"]);

function MiniTile({ tile }: { tile: PreviewTile }) {
  const kind = tile.t === "chart" ? (tile.c || "bar") : tile.t;
  const body = (() => {
    if (kind === "kpi" || kind === "gauge") {
      return (
        <span className="absolute inset-[18%_14%] flex flex-col justify-center gap-[3px]">
          <span className="block h-[3px] w-[45%] rounded-full bg-muted/40" />
          <span className="block h-[6px] w-[70%] rounded-full bg-text/70" />
        </span>
      );
    }
    if (LINE_KINDS.has(kind)) {
      return (
        <svg className="absolute inset-[22%_8%_14%] h-[64%] w-[84%]" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
          <polyline points="0,30 18,24 36,27 54,14 72,18 100,6" fill="none" stroke="rgb(var(--color-series-1))" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        </svg>
      );
    }
    if (kind === "pie" || kind === "donut") {
      return <span className="absolute left-1/2 top-1/2 h-[46%] aspect-square -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-series-1/70 border-r-series-2/70" />;
    }
    if (kind === "table" || kind === "pivot" || kind === "avatar_list" || kind === "sql") {
      return (
        <span className="absolute inset-[20%_10%] flex flex-col justify-between">
          {[0, 1, 2, 3].map((i) => <span key={i} className="block h-[2px] rounded-full bg-muted/35" style={{ width: `${90 - i * 12}%` }} />)}
        </span>
      );
    }
    if (kind === "text" || kind === "heading" || kind === "divider" || kind === "filter" || kind === "input") {
      return <span className="absolute inset-[40%_12%] block h-[3px] rounded-full bg-muted/35" />;
    }
    const horiz = kind === "horizontal_bar" || kind === "funnel";
    return (
      <span className={`absolute inset-[22%_10%_12%] flex ${horiz ? "flex-col justify-between" : "items-end gap-[8%]"}`}>
        {[55, 85, 40, 70].map((v, i) => (
          <span key={i} className="block rounded-[1.5px] bg-series-1/70" style={horiz ? { height: "16%", width: `${v}%` } : { width: "100%", height: `${v}%` }} />
        ))}
      </span>
    );
  })();
  return (
    <i className="relative block overflow-hidden rounded-[4px] bg-subtle" style={{ gridColumn: `${tile.x + 1} / span ${Math.max(1, tile.w)}`, gridRow: `${tile.y + 1} / span ${Math.max(1, tile.h)}` }}>
      {body}
    </i>
  );
}

// 2026-10-15 (R50): a designed board is drawn in its own theme - a hero tile, KPI tiles and a chart row.
function BoardThumb({ board, compact = false }: { board: NonNullable<DashboardSummary["board"]>; compact?: boolean }) {
  const p = board.palette;
  return (
    <div aria-hidden="true" data-thumb="board" className={`${compact ? "h-full" : "h-[118px] border-b border-border"} p-2.5 grid gap-[4px]`}
      style={{ background: p.bg, gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gridTemplateRows: "1fr 1fr 1.2fr" }}>
      <span style={{ background: p.card, gridColumn: "1 / 3", gridRow: "1 / 3", borderRadius: 5, position: "relative", overflow: "hidden" }}>
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" style={{ position: "absolute", left: "8%", right: "8%", bottom: "12%", width: "84%", height: "45%" }}>
          <polyline points="0,32 20,26 40,28 60,16 80,19 100,6" fill="none" stroke={p.accent} strokeWidth="3" vectorEffect="non-scaling-stroke" />
        </svg>
        <span style={{ position: "absolute", left: "10%", top: "16%", width: "38%", height: 5, borderRadius: 3, background: p.ink, opacity: 0.75 }} />
      </span>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} style={{ background: p.card, borderRadius: 5, position: "relative" }}>
          <span style={{ position: "absolute", left: "14%", top: "40%", width: `${50 + i * 8}%`, height: 4, borderRadius: 3, background: p.ink, opacity: 0.55 }} />
        </span>
      ))}
      <span style={{ background: p.card, gridColumn: "1 / 5", borderRadius: 5, display: "flex", alignItems: "flex-end", gap: 4, padding: "6px 10px" }}>
        {[70, 45, 85, 30, 55, 40, 65].map((h, i) => <span key={i} style={{ flex: 1, height: `${h}%`, borderRadius: 2, background: i === 2 ? p.warn : p.accent, opacity: i === 2 ? 1 : 0.8 }} />)}
      </span>
    </div>
  );
}

// The dashboard's own first page, drawn to scale from its tile layout (the top of it).
function Thumb({ preview, classic, compact = false, board }: { preview?: PreviewTile[]; classic: boolean; compact?: boolean; board?: DashboardSummary["board"] }) {
  if (board) return <BoardThumb board={board} compact={compact} />;
  const ROWS = compact ? 12 : 14;
  const tiles = (preview || []).filter((t) => t.y < ROWS).map((t) => ({ ...t, h: Math.min(t.h, ROWS - t.y), w: Math.min(t.w, 12 - t.x) }));
  return (
    <div
      aria-hidden="true"
      data-thumb={tiles.length ? "layout" : "empty"}
      className={`${compact ? "h-full" : "h-[118px] border-b border-border"} bg-base p-2.5 grid gap-[3px]`}
      style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gridTemplateRows: `repeat(${ROWS}, minmax(0, 1fr))` }}
    >
      {tiles.length ? tiles.map((t, i) => <MiniTile key={i} tile={t} />) : (
        <span className="col-span-12 row-span-full grid place-items-center text-caption text-faint">{classic ? "Pinned charts" : "Empty"}</span>
      )}
    </div>
  );
}

const MODE_TEXT: Record<string, string> = { live: "Live", file: "Uploaded file", mixed: "Live + file" };
const AUTO_BADGE: Record<string, string> = { realtime: "Real-time", "5m": "Auto · 5 min", "15m": "Auto · 15 min", "30m": "Auto · 30 min", "1h": "Auto · hourly", "6h": "Auto · 6 h", daily: "Auto · daily" };

function FreshDot({ mode }: { mode?: string | null }) {
  if (!mode) return null;
  return (
    <span className="inline-flex items-center gap-1.5" data-card-mode={mode} title={mode === "file" ? "Reads an uploaded file - a fixed copy" : mode === "mixed" ? "Part live, part an uploaded file" : "Reads a live source"}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${mode === "file" ? "bg-muted" : "bg-good"}`} />
      {MODE_TEXT[mode]}
    </span>
  );
}

function DashboardCard({
  d, view, onDeleted, onUpgrade, upgrading, onRenamed, onDuplicated, names, onMerge,
}: {
  d: DashboardSummary;
  view: "grid" | "list";
  onDeleted: (id: string) => void;
  onUpgrade: (d: DashboardSummary) => void;
  upgrading: boolean;
  onRenamed: (id: string, name: string) => void;
  onDuplicated: (copy: DashboardSummary) => void;
  names: Set<string>;
  onMerge?: () => void;
}) {
  const navigate = useNavigate();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(d.name);
  const [note, setNote] = useState("");
  const classic = d.layout_version !== 2 && d.layout_version !== 4;
  const href = dashboardHref(d);
  const madeKind = d.source_kind === "answer" || d.source_kind === "analysis" ? d.source_kind : null;
  const madeHref = madeKind ? sourceHref(madeKind, d.source_id, d.source_datasource_id) : null;
  const sources = d.sources || [];
  const primary = sources[0];
  const when = d.data_at ? relativeTime(d.data_at) : null;
  const flash = (t: string) => { setNote(t); window.setTimeout(() => setNote(""), 2600); };

  const doDelete = async () => {
    setBusy(true);
    try {
      await dashboardApi.remove(d.id);
      onDeleted(d.id);
    } catch {
      setBusy(false);
      setConfirmingDelete(false);
      flash("Couldn't delete it - try again.");
    }
  };
  const commitRename = async () => {
    const name = draft.trim();
    setRenaming(false);
    if (!name || name === d.name) return;
    if (names.has(name.toLowerCase()) && name.toLowerCase() !== d.name.trim().toLowerCase()) {
      flash(`You already have a dashboard called “${name}”.`);
      setDraft(d.name);
      return;
    }
    try {
      const out = await dashboardApi.rename(d.id, name);
      onRenamed(d.id, out.name);
    } catch {
      setDraft(d.name);
      flash("Couldn't rename it - try again.");
    }
  };
  const duplicate = async () => {
    try {
      onDuplicated(await dashboardApi.duplicate(d.id));
      flash("Duplicated - the copy is first in the list.");
    } catch (e: any) {
      flash(errorText(e, "Couldn't duplicate it."));
    }
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${href}`);
      flash("Link copied.");
    } catch {
      flash("Couldn't copy the link.");
    }
  };

  const menu = (
    <Popover
      align="end"
      width={210}
      haspopup="menu"
      role="menu"
      ariaLabel={`Actions for ${d.name}`}
      trigger={(api) => (
        <button type="button" {...api.props} data-card-menu="" aria-label={`Actions for ${d.name}`} className="ui-focus -mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-muted hover:bg-subtle hover:text-text">
          <MoreIcon size={15} />
        </button>
      )}
    >
      {({ close }) => (
        <div className="py-1">
          <MenuRow icon={<ArrowRightIcon size={14} />} onClick={() => { close(); navigate(href); }}>Open</MenuRow>
          <MenuRow icon={<ExternalIcon size={14} />} onClick={() => { close(); window.open(href, "_blank", "noopener"); }}>Open in new tab</MenuRow>
          {d.can_edit && <MenuRow icon={<EditIcon size={14} />} onClick={() => { close(); setDraft(d.name); setRenaming(true); }}>Rename</MenuRow>}
          {!classic && <MenuRow icon={<CopyIcon size={14} />} onClick={() => { close(); duplicate(); }}>Duplicate</MenuRow>}
          {!classic && onMerge && <MenuRow icon={<MergeIcon size={14} />} onClick={() => { close(); onMerge(); }}>Merge with others…</MenuRow>}
          <MenuRow icon={<ShareIcon size={14} />} onClick={() => { close(); copyLink(); }}>Copy link</MenuRow>
          {d.can_delete && (
            <>
              <div className="my-1 border-t border-border" />
              <MenuRow danger icon={<TrashIcon size={14} />} onClick={() => { close(); setConfirmingDelete(true); }}>Delete…</MenuRow>
            </>
          )}
        </div>
      )}
    </Popover>
  );

  const body = (
    <div className="p-4 flex flex-col gap-2.5 min-w-0 flex-1">
      <div className="flex items-start gap-2 min-w-0">
        {renaming ? (
          <input
            autoFocus
            value={draft}
            maxLength={120}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { setRenaming(false); setDraft(d.name); } }}
            className="ui-focus h-8 min-w-0 flex-1 rounded-ctl border border-border-strong bg-base px-2 text-body font-semibold text-text"
            aria-label="Dashboard name"
            data-card-rename=""
          />
        ) : (
          <Link to={href} title={d.name} className="ui-focus min-w-0 flex-1 text-body font-semibold text-text hover:text-brand-ink truncate" data-dashboard-card-link="">
            {d.name}
          </Link>
        )}
        {menu}
      </div>
      {madeKind && d.source_title && madeHref ? (
        <MadeFromLink kind={madeKind} title={d.source_title} href={madeHref} />
      ) : primary ? (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-caption text-secondary" title={sources.map((s) => s.name).join(", ")}>
          <ProviderBadge provider={primary.kind} />
          <span className="truncate">{primary.name}{sources.length > 1 ? ` + ${sources.length - 1} more` : ""}</span>
        </span>
      ) : (
        <span className="text-caption text-muted">{classic ? "Pinned charts" : "No data source yet"}</span>
      )}
      {/* round 35: one quiet line - what it reads and who sees it on the left, when on the right */}
      <div className="flex items-center gap-2 text-caption text-muted min-w-0" data-card-meta="">
        {classic ? (
          <span className="inline-flex shrink-0 items-center h-5 px-1.5 rounded border border-border text-[10.5px] font-semibold uppercase tracking-caps text-muted">Classic</span>
        ) : (
          <span className="shrink-0"><FreshDot mode={d.data_mode} /></span>
        )}
        {!classic && d.data_mode !== "file" && d.refresh_interval && d.refresh_interval !== "off" && (
          <span className="inline-flex shrink-0 items-center h-5 px-1.5 rounded border border-tint-border text-brand-ink text-[10.5px] font-semibold" data-card-auto={d.refresh_interval}>
            {AUTO_BADGE[d.refresh_interval] || "Auto"}
          </span>
        )}
        {d.published && <span className="inline-flex shrink-0 items-center h-5 px-1.5 rounded bg-good-fill text-good text-[10.5px] font-semibold">Published</span>}
        <span className="min-w-0 flex-1 truncate" title={[madeKind && primary ? primary.name : null, d.workspace_id ? `Shared with ${d.workspace_name || "a team"}` : "Only you", !d.is_own ? `by ${d.created_by_name || d.created_by_email}` : null].filter(Boolean).join(" · ")}>
          {[madeKind && primary ? primary.name : null, d.workspace_id ? (d.workspace_name || "Team") : "Only you", !d.is_own ? `by ${d.created_by_name || d.created_by_email}` : null].filter(Boolean).join(" · ")}
        </span>
        {when && <span className="shrink-0 tabular-nums" title={d.data_at ? `Numbers computed ${new Date(d.data_at).toLocaleString()}` : undefined}>{when}</span>}
      </div>
      {note && <span role="status" className="text-caption text-brand-ink">{note}</span>}
      {classic && d.can_edit && (
        <button
          type="button"
          onClick={() => onUpgrade(d)}
          disabled={upgrading}
          data-upgrade-dashboard=""
          className="ui-focus self-start inline-flex items-center gap-1 text-caption font-semibold text-kind-dashboard hover:underline underline-offset-2 disabled:opacity-50"
        >
          {upgrading ? "Upgrading…" : "Upgrade to a live dashboard →"}
        </button>
      )}
      <ConfirmDialog
        open={confirmingDelete}
        title={`Delete “${d.name}”?`}
        confirmLabel="Delete dashboard"
        busy={busy}
        onConfirm={doDelete}
        onCancel={() => setConfirmingDelete(false)}
      >
        It's removed for everyone it's shared with{d.published ? ", and its published link stops working" : ""}. This can't be undone.
      </ConfirmDialog>
    </div>
  );

  if (view === "list") {
    return (
      <div className="dash-card flex items-stretch overflow-hidden" data-dashboard-card="">
        <Link to={href} tabIndex={-1} aria-hidden="true" className="hidden sm:block w-[132px] shrink-0 border-r border-border">
          <Thumb preview={d.preview} classic={classic} compact board={d.board} />
        </Link>
        {body}
      </div>
    );
  }
  return (
    <div className="dash-card overflow-hidden flex flex-col" data-dashboard-card="">
      <Link to={href} tabIndex={-1} aria-hidden="true">
        <Thumb preview={d.preview} classic={classic} board={d.board} />
      </Link>
      {body}
    </div>
  );
}

export default function Dashboards() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useViewMode("gd360_view_dashboards");
  const [filter, setFilter] = useState<Filter>("all");
  // round 35: find one among many - search and sort
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"updated" | "name" | "oldest">("updated");
  // round 35b: one way to start - the New dashboard sheet (?new=1, and the older ?start=1, open it)
  const [newOpen, setNewOpen] = useState(params.get("new") === "1" || params.get("start") === "1");
  const [newStart, setNewStart] = useState<"data" | "merge">(params.get("merge") === "1" ? "merge" : "data");
  const [newPicked, setNewPicked] = useState<string[]>([]);
  const [upgradingId, setUpgradingId] = useState<string | null>(null);
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();

  useEffect(() => {
    dashboardApi
      .list()
      .then(setDashboards)
      .catch(() => setError("Couldn't load your dashboards. Please try refreshing."));
  }, []);

  useEffect(() => {
    if (!params.get("new") && !params.get("start") && !params.get("merge")) return;
    const next = new URLSearchParams(params);
    next.delete("new");
    next.delete("start");
    next.delete("merge");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeById = (id: string) => setDashboards((ds) => (ds || []).filter((x) => x.id !== id));
  const renameById = (id: string, name: string) => setDashboards((ds) => (ds || []).map((x) => (x.id === id ? { ...x, name } : x)));
  const addCopy = (copy: DashboardSummary) => setDashboards((ds) => [copy, ...(ds || [])]);

  const upgrade = async (d: DashboardSummary) => {
    if (d.layout_version === 3) {
      // A classic answer dashboard is rebuilt from its answer: the sheet there.
      navigate(`/project-dashboards/${d.id}?upgrade=1`);
      return;
    }
    setUpgradingId(d.id);
    setError("");
    try {
      await dashboardApi.upgrade(d.id);
      navigate(`/dashboard-builder/${d.id}`);
    } catch (e: any) {
      setError(errorText(e, "Couldn't upgrade that dashboard. Please try again."));
      setUpgradingId(null);
    }
  };

  const all = dashboards || [];
  const mine = all.filter((d) => d.is_own);
  const shared = all.filter((d) => !d.is_own);
  const names = useMemo(() => new Set(mine.map((d) => d.name.trim().toLowerCase())), [mine]);
  const scoped = filter === "mine" ? mine : filter === "shared" ? shared : all;
  const q = query.trim().toLowerCase();
  const shown = q
    ? scoped.filter((d) => d.name.toLowerCase().includes(q) || (d.sources || []).some((s) => s.name.toLowerCase().includes(q)) || (d.source_title || "").toLowerCase().includes(q))
    : scoped;
  const stamp = (d: DashboardSummary) => new Date(d.updated_at || d.created_at).getTime();
  // Full dashboards first, then classic ones; within each, the chosen order.
  const ordered = [...shown].sort((a, b) => {
    const ca = a.layout_version === 2 || a.layout_version === 4 ? 0 : 1;
    const cb = b.layout_version === 2 || b.layout_version === 4 ? 0 : 1;
    if (ca !== cb) return ca - cb;
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "oldest") return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    return stamp(b) - stamp(a);
  });

  void AppSidebar; void TopNav; void switchWorkspace; void handleWorkspaceCreated; void workspaces;
  return (
    <>
      <ListPage data="dashboards" crumbs={[{ label: "Dashboards" }]}>
          <PageHead title="Dashboards" sub={`Live, filterable pages to monitor and share${dashboards ? ` · ${all.length} in this workspace` : ""}.`}
            actions={<button type="button" onClick={() => { setNewStart("data"); setNewPicked([]); setNewOpen(true); }} className="sd-btnp" data-new-dashboard="">New dashboard</button>} />

          {error && <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2.5 text-ui text-text">{error}</div>}

          <section aria-label="Your dashboards" className="flex flex-col gap-3.5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div role="tablist" aria-label="Show" className="flex gap-0.5 rounded-ctl border border-border bg-surface p-[3px]">
                {([
                  ["all", "All", all.length],
                  ["mine", "Mine", mine.length],
                  ["shared", "Shared with me", shared.length],
                ] as [Filter, string, number][]).map(([f, label, n]) => (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={filter === f}
                    onClick={() => setFilter(f)}
                    className={`h-8 px-3 rounded-[7px] text-ui inline-flex items-center gap-1.5 ${filter === f ? "bg-subtle text-text" : "text-muted hover:text-text"}`}
                  >
                    {label} <span className="font-mono text-[11px] text-muted">{n}</span>
                  </button>
                ))}
              </div>
              {all.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="relative">
                    <span className="sr-only">Search dashboards</span>
                    <SearchIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search dashboards"
                      className="ui-focus h-8 w-[200px] max-w-full rounded-ctl border border-border bg-surface pl-8 pr-2.5 text-ui text-text placeholder:text-faint"
                      data-dashboard-search=""
                    />
                  </label>
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as typeof sort)}
                    aria-label="Sort dashboards"
                    className="ui-focus h-8 rounded-ctl border border-border bg-surface px-2 text-ui text-text"
                    data-dashboard-sort=""
                  >
                    <option value="updated">Recently updated</option>
                    <option value="name">Name A–Z</option>
                    <option value="oldest">Oldest first</option>
                  </select>
                  <ViewToggle mode={viewMode} onChange={setViewMode} />
                </div>
              )}
            </div>

            {dashboards === null && !error && <div className="text-ui text-muted">Loading…</div>}

            {dashboards !== null && all.length === 0 && (
              <div className="dash-card p-8 flex flex-col items-center gap-3 text-center">
                <KindTile kind="dashboard" size={44} />
                <div className="text-section font-semibold text-text">No dashboards yet</div>
                <p className="m-0 text-ui text-muted max-w-[52ch]">
                  Describe one above, or make one from something you've already asked or analyzed. Every dashboard gets live filters, cross-filter and publishing.
                </p>
              </div>
            )}

            {dashboards !== null && all.length > 0 && ordered.length === 0 && (
              <div className="dash-card p-6 text-ui text-muted text-center">
                {q ? <>No dashboard matches “{query.trim()}”. <button type="button" className="text-brand-ink hover:underline" onClick={() => setQuery("")}>Clear search</button></> : filter === "shared" ? "Nothing shared with you yet." : "Nothing here yet."}
              </div>
            )}

            {ordered.length > 0 && (
              <div className={viewMode === "grid" ? "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3.5" : "grid grid-cols-1 gap-2.5"}>
                {ordered.map((d) => (
                  <DashboardCard key={d.id} d={d} view={viewMode} onDeleted={removeById} onUpgrade={upgrade} upgrading={upgradingId === d.id} onRenamed={renameById} onDuplicated={addCopy} names={names} onMerge={() => { setNewStart("merge"); setNewPicked([d.id]); setNewOpen(true); }} />
                ))}
              </div>
            )}
            {ordered.some((d) => d.layout_version !== 2 && d.layout_version !== 4) && (
              <p className="m-0 text-caption text-muted">
                <KindPill kind="dashboard" className="h-[18px] px-1.5 text-[10.5px] mr-1.5 align-[1px]">Classic</KindPill>
                dashboards are from before every dashboard became the full kind. Upgrade keeps the same link, name and sharing.
              </p>
            )}
          </section>
      </ListPage>

      <NewDashboardSheet open={newOpen} onClose={() => setNewOpen(false)} workspaceId={activeWorkspaceId} initialStart={newStart} initialPicked={newPicked} />
    </>
  );
}
