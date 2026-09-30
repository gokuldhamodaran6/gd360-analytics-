import { CSSProperties, useEffect, useMemo, useState } from "react";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
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
//
// 2026-09-30 (Gokul's own bug report - "not structurally designed and
// looks very bad"): redesigned around this app's own established
// dashboard-tile visual language (.dash-card/.dash-icon-chip/--dash-accent-N
// - see index.css and pages/Landing.tsx for the same components used
// elsewhere) instead of a single plain HTML table with no visual
// hierarchy. Every number on this page is still computed purely from the
// same governanceApi.overview/auditLog responses the old version already
// fetched - nothing new is fabricated, this only changes how it's laid
// out and grouped. Backend (routers/governance.py) is completely
// untouched - it already returned everything this redesign needs.

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

// Groups every real audit action into one of a few broad categories, so
// the audit log can show a meaningful icon per entry instead of a bare
// colored dot - purely a presentation grouping, every action string above
// still gets its own real label underneath.
type ActionCategory = "access" | "data" | "dashboard" | "quality" | "review" | "activity";

const ACTION_CATEGORY: Record<string, ActionCategory> = {
  login: "activity",
  signup: "activity",
  workspace_created: "access",
  member_role_changed: "access",
  member_joined: "access",
  datasource_connected: "data",
  datasource_deleted: "data",
  dashboard_created: "dashboard",
  dashboard_deleted: "dashboard",
  quality_rule_created: "quality",
  quality_rule_deleted: "quality",
  governance_review_marked: "review",
};

// A small, stable accent index keyed off the action string itself (rather
// than a fixed per-action map) so an unmapped/future action still gets a
// real, consistent accent instead of falling back to nothing.
function accentForAction(action: string): number {
  let hash = 0;
  for (let i = 0; i < action.length; i++) hash = (hash * 31 + action.charCodeAt(i)) >>> 0;
  return hash % 6;
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

// A real calendar-day label for the audit log's grouping - "Today"/
// "Yesterday" for the two most recent days, a real date otherwise. Purely
// a display grouping of the same events array the backend already sent;
// no new data is fetched or computed beyond a date comparison.
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function ShieldIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 9.5-4-1.3-7-5-7-9.5V6l7-3z" />
      <path d="M9.5 12l1.8 1.8L15 10" />
    </svg>
  );
}

function DatabaseIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </svg>
  );
}

function CheckCircleIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.3 2.3 4.7-5" />
    </svg>
  );
}

function AlertIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 9.5-4-1.3-7-5-7-9.5V6l7-3z" />
      <path d="M12 8v5M12 16h.01" />
    </svg>
  );
}

function UsersIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="17" cy="9" r="2.3" />
      <path d="M16 14.2c2.3.4 4 2.4 4 4.8" />
    </svg>
  );
}

function GridIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <rect x="7" y="12" width="3" height="6" rx="0.5" />
      <rect x="13" y="8" width="3" height="10" rx="0.5" />
      <rect x="18" y="5" width="3" height="13" rx="0.5" />
    </svg>
  );
}

function QualityIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.3 2.3 4.7-5" />
    </svg>
  );
}

function ActivityIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

const CATEGORY_ICON: Record<ActionCategory, (p: { className?: string }) => JSX.Element> = {
  access: UsersIcon,
  data: DatabaseIcon,
  dashboard: GridIcon,
  quality: QualityIcon,
  review: CheckCircleIcon,
  activity: ActivityIcon,
};

function SearchIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function accentStyle(idx: number): CSSProperties {
  return { "--dash-card-accent-color": `rgb(var(--dash-accent-${idx}))` } as CSSProperties;
}

function GovStatTile({
  icon,
  accent,
  label,
  value,
  tone,
}: {
  icon: JSX.Element;
  accent: number;
  label: string;
  value: string | number;
  tone?: "warn";
}) {
  return (
    <div className="dash-card dash-card--accented p-3.5" style={accentStyle(accent)}>
      <div className={`dash-icon-chip dash-icon-chip--sm dash-accent-${accent} mb-2.5`}>{icon}</div>
      <div className={`text-xl font-bold tracking-tight ${tone === "warn" ? "text-amber-500 dark:text-amber-400" : ""}`}>{value}</div>
      <div className="text-xs text-muted mt-0.5">{label}</div>
    </div>
  );
}

