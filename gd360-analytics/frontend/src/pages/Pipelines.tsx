import { useEffect, useMemo, useState } from "react";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import {
  datasourceApi,
  dashboardApi,
  pipelinesApi,
  DataSourceSummary,
  DashboardSummary,
  Pipeline,
  PipelineRun,
  PipelineStep,
  PipelineStepType,
  RefreshInterval,
} from "../api/client";

// 2026-09-30 (orchestration v1): the real, honest home for chained
// multi-step automation - closes the exact gap
// claude/gd360-competitive-gap-analysis-2026-09-29.md's own gap #5 names
// plainly: "no dependency graph, no multi-step chains, no backfill/
// replay." This page is where a person builds a small, named, LINEAR
// chain of a few whitelisted actions (refresh an API source, rebuild a
// dashboard, re-check quality rules) run strictly in order, on demand or
// on the same schedule vocabulary the Jobs page's dashboard refreshes
// already use.
//
// Deliberately a separate top-level page (not folded into the Jobs page)
// even though both are "background automation" - a Pipeline's steps can
// each target a DIFFERENT data source or dashboard, unlike a Job which is
// always scoped to exactly one dashboard, so the two features have
// genuinely different shapes even though they share one clock
// (services/scheduler.py's 60-second tick) under the hood.

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

function blankStep(type: PipelineStepType): PipelineStep {
  if (type === "rebuild_dashboard") return { type, dashboard_id: "" };
  return { type, datasource_id: "" } as PipelineStep;
}

type BuilderState = {
  id: string | null; // null = creating a new pipeline
  name: string;
  description: string;
  steps: PipelineStep[];
  schedule_interval: RefreshInterval;
};

const emptyBuilder: BuilderState = { id: null, name: "", description: "", steps: [], schedule_interval: "off" };

