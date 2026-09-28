import { useEffect, useMemo, useState } from "react";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { DashboardSchedule, JobRun, RefreshInterval, jobsApi } from "../api/client";

// 2026-09-28 (scheduled auto-refresh + background jobs round): the real,
// honest home for both new features at once - closes the exact gap
// backend/app/models.py's own DashboardBlock.data_updated_at comment
// names plainly: "this app has no auto-refreshing data pipeline; a
// block's numbers only change when someone rebuilds them." This page is
// where a dashboard's numbers can now be told to rebuild themselves on a
// schedule, and where every run (scheduled or clicked) is logged so
// nothing about "is this actually refreshing" is ever a guess.
//
// Two tables:
//   - "Scheduled refreshes": one row per Dashboard Builder dashboard this
//     person can see, its refresh interval (a plain select - see
//     RefreshInterval), its most recent run's status, and "Run now".
//   - "Recent runs": the full run history (backend models.JobRun) across
//     every one of those dashboards, newest first, sortable, paginated -
//     the audit trail proving a refresh genuinely ran rather than just
//     being configured.
//
// The one real limitation this round intentionally does NOT hide (see
// backend services/scheduler.py's own module docstring for the full
// explanation): this only runs while GD360's own server process is
// awake. A short note says so in plain language below, rather than
// implying a guarantee this app's hosting can't actually make.

const REFRESH_LABELS: Record<RefreshInterval, string> = {
  off: "Off",
  "15m": "Every 15 minutes",
  "1h": "Every hour",
  "6h": "Every 6 hours",
  daily: "Once a day",
};

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function formatRelativeFuture(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "due now";
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  return `in ${days}d`;
}

