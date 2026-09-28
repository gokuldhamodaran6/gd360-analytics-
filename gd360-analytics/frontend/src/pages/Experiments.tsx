import { useEffect, useState } from "react";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { Experiment, ExperimentStats, ExperimentVariantStats, experimentsApi } from "../api/client";
import CreateExperimentModal, { CopyField } from "../components/CreateExperimentModal";

// Phase 4 (2026-09-28, "Replacing the Data Team" roadmap - "A/B test
// design, assignment, and tracking"): the Experiments page. Laid out as a
// card-per-experiment grid (pages/Models.tsx's own layout - a card grid
// reads better here than Jobs.tsx's row-per-item table, since each
// experiment needs real vertical room for two KPI mini-cards side by
// side, a significance badge, and - while running - its own pair of
// copyable public URLs, none of which fit a single table row cleanly).
// The "New experiment" button opens CreateExperimentModal.tsx, the exact
// 3-step (metric -> variants -> launch) wizard the roadmap spec calls
// for, modeled on components/BuildDashboardModal.tsx.
//
// Every count and percentage on every card comes straight from the
// backend's own live computation (routers/experiments.py's
// _experiment_stats, backed by services/experiments_stats.
// compute_experiment_stats) - never something this page derives, guesses,
// or fabricates on its own.

function FlaskIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6M10 3v6.5L4.8 18a1.6 1.6 0 0 0 1.4 2.4h11.6a1.6 1.6 0 0 0 1.4-2.4L14 9.5V3" />
      <path d="M7.5 15h9" />
    </svg>
  );
}

// A local copy of Jobs.tsx's own StatusPill styling (identical
// inline-flex/dot classes) rather than an import - Jobs.tsx doesn't
// export it, and an Experiment only ever has two states anyway (see
// models.Experiment's own docstring: "running" | "stopped", no "draft"
// and no third state), so this is a smaller, two-way version of the same
// visual pattern rather than a reused component.
function StatusPill({ status }: { status: "running" | "stopped" }) {
  const cfg =
    status === "running"
      ? { cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400", dot: "bg-blue-500 animate-pulse", label: "Running" }
      : { cls: "bg-surface2 text-muted", dot: "bg-muted", label: "Stopped" };
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full ${cfg.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function SignificanceBadge({ stats }: { stats: ExperimentStats }) {
  if (stats.insufficient_data) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-surface2 text-muted">
        <span className="w-1.5 h-1.5 rounded-full bg-muted" />
        Not enough data
      </span>
    );
  }
  if (stats.is_significant) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-green-500/10 text-green-600 dark:text-green-400">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
        Significant
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-surface2 text-muted">
      <span className="w-1.5 h-1.5 rounded-full bg-muted" />
      Not yet significant
    </span>
  );
}

function TrashIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