export default function Pipelines() {
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();

  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [datasources, setDatasources] = useState<DataSourceSummary[] | null>(null);
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null);
  const [error, setError] = useState("");

  const [builder, setBuilder] = useState<BuilderState | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runsByPipeline, setRunsByPipeline] = useState<Record<string, PipelineRun[]>>({});
  const [runsLoading, setRunsLoading] = useState<string | null>(null);

  const loadPipelines = () => {
    pipelinesApi
      .list()
      .then(setPipelines)
      .catch(() => setError("Couldn't load your pipelines. Please try refreshing."));
  };

  useEffect(loadPipelines, []);
  useEffect(() => {
    datasourceApi.list().then(setDatasources).catch(() => setDatasources([]));
    dashboardApi.list().then(setDashboards).catch(() => setDashboards([]));
  }, []);

  // Only "api"-kind sources have anything to refresh (see
  // services/pipelines._run_refresh_datasource_step's own check) - the
  // picker for that step type only offers those, rather than letting
  // someone pick a source whose refresh will always fail.
  const apiDatasources = useMemo(() => (datasources || []).filter((d) => d.kind === "api"), [datasources]);
  // Only layout_version===2 (Dashboard Builder) dashboards can be
  // rebuilt - the old flat chart-board kind has no pages/blocks for
  // services/scheduler.refresh_dashboard to recompute.
  const rebuildableDashboards = useMemo(
    () => (dashboards || []).filter((d) => d.layout_version === 2),
    [dashboards]
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
      loadPipelines();
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't save this pipeline. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const changeSchedule = async (p: Pipeline, interval: RefreshInterval) => {
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

  const runNow = async (p: Pipeline) => {
    setRunningId(p.id);
    setError("");
    try {
      await pipelinesApi.runNow(p.id);
      loadPipelines();
      if (expandedId === p.id) loadRuns(p.id);
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't run this pipeline. Please try again.");
    } finally {
      setRunningId(null);
    }
  };

  const deletePipeline = async (p: Pipeline) => {
    if (!window.confirm(`Delete "${p.name}"? This can't be undone.`)) return;
    setDeletingId(p.id);
    setError("");
    try {
      await pipelinesApi.delete(p.id);
      loadPipelines();
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't delete this pipeline. Please try again.");
    } finally {
      setDeletingId(null);
    }
  };

  const loadRuns = (pipelineId: string) => {
    setRunsLoading(pipelineId);
    pipelinesApi
      .listRuns(pipelineId, 1, 10)
      .then((page) => setRunsByPipeline((prev) => ({ ...prev, [pipelineId]: page.runs })))
      .catch(() => setError("Couldn't load this pipeline's run history."))
      .finally(() => setRunsLoading(null));
  };

  const toggleExpanded = (p: Pipeline) => {
    if (expandedId === p.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(p.id);
    if (!runsByPipeline[p.id]) loadRuns(p.id);
  };

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
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Pipelines</h1>
              <p className="text-sm text-muted mt-1 max-w-2xl">
                Chain a few steps together and run them in order - refresh a data source, then rebuild a
                dashboard so it sees the fresh data, then re-check that source's quality rules. Run it by
                hand, or put it on the same schedule Jobs uses.
              </p>
              <p className="text-xs text-muted mt-2 max-w-2xl">
                A chain stops at the first step that fails - later steps never run against a source that
                didn't refresh or a check that never happened. Same server-awake limitation as Jobs: a
                scheduled run may fire a little late if the server's been idle.
              </p>
            </div>
            {!builder && (
              <button
                type="button"
                className="text-sm font-medium px-4 py-2 rounded-lg bg-primary text-white hover:opacity-90 transition whitespace-nowrap"
                onClick={startCreate}
              >
                + New pipeline
              </button>
            )}
          </div>

          {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">{error}</div>}

          {builder && (
            <div className="card p-5 mb-8">
              <div className="font-semibold text-sm mb-3">{builder.id ? "Edit pipeline" : "New pipeline"}</div>
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
                        {(s.type === "refresh_datasource" ? apiDatasources : datasources || []).map((d) => (
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
                    className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border hover:bg-surface2 transition disabled:opacity-40"
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
                  className="text-sm font-medium px-4 py-2 rounded-lg bg-primary text-white hover:opacity-90 transition disabled:opacity-50"
                  disabled={!canSave || saving}
                  onClick={saveBuilder}
                >
                  {saving ? "Saving…" : builder.id ? "Save changes" : "Create pipeline"}
                </button>
                <button
                  type="button"
                  className="text-sm font-medium px-4 py-2 rounded-lg border border-border hover:bg-surface2 transition"
                  onClick={cancelBuilder}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {pipelines === null && !error && <div className="text-sm text-muted">Loading…</div>}
          {pipelines !== null && pipelines.length === 0 && !builder && (
            <div className="dash-card p-8 text-center">
              <div className="text-sm text-muted leading-relaxed">
                You don&rsquo;t have any pipelines yet. A pipeline is a small, named chain of steps - build
                one to automate what you&rsquo;d otherwise click through by hand.
              </div>
            </div>
          )}
          {pipelines !== null && pipelines.length > 0 && (
            <div className="flex flex-col gap-3">
              {pipelines.map((p) => (
                <div key={p.id} className="card p-4">
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
                        onChange={(e) => changeSchedule(p, e.target.value as RefreshInterval)}
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
                      className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border hover:bg-surface2 transition disabled:opacity-50"
                      disabled={!p.can_edit || runningId === p.id}
                      onClick={() => runNow(p)}
                    >
                      {runningId === p.id ? "Running…" : "Run now"}
                    </button>
                    <button
                      type="button"
                      className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border hover:bg-surface2 transition disabled:opacity-50"
                      disabled={!p.can_edit}
                      onClick={() => startEdit(p)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border hover:bg-surface2 transition"
                      onClick={() => toggleExpanded(p)}
                    >
                      {expandedId === p.id ? "Hide runs" : "Run history"}
                    </button>
                    {p.can_delete && (
                      <button
                        type="button"
                        className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/30 transition disabled:opacity-50 ml-auto"
                        disabled={deletingId === p.id}
                        onClick={() => deletePipeline(p)}
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
        </div>
      </div>
    </div>
  );
}
