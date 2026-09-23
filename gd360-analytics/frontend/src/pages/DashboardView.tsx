import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { dashboardApi, DashboardDetail, workspaceApi, WorkspaceSummary } from "../api/client";
import TopNav from "../components/TopNav";
import ChartCanvas from "../components/ChartCanvas";

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

function TrashIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

export default function DashboardView() {
  const { dashboardId } = useParams();
  const navigate = useNavigate();
  const [dash, setDash] = useState<DashboardDetail | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [error, setError] = useState("");

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [sharePickerOpen, setSharePickerOpen] = useState(false);
  const [sharing, setSharing] = useState(false);

  const load = () => {
    if (!dashboardId) return;
    dashboardApi
      .get(dashboardId)
      .then((data) => setDash(data))
      .catch((err) => setError(err?.response?.status === 404 ? "Dashboard not found." : "Couldn't load this dashboard."));
  };

  useEffect(load, [dashboardId]);
  useEffect(() => { workspaceApi.list().then(setWorkspaces).catch(() => {}); }, []);

  const startRename = () => {
    if (!dash) return;
    setNameDraft(dash.name);
    setRenaming(true);
  };

  const commitRename = async () => {
    if (!dash) return;
    const trimmed = nameDraft.trim();
    setRenaming(false);
    if (!trimmed || trimmed === dash.name) return;
    setSavingName(true);
    try {
      const updated = await dashboardApi.rename(dash.id, trimmed);
      setDash({ ...dash, ...updated });
    } catch {
      // Leave the old name showing rather than a broken half-state.
    } finally {
      setSavingName(false);
    }
  };

  const removeChart = async (chartId: string) => {
    if (!dash) return;
    setDash({ ...dash, charts: dash.charts.filter((c) => c.id !== chartId) });
    try {
      await dashboardApi.removeChart(dash.id, chartId);
    } catch {
      load(); // resync if the delete didn't actually go through
    }
  };

  const doDelete = async () => {
    if (!dash) return;
    setDeleting(true);
    try {
      await dashboardApi.remove(dash.id);
      navigate("/dashboards");
    } catch {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const setWorkspace = async (workspaceId: string | null) => {
    if (!dash) return;
    setSharing(true);
    try {
      const updated = await dashboardApi.setWorkspace(dash.id, workspaceId);
      setDash({ ...dash, ...updated });
      setSharePickerOpen(false);
    } catch {
      // stays open on failure so the person can retry
    } finally {
      setSharing(false);
    }
  };

  // Only offered as share targets: a real team workspace where this
  // person isn't just a "viewer" - matches what the backend actually
  // allows (see routers/dashboards.py _check_can_share_into).
  const shareOptions = workspaces.filter((w) => !w.is_personal && w.role !== "viewer");

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

  return (
    <div>
      <TopNav />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <Link to="/dashboards" className="text-xs text-muted hover:text-text transition inline-block mb-3">&larr; Dashboards</Link>

        <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
          <div className="min-w-0">
            {renaming ? (
              <input
                autoFocus
                className="input text-xl font-bold py-1 w-full max-w-md"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenaming(false);
                }}
                onBlur={commitRename}
                maxLength={80}
              />
            ) : (
              <h1 className="text-2xl font-bold flex items-center gap-2 flex-wrap">
                {dash.name}
                {dash.can_edit && (
                  <button type="button" className="opacity-50 hover:opacity-100 transition text-base" title="Rename this dashboard" onClick={startRename}>
                    &#9998;
                  </button>
                )}
                {savingName && <span className="text-xs font-normal text-accent">Saving&hellip;</span>}
              </h1>
            )}
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {dash.workspace_id ? (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-surface2 border border-border text-muted">
                  <PeopleIcon /> Shared with {dash.workspace_name || "workspace"}
                </span>
              ) : (
                <span className="text-xs px-2 py-0.5 rounded-full bg-surface2 border border-border text-muted">Personal</span>
              )}
              {!dash.is_own && (
                <span className="text-xs text-muted" title={dash.created_by_email || undefined}>
                  Created by {dash.created_by_name || dash.created_by_email}
                </span>
              )}
            </div>
          </div>

          {dash.is_own && (
            <div className="relative shrink-0">
              <button type="button" className="btn-secondary text-xs" onClick={() => setSharePickerOpen((o) => !o)}>
                {dash.workspace_id ? "Change sharing" : "Share…"}
              </button>
              {sharePickerOpen && (
                <div className="absolute right-0 top-full mt-2 w-64 card bg-surface shadow-2xl border border-border p-3 z-30">
                  <div className="text-xs text-muted mb-2">Who can see this dashboard?</div>
                  <div className="space-y-1">
                    <button
                      type="button"
                      disabled={sharing}
                      className={`w-full text-left text-sm px-2.5 py-1.5 rounded-lg hover:bg-surface2 transition ${!dash.workspace_id ? "text-primary font-medium" : ""}`}
                      onClick={() => setWorkspace(null)}
                    >
                      Personal (only me)
                    </button>
                    {shareOptions.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        disabled={sharing}
                        className={`w-full text-left text-sm px-2.5 py-1.5 rounded-lg hover:bg-surface2 transition ${dash.workspace_id === w.id ? "text-primary font-medium" : ""}`}
                        onClick={() => setWorkspace(w.id)}
                      >
                        Shared with {w.name}
                      </button>
                    ))}
                    {shareOptions.length === 0 && (
                      <div className="text-xs text-muted px-2.5 py-1.5">
                        You don&rsquo;t have edit access to any team workspace to share this with.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
          {dash.charts.map((c) => (
            <div key={c.id} className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                {dash.can_edit && (
                  <button
                    type="button"
                    className="ml-auto text-xs text-muted hover:text-red-400 transition flex items-center gap-1"
                    onClick={() => removeChart(c.id)}
                    title="Remove this chart from the dashboard"
                  >
                    <TrashIcon /> Remove
                  </button>
                )}
              </div>
              <div className="h-[380px]">
                <ChartCanvas chartSpec={c.chart_spec} title={c.title} />
              </div>
              {c.insight && (
                <div className="text-sm bg-accent/10 border border-accent/30 rounded-xl px-4 py-2.5">
                  <span className="font-semibold text-accent">Insight: </span>{c.insight}
                </div>
              )}
            </div>
          ))}
          {dash.charts.length === 0 && (
            <div className="text-muted text-sm">
              No charts saved to this dashboard yet. Open a Project&rsquo;s chart and use &ldquo;Save chart to
              dashboard&rdquo; to pin one here.
            </div>
          )}
        </div>

        {dash.can_delete && (
          <div className="mt-10 pt-6 border-t border-border">
            {confirmingDelete ? (
              <div className="text-sm bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 max-w-md space-y-2">
                <div>Delete &ldquo;{dash.name}&rdquo;? This removes all {dash.charts.length} chart(s) on it and can&rsquo;t be undone.</div>
                <div className="flex items-center gap-2">
                  <button type="button" className="btn-secondary text-xs" onClick={() => setConfirmingDelete(false)}>Cancel</button>
                  <button
                    type="button"
                    disabled={deleting}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 transition disabled:opacity-50"
                    onClick={doDelete}
                  >
                    {deleting ? "Deleting…" : "Delete dashboard"}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="text-xs text-muted hover:text-red-400 transition flex items-center gap-1.5" onClick={() => setConfirmingDelete(true)}>
                <TrashIcon /> Delete this dashboard
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
