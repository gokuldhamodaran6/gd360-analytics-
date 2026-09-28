import { useEffect, useState } from "react";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { SIGNATURE_COLORS } from "../lib/chartStyle";
import { AuditEvent, GovernanceDataSource, governanceApi } from "../api/client";

// Phase 5, Batch A (2026-09-28, "Data governance & quality" roadmap): the
// /governance page - owner-only for the active workspace (the backend
// 403s anyone else - see routers/governance.py). Two sections:
//   (a) Access review - every data source shared into this workspace, who
//       can see it, and when it was last marked "reviewed" by a real
//       person (never inferred).
//   (b) Audit log - this workspace's own real, persisted history of
//       significant actions (see models.AuditEvent's own docstring for why
//       this is genuinely different from /admin's live-computed "Recent
//       activity" feed, which is platform-wide and GD360-staff-only).
// Styled similarly to AdminDashboard.tsx's own "Recent activity" card
// (small colored dot + label + text + relative time) without importing
// anything from that file - this is a completely different, workspace-
// scoped data source built fresh for this page.

const PAGE_SIZE = 20;

const ACTION_LABELS: Record<string, string> = {
  login: "Logged in",
  signup: "Created an account",
  workspace_created: "Created a workspace",
  member_role_changed: "Changed a member's role",
  member_joined: "Joined the workspace",
  datasource_connected: "Connected a data source",
  datasource_deleted: "Removed a data source",
  dashboard_created: "Created a dashboard",
  dashboard_deleted: "Deleted a dashboard",
  quality_rule_created: "Added a quality check",
  quality_rule_deleted: "Removed a quality check",
  governance_review_marked: "Marked a data source reviewed",
};

// A small, stable palette keyed off the action string itself (rather than
// a fixed per-action map) so an unmapped/future action still gets a real,
// consistent dot color instead of falling back to nothing.
function colorForAction(action: string): string {
  let hash = 0;
  for (let i = 0; i < action.length; i++) hash = (hash * 31 + action.charCodeAt(i)) >>> 0;
  return SIGNATURE_COLORS[hash % SIGNATURE_COLORS.length];
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] || action;
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function eventDescription(event: AuditEvent): string {
  const meta = event.event_metadata;
  if (event.action === "member_role_changed" && meta && typeof meta.new_role === "string") {
    return `New role: ${meta.new_role}`;
  }
  if (event.action === "datasource_connected" && meta && typeof meta.kind === "string") {
    return `Kind: ${meta.kind}`;
  }
  return "";
}

function ShieldIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 9.5-4-1.3-7-5-7-9.5V6l7-3z" />
      <path d="M9.5 12l1.8 1.8L15 10" />
    </svg>
  );
}

