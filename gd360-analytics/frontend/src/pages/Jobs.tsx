import { useEffect, useMemo, useState } from "react";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import {
  DashboardSchedule,
  JobRun,
  RefreshInterval,
  jobsApi,
  datasourceApi,
  dashboardApi,
  pipelinesApi,
  DataSourceSummary,
  DashboardSummary,
  Pipeline,
  PipelineRun,
  PipelineStep,
  PipelineStepType,
} from "../api/client";

// 2026-09-28 (scheduled auto-refresh + background jobs round): the real,
// honest home for both new features at once - closes the exact gap
// backend/app/models.py's own DashboardBlock.data_updated_at comment
// names plainly: "this app has no auto-refreshing data pipeline; a
// block's numbers only change when someone rebuilds them." This page is
// where a dashboard's numbers can now be told to rebuild themselves on a
// schedule, and where every run (scheduled or clicked) is logged so
// nothing about "is this actually refreshing" is ever a guess.
//
// 2026-09-30 (Gokul's own bug report - "jobs section also very badly
// structure... think about our customer design and make it more easy and
// attractive elite way", plus "pipeline... feature is not required...
// this is very repeated feature and leads to confusion"): redesigned
// around this app's own .dash-card/.dash-icon-chip stat-tile language
// (see index.css, pages/Landing.tsx), and the standalone Pipelines page's
// one real, non-redundant capability - named, multi-step chains, not just
// one dashboard's schedule - now lives here as a second "Chains" tab
// instead of its own separate top-level nav entry, so automation lives in
// exactly one place instead of two easily-confused ones. Every call this
// page makes (jobsApi.*, pipelinesApi.*) is completely unchanged from
// before - this only changes layout, not what's real or how it's
// computed.

const REFRESH_LABELS: Record<RefreshInterval, string> = {
  off: "Off",
  "15m": "Every 15 minutes",
  "1h": "Every hour",
  "6h": "Every 6 hours",
  daily: "Once a day",
};