function formatPercent(rate: number | null): string {
  // null means "undefined" (zero visitors assigned to this variant yet),
  // never a fabricated 0% - see backend services/experiments_stats.py's
  // own docstring for the same rule applied server-side.
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function VariantMiniCard({ label, stats }: { label: string; stats: ExperimentVariantStats }) {
  return (
    <div className="rounded-xl border border-border bg-surface2/60 p-3 min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted truncate" title={label}>
        {label}
      </div>
      <div className="dash-kpi-value text-xl font-bold mt-1">{formatPercent(stats.conversion_rate)}</div>
      <div className="text-[11px] text-muted mt-0.5">
        {stats.converted_count.toLocaleString()} / {stats.assigned_count.toLocaleString()} converted
      </div>
    </div>
  );
}

function ExperimentCard({
  experiment,
  busy,
  onStop,
  onDelete,
}: {
  experiment: Experiment;
  busy: boolean;
  onStop: () => void;
  onDelete: () => void;
}) {
  const { stats } = experiment;
  return (
    <div className="dash-card p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5 min-w-0">
          <span className="dash-icon-chip dash-accent-3 shrink-0">
            <FlaskIcon />
          </span>
          <div className="min-w-0">
            <div className="font-semibold text-sm truncate" title={experiment.name}>
              {experiment.name}
            </div>
            <div className="text-xs text-muted mt-0.5 truncate" title={experiment.metric_name}>
              Measuring: {experiment.metric_name}
            </div>
          </div>
        </div>
        <StatusPill status={experiment.status} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <VariantMiniCard label={stats.variant_a.variant_name} stats={stats.variant_a} />
        <VariantMiniCard label={stats.variant_b.variant_name} stats={stats.variant_b} />
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <SignificanceBadge stats={stats} />
        {stats.p_value !== null && <span className="text-[11px] text-muted">p = {stats.p_value.toFixed(4)}</span>}
      </div>

      {experiment.status === "running" && (
        <div className="space-y-2 pt-2 border-t border-border">
          <CopyField label="Assignment URL" value={experiment.assign_url} />
          <CopyField label="Conversion URL" value={experiment.convert_url} />
        </div>
      )}

      {experiment.can_edit && (
        <div className="flex items-center gap-2 pt-1">
          {experiment.status === "running" && (
            <button
              type="button"
              className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border hover:bg-surface2 transition disabled:opacity-50"
              disabled={busy}
              onClick={onStop}
            >
              {busy ? "Stopping…" : "Stop experiment"}
            </button>
          )}
          <button
            type="button"
            className="ml-auto text-muted hover:text-red-500 transition disabled:opacity-40 p-1.5 rounded-lg hover:bg-red-500/10"
            disabled={busy}
            onClick={onDelete}
            aria-label="Delete experiment"
            title="Delete experiment"
          >
            <TrashIcon />
          </button>
        </div>
      )}
    </div>
  );
}

export default function Experiments() {
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [experiments, setExperiments] = useState<Experiment[] | null>(null);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const load = () => {
    experimentsApi
      .list()
      .then(setExperiments)
      .catch(() => setError("Couldn't load your experiments. Please try refreshing."));
  };

  useEffect(load, []);

  const stopExperiment = async (id: string) => {
    setActioningId(id);
    setError("");
    try {
      const updated = await experimentsApi.setStatus(id, "stopped");
      setExperiments((prev) => (prev || []).map((e) => (e.id === id ? updated : e)));
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't stop this experiment. Please try again.");
    } finally {
      setActioningId(null);
    }
  };

  const deleteExperiment = async (id: string) => {
    if (!window.confirm("Delete this experiment? This can't be undone.")) return;
    setActioningId(id);
    setError("");
    try {
      await experimentsApi.delete(id);
      setExperiments((prev) => (prev || []).filter((e) => e.id !== id));
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't delete this experiment. Please try again.");
    } finally {
      setActioningId(null);
    }
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
          <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Experiments</h1>
              <p className="text-sm text-muted mt-1 max-w-2xl">
                Design an A/B test, get a ready-to-embed pair of URLs for your own website, and watch
                real-time results here - a clean 50/50 split with a real significance check, never a guess.
              </p>
            </div>
            <button type="button" className="btn-primary text-sm shrink-0" onClick={() => setModalOpen(true)}>
              New experiment
            </button>
          </div>

          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">{error}</div>
          )}

          {experiments === null && !error && <div className="text-sm text-muted">Loading&hellip;</div>}

          {experiments !== null && experiments.length === 0 && (
            <div className="dash-card p-8 text-center">
              <div className="text-sm text-muted mb-1 leading-relaxed">No experiments yet.</div>
              <div className="text-xs text-muted leading-relaxed max-w-md mx-auto">
                Click &ldquo;New experiment&rdquo; to design an A/B test - pick a metric, name your two
                variants, and launch. You&rsquo;ll get two URLs to call from your own website&rsquo;s code.
              </div>
            </div>
          )}

          {experiments !== null && experiments.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {experiments.map((exp) => (
                <ExperimentCard
                  key={exp.id}
                  experiment={exp}
                  busy={actioningId === exp.id}
                  onStop={() => stopExperiment(exp.id)}
                  onDelete={() => deleteExperiment(exp.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <CreateExperimentModal open={modalOpen} onClose={() => setModalOpen(false)} onCreated={load} />
    </div>
  );
}
