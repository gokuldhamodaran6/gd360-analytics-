import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { datasourceApi, DataSourceSummary, mlModelsApi, MLModel } from "../api/client";
import { hasMultipleTables } from "../components/DataSourceForm";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { algorithmLabel, formatNumber, metricLabel, plainLanguageHeadline, statusLabel, timeAgo } from "../lib/mlModelText";

// 2026-09-28 (ML Models round): a trained model's own detail page - plain-
// language result + an expandable "Technical details" section (same
// pattern as TrainModelWizard's own result step), a "Try it" form built
// from this model's real feature_columns, "Score a whole table", retrain
// (with a confirmation dialog, since it overwrites), usage stats, and a
// creator-only delete. Mirrors QualityChecksPanel.tsx/Governance.tsx's own
// loading/error/forbidden-state conventions rather than inventing new ones.

function TrashIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

function StatusBadge({ status }: { status: MLModel["status"] }) {
  const cls =
    status === "ready"
      ? "bg-green-500/10 text-green-600 dark:text-green-400"
      : status === "training"
      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
      : "bg-red-500/10 text-red-500 dark:text-red-400";
  return <span className={`inline-flex items-center text-xs font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full ${cls}`}>{statusLabel({ status })}</span>;
}

export default function MLModelDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();

  const [model, setModel] = useState<MLModel | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");
  const [showTechnical, setShowTechnical] = useState(false);

  // "Try it"
  const [tryValues, setTryValues] = useState<Record<string, string>>({});
  const [predicting, setPredicting] = useState(false);
  const [predictResult, setPredictResult] = useState<{ predicted_value: unknown; confidence: number | null } | null>(null);
  const [predictError, setPredictError] = useState("");

  // Score a table
  const [ds, setDs] = useState<DataSourceSummary | null>(null);
  const [scoreTable, setScoreTable] = useState<string>("");
  const [scoring, setScoring] = useState(false);
  const [scoreError, setScoreError] = useState("");
  const [scoreResult, setScoreResult] = useState<{ new_version_id: string; new_version_name: string; row_count: number } | null>(null);

  // Retrain
  const [confirmingRetrain, setConfirmingRetrain] = useState(false);
  const [retraining, setRetraining] = useState(false);
  const [retrainError, setRetrainError] = useState("");

  // Delete
  const [deleting, setDeleting] = useState(false);

  const load = () => {
    if (!id) return;
    mlModelsApi
      .get(id)
      .then((m) => {
        setModel(m);
        const init: Record<string, string> = {};
        (m.feature_columns || []).forEach((c) => { init[c] = ""; });
        setTryValues(init);
      })
      .catch((err: any) => {
        if (err?.response?.status === 404) setNotFound(true);
        else setError("Couldn't load this model. Please try again.");
      });
  };

  useEffect(load, [id]);

  useEffect(() => {
    if (!model || !activeWorkspaceId) return;
    datasourceApi
      .list(activeWorkspaceId)
      .then((list) => setDs(list.find((d) => d.id === model.datasource_id) || null))
      .catch(() => setDs(null));
  }, [model, activeWorkspaceId]);

  const multiTable = ds ? hasMultipleTables(ds.kind, ds.schema_cache) : false;
  const tableOptions = multiTable ? Object.keys(ds?.schema_cache || {}) : [];

  const runPredict = async () => {
    if (!id) return;
    setPredicting(true);
    setPredictError("");
    setPredictResult(null);
    try {
      const res = await mlModelsApi.predict(id, tryValues);
      setPredictResult(res);
      load();
    } catch (err: any) {
      setPredictError(err?.response?.data?.detail || "Couldn't make a prediction with those values. Please check them and try again.");
    } finally {
      setPredicting(false);
    }
  };

  const runScore = async () => {
    if (!id) return;
    setScoring(true);
    setScoreError("");
    setScoreResult(null);
    try {
      const res = await mlModelsApi.score(id, multiTable ? scoreTable || tableOptions[0] : undefined);
      setScoreResult(res);
      load();
    } catch (err: any) {
      setScoreError(err?.response?.data?.detail || "Couldn't score this table. Please try again.");
    } finally {
      setScoring(false);
    }
  };

  const runRetrain = async () => {
    if (!id) return;
    setRetraining(true);
    setRetrainError("");
    setConfirmingRetrain(false);
    try {
      const m = await mlModelsApi.retrain(id);
      setModel(m);
    } catch {
      setRetrainError("Couldn't retrain this model. Please try again.");
    } finally {
      setRetraining(false);
    }
  };

  const runDelete = async () => {
    if (!id || !model) return;
    if (!window.confirm(`Delete "${model.name}"? This can't be undone.`)) return;
    setDeleting(true);
    try {
      await mlModelsApi.delete(id);
      navigate("/ml-models");
    } catch {
      setError("Couldn't delete this model. Please try again.");
      setDeleting(false);
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
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
          <Link to="/ml-models" className="text-xs text-muted hover:text-text transition mb-4 inline-block">&larr; Back to ML Models</Link>

          {notFound && (
            <div className="dash-card p-8 text-center">
              <div className="text-sm text-muted">This model doesn&rsquo;t exist, or you don&rsquo;t have access to it.</div>
            </div>
          )}

          {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">{error}</div>}

          {!notFound && model === null && !error && <div className="text-sm text-muted">Loading&hellip;</div>}

          {model && (
            <>
              <div className="mb-6 flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <h1 className="text-2xl font-bold tracking-tight truncate">{model.name}</h1>
                    <StatusBadge status={model.status} />
                  </div>
                  <div className="text-xs text-muted">
                    From {model.datasource_name} &middot; predicting &ldquo;{model.target_column}&rdquo;
                  </div>
                  {model.description && <p className="text-sm text-muted mt-2 max-w-xl leading-relaxed">{model.description}</p>}
                </div>
                {model.can_delete && (
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={runDelete}
                    className="p-2 rounded-lg text-muted hover:text-red-400 hover:bg-red-500/10 transition shrink-0 disabled:opacity-50"
                    title="Delete this model"
                    aria-label="Delete this model"
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>

              {model.status === "failed" && (
                <div className="dash-card p-4 mb-6 border-red-500/30">
                  <div className="text-sm font-semibold text-red-500 mb-1">This model couldn&rsquo;t be trained</div>
                  <p className="text-sm text-muted leading-relaxed">{model.error_message}</p>
                </div>
              )}

              {model.status === "ready" && (
                <div className="dash-card p-5 mb-6">
                  <div className="text-lg font-bold leading-snug mb-3">{plainLanguageHeadline(model)}</div>

                  {model.excluded_columns && model.excluded_columns.length > 0 && (
                    <div className="mb-3 text-xs text-muted bg-surface2 border border-border rounded-lg p-3">
                      <div className="font-semibold text-text mb-1">Columns not used, and why</div>
                      <ul className="space-y-0.5">
                        {model.excluded_columns.map((e) => (
                          <li key={e.column}><span className="font-medium text-text">{e.column}</span>: {e.reason}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => setShowTechnical(!showTechnical)}>
                    {showTechnical ? "Hide technical details" : "Technical details"}
                  </button>
                  {showTechnical && (
                    <div className="mt-2 text-xs bg-surface2 border border-border rounded-lg p-3 space-y-1">
                      <div><span className="text-muted">Algorithm:</span> {algorithmLabel(model.algorithm)}</div>
                      <div><span className="text-muted">Task type:</span> {model.task_type}</div>
                      <div><span className="text-muted">Trained on:</span> {model.trained_row_count?.toLocaleString()} rows</div>
                      {model.metrics && Object.entries(model.metrics).map(([k, v]) => (
                        <div key={k}><span className="text-muted">{metricLabel(k)}:</span> {typeof v === "number" ? formatNumber(v) : String(v)}</div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-3 flex-wrap text-xs text-muted mt-4 pt-3 border-t border-border">
                    <span>{model.prediction_count.toLocaleString()} prediction{model.prediction_count === 1 ? "" : "s"} made</span>
                    <span>&middot;</span>
                    <span>Last used {timeAgo(model.last_predicted_at)}</span>
                    <span>&middot;</span>
                    <span>Trained {timeAgo(model.trained_at)}</span>
                  </div>
                </div>
              )}

              {model.status === "ready" && (
                <>
                  {/* ---- Try it ---- */}
                  <div className="dash-card p-5 mb-6">
                    <div className="font-semibold text-sm mb-1">Try it</div>
                    <p className="text-xs text-muted mb-3">
                      Type in some values and see what this model predicts for &ldquo;{model.target_column}&rdquo;.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                      {(model.feature_columns || []).map((col) => (
                        <div key={col}>
                          <label className="block text-xs font-semibold text-muted mb-1.5">{col}</label>
                          <input
                            className="input text-sm w-full"
                            value={tryValues[col] || ""}
                            onChange={(e) => setTryValues((prev) => ({ ...prev, [col]: e.target.value }))}
                            placeholder="Type a value…"
                          />
                        </div>
                      ))}
                    </div>
                    {predictError && (
                      <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">{predictError}</div>
                    )}
                    {predictResult && (
                      <div className="mb-3 text-sm bg-primary/10 border border-primary/30 rounded-lg px-3 py-2.5">
                        <span className="font-semibold">Prediction: {String(predictResult.predicted_value)}</span>
                        {predictResult.confidence != null && (
                          <span className="text-muted"> &middot; {Math.round(predictResult.confidence * 100)}% confident</span>
                        )}
                      </div>
                    )}
                    <button type="button" className="btn-primary text-sm disabled:opacity-50" disabled={predicting} onClick={runPredict}>
                      {predicting ? "Predicting…" : "Predict"}
                    </button>
                  </div>

                  {/* ---- Score a whole table ---- */}
                  <div className="dash-card p-5 mb-6">
                    <div className="font-semibold text-sm mb-1">Score a whole table</div>
                    <p className="text-xs text-muted mb-3">
                      Run this model against every row of a table and save the result as a new saved table, with a
                      real prediction added to every row.
                    </p>
                    {multiTable && (
                      <select className="input text-sm w-full mb-3" value={scoreTable} onChange={(e) => setScoreTable(e.target.value)}>
                        {tableOptions.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    )}
                    {scoreError && (
                      <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">{scoreError}</div>
                    )}
                    {scoreResult && (
                      <div className="mb-3 text-sm bg-primary/10 border border-primary/30 rounded-lg px-3 py-2.5">
                        Scored {scoreResult.row_count.toLocaleString()} rows &middot;{" "}
                        <Link className="font-semibold text-primary hover:underline" to={`/workspace/${model.datasource_id}`}>
                          Open &ldquo;{scoreResult.new_version_name}&rdquo; on the Data tab &rarr;
                        </Link>
                      </div>
                    )}
                    <button type="button" className="btn-secondary text-sm disabled:opacity-50" disabled={scoring} onClick={runScore}>
                      {scoring ? "Scoring…" : "Score this table"}
                    </button>
                  </div>
                </>
              )}

              {/* ---- Retrain ---- */}
              <div className="dash-card p-5 mb-6">
                <div className="font-semibold text-sm mb-1">Keep this model current</div>
                <p className="text-xs text-muted mb-3">
                  Retrains this model on the data source&rsquo;s latest data, replacing its current results.
                  This doesn&rsquo;t keep a history of earlier versions.
                </p>
                {retrainError && (
                  <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">{retrainError}</div>
                )}
                {!confirmingRetrain ? (
                  <button type="button" className="btn-secondary text-sm disabled:opacity-50" disabled={retraining} onClick={() => setConfirmingRetrain(true)}>
                    {retraining ? "Retraining…" : "Retrain with latest data"}
                  </button>
                ) : (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted">This will overwrite the current results. Are you sure?</span>
                    <button type="button" className="btn-primary text-xs" onClick={runRetrain}>Yes, retrain</button>
                    <button type="button" className="btn-secondary text-xs" onClick={() => setConfirmingRetrain(false)}>Cancel</button>
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