export default function Governance() {
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();

  const [datasources, setDatasources] = useState<GovernanceDataSource[] | null>(null);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [totalEvents, setTotalEvents] = useState(0);
  const [page, setPage] = useState(1);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState("");
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const loadOverview = () => {
    if (!activeWorkspaceId) return;
    governanceApi
      .overview(activeWorkspaceId)
      .then(setDatasources)
      .catch((err: any) => {
        if (err?.response?.status === 403) {
          setForbidden(true);
        } else if (err?.response?.status !== 404) {
          setError("Couldn't load the access review. Please try again in a moment.");
        }
      });
  };

  const loadAuditLog = (p: number) => {
    if (!activeWorkspaceId) return;
    governanceApi
      .auditLog(activeWorkspaceId, p, PAGE_SIZE)
      .then((res) => {
        setEvents(res.events);
        setTotalEvents(res.total);
      })
      .catch((err: any) => {
        if (err?.response?.status === 403) {
          setForbidden(true);
        } else if (err?.response?.status !== 404) {
          setError("Couldn't load the audit log. Please try again in a moment.");
        }
      });
  };

  useEffect(() => {
    setDatasources(null);
    setEvents(null);
    setForbidden(false);
    setError("");
    setPage(1);
    loadOverview();
    loadAuditLog(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

  const changePage = (p: number) => {
    if (p < 1) return;
    setPage(p);
    loadAuditLog(p);
  };

  const markReviewed = async (dsId: string) => {
    setReviewingId(dsId);
    try {
      await governanceApi.markReviewed(dsId);
      loadOverview();
    } catch {
      setError("Couldn't mark this data source reviewed. Please try again.");
    } finally {
      setReviewingId(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(totalEvents / PAGE_SIZE));

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onWorkspaceSwitch={switchWorkspace}
        onWorkspaceCreated={handleWorkspaceCreated}
      />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ShieldIcon /> Governance
            </h1>
            <p className="text-sm text-muted mt-1 max-w-2xl">
              Who has access to your team&rsquo;s data, when it was last reviewed, and a real record of
              significant activity in this workspace.
            </p>
          </div>

          {forbidden ? (
            <div className="dash-card p-8 text-center">
              <div className="text-sm text-muted">You don&rsquo;t have access to this page.</div>
              <div className="text-xs text-muted mt-1">Only the workspace owner can view governance data.</div>
            </div>
          ) : (
            <>
              {error && (
                <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">
                  {error}
                </div>
              )}

              {/* ---- Access review ---- */}
              <div className="mb-8">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-3">Access review</h2>
                {datasources === null && !error && <div className="text-sm text-muted">Loading&hellip;</div>}
                {datasources !== null && datasources.length === 0 && (
                  <div className="dash-card p-8 text-center">
                    <div className="text-sm text-muted mb-1">No data sources in this workspace yet.</div>
                    <div className="text-xs text-muted max-w-md mx-auto leading-relaxed">
                      Connect a data source, or share an existing one into this workspace, and it will show
                      up here with who has access to it.
                    </div>
                  </div>
                )}
                {datasources !== null && datasources.length > 0 && (
                  <div className="dash-card overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-muted border-b border-border">
                          <th className="px-4 py-2.5 font-medium">Name</th>
                          <th className="px-4 py-2.5 font-medium">Who has access</th>
                          <th className="px-4 py-2.5 font-medium">Last reviewed</th>
                          <th className="px-4 py-2.5 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {datasources.map((ds) => (
                          <tr key={ds.id} className="border-b border-border last:border-0">
                            <td className="px-4 py-3 font-medium truncate max-w-[220px]" title={ds.name}>
                              {ds.name}
                              <span className="ml-2 text-[10px] uppercase tracking-wide text-muted">{ds.kind}</span>
                            </td>
                            <td className="px-4 py-3 text-muted">
                              <div className="flex flex-wrap gap-1">
                                {ds.member_access.map((m) => (
                                  <span
                                    key={m.user_id}
                                    className="inline-flex items-center text-xs px-2 py-0.5 rounded-full bg-surface2 border border-border"
                                    title={`${m.email} (${m.role})`}
                                  >
                                    {m.name || m.email}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-muted whitespace-nowrap">
                              {ds.governance_last_reviewed_at ? (
                                <span title={ds.governance_last_reviewed_by ? `By ${ds.governance_last_reviewed_by}` : undefined}>
                                  {timeAgo(ds.governance_last_reviewed_at)}
                                </span>
                              ) : (
                                "Never reviewed"
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <button
                                type="button"
                                className="btn-secondary text-xs disabled:opacity-50"
                                disabled={reviewingId === ds.id}
                                onClick={() => markReviewed(ds.id)}
                              >
                                {reviewingId === ds.id ? "Marking…" : "Mark reviewed"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* ---- Audit log ---- */}
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-3">Audit log</h2>
                <div className="dash-card p-4">
                  {events === null && !error && <div className="text-sm text-muted py-4 text-center">Loading&hellip;</div>}
                  {events !== null && events.length === 0 && (
                    <div className="text-muted text-sm py-6 text-center">No activity yet.</div>
                  )}
                  {events !== null && events.length > 0 && (
                    <div className="max-h-[28rem] overflow-y-auto -mx-1">
                      {events.map((event) => (
                        <div key={event.id} className="flex items-center gap-3 px-1 py-2 border-b border-border last:border-0">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorForAction(event.action) }} />
                          <span className="text-xs font-medium text-muted shrink-0 w-40 truncate">{actionLabel(event.action)}</span>
                          <span className="text-sm flex-1 min-w-0 truncate">
                            {event.actor_name || event.actor_email || "Someone"}
                            {eventDescription(event) && <span className="text-muted"> &middot; {eventDescription(event)}</span>}
                          </span>
                          <span className="text-xs text-muted shrink-0">{timeAgo(event.created_at)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {events !== null && totalEvents > 0 && (
                  <div className="flex items-center justify-between mt-3">
                    <div className="text-xs text-muted">
                      Page {page} of {totalPages} &middot; {totalEvents} event(s)
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="btn-secondary text-xs disabled:opacity-50"
                        disabled={page <= 1}
                        onClick={() => changePage(page - 1)}
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        className="btn-secondary text-xs disabled:opacity-50"
                        disabled={page >= totalPages}
                        onClick={() => changePage(page + 1)}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