const STEP_TYPE_LABELS: Record<PipelineStepType, string> = {
  refresh_datasource: "Refresh a data source",
  rebuild_dashboard: "Rebuild a dashboard",
  run_quality_checks: "Re-check quality rules",
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

function ClockIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

function ChainIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="12" r="2.3" />
      <circle cx="12" cy="6" r="2.3" />
      <circle cx="19" cy="12" r="2.3" />
      <circle cx="12" cy="18" r="2.3" />
      <path d="M7 12h10M9.6 7.6l2.9 2.9M14.4 7.6l-2.9 2.9M9.6 16.4l2.9-2.9M14.4 16.4l-2.9-2.9" />
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

function JobsStatTile({
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
    <div className="dash-card dash-card--accented p-3.5" style={{ "--dash-card-accent-color": `rgb(var(--dash-accent-${accent}))` } as any}>
      <div className={`dash-icon-chip dash-icon-chip--sm dash-accent-${accent} mb-2.5`}>{icon}</div>
      <div className={`text-xl font-bold tracking-tight ${tone === "warn" ? "text-red-500 dark:text-red-400" : ""}`}>{value}</div>
      <div className="text-xs text-muted mt-0.5">{label}</div>
    </div>
  );
}

type RunSortKey = "target_label" | "source_label" | "status" | "duration_seconds" | "next_run_at";
type JobsTab = "schedules" | "chains";

function blankStep(type: PipelineStepType): PipelineStep {
  if (type === "rebuild_dashboard") return { type, dashboard_id: "" };
  return { type, datasource_id: "" } as PipelineStep;
}

type BuilderState = {
  id: string | null; // null = creating a new chain
  name: string;
  description: string;
  steps: PipelineStep[];
  schedule_interval: RefreshInterval;
};

const emptyBuilder: BuilderState = { id: null, name: "", description: "", steps: [], schedule_interval: "off" };

export default function Jobs() {
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();

  const [tab, setTab] = useState<JobsTab>("schedules");

  // ---- Scheduled refreshes (per-dashboard) ----
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

  // ---- Chains (formerly the standalone Pipelines page) ----
  const [chainsLoaded, setChainsLoaded] = useState(false);
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [chainDatasources, setChainDatasources] = useState<DataSourceSummary[] | null>(null);
  const [chainDashboards, setChainDashboards] = useState<DashboardSummary[] | null>(null);

  const [builder, setBuilder] = useState<BuilderState | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState<string | null>(null);
  const [runningChainId, setRunningChainId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runsByPipeline, setRunsByPipeline] = useState<Record<string, PipelineRun[]>>({});
  const [runsLoading, setRunsLoading] = useState<string | null>(null);

  const loadChains = () => {
    pipelinesApi
      .list()
      .then(setPipelines)
      .catch(() => setError("Couldn't load your chains. Please try refreshing."));
  };

  // Lazy-loads only the first time the Chains tab is actually opened - no
  // point fetching pipelines/datasources/dashboards for someone who only
  // ever looks at Scheduled refreshes.
  useEffect(() => {
    if (tab !== "chains" || chainsLoaded) return;
    setChainsLoaded(true);
    loadChains();
    datasourceApi.list().then(setChainDatasources).catch(() => setChainDatasources([]));
    dashboardApi.list().then(setChainDashboards).catch(() => setChainDashboards([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, chainsLoaded]);

  const apiDatasources = useMemo(() => (chainDatasources || []).filter((d) => d.kind === "api"), [chainDatasources]);
  const rebuildableDashboards = useMemo(
    () => (chainDashboards || []).filter((d) => d.layout_version === 2),
    [chainDashboards]
  );

  const startCreate = () => {
    setBuilder({ ...emptyBuilder });
    setError("");
  };

  const startEdit = (p: Pipeline) => {
    setBuilder({ id: p.id, name: p.name, description: p.description || "", steps: p.steps, schedule_interval: p.schedule_interval });
    setError("");
  };

  const cancelBuilder = () => setBuilder(null);

  const addStep = (type: PipelineStepType) => {
    if (!builder) return;
    if (builder.steps.length >= 10) return;
    setBuilder({ ...builder, steps: [...builder.steps, blankStep(type)] });
  };

  const updateStep = (index: number, patch: Partial<PipelineStep>) => {
    if (!builder) return;
    const steps = builder.steps.map((s, i) => (i === index ? ({ ...s, ...patch } as PipelineStep) : s));
    setBuilder({ ...builder, steps });
  };

  const removeStep = (index: number) => {
    if (!builder) return;
    setBuilder({ ...builder, steps: builder.steps.filter((_, i) => i !== index) });
  };

  const moveStep = (index: number, dir: -1 | 1) => {
    if (!builder) return;
    const target = index + dir;
    if (target < 0 || target >= builder.steps.length) return;
    const steps = [...builder.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    setBuilder({ ...builder, steps });
  };

  const stepIsComplete = (s: PipelineStep): boolean => {
    if (s.type === "rebuild_dashboard") return !!s.dashboard_id;
    return !!s.datasource_id;
  };

  const canSave = !!builder && builder.name.trim().length > 0 && builder.steps.length > 0 && builder.steps.every(stepIsComplete);

  const saveBuilder = async () => {
    if (!builder || !canSave) return;
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: builder.name.trim(),
        description: builder.description.trim() || null,
        steps: builder.steps,
        schedule_interval: builder.schedule_interval,
      };
      if (builder.id) {
        await pipelinesApi.update(builder.id, payload);
      } else {
        await pipelinesApi.create(payload);
      }
      setBuilder(null);
      loadChains();
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't save this chain. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const changeChainSchedule = async (p: Pipeline, interval: RefreshInterval) => {
    setSavingSchedule(p.id);
    setError("");
    try {
      const updated = await pipelinesApi.update(p.id, { schedule_interval: interval });
      setPipelines((prev) => (prev || []).map((row) => (row.id === p.id ? updated : row)));
    } catch {
      setError("Couldn't update that schedule. Please try again.");
    } finally {
      setSavingSchedule(null);
    }
  };

  const runChainNow = async (p: Pipeline) => {
    setRunningChainId(p.id);
    setError("");
    try {
      await pipelinesApi.runNow(p.id);
      loadChains();
      if (expandedId === p.id) loadChainRuns(p.id);
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't run this chain. Please try again.");
    } finally {
      setRunningChainId(null);
    }
  };

  const deleteChain = async (p: Pipeline) => {
    if (!window.confirm(`Delete "${p.name}"? This can't be undone.`)) return;
    setDeletingId(p.id);
    setError("");
    try {
      await pipelinesApi.delete(p.id);
      loadChains();
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't delete this chain. Please try again.");
    } finally {
      setDeletingId(null);
    }
  };

  const loadChainRuns = (pipelineId: string) => {
    setRunsLoading(pipelineId);
    pipelinesApi
      .listRuns(pipelineId, 1, 10)
      .then((page) => setRunsByPipeline((prev) => ({ ...prev, [pipelineId]: page.runs })))
      .catch(() => setError("Couldn't load this chain's run history."))
      .finally(() => setRunsLoading(null));
  };

  const toggleExpanded = (p: Pipeline) => {
    if (expandedId === p.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(p.id);
    if (!runsByPipeline[p.id]) loadChainRuns(p.id);
  };

  // Combined stat row across both automation kinds - real counts computed
  // purely from the schedules/pipelines arrays already fetched, nothing
  // extra requested just to populate a tile.
  const stats = useMemo(() => {
    const activeSchedules = (schedules || []).filter((s) => s.refresh_interval !== "off").length;
    const activeChains = (pipelines || []).filter((p) => p.schedule_interval !== "off").length;
    const failedSchedules = (schedules || []).filter((s) => s.last_run_status === "failed").length;
    const failedChains = (pipelines || []).filter((p) => p.last_run_status === "failed").length;
    return {
      total: (schedules || []).length + (pipelines || []).length,
      active: activeSchedules + activeChains,
      failed: failedSchedules + failedChains,
      chains: (pipelines || []).length,
    };
  }, [schedules, pipelines]);

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
              Set a dashboard to refresh itself automatically, run it right now, or chain a few steps
              together to run in order - refresh a data source, then rebuild a dashboard, then re-check its
              quality rules.
            </p>
            <p className="text-xs text-muted mt-2 max-w-2xl">
              Both kinds of automation share the same clock: they only run while GD360&rsquo;s own server is
              awake. If it&rsquo;s been idle for a while, the next scheduled run may fire a little late
              instead of exactly on time.
            </p>
          </div>

          {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">{error}</div>}

          {/* ---- Combined stat row ---- */}
          {(schedules !== null && schedules.length > 0) || (pipelines !== null && pipelines.length > 0) ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <JobsStatTile icon={<ClockIcon />} accent={0} label="Total automations" value={stats.total} />
              <JobsStatTile icon={<CheckCircleIcon />} accent={2} label="Active" value={stats.active} />
              <JobsStatTile icon={<AlertIcon />} accent={5} label="Failed last run" value={stats.failed} tone={stats.failed > 0 ? "warn" : undefined} />
              <JobsStatTile icon={<ChainIcon />} accent={3} label="Chains" value={stats.chains} />
            </div>
          ) : null}

          {/* ---- Tab switcher ---- */}
          <div className="inline-flex items-center gap-1 p-1 mb-6 rounded-xl bg-surface2 border border-border">
            <button
              type="button"
              onClick={() => setTab("schedules")}
              aria-pressed={tab === "schedules"}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition ${
                tab === "schedules" ? "bg-primary text-on-primary shadow-sm" : "text-muted hover:text-text"
              }`}
            >
              <ClockIcon className="w-4 h-4" /> Scheduled refreshes
            </button>
            <button
              type="button"
              onClick={() => setTab("chains")}
              aria-pressed={tab === "chains"}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition ${
                tab === "chains" ? "bg-primary text-on-primary shadow-sm" : "text-muted hover:text-text"
              }`}
            >
              <ChainIcon className="w-4 h-4" /> Chains
            </button>
          </div>

          {/* ==================== Scheduled refreshes tab ==================== */}
          {tab === "schedules" && (
            <>
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
                <div className="dash-card overflow-x-auto mb-10">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-muted border-b border-border select-none">
                        <th className="p-3">Job</th>
                        <th className="p-3">Source</th>
                        <th className="p-3">Schedule</th>
                        <th className="p-3">Status</th>
                        <th className="p-3">Duration</th>
                        <th className="p-3">Next run</th>
                        <th className="p-3" />
                      </tr>
                    </thead>
                    <tbody>
                      {schedules.map((s) => (
                        <tr key={s.dashboard_id} className="border-b border-border last:border-0">
                          <td className="p-3 font-medium truncate max-w-[160px]" title={s.dashboard_name}>
                            {s.dashboard_name}
                          </td>
                          <td className="p-3 text-muted truncate max-w-[140px]" title={s.source_label || undefined}>
                            {s.source_label || "—"}
                          </td>
                          <td className="p-3">
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
                          <td className="p-3">
                            <StatusPill status={s.last_run_status} />
                            {s.last_run_status === "failed" && s.last_run_error && (
                              <div className="text-[11px] text-red-400 mt-1 max-w-[220px] truncate" title={s.last_run_error}>
                                {s.last_run_error}
                              </div>
                            )}
                          </td>
                          <td className="p-3 text-muted">{formatDuration(s.last_run_duration_seconds)}</td>
                          <td className="p-3 text-muted" title={s.next_refresh_at ? new Date(s.next_refresh_at).toLocaleString() : undefined}>
                            {s.refresh_interval === "off" ? "—" : formatRelativeFuture(s.next_refresh_at)}
                          </td>
                          <td className="p-3 text-right">
                            <button
                              type="button"
                              className="btn-secondary text-xs disabled:opacity-50 whitespace-nowrap"
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
                  <div className="dash-card overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-muted border-b border-border select-none">
                          <th className="p-3 cursor-pointer hover:text-fg" onClick={() => toggleSort("target_label")}>
                            Job{sortArrow("target_label")}
                          </th>
                          <th className="p-3 cursor-pointer hover:text-fg" onClick={() => toggleSort("source_label")}>
                            Source{sortArrow("source_label")}
                          </th>
                          <th className="p-3 cursor-pointer hover:text-fg" onClick={() => toggleSort("status")}>
                            Status{sortArrow("status")}
                          </th>
                          <th className="p-3 cursor-pointer hover:text-fg" onClick={() => toggleSort("duration_seconds")}>
                            Duration{sortArrow("duration_seconds")}
                          </th>
                          <th className="p-3 cursor-pointer hover:text-fg" onClick={() => toggleSort("next_run_at")}>
                            Next run{sortArrow("next_run_at")}
                          </th>
                          <th className="p-3">Started</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedRuns.map((r) => (
                          <tr key={r.id} className="border-b border-border last:border-0">
                            <td className="p-3 font-medium truncate max-w-[160px]" title={r.target_label}>
                              {r.target_label}
                              <span className="ml-1.5 text-[10px] text-muted uppercase tracking-wide">
                                {r.job_type === "manual_refresh" ? "manual" : "scheduled"}
                              </span>
                            </td>
                            <td className="p-3 text-muted truncate max-w-[140px]" title={r.source_label || undefined}>
                              {r.source_label || "—"}
                            </td>
                            <td className="p-3">
                              <StatusPill status={r.status} />
                              {r.status === "failed" && r.error_message && (
                                <div className="text-[11px] text-red-400 mt-1 max-w-[220px] truncate" title={r.error_message}>
                                  {r.error_message}
                                </div>
                              )}
                            </td>
                            <td className="p-3 text-muted">{formatDuration(r.duration_seconds)}</td>
                            <td className="p-3 text-muted" title={r.next_run_at ? new Date(r.next_run_at).toLocaleString() : undefined}>
                              {formatRelativeFuture(r.next_run_at)}
                            </td>
                            <td className="p-3 text-muted" title={new Date(r.started_at).toLocaleString()}>
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
                        className="btn-secondary text-xs disabled:opacity-40"
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
                        className="btn-secondary text-xs disabled:opacity-40"
                        disabled={runsPage >= runsTotalPages}
                        onClick={() => setRunsPage((p) => Math.min(runsTotalPages, p + 1))}
                      >
                        Next
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ==================== Chains tab (formerly Pipelines) ==================== */}
          {tab === "chains" && (
            <>
              <div className="mb-6 flex items-start justify-between gap-4">
                <p className="text-xs text-muted max-w-2xl">
                  A chain stops at the first step that fails - later steps never run against a source that
                  didn&rsquo;t refresh or a check that never happened.
                </p>
                {!builder && (
                  <button
                    type="button"
                    className="btn-primary text-sm px-4 py-2 whitespace-nowrap shrink-0"
                    onClick={startCreate}
                  >
                    + New chain
                  </button>
                )}
              </div>

              {builder && (
                <div className="dash-card p-5 mb-8">
                  <div className="font-semibold text-sm mb-3">{builder.id ? "Edit chain" : "New chain"}</div>
                  <div className="grid gap-3 mb-4">
                    <input
                      className="text-sm bg-surface2 border border-border rounded-lg px-3 py-2"
                      placeholder='Name (e.g. "Morning refresh")'
                      value={builder.name}
                      onChange={(e) => setBuilder({ ...builder, name: e.target.value })}
                      maxLength={200}
                    />
                    <textarea
                      className="text-sm bg-surface2 border border-border rounded-lg px-3 py-2 resize-none"
                      placeholder="What this chain does (optional)"
                      rows={2}
                      value={builder.description}
                      onChange={(e) => setBuilder({ ...builder, description: e.target.value })}
                    />
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted">Schedule:</span>
                      <select
                        className="text-xs bg-surface2 border border-border rounded-md px-2 py-1.5 cursor-pointer"
                        value={builder.schedule_interval}
                        onChange={(e) => setBuilder({ ...builder, schedule_interval: e.target.value as RefreshInterval })}
                      >
                        {(Object.keys(REFRESH_LABELS) as RefreshInterval[]).map((k) => (
                          <option key={k} value={k}>{REFRESH_LABELS[k]}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="text-xs font-medium text-muted mb-2">Steps (run in this order)</div>
                  {builder.steps.length === 0 && (
                    <div className="text-sm text-muted mb-3">No steps yet - add one below.</div>
                  )}
                  <div className="flex flex-col gap-2 mb-3">
                    {builder.steps.map((s, i) => (
                      <div key={i} className="flex items-center gap-2 bg-surface2 border border-border rounded-lg px-3 py-2">
                        <span className="text-xs text-muted w-5 shrink-0">{i + 1}.</span>
                        <span className="text-xs font-medium shrink-0">{STEP_TYPE_LABELS[s.type]}</span>
                        {s.type === "rebuild_dashboard" ? (
                          <select
                            className="text-xs bg-surface border border-border rounded-md px-2 py-1.5 cursor-pointer flex-1 min-w-0"
                            value={s.dashboard_id}
                            onChange={(e) => updateStep(i, { dashboard_id: e.target.value } as Partial<PipelineStep>)}
                          >
                            <option value="">Choose a dashboard…</option>
                            {rebuildableDashboards.map((d) => (
                              <option key={d.id} value={d.id}>{d.name}</option>
                            ))}
                          </select>
                        ) : (
                          <select
                            className="text-xs bg-surface border border-border rounded-md px-2 py-1.5 cursor-pointer flex-1 min-w-0"
                            value={(s as any).datasource_id}
                            onChange={(e) => updateStep(i, { datasource_id: e.target.value } as Partial<PipelineStep>)}
                          >
                            <option value="">Choose a data source…</option>
                            {(s.type === "refresh_datasource" ? apiDatasources : chainDatasources || []).map((d) => (
                              <option key={d.id} value={d.id}>{d.name}</option>
                            ))}
                          </select>
                        )}
                        <div className="flex items-center gap-1 shrink-0">
                          <button type="button" className="text-muted hover:text-fg px-1 disabled:opacity-30" disabled={i === 0} onClick={() => moveStep(i, -1)} title="Move up">▲</button>
                          <button type="button" className="text-muted hover:text-fg px-1 disabled:opacity-30" disabled={i === builder.steps.length - 1} onClick={() => moveStep(i, 1)} title="Move down">▼</button>
                          <button type="button" className="text-red-400 hover:text-red-500 px-1" onClick={() => removeStep(i)} title="Remove step">✕</button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {apiDatasources.length === 0 && (
                    <div className="text-xs text-muted mb-3">
                      You don&rsquo;t have any API-connected data sources yet, so a &ldquo;Refresh a data
                      source&rdquo; step has nothing to offer - connect one from Data Sources first if you want
                      that step type.
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2 mb-4">
                    {(Object.keys(STEP_TYPE_LABELS) as PipelineStepType[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        className="btn-secondary text-xs disabled:opacity-40"
                        disabled={builder.steps.length >= 10}
                        onClick={() => addStep(t)}
                      >
                        + {STEP_TYPE_LABELS[t]}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="btn-primary text-sm px-4 py-2 disabled:opacity-50"
                      disabled={!canSave || saving}
                      onClick={saveBuilder}
                    >
                      {saving ? "Saving…" : builder.id ? "Save changes" : "Create chain"}
                    </button>
                    <button type="button" className="btn-secondary text-sm px-4 py-2" onClick={cancelBuilder}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {pipelines === null && !error && <div className="text-sm text-muted">Loading…</div>}
              {pipelines !== null && pipelines.length === 0 && !builder && (
                <div className="dash-card p-8 text-center">
                  <div className="text-sm text-muted leading-relaxed">
                    You don&rsquo;t have any chains yet. A chain is a small, named sequence of steps - build
                    one to automate what you&rsquo;d otherwise click through by hand.
                  </div>
                </div>
              )}
              {pipelines !== null && pipelines.length > 0 && (
                <div className="flex flex-col gap-3">
                  {pipelines.map((p) => (
                    <div key={p.id} className="dash-card p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{p.name}</span>
                            <StatusPill status={p.last_run_status} />
                          </div>
                          {p.description && <div className="text-xs text-muted mt-1">{p.description}</div>}
                          <ol className="text-xs text-muted mt-2 list-decimal list-inside">
                            {p.step_summary.map((line, i) => (
                              <li key={i}>{line}</li>
                            ))}
                          </ol>
                        </div>
                        <div className="flex flex-col items-end gap-2 shrink-0">
                          <select
                            className="text-xs bg-surface2 border border-border rounded-md px-2 py-1.5 cursor-pointer disabled:opacity-50"
                            value={p.schedule_interval}
                            disabled={!p.can_edit || savingSchedule === p.id}
                            onChange={(e) => changeChainSchedule(p, e.target.value as RefreshInterval)}
                          >
                            {(Object.keys(REFRESH_LABELS) as RefreshInterval[]).map((k) => (
                              <option key={k} value={k}>{REFRESH_LABELS[k]}</option>
                            ))}
                          </select>
                          {p.schedule_interval !== "off" && (
                            <span className="text-[11px] text-muted" title={p.next_run_at ? new Date(p.next_run_at).toLocaleString() : undefined}>
                              Next: {formatRelativeFuture(p.next_run_at)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-3">
                        <button
                          type="button"
                          className="btn-secondary text-xs disabled:opacity-50"
                          disabled={!p.can_edit || runningChainId === p.id}
                          onClick={() => runChainNow(p)}
                        >
                          {runningChainId === p.id ? "Running…" : "Run now"}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary text-xs disabled:opacity-50"
                          disabled={!p.can_edit}
                          onClick={() => startEdit(p)}
                        >
                          Edit
                        </button>
                        <button type="button" className="btn-secondary text-xs" onClick={() => toggleExpanded(p)}>
                          {expandedId === p.id ? "Hide runs" : "Run history"}
                        </button>
                        {p.can_delete && (
                          <button
                            type="button"
                            className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/30 transition disabled:opacity-50 ml-auto"
                            disabled={deletingId === p.id}
                            onClick={() => deleteChain(p)}
                          >
                            {deletingId === p.id ? "Deleting…" : "Delete"}
                          </button>
                        )}
                      </div>

                      {expandedId === p.id && (
                        <div className="mt-3 pt-3 border-t border-border">
                          {runsLoading === p.id && <div className="text-xs text-muted">Loading…</div>}
                          {runsLoading !== p.id && (runsByPipeline[p.id] || []).length === 0 && (
                            <div className="text-xs text-muted">No runs yet.</div>
                          )}
                          {runsLoading !== p.id && (runsByPipeline[p.id] || []).length > 0 && (
                            <div className="flex flex-col gap-2">
                              {(runsByPipeline[p.id] || []).map((r) => (
                                <div key={r.id} className="text-xs bg-surface2 rounded-lg px-3 py-2">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <StatusPill status={r.status} />
                                    <span className="text-muted uppercase tracking-wide text-[10px]">{r.run_type}</span>
                                    <span className="text-muted">{formatDuration(r.duration_seconds)}</span>
                                    <span className="text-muted ml-auto" title={new Date(r.started_at).toLocaleString()}>
                                      {formatRelativePast(r.started_at)}
                                    </span>
                                  </div>
                                  {r.step_results.length > 0 && (
                                    <ol className="mt-1.5 list-decimal list-inside">
                                      {r.step_results.map((sr) => (
                                        <li key={sr.index} className={sr.status === "failed" ? "text-red-400" : "text-muted"}>
                                          {sr.label ? `${STEP_TYPE_LABELS[(sr.type as PipelineStepType) || "refresh_datasource"] || sr.type} — ${sr.label}` : sr.type}
                                          {sr.status === "failed" && sr.error ? `: ${sr.error}` : ""}
                                        </li>
                                      ))}
                                    </ol>
                                  )}
                                  {r.error_message && r.status === "failed" && r.step_results.length === 0 && (
                                    <div className="text-red-400 mt-1">{r.error_message}</div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
