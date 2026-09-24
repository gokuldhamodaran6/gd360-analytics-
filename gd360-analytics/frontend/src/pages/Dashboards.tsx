import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { dashboardApi, DashboardSummary, WorkspaceSummary } from "../api/client";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import ViewToggle, { useViewMode } from "../components/ViewToggle";

// 2026-09-23 (shared dashboards v1): the "My dashboards" page this app
// never actually had before - previously a dashboard could only be opened
// by hitting /dashboards/<id> directly, and every "Save chart to
// dashboard" click silently created a brand-new one (see
// backend/app/routers/dashboards.py's scope history). This lists every
// dashboard the signed-in person can see: their own personal ones, plus
// anything a teammate has shared into a workspace they're a member of.

function ChartIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <rect x="7" y="12" width="3" height="6" rx="0.5" />
      <rect x="13" y="8" width="3" height="10" rx="0.5" />
      <rect x="18" y="5" width="3" height="13" rx="0.5" />
    </svg>
  );
}

function PlusIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CloseIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function TrashIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

function PeopleIcon({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function CreateDashboardModal({
  workspaces,
  onClose,
  onCreated,
}: {
  workspaces: WorkspaceSummary[];
  onClose: () => void;
  onCreated: (d: DashboardSummary) => void;
}) {
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Only a real team workspace where this person can actually add to
  // things (not "viewer") is offered as a share target - same rule the
  // backend enforces server-side either way.
  const shareOptions = workspaces.filter((w) => !w.is_personal && w.role !== "viewer");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError("");
    try {
      const d = await dashboardApi.create(trimmed, workspaceId || null);
      onCreated(d);
    } catch {
      setError("Couldn't create that dashboard. Please try again.");
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card w-full max-w-sm p-6 relative">
        <button className="absolute top-4 right-4 text-muted hover:text-text transition" onClick={onClose} aria-label="Close">
          <CloseIcon className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-bold mb-1">New dashboard</h2>
        <p className="text-xs text-muted mb-5 leading-relaxed">
          A board to pin charts onto. Keep it personal, or share it with a team workspace so everyone
          sees the same curated set instead of digging through Projects to find it again.
        </p>
        <form onSubmit={submit} className="space-y-3">
          {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
          <input
            autoFocus
            className="input text-sm w-full"
            placeholder="e.g. Weekly revenue, Marketing overview"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
          {shareOptions.length > 0 && (
            <div>
              <label className="text-xs text-muted mb-1 block">Visibility</label>
              <select
                className="input text-sm w-full"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                <option value="">Personal (only me)</option>
                {shareOptions.map((w) => (
                  <option key={w.id} value={w.id}>Shared with {w.name}</option>
                ))}
              </select>
            </div>
          )}
          <button className="btn-primary w-full text-sm" type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create dashboard"}
          </button>
        </form>
      </div>
    </div>,
    document.body
  );
}

function DashboardCard({ d, onDeleted }: { d: DashboardSummary; onDeleted: (id: string) => void }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="card p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <Link
          to={d.layout_version === 2 ? `/dashboard-builder/${d.id}` : `/dashboards/${d.id}`}
          className="flex items-center gap-2 min-w-0 group"
        >
          <span className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <ChartIcon />
          </span>
          <span className="font-semibold text-sm truncate group-hover:text-primary transition">{d.name}</span>
        </Link>
        {d.can_delete && !confirmingDelete && (
          <button
            type="button"
            className="opacity-50 hover:opacity-100 hover:text-red-400 transition shrink-0"
            title="Delete dashboard"
            onClick={() => setConfirmingDelete(true)}
          >
            <TrashIcon />
          </button>
        )}
      </div>

      {confirmingDelete ? (
        <div className="text-xs bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 space-y-2">
          <div className="text-text">Delete &ldquo;{d.name}&rdquo;? This can&rsquo;t be undone.</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex-1 text-xs font-medium px-2.5 py-1 rounded-lg border border-border hover:bg-surface2 transition"
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              className="flex-1 text-xs font-semibold px-2.5 py-1 rounded-lg bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 transition disabled:opacity-50"
              onClick={doDelete}
            >
              {busy ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="text-xs text-muted">
            {d.chart_count} chart{d.chart_count === 1 ? "" : "s"}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {d.workspace_id ? (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-surface2 border border-border text-muted">
                <PeopleIcon /> Shared with {d.workspace_name || "workspace"}
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface2 border border-border text-muted">
                Personal
              </span>
            )}
            {!d.is_own && (
              <span className="text-[10px] text-muted" title={d.created_by_email || undefined}>
                by {d.created_by_name || d.created_by_email}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function Dashboards() {
  const navigate = useNavigate();
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useViewMode("gd360_view_dashboards");

  // The sidebar's own workspace list/switcher - Dashboards itself isn't
  // scoped to one active workspace (it shows every dashboard across all of
  // them, grouped by section below), this is purely so the persistent
  // AppSidebar behaves identically here as it does on every other page.
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();

  useEffect(() => {
    dashboardApi
      .list()
      .then(setDashboards)
      .catch(() => setError("Couldn't load your dashboards. Please try refreshing."));
  }, []);

  const personal = (dashboards || []).filter((d) => !d.workspace_id);
  const shared = (dashboards || []).filter((d) => d.workspace_id);
  const sharedByWorkspace = new Map<string, DashboardSummary[]>();
  for (const d of shared) {
    const key = d.workspace_id as string;
    if (!sharedByWorkspace.has(key)) sharedByWorkspace.set(key, []);
    sharedByWorkspace.get(key)!.push(d);
  }

  return (
    <div className="flex">
      <AppSidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onWorkspaceSwitch={switchWorkspace}
        onWorkspaceCreated={handleWorkspaceCreated}
      />
      <div className="flex-1 min-w-0">
      <TopNav hideLogo />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold">Dashboards</h1>
            <p className="text-sm text-muted mt-1">
              Curated boards of pinned charts - keep one for yourself, or share one with a workspace.
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            {dashboards && dashboards.length > 0 && <ViewToggle mode={viewMode} onChange={setViewMode} />}
            <button type="button" className="btn-primary text-sm flex items-center gap-1.5" onClick={() => setShowCreate(true)}>
              <PlusIcon /> New dashboard
            </button>
          </div>
        </div>

        {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">{error}</div>}

        {dashboards === null && !error && <div className="text-sm text-muted">Loading…</div>}

        {dashboards !== null && dashboards.length === 0 && (
          <div className="card p-8 text-center">
            <div className="text-sm text-muted mb-4 leading-relaxed">
              You don&rsquo;t have any dashboards yet. Save a chart from a Project&rsquo;s Ask GD360 chat
              with &ldquo;Save chart to dashboard&rdquo;, or start an empty one here.
            </div>
            <button type="button" className="btn-primary text-sm" onClick={() => setShowCreate(true)}>
              + New dashboard
            </button>
          </div>
        )}

        {personal.length > 0 && (
          <div className="mb-8">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-2">Personal</div>
            <div className={viewMode === "grid" ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" : "grid grid-cols-1 gap-2"}>
              {personal.map((d) => (
                <DashboardCard key={d.id} d={d} onDeleted={(id) => setDashboards((ds) => (ds || []).filter((x) => x.id !== id))} />
              ))}
            </div>
          </div>
        )}

        {[...sharedByWorkspace.entries()].map(([wsId, list]) => (
          <div className="mb-8" key={wsId}>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-2">
              Shared with {list[0].workspace_name || "workspace"}
            </div>
            <div className={viewMode === "grid" ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" : "grid grid-cols-1 gap-2"}>
              {list.map((d) => (
                <DashboardCard key={d.id} d={d} onDeleted={(id) => setDashboards((ds) => (ds || []).filter((x) => x.id !== id))} />
              ))}
            </div>
          </div>
        ))}
      </div>
      </div>

      {showCreate && (
        <CreateDashboardModal
          workspaces={workspaces}
          onClose={() => setShowCreate(false)}
          onCreated={(d) => {
            setShowCreate(false);
            setDashboards((ds) => [d, ...(ds || [])]);
            navigate(`/dashboards/${d.id}`);
          }}
        />
      )}
    </div>
  );
}