function ReviewStatusPill({ reviewedAt, reviewedBy }: { reviewedAt: string | null; reviewedBy: string | null }) {
  if (!reviewedAt) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        Never reviewed
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      title={reviewedBy ? `By ${reviewedBy}` : undefined}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
      Reviewed {timeAgo(reviewedAt)}
    </span>
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
  const [accessQuery, setAccessQuery] = useState("");

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
    setAccessQuery("");
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

  // Every number here is computed purely from the two arrays already
  // fetched above - nothing new is requested or fabricated.
  const stats = useMemo(() => {
    const list = datasources || [];
    const reviewed = list.filter((d) => d.governance_last_reviewed_at).length;
    const needsReview = list.length - reviewed;
    const memberCount = list[0]?.member_access.length ?? 0;
    return { total: list.length, reviewed, needsReview, memberCount };
  }, [datasources]);

  // Never-reviewed first, then longest-overdue, then alphabetical - so the
  // things most worth a founder's attention surface at the top instead of
  // being buried in whatever order the API happened to return. Client-side
  // name filter on top, same debounce-free instant pattern the rest of
  // this app's small search boxes use.
  const sortedDatasources = useMemo(() => {
    const list = datasources || [];
    const q = accessQuery.trim().toLowerCase();
    const filtered = q ? list.filter((d) => d.name.toLowerCase().includes(q)) : list;
    return [...filtered].sort((a, b) => {
      if (!a.governance_last_reviewed_at && b.governance_last_reviewed_at) return -1;
      if (a.governance_last_reviewed_at && !b.governance_last_reviewed_at) return 1;
      if (a.governance_last_reviewed_at && b.governance_last_reviewed_at) {
        const diff = new Date(a.governance_last_reviewed_at).getTime() - new Date(b.governance_last_reviewed_at).getTime();
        if (diff !== 0) return diff;
      }
      return a.name.localeCompare(b.name);
    });
  }, [datasources, accessQuery]);

  // Groups the current audit-log page by real calendar day - purely a
  // client-side presentation grouping of the same paginated events array.
  const groupedEvents = useMemo(() => {
    const groups: { label: string; items: AuditEvent[] }[] = [];
    for (const event of events || []) {
      const label = dayLabel(event.created_at);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(event);
      else groups.push({ label, items: [event] });
    }
    return groups;
  }, [events]);

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

              {/* ---- Stat tiles - the same .dash-card/.dash-icon-chip
                  language every dashboard on this app already uses ---- */}
              {datasources !== null && datasources.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
                  <GovStatTile icon={<DatabaseIcon />} accent={0} label="Data sources" value={stats.total} />
                  <GovStatTile icon={<CheckCircleIcon />} accent={2} label="Reviewed" value={stats.reviewed} />
                  <GovStatTile
                    icon={<AlertIcon />}
                    accent={1}
                    label="Needs review"
                    value={stats.needsReview}
                    tone={stats.needsReview > 0 ? "warn" : undefined}
                  />
                  <GovStatTile icon={<UsersIcon />} accent={4} label="Team access" value={stats.memberCount} />
                </div>
              )}

              {/* ---- Access review ---- */}
              <div className="mb-8">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Access review</h2>
                  {datasources !== null && datasources.length > 0 && (
                    <div className="relative">
                      <SearchIcon className="w-3.5 h-3.5 text-muted absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        className="input input-icon-sm text-xs py-1.5 w-48"
                        placeholder="Search data sources…"
                        value={accessQuery}
                        onChange={(e) => setAccessQuery(e.target.value)}
                      />
                    </div>
                  )}
                </div>
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
                {datasources !== null && datasources.length > 0 && sortedDatasources.length === 0 && (
                  <div className="dash-card p-6 text-center text-sm text-muted">
                    No data sources match &ldquo;{accessQuery.trim()}&rdquo;.
                  </div>
                )}
                {sortedDatasources.length > 0 && (
                  <div className="dash-card overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-muted border-b border-border">
                          <th className="px-4 py-2.5 font-medium">Name</th>
                          <th className="px-4 py-2.5 font-medium">Who has access</th>
                          <th className="px-4 py-2.5 font-medium">Review status</th>
                          <th className="px-4 py-2.5 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedDatasources.map((ds) => (
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
                            <td className="px-4 py-3 whitespace-nowrap">
                              <ReviewStatusPill
                                reviewedAt={ds.governance_last_reviewed_at}
                                reviewedBy={ds.governance_last_reviewed_by}
                              />
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
                      {groupedEvents.map((group) => (
                        <div key={group.label} className="mb-3 last:mb-0">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted px-1 py-1">
                            {group.label}
                          </div>
                          {group.items.map((event) => {
                            const category = ACTION_CATEGORY[event.action] || "activity";
                            const Icon = CATEGORY_ICON[category];
                            const accent = accentForAction(event.action);
                            return (
                              <div key={event.id} className="flex items-center gap-3 px-1 py-2 border-b border-border last:border-0">
                                <span className={`dash-icon-chip dash-icon-chip--sm dash-accent-${accent} shrink-0`} style={accentStyle(accent)}>
                                  <Icon />
                                </span>
                                <span className="text-xs font-medium text-muted shrink-0 w-40 truncate">{actionLabel(event.action)}</span>
                                <span className="text-sm flex-1 min-w-0 truncate">
                                  {event.actor_name || event.actor_email || "Someone"}
                                  {eventDescription(event) && <span className="text-muted"> &middot; {eventDescription(event)}</span>}
                                </span>
                                <span className="text-xs text-muted shrink-0">{timeAgo(event.created_at)}</span>
                              </div>
                            );
                          })}
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
