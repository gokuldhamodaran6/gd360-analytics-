import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { mlModelsApi, MLModel } from "../api/client";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { plainLanguageSummary, statusLabel, timeAgo } from "../lib/mlModelText";
import TrainModelWizard from "../components/TrainModelWizard";

// 2026-09-28 (ML Models round): the /ml-models gallery page - the real ML
// feature, deliberately never called just "Models" anywhere in this app
// (see models.MLModel's own backend docstring for why - routers/
// models_library.py's /models page, pages/Models.tsx, renders right next
// to this one in the sidebar under its now-renamed "Saved Tables" label,
// and is a completely different thing: promoted, reusable data TABLES,
// nothing to do with machine learning).
//
// Mirrors pages/Models.tsx's own card-gallery visual style
// (.dash-card/.dash-icon-chip/.dash-accent-N - reusable primitives already
// in index.css, see that page's own comment) rather than inventing new
// visual language for one more card grid - every ML Models card just
// carries a status pill and a real, computed plain-language sentence
// instead of a shared-model's step/row-count chips.

function SparkleNodesIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="4.5" cy="6" r="1.6" />
      <circle cx="19.5" cy="6" r="1.6" />
      <circle cx="4.5" cy="18" r="1.6" />
      <circle cx="19.5" cy="18" r="1.6" />
      <path d="M9.9 10.3L6 7.3M14.1 10.3L18 7.3M9.9 13.7L6 16.7M14.1 13.7L18 16.7" />
    </svg>
  );
}

const ACCENT_CLASSES = ["dash-accent-0", "dash-accent-1", "dash-accent-2", "dash-accent-3", "dash-accent-4", "dash-accent-5"];

function StatusPill({ status }: { status: MLModel["status"] }) {
  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Ready
      </span>
    );
  }
  if (status === "training") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Training
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-red-500/10 text-red-500 dark:text-red-400">
      <span className="w-1.5 h-1.5 rounded-full bg-red-500" /> Couldn&rsquo;t train
    </span>
  );
}

function MLModelCard({ model, accentIndex, onOpen }: { model: MLModel; accentIndex: number; onOpen: () => void }) {
  const accentClass = ACCENT_CLASSES[accentIndex % ACCENT_CLASSES.length];
  return (
    <div className="dash-card p-4 flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-2">
        <span className={`dash-icon-chip ${accentClass}`}>
          <SparkleNodesIcon />
        </span>
        <StatusPill status={model.status} />
      </div>
      <div className="min-w-0">
        <div className="font-semibold text-sm truncate" title={model.name}>{model.name}</div>
        <div className="text-xs text-muted mt-0.5 truncate" title={model.datasource_name}>
          From {model.datasource_name}
        </div>
      </div>
      <p className="text-xs text-muted leading-relaxed line-clamp-3">{plainLanguageSummary(model)}</p>
      <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-muted">
        {model.trained_at && <span>Trained {timeAgo(model.trained_at)}</span>}
        {model.status === "ready" && (
          <span className="px-1.5 py-0.5 rounded-full bg-surface2 border border-border">
            {model.prediction_count.toLocaleString()} prediction{model.prediction_count === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <button type="button" className="btn-primary text-xs mt-2" onClick={onOpen}>
        Open &rarr;
      </button>
    </div>
  );
}

export default function MLModels() {
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [models, setModels] = useState<MLModel[] | null>(null);
  const [error, setError] = useState("");
  const [showWizard, setShowWizard] = useState(false);

  const load = () => {
    mlModelsApi
      .list()
      .then(setModels)
      .catch(() => setError("Couldn't load your ML models. Please try refreshing."));
  };

  useEffect(load, []);

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
          <div className="mb-6 flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">ML Models</h1>
              <p className="text-sm text-muted mt-1 max-w-2xl">
                Train a real machine learning model on your own data, in plain language - no code, no jargon.
                Every number shown here is a real, computed result, never a guess.
              </p>
            </div>
            <button type="button" className="btn-primary text-sm shrink-0" onClick={() => setShowWizard(true)}>
              + Train a new model
            </button>
          </div>

          {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">{error}</div>}

          {models === null && !error && <div className="text-sm text-muted">Loading&hellip;</div>}

          {models !== null && models.length === 0 && (
            <div className="dash-card p-8 text-center">
              <div className="text-sm text-muted mb-1 leading-relaxed">No ML models yet.</div>
              <div className="text-xs text-muted leading-relaxed max-w-md mx-auto mb-4">
                Pick a data source, choose a column to predict, and GD360 will train and evaluate a real model
                for you - typically in a few seconds.
              </div>
              <button type="button" className="btn-primary text-sm" onClick={() => setShowWizard(true)}>
                + Train your first model
              </button>
            </div>
          )}

          {models !== null && models.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {models.map((m, i) => (
                <MLModelCard key={m.id} model={m} accentIndex={i} onOpen={() => navigate(`/ml-models/${m.id}`)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {showWizard && (
        <TrainModelWizard
          activeWorkspaceId={activeWorkspaceId}
          onClose={() => setShowWizard(false)}
          onTrained={(model) => {
            setShowWizard(false);
            load();
            navigate(`/ml-models/${model.id}`);
          }}
        />
      )}
    </div>
  );
}
