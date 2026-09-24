import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { dashboardBuilderApi, DashboardBuilderDetail } from "../api/client";
import TopNav from "../components/TopNav";
import { DashboardBlockGrid } from "../components/DashboardBlocks";
import DashboardCanvas from "../components/DashboardCanvas";
import { useDashboardFilters } from "../lib/useDashboardFilters";

// 2026-09-24 (Dashboard Builder Phase 1 + Phase 2 + Phase 2b): the
// owner/editor view for the new pages+blocks kind of dashboard - opened
// from Dashboards.tsx (routed here instead of DashboardView.tsx whenever
// layout_version===2) or straight after "Build with AI" finishes (see
// BuildDashboardModal.tsx).
//
// Phase 2 adds a real edit/view toggle: someone who can_edit this dashboard
// lands in edit mode by default (DashboardCanvas - drag/resize/add/remove
// blocks, per-block Ask AI/manual build/style) and can switch to a plain
// read view (DashboardBlockGrid, the exact same renderer the public link
// uses) at any time; a view-only visitor (can_edit===false) only ever sees
// the read view, with no toggle offered at all.
//
// Phase 2b adds cross-filtering, live in BOTH Edit and Preview here (never
// on the public link - see lib/useDashboardFilters.ts and the backend's
// own reasoning). One useDashboardFilters() call per active page, shared
// by both DashboardCanvas and DashboardBlockGrid below so a filter
// selection behaves identically whichever mode you're looking at it in.

function LinkIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function CopyIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function PublishPanel({ dash, onChange }: { dash: DashboardBuilderDetail; onChange: (d: DashboardBuilderDetail) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const publicUrl = dash.public_slug ? `${window.location.origin}/d/${dash.public_slug}` : "";

  const doPublish = async () => {
    setBusy(true);
    setError("");
    try {
      onChange(await dashboardBuilderApi.publish(dash.id));
    } catch {
      setError("Couldn't publish this dashboard. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const doUnpublish = async () => {
    setBusy(true);
    setError("");
    try {
      onChange(await dashboardBuilderApi.unpublish(dash.id));
    } catch {
      setError("Couldn't unpublish this dashboard. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard permission can be refused in some contexts - the link
      // text itself is still selectable, so this just silently no-ops.
    }
  };

  if (!dash.can_edit) {
    return dash.is_published ? (
      <a href={publicUrl} target="_blank" rel="noreferrer" className="btn-secondary text-xs flex items-center gap-1.5">
        <LinkIcon className="w-3.5 h-3.5" /> View public link
      </a>
    ) : null;
  }

  return (
    <div className="relative">
      <button
        type="button"
        className={dash.is_published ? "btn-secondary text-xs" : "btn-primary text-xs"}
        onClick={() => setOpen((o) => !o)}
      >
        {dash.is_published ? "Published" : "Publish"}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 card bg-surface shadow-2xl border border-border p-4 z-30">
          {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">{error}</div>}
          {dash.is_published ? (
            <>
              <div className="text-xs text-muted mb-2">Anyone with this link can view this dashboard.</div>
              <div className="flex items-center gap-1.5 mb-3">
                <input readOnly className="input text-xs flex-1 truncate" value={publicUrl} onFocus={(e) => e.target.select()} />
                <button type="button" className="btn-secondary text-xs px-2.5 py-1.5 shrink-0 flex items-center gap-1" onClick={copyLink}>
                  <CopyIcon /> {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <button type="button" disabled={busy} className="text-xs text-muted hover:text-red-400 transition disabled:opacity-50" onClick={doUnpublish}>
                {busy ? "Working…" : "Unpublish"}
              </button>
            </>
          ) : (
            <>
              <div className="text-xs text-muted mb-3 leading-relaxed">
                Publishing creates a public link - anyone who has it can view this dashboard without
                signing in. Named, password-protected private sharing is coming in a later round.
              </div>
              <button type="button" disabled={busy} className="btn-primary text-xs w-full" onClick={doPublish}>
                {busy ? "Publishing…" : "Publish publicly"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function DashboardBuilderView() {
  const { dashboardId } = useParams();
  const [dash, setDash] = useState<DashboardBuilderDetail | null>(null);
  const [error, setError] = useState("");
  const [activePageId, setActivePageId] = useState<string | null>(null);
  // 2026-09-24 (Phase 2): edit mode by default for whoever can actually
  // edit this dashboard - a view-only visitor never sees "edit" at all
  // (guarded below in the render, not just here) since dash.can_edit isn't
  // known until the fetch below resolves.
  const [mode, setMode] = useState<"edit" | "view">("edit");

  useEffect(() => {
    if (!dashboardId) return;
    dashboardBuilderApi
      .get(dashboardId)
      .then((data) => {
        setDash(data);
        setActivePageId(data.pages[0]?.id || null);
        if (!data.can_edit) setMode("view");
      })
      .catch((err) =>
        setError(err?.response?.status === 404 ? "Dashboard not found." : "Couldn't load this dashboard.")
      );
  }, [dashboardId]);

  if (error) {
    return (
      <div>
        <TopNav />
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 inline-block">{error}</div>
          <div className="mt-4">
            <Link to="/dashboards" className="text-sm text-primary hover:underline">&larr; Back to Dashboards</Link>
          </div>
        </div>
      </div>
    );
  }

  if (!dash) {
    return (
      <div>
        <TopNav />
        <div className="max-w-6xl mx-auto px-6 py-8 text-sm text-muted">Loading&hellip;</div>
      </div>
    );
  }

  const activePage = dash.pages.find((p) => p.id === activePageId) || dash.pages[0];

  return (
    <DashboardBuilderViewBody
      dash={dash}
      setDash={setDash}
      activePage={activePage}
      setActivePageId={setActivePageId}
      mode={mode}
      setMode={setMode}
    />
  );
}

// Split out so useDashboardFilters (a hook, which can't be called
// conditionally) only ever runs once `dash` is loaded and `activePage` is
// known - the loading/error early-returns above happen before this
// component even mounts.
function DashboardBuilderViewBody({
  dash,
  setDash,
  activePage,
  setActivePageId,
  mode,
  setMode,
}: {
  dash: DashboardBuilderDetail;
  setDash: (d: DashboardBuilderDetail) => void;
  activePage: DashboardBuilderDetail["pages"][number] | undefined;
  setActivePageId: (id: string) => void;
  mode: "edit" | "view";
  setMode: (m: "edit" | "view") => void;
}) {
  const filterState = useDashboardFilters(dash.id, activePage);

  // Every block-mutating action anywhere on this page (build manually,
  // ask AI, restyle, delete, add) flows through here - re-running the
  // active filter selection afterward means an override never lingers on
  // a block whose real, persisted content just changed underneath it.
  const handleDashChange = (d: DashboardBuilderDetail) => {
    setDash(d);
    filterState.refresh();
  };

  return (
    <div>
      <TopNav />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <Link to="/dashboards" className="text-xs text-muted hover:text-text transition inline-block mb-3">&larr; Dashboards</Link>

        <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold flex items-center gap-2 flex-wrap">
              {dash.name}
              <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/30">
                Dashboard
              </span>
            </h1>
            <div className="text-xs text-muted mt-1.5">
              {dash.is_published ? "Published - anyone with the link can view it" : "Not published yet - only you can see this"}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {dash.can_edit && (
              <div className="flex items-center rounded-lg border border-border overflow-hidden text-xs">
                <button
                  type="button"
                  className={`px-2.5 py-1.5 transition ${mode === "edit" ? "bg-primary text-white" : "text-muted hover:text-text hover:bg-surface2"}`}
                  onClick={() => setMode("edit")}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={`px-2.5 py-1.5 transition ${mode === "view" ? "bg-primary text-white" : "text-muted hover:text-text hover:bg-surface2"}`}
                  onClick={() => setMode("view")}
                >
                  Preview
                </button>
              </div>
            )}
            <PublishPanel dash={dash} onChange={handleDashChange} />
          </div>
        </div>

        {dash.pages.length > 1 && (
          <div className="flex items-center gap-1.5 mt-5 mb-4 flex-wrap">
            {dash.pages.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
                  activePage?.id === p.id
                    ? "bg-primary text-white border-primary"
                    : "border-border text-muted hover:text-text hover:bg-surface2"
                }`}
                onClick={() => setActivePageId(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}

        {filterState.activeFilters.length > 0 && (
          <div className="text-[11px] text-muted mb-2 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
            Filtering {filterState.loading ? "…" : `${filterState.activeFilters.length} active`}
          </div>
        )}

        <div className="mt-6">
          {!activePage ? (
            <div className="text-sm text-muted py-10 text-center">This dashboard has no pages yet.</div>
          ) : dash.can_edit && mode === "edit" ? (
            <DashboardCanvas dash={dash} page={activePage} onChange={handleDashChange} filterState={filterState} />
          ) : (
            <DashboardBlockGrid blocks={activePage.blocks} datasourceId={dash.datasource_id} filterState={filterState} />
          )}
        </div>
      </div>
    </div>
  );
}