function formatRelativePast(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function StatusPill({ status }: { status: "running" | "success" | "failed" | null }) {
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-surface2 text-muted">
        <span className="w-1.5 h-1.5 rounded-full bg-muted" />
        Never run
      </span>
    );
  }
  const cfg =
    status === "success"
      ? { cls: "bg-green-500/10 text-green-600 dark:text-green-400", dot: "bg-green-500", label: "Success" }
      : status === "running"
      ? { cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400", dot: "bg-blue-500 animate-pulse", label: "Running" }
      : { cls: "bg-red-500/10 text-red-500 dark:text-red-400", dot: "bg-red-500", label: "Failed" };
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full ${cfg.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

type RunSortKey = "target_label" | "source_label" | "status" | "duration_seconds" | "next_run_at";

export default function Jobs() {
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();

  const [schedules, setSchedules] = useState<DashboardSchedule[] | null>(null);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsPage, setRunsPage] = useState(1);
  const RUNS_PAGE_SIZE = 20;

  const [sortKey, setSortKey] = useState<RunSortKey>("target_label");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const loadSchedules = () => {
    jobsApi
      .listSchedules()
      .then(setSchedules)
      .catch(() => setError("Couldn't load your scheduled refreshes. Please try refreshing."));
  };

  const loadRuns = (page: number) => {
    jobsApi
      .listRuns(page, RUNS_PAGE_SIZE)
      .then((data) => {
        setRuns(data.runs);
        setRunsTotal(data.total);
      })
      .catch(() => setError("Couldn't load the run history. Please try refreshing."));
  };

  useEffect(loadSchedules, []);
  useEffect(() => loadRuns(runsPage), [runsPage]);

  const changeInterval = async (dashboardId: string, interval: RefreshInterval) => {
    setSavingId(dashboardId);
    setError("");
    try {
      const updated = await jobsApi.updateSchedule(dashboardId, interval);
      setSchedules((prev) => (prev || []).map((s) => (s.dashboard_id === dashboardId ? updated : s)));
    } catch {
      setError("Couldn't update that schedule. Please try again.");
    } finally {
      setSavingId(null);
    }
  };

  const runNow = async (dashboardId: string) => {
    setRunningId(dashboardId);
    setError("");
    try {
      await jobsApi.runNow(dashboardId);
      // Refresh both tables - the schedule row's own "last run"/"next run"
      // just changed, and this run now belongs at the top of the history.
      loadSchedules();
      setRunsPage(1);
      loadRuns(1);
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't run this dashboard's refresh. Please try again.");
    } finally {
      setRunningId(null);
    }
  };

  const toggleSort = (key: RunSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };
  const sortArrow = (key: RunSortKey) => (key === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  const sortedRuns = useMemo(() => {
    const list = [...(runs || [])];
    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      let av: string | number = "";
      let bv: string | number = "";
      switch (sortKey) {
        case "duration_seconds":
          av = a.duration_seconds ?? -1;
          bv = b.duration_seconds ?? -1;
          break;
        case "next_run_at":
          av = a.next_run_at || "";
          bv = b.next_run_at || "";
          break;
        default:
          av = (a[sortKey] as string) || "";
          bv = (b[sortKey] as string) || "";
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return list;
  }, [runs, sortKey, sortDir]);

  const runsTotalPages = Math.max(1, Math.ceil(runsTotal / RUNS_PAGE_SIZE));

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
            <h1 className="text-2xl font-bold tracking-tight">Jobs</h1>
            <p className="text-sm text-muted mt-1 max-w-2xl">
              Set a dashboard to refresh itself automatically, or run it right now. A refresh recomputes
              every block that can be recomputed unattended - the exact same computation "Ask AI" and
              "Build manually" already run by hand, just on a timer.
            </p>
            {/* The honest limitation, stated plainly rather than left
                implicit - see backend services/scheduler.py's own module
                docstring for the full explanation. */}
            <p className="text-xs text-muted mt-2 max-w-2xl">
              Scheduled refreshes only run while GD360&rsquo;s own server is awake. If it&rsquo;s been idle
              for a while, the next scheduled run may fire a little late instead of exactly on time.
            </p>
          </div>

          {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">{error}</div>}

          <div className="mb-4 font-semibold text-sm">Scheduled refreshes</div>
          {schedules === null && !error && <div className="text-sm text-muted">Loading…</div>}
          {schedules !== null && schedules.length === 0 && (
            <div className="dash-card p-8 text-center mb-10">
              <div className="text-sm text-muted leading-relaxed">
                You don&rsquo;t have any Dashboard Builder dashboards yet - build one from a Project&rsquo;s
                chat first, then come back here to schedule it.
              </div>
            </div>
          )}
          {schedules !== null && schedules.length > 0 && (
            <div className="card overflow-x-auto mb-10">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted border-b border-border select-none">
                    <th className="p-2">Job</th>
                    <th className="p-2">Source</th>
                    <th className="p-2">Schedule</th>
                    <th className="p-2">Status</th>
                    <th className="p-2">Duration</th>
                    <th className="p-2">Next run</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((s) => (
                    <tr key={s.dashboard_id} className="border-b border-border last:border-0">
                      <td className="p-2 font-medium truncate max-w-[160px]" title={s.dashboard_name}>
                        {s.dashboard_name}
                      </td>
                      <td className="p-2 text-muted truncate max-w-[140px]" title={s.source_label || undefined}>
                        {s.source_label || "—"}
                      </td>
                      <td className="p-2">
                        <select
                          className="text-xs bg-surface2 border border-border rounded-md px-2 py-1.5 cursor-pointer disabled:opacity-50"
                          value={s.refresh_interval}
                          disabled={!s.can_edit || savingId === s.dashboard_id}
                          onChange={(e) => changeInterval(s.dashboard_id, e.target.value as RefreshInterval)}
                        >
                          {(Object.keys(REFRESH_LABELS) as RefreshInterval[]).map((k) => (
                            <option key={k} value={k}>{REFRESH_LABELS[k]}</option>
                          ))}
                        </select>
                      </td>
                      <td className="p-2">
                        <StatusPill status={s.last_run_status} />
                        {s.last_run_status === "failed" && s.last_run_error && (
                          <div className="text-[11px] text-red-400 mt-1 max-w-[220px] truncate" title={s.last_run_error}>
                            {s.last_run_error}
                          </div>
                        )}
                      </td>
                      <td className="p-2 text-muted">{formatDuration(s.last_run_duration_seconds)}</td>
                      <td className="p-2 text-muted" title={s.next_refresh_at ? new Date(s.next_refresh_at).toLocaleString() : undefined}>
                        {s.refresh_interval === "off" ? "—" : formatRelativeFuture(s.next_refresh_at)}
                      </td>
                      <td className="p-2 text-right">
                        <button
                          type="button"
                          className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border hover:bg-surface2 transition disabled:opacity-50 whitespace-nowrap"
                          disabled={!s.can_edit || runningId === s.dashboard_id}
                          onClick={() => runNow(s.dashboard_id)}
                        >
                          {runningId === s.dashboard_id ? "Running…" : "Run now"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mb-4 font-semibold text-sm">Recent runs</div>
          {runs === null && !error && <div className="text-sm text-muted">Loading…</div>}
          {runs !== null && runs.length === 0 && (
            <div className="dash-card p-8 text-center">
              <div className="text-sm text-muted">No refreshes have run yet - turn on a schedule above, or click "Run now".</div>
            </div>
          )}
          {runs !== null && runs.length > 0 && (
            <>
              <div className="card overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted border-b border-border select-none">
                      <th className="p-2 cursor-pointer hover:text-fg" onClick={() => toggleSort("target_label")}>
                        Job{sortArrow("target_label")}
                      </th>
                      <th className="p-2 cursor-pointer hover:text-fg" onClick={() => toggleSort("source_label")}>
                        Source{sortArrow("source_label")}
                      </th>
                      <th className="p-2 cursor-pointer hover:text-fg" onClick={() => toggleSort("status")}>
                        Status{sortArrow("status")}
                      </th>
                      <th className="p-2 cursor-pointer hover:text-fg" onClick={() => toggleSort("duration_seconds")}>
                        Duration{sortArrow("duration_seconds")}
                      </th>
                      <th className="p-2 cursor-pointer hover:text-fg" onClick={() => toggleSort("next_run_at")}>
                        Next run{sortArrow("next_run_at")}
                      </th>
                      <th className="p-2">Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRuns.map((r) => (
                      <tr key={r.id} className="border-b border-border last:border-0">
                        <td className="p-2 font-medium truncate max-w-[160px]" title={r.target_label}>
                          {r.target_label}
                          <span className="ml-1.5 text-[10px] text-muted uppercase tracking-wide">
                            {r.job_type === "manual_refresh" ? "manual" : "scheduled"}
                          </span>
                        </td>
                        <td className="p-2 text-muted truncate max-w-[140px]" title={r.source_label || undefined}>
                          {r.source_label || "—"}
                        </td>
                        <td className="p-2">
                          <StatusPill status={r.status} />
                          {r.status === "failed" && r.error_message && (
                            <div className="text-[11px] text-red-400 mt-1 max-w-[220px] truncate" title={r.error_message}>
                              {r.error_message}
                            </div>
                          )}
                        </td>
                        <td className="p-2 text-muted">{formatDuration(r.duration_seconds)}</td>
                        <td className="p-2 text-muted" title={r.next_run_at ? new Date(r.next_run_at).toLocaleString() : undefined}>
                          {formatRelativeFuture(r.next_run_at)}
                        </td>
                        <td className="p-2 text-muted" title={new Date(r.started_at).toLocaleString()}>
                          {formatRelativePast(r.started_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {runsTotalPages > 1 && (
                <div className="flex items-center justify-center gap-3 mt-4 text-sm text-muted">
                  <button
                    type="button"
                    className="px-3 py-1.5 rounded-lg border border-border hover:bg-surface2 transition disabled:opacity-40"
                    disabled={runsPage <= 1}
                    onClick={() => setRunsPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </button>
                  <span>
                    Page {runsPage} of {runsTotalPages}
                  </span>
                  <button
                    type="button"
                    className="px-3 py-1.5 rounded-lg border border-border hover:bg-surface2 transition disabled:opacity-40"
                    disabled={runsPage >= runsTotalPages}
                    onClick={() => setRunsPage((p) => Math.min(runsTotalPages, p + 1))}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
