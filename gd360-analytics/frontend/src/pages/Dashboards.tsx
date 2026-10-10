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
import { ProviderBadge } from "../ui";
import TopNav from "../components/TopNav";
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

// What a full dashboard's card shows beyond the list endpoint's own fields -
// the provider it computes in and when a block last ran (read from each
// dashboard's own GET /dashboard-builder/{id}, bounded, after the list renders).
type DashboardMeta = { datasource_kind: string | null; warehouse_native: boolean; last_refreshed: string | null; published: boolean };

function metaOf(detail: Awaited<ReturnType<typeof dashboardBuilderApi.get>>): DashboardMeta {
  let latest = 0;
  for (const page of detail.pages) {
    for (const b of page.blocks) {
      for (const iso of [b.last_run?.ran_at, b.data_updated_at]) {
        if (!iso) continue;
        const t = new Date(iso).getTime();
        if (Number.isFinite(t) && t > latest) latest = t;
      }
    }
  }
  return {
    datasource_kind: detail.datasource_kind,
    warehouse_native: Boolean(detail.warehouse_native),
    last_refreshed: latest ? new Date(latest).toISOString() : null,
    published: Boolean(detail.is_published),
  };
}

const META_FETCH_CAP = 40;

function useDashboardMeta(dashboards: DashboardSummary[] | null): Record<string, DashboardMeta> {
  const [meta, setMeta] = useState<Record<string, DashboardMeta>>({});
  useEffect(() => {
    if (!dashboards) return;
    let cancelled = false;
    const ids = dashboards.filter((d) => d.layout_version === 2).map((d) => d.id).slice(0, META_FETCH_CAP);
    ids.forEach((id) => {
      dashboardBuilderApi
        .get(id)
        .then((detail) => {
          if (!cancelled) setMeta((m) => ({ ...m, [id]: metaOf(detail) }));
        })
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [dashboards]);
  return meta;
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

// A small, to-scale sketch of a dashboard: KPI row, then two charts.
function Thumb({ classic }: { classic: boolean }) {
  return (
    <div aria-hidden="true" className="h-[118px] bg-base border-b border-border p-3 grid grid-cols-4 grid-rows-[24px_1fr] gap-1.5">
      <i className={`block rounded-[5px] ${classic ? "bg-subtle" : "bg-kind-dashboard-fill"}`} />
      <i className="block rounded-[5px] bg-subtle" />
      <i className="block rounded-[5px] bg-subtle" />
      <i className="block rounded-[5px] bg-subtle" />
      <i className="col-span-2 block rounded-[5px] bg-subtle relative overflow-hidden">
        <span className="absolute left-2 right-2 bottom-2 flex items-end gap-1 h-[60%]">
          <span className="flex-1 h-[55%] rounded-t-[2px] bg-series-1/70" />
          <span className="flex-1 h-[85%] rounded-t-[2px] bg-series-1/70" />
          <span className="flex-1 h-[40%] rounded-t-[2px] bg-series-1/70" />
          <span className="flex-1 h-[70%] rounded-t-[2px] bg-series-1/70" />
        </span>
      </i>
      <i className="col-span-2 block rounded-[5px] bg-subtle relative overflow-hidden">
        <svg className="absolute inset-x-2 bottom-2 h-[60%] w-[calc(100%-16px)]" viewBox="0 0 100 40" preserveAspectRatio="none">
          <polyline points="0,30 20,22 40,26 60,12 80,16 100,6" fill="none" stroke="rgb(var(--color-series-2))" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        </svg>
      </i>
    </div>
  );
}

function DashboardCard({
  d, meta, view, onDeleted, onUpgrade, upgrading,
}: {
  d: DashboardSummary;
  meta?: DashboardMeta;
  view: "grid" | "list";
  onDeleted: (id: string) => void;
  onUpgrade: (d: DashboardSummary) => void;
  upgrading: boolean;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const classic = d.layout_version !== 2;
  const href = dashboardHref(d);
  const refreshed = meta?.last_refreshed ? relativeTime(meta.last_refreshed) : null;
  const madeKind = d.source_kind === "answer" || d.source_kind === "analysis" ? d.source_kind : null;
  const madeHref = madeKind ? sourceHref(madeKind, d.source_id, d.source_datasource_id) : null;

  const doDelete = async () => {
    setBusy(true);
    try {
      await dashboardApi.remove(d.id);
      onDeleted(d.id);
    } catch {
      setBusy(false);
      setConfirmingDelete(false);
    }
  };

  const body = (
    <div className="p-4 flex flex-col gap-2.5 min-w-0 flex-1">
      <div className="flex items-start gap-2 min-w-0">
        <Link to={href} className="ui-focus min-w-0 flex-1 text-body font-semibold text-text hover:text-brand-ink truncate" data-dashboard-card-link="">
          {d.name}
        </Link>
        {d.can_delete && !confirmingDelete && (
          <button type="button" className="ui-focus shrink-0 text-faint hover:text-danger" title="Delete dashboard" aria-label={`Delete ${d.name}`} onClick={() => setConfirmingDelete(true)}>
            <TrashIcon />
          </button>
        )}
      </div>
      {madeKind && d.source_title && madeHref ? (
        <MadeFromLink kind={madeKind} title={d.source_title} href={madeHref} />
      ) : (
        <span className="text-caption text-muted">{classic && d.layout_version !== 3 ? "Pinned charts" : "Started on its own"}</span>
      )}
      <div className="flex items-center gap-1.5 flex-wrap text-caption text-muted">
        {classic ? (
          <span className="inline-flex items-center h-5 px-1.5 rounded border border-border text-[10.5px] font-semibold uppercase tracking-caps text-muted">Classic</span>
        ) : (
          meta?.datasource_kind && <ProviderBadge provider={meta.datasource_kind} title={meta.warehouse_native ? `Computed in ${meta.datasource_kind}` : "Computed in GD360"} />
        )}
        {meta?.published && <span className="inline-flex items-center h-5 px-1.5 rounded bg-good-fill text-good text-[10.5px] font-semibold">Published</span>}
        <span>{d.workspace_id ? `Shared with ${d.workspace_name || "workspace"}` : "Personal"}</span>
        {!d.is_own && <span title={d.created_by_email || undefined}>· by {d.created_by_name || d.created_by_email}</span>}
        {refreshed && <span>· refreshed {refreshed}</span>}
      </div>
      {classic && d.can_edit && !confirmingDelete && (
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
      {confirmingDelete && (
        <div className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2.5 flex flex-col gap-2 text-caption text-text">
          <span>Delete “{d.name}”? This can't be undone.</span>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary text-xs" onClick={() => setConfirmingDelete(false)}>Cancel</button>
            <button type="button" disabled={busy} className="ui-focus h-8 px-3 rounded-ctl bg-danger text-[rgb(var(--color-base))] text-xs font-semibold disabled:opacity-50" onClick={doDelete}>
              {busy ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  if (view === "list") {
    return (
      <div className="dash-card flex items-stretch overflow-hidden" data-dashboard-card="">
        <Link to={href} className="hidden sm:grid place-items-center w-16 shrink-0 border-r border-border bg-base" aria-label={`Open ${d.name}`}>
          <KindTile kind="dashboard" size={32} />
        </Link>
        {body}
      </div>
    );
  }
  return (
    <div className="dash-card overflow-hidden flex flex-col" data-dashboard-card="">
      <Link to={href} tabIndex={-1} aria-hidden="true">
        <Thumb classic={classic} />
      </Link>
      {body}
    </div>
  );
}

function StartTile({
  kind, title, text, onClick, highlight, recommended,
}: {
  kind: Kind | "blank";
  title: string;
  text: string;
  onClick: () => void;
  highlight?: boolean;
  recommended?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-start={kind}
      className={`ui-focus text-left flex flex-col gap-2 p-4 rounded-card border transition-colors ${
        recommended ? "border-kind-dashboard-border bg-kind-dashboard-fill/60 hover:bg-kind-dashboard-fill" : "border-border bg-surface hover:border-border-strong"
      } ${highlight ? "ring-2 ring-kind-dashboard/40" : ""}`}
    >
      <span className="flex items-center gap-2">
        {kind === "blank" ? (
          <span className="grid place-items-center w-[30px] h-[30px] rounded-[9px] border border-dashed border-border-strong text-muted" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </span>
        ) : (
          <KindTile kind={kind} size={30} />
        )}
        {recommended && <span className="text-[10.5px] font-semibold uppercase tracking-caps text-kind-dashboard">Recommended</span>}
      </span>
      <span className="text-body font-semibold text-text">{title}</span>
      <span className="text-caption text-muted leading-snug">{text}</span>
    </button>
  );
}

function StartDialog({
  kind, workspaceId, onClose,
}: {
  kind: StartKind;
  workspaceId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [sources, setSources] = useState<DataSourceSummary[] | null>(null);
  const [q, setQ] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (kind === "blank") {
      datasourceApi
        .list(workspaceId || undefined)
        .then((list) => {
          setSources(list);
          setSourceId(list[0]?.id || "");
        })
        .catch(() => setSources([]));
    } else {
      conversationApi
        .list(workspaceId || undefined)
        .then((list) => setItems(list.filter((c) => (kind === "answer" ? c.kind === "project" : c.kind !== "project"))))
        .catch(() => setItems([]));
    }
  }, [kind, workspaceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = items || [];
    return (t ? list.filter((c) => c.title.toLowerCase().includes(t) || (c.datasource_name || "").toLowerCase().includes(t)) : list).slice(0, 40);
  }, [items, q]);

  const pick = (c: ConversationSummary) => {
    if (kind === "answer") navigate(`/p/${c.id}?create=1`);
    else if (c.kind === "guided") navigate(`/g/${c.id}?create=1`);
    else if (c.datasource_id) navigate(`/workspace/${c.datasource_id}?conversation=${c.id}&create=1`);
  };

  const createBlank = async () => {
    if (!sourceId || busy) return;
    setBusy(true);
    setError("");
    try {
      const d = await dashboardBuilderApi.createBlankOnSource(sourceId, name.trim() || undefined);
      navigate(`/dashboard-builder/${d.id}`);
    } catch (e: any) {
      setError(errorText(e, "Couldn't start a blank dashboard. Please try again."));
      setBusy(false);
    }
  };

  const title = kind === "answer" ? "From an answer" : kind === "analysis" ? "From an analysis" : "Blank canvas";
  const sub =
    kind === "answer"
      ? "Pick a question you've asked. It opens with “Create dashboard” ready."
      : kind === "analysis"
      ? "Pick a Guided Analysis. It opens with “Create dashboard” ready."
      : "Pick the data source it computes on, then add blocks yourself.";

  return createPortal(
    <div className="fixed inset-0 z-[60] bg-black/55 grid place-items-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="start-title" data-start-dialog={kind} className="w-full max-w-[560px] max-h-[86vh] overflow-hidden rounded-[18px] border border-border bg-base shadow-pop flex flex-col">
        <div className="p-5 border-b border-border flex items-start gap-3">
          {kind === "blank" ? <KindTile kind="dashboard" size={34} /> : <KindTile kind={kind} size={34} />}
          <div className="min-w-0 flex-1">
            <h2 id="start-title" className="m-0 text-section font-semibold text-text">{title}</h2>
            <p className="m-0 mt-0.5 text-caption text-muted">{sub}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="ui-focus w-9 h-9 grid place-items-center rounded-ctl border border-border text-muted hover:text-text">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        {kind === "blank" ? (
          <div className="p-5 flex flex-col gap-4 overflow-y-auto">
            <label className="flex flex-col gap-1.5 text-caption font-medium text-secondary">
              Name
              <input className="input h-10 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Untitled dashboard" maxLength={120} autoFocus />
            </label>
            <label className="flex flex-col gap-1.5 text-caption font-medium text-secondary">
              Computes on
              {sources === null ? (
                <span className="text-ui text-muted">Loading your sources…</span>
              ) : sources.length ? (
                <select className="input h-10 text-sm" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} · {s.kind}</option>
                  ))}
                </select>
              ) : (
                <span className="text-ui text-muted">No sources yet - <Link to="/data" className="text-text underline">connect one</Link> first.</span>
              )}
            </label>
            {error && <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-ui text-text">{error}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary text-sm" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" className="btn-primary text-sm" onClick={createBlank} disabled={busy || !sourceId}>{busy ? "Starting…" : "Create blank dashboard"}</button>
            </div>
          </div>
        ) : (
          <>
            <div className="px-5 pt-4">
              <label className="sr-only" htmlFor="start-search">Search</label>
              <input id="start-search" className="input h-10 text-sm w-full" placeholder={kind === "answer" ? "Search your answers…" : "Search your analyses…"} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
            </div>
            <div className="p-3 overflow-y-auto flex flex-col gap-1">
              {items === null && <div className="p-4 text-ui text-muted">Loading…</div>}
              {items !== null && shown.length === 0 && (
                <div className="p-4 text-ui text-muted">
                  {items.length === 0
                    ? kind === "answer"
                      ? <>No answers yet. <Link to="/" className="text-text underline">Get an Instant Answer</Link> first.</>
                      : <>No analyses yet. <Link to="/?intent=guided" className="text-text underline">Start a Guided Analysis</Link> first.</>
                    : "Nothing matches."}
                </div>
              )}
              {shown.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => pick(c)}
                  className="ui-focus w-full grid grid-cols-[32px_minmax(0,1fr)_auto] gap-3 items-center px-3 py-2.5 rounded-ctl text-left hover:bg-surface"
                >
                  <KindTile kind={kind === "answer" ? "answer" : "analysis"} size={32} />
                  <span className="min-w-0 flex flex-col">
                    <span className="text-ui text-text truncate">{c.title}</span>
                    <span className="text-caption text-muted truncate">
                      {c.datasource_name || "No source"}
                      {c.dashboard_count ? ` · ${c.dashboard_count} dashboard${c.dashboard_count === 1 ? "" : "s"} already` : ""}
                    </span>
                  </span>
                  <span className="text-caption text-muted">{relativeTime(c.updated_at)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default function Dashboards() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useViewMode("gd360_view_dashboards");
  const [filter, setFilter] = useState<Filter>("all");
  const [start, setStart] = useState<StartKind | null>(null);
  const [upgradingId, setUpgradingId] = useState<string | null>(null);
  const highlightStart = params.get("start") === "1";
  const startRef = useRef<HTMLDivElement>(null);
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();

  useEffect(() => {
    dashboardApi
      .list()
      .then(setDashboards)
      .catch(() => setError("Couldn't load your dashboards. Please try refreshing."));
  }, []);

  useEffect(() => {
    if (!highlightStart) return;
    startRef.current?.scrollIntoView({ block: "center" });
    (startRef.current?.querySelector("button") as HTMLButtonElement | null)?.focus();
    const t = window.setTimeout(() => {
      const next = new URLSearchParams(params);
      next.delete("start");
      setParams(next, { replace: true });
    }, 2400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightStart]);

  const meta = useDashboardMeta(dashboards);
  const removeById = (id: string) => setDashboards((ds) => (ds || []).filter((x) => x.id !== id));

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
  const shown = filter === "mine" ? mine : filter === "shared" ? shared : all;
  // Full dashboards first, then classic ones, newest first within each.
  const ordered = [...shown].sort((a, b) => {
    const ca = a.layout_version === 2 ? 0 : 1;
    const cb = b.layout_version === 2 ? 0 : 1;
    if (ca !== cb) return ca - cb;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <main className="max-w-[1180px] mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col gap-7">
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div className="flex flex-col gap-1.5">
              <h1 className="m-0 text-[28px] sm:text-[32px] font-semibold tracking-tight text-text">Dashboards</h1>
              <p className="m-0 text-body text-muted max-w-[62ch]">
                Live, filterable pages to monitor and share. Every dashboard in GD360 is this kind — whatever you make it from.
              </p>
            </div>
            <Link to="/dashboards/new" className="btn-primary text-sm inline-flex items-center gap-1.5" data-new-dashboard-cta="">
              <KindIcon kind="dashboard" size={15} /> New dashboard
            </Link>
          </div>

          <section aria-label="Start a dashboard" className="flex flex-col gap-2.5" ref={startRef}>
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Start a dashboard</span>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
              <StartTile kind="dashboard" recommended highlight={highlightStart} title="Describe it" text="“Bookings and cancellations by hotel and month.” GD360 drafts it with filters; you refine." onClick={() => navigate("/dashboards/new")} />
              <StartTile kind="answer" highlight={highlightStart} title="From an answer" text="Turn something you asked into a live dashboard." onClick={() => setStart("answer")} />
              <StartTile kind="analysis" highlight={highlightStart} title="From an analysis" text="Use what you worked through in Guided Analysis." onClick={() => setStart("analysis")} />
              <StartTile kind="blank" highlight={highlightStart} title="Blank canvas" text="Pick a source and add blocks yourself." onClick={() => setStart("blank")} />
            </div>
          </section>

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
              {all.length > 0 && <ViewToggle mode={viewMode} onChange={setViewMode} />}
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
              <div className="dash-card p-6 text-ui text-muted text-center">{filter === "shared" ? "Nothing shared with you yet." : "Nothing here yet."}</div>
            )}

            {ordered.length > 0 && (
              <div className={viewMode === "grid" ? "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3.5" : "grid grid-cols-1 gap-2.5"}>
                {ordered.map((d) => (
                  <DashboardCard key={d.id} d={d} meta={meta[d.id]} view={viewMode} onDeleted={removeById} onUpgrade={upgrade} upgrading={upgradingId === d.id} />
                ))}
              </div>
            )}
            {ordered.some((d) => d.layout_version !== 2) && (
              <p className="m-0 text-caption text-muted">
                <KindPill kind="dashboard" className="h-[18px] px-1.5 text-[10.5px] mr-1.5 align-[1px]">Classic</KindPill>
                dashboards are from before every dashboard became the full kind. Upgrade keeps the same link, name and sharing.
              </p>
            )}
          </section>
        </main>
      </div>

      {start && <StartDialog kind={start} workspaceId={activeWorkspaceId} onClose={() => setStart(null)} />}
    </div>
  );
}
