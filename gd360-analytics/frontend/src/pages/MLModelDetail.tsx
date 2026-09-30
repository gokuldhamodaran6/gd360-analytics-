import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { datasourceApi, DataSourceSummary, mlModelsApi, MLModel, MLModelVersion, PredictResult } from "../api/client";
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
//
// 2026-09-30 (model trustworthiness round): three additions, all built
// from real backend numbers, none of them new visual language - "Top
// drivers" (model.feature_importance, a real global weight per feature),
// "Why this prediction" inside Try it (predictResult.explanation, a real
// per-feature contribution for THIS one prediction - only ever present
// for a linear/logistic model, honestly absent otherwise rather than
// approximated), and "Version history" (lazy-loaded, same toggle pattern
// as "Technical details" above) with a real "promote to active" rollback.

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

// 2026-09-30 (model trustworthiness round): one row of the "Top drivers"
// panel - a real, normalized-to-100% share of this model's own global
// feature_importance (see backend models.MLModel.feature_importance's own
// docstring). Deliberately plain (a label, a filled track, a percentage) -
// this is a share of the model's own reasoning, not a currency/count value,
// so no dataviz color-by-series treatment is warranted here.
function FeatureImportanceBar({ feature, importance }: { feature: string; importance: number }) {
  const pct = Math.round(importance * 100);
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs w-36 sm:w-44 shrink-0 truncate" title={feature}>{feature}</span>
      <div className="flex-1 h-2.5 bg-surface2 rounded-full overflow-hidden">
        <div className="h-2.5 bg-primary rounded-full" style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      <span className="text-xs font-semibold w-9 text-right shrink-0">{pct}%</span>
    </div>
  );
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
  const [predictResult, setPredictResult] = useState<PredictResult | null>(null);
  const [predictError, setPredictError] = useState("");

  // Version history (2026-09-30, model trustworthiness round) - lazy-
  // loaded the first time the section is opened, same pattern as
  // showTechnical above.
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<MLModelVersion[] | null>(null);
  const [versionsError, setVersionsError] = useState("");
  const [promotingVersionId, setPromotingVersionId] = useState<string | null>(null);
  const [promoteError, setPromoteError] = useState("");

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

  useEffect(() => {
    if (!showVersions || !id || versions !== null) return;
    setVersionsError("");
    mlModelsApi
      .listVersions(id)
      .then(setVersions)
      .catch(() => setVersionsError("Couldn't load version history. Please try again."));
  }, [showVersions, id, versions]);

  const runPromote = async (versionId: string) => {
    if (!id) return;
    setPromotingVersionId(versionId);
    setPromoteError("");
    try {
      const m = await mlModelsApi.promoteVersion(id, versionId);
      setModel(m);
      setVersions(null); // refetch - promoting itself appends a new "promoted" version row
    } catch {
      setPromoteError("Couldn't promote this version. Please try again.");
    } finally {
      setPromotingVersionId(null);
    }
  };

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
                  <p className="text-xs text-muted leading-relaxed mt-2">
                    If this model worked before, its last good version may still be saved &mdash; see
                    &ldquo;Version history&rdquo; below to make it active again.
                  </p>
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
                    <span>&middot;</span>
                    <span>Version {model.version_number}</span>
                  </div>
                </div>
              )}

              {/* ---- Top drivers (2026-09-30, model trustworthiness round) ---- */}
              {model.status === "ready" && model.feature_importance && model.feature_importance.length > 0 && (
                <div className="dash-card p-5 mb-6">
                  <div className="font-semibold text-sm mb-1">Top drivers</div>
                  <p className="text-xs text-muted mb-3 leading-relaxed">
                    What this model leans on most, across every prediction it makes &mdash; not why any one specific
                    prediction came out the way it did. Computed directly from the trained model&rsquo;s own real
                    weights.
                  </p>
                  <div className="space-y-2.5">
                    {model.feature_importance.map((f) => (
                      <FeatureImportanceBar key={f.feature} feature={f.feature} importance={f.importance} />
                    ))}
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
                    {/* ---- Why this prediction (2026-09-30, model trustworthiness round) ---- */}
                    {predictResult && predictResult.explanation && predictResult.explanation.length > 0 && (
                      <div className="mb-3 text-xs bg-surface2 border border-border rounded-lg p-3 space-y-1.5">
                        <div className="font-semibold text-text mb-1">Why this prediction</div>
                        {predictResult.explanation.map((e) => {
                          const up = e.contribution >= 0;
                          return (
                            <div key={e.feature} className="flex items-center justify-between gap-3">
                              <span className="truncate">
                                {e.feature}: <span className="font-medium text-text">{String(e.value)}</span>
                              </span>
                              <span className={`shrink-0 font-medium ${up ? "text-emerald-500" : "text-red-400"}`}>
                                {up ? "▲" : "▼"} {up ? "pushed it up" : "pushed it down"} &middot; {formatNumber(e.contribution)}
                              </span>
                            </div>
                          );
                        })}
                        <p className="text-[11px] text-muted leading-relaxed pt-1">
                          Computed from the model&rsquo;s own coefficients &times; this prediction&rsquo;s own
                          values &mdash; the exact numbers the model used, not an approximation.
                        </p>
                      </div>
                    )}
                    {predictResult && !predictResult.explanation && (
                      <p className="text-[11px] text-muted leading-relaxed mb-3">
                        Per-prediction explanations like this are available for linear/logistic models. This model
                        ({algorithmLabel(model.algorithm)}) shows the Top drivers panel above instead.
                      </p>
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
                  Retrains this model on the data source&rsquo;s latest data and makes the new result active.
                  Your current version is saved first &mdash; see &ldquo;Version history&rdquo; below to bring it
                  back at any time.
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
                    <span className="text-xs text-muted">This makes the new result active. Are you sure?</span>
                    <button type="button" className="btn-primary text-xs" onClick={runRetrain}>Yes, retrain</button>
                    <button type="button" className="btn-secondary text-xs" onClick={() => setConfirmingRetrain(false)}>Cancel</button>
                  </div>
                )}
              </div>

              {/* ---- Version history (2026-09-30, model trustworthiness round) ---- */}
              <div className="dash-card p-5 mb-6">
                <div className="font-semibold text-sm mb-1">Version history</div>
                <p className="text-xs text-muted mb-3">
                  Every real training run of this model, newest first. Promoting an older version makes it active
                  again immediately &mdash; no retraining involved.
                </p>
                <button
                  type="button"
                  className="text-xs font-semibold text-primary hover:underline"
                  onClick={() => setShowVersions(!showVersions)}
                >
                  {showVersions ? "Hide version history" : "Show version history"}
                </button>

                {showVersions && (
                  <div className="mt-3">
                    {versionsError && (
                      <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-2">{versionsError}</div>
                    )}
                    {promoteError && (
                      <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-2">{promoteError}</div>
                    )}
                    {versions === null && !versionsError && <div className="text-xs text-muted">Loading&hellip;</div>}
                    {versions !== null && versions.length === 0 && (
                      <div className="text-xs text-muted">No version history yet.</div>
                    )}
                    {versions !== null && versions.length > 0 && (
                      <div className="space-y-2">
                        {versions.map((v) => (
                          <div
                            key={v.id}
                            className={`text-xs rounded-lg p-3 border ${v.is_current ? "border-primary/40 bg-primary/5" : "border-border bg-surface2"}`}
                          >
                            <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold">Version {v.version_number}</span>
                                {v.is_current && (
                                  <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-primary/15 text-primary">
                                    Active
                                  </span>
                                )}
                                {v.created_reason === "promoted" && (
                                  <span className="text-[10px] text-muted">promoted, no retraining</span>
                                )}
                              </div>
                              {!v.is_current && (
                                <button
                                  type="button"
                                  className="btn-secondary text-[11px] py-1 px-2 disabled:opacity-50"
                                  disabled={promotingVersionId === v.id}
                                  onClick={() => runPromote(v.id)}
                                >
                                  {promotingVersionId === v.id ? "Promoting…" : "Promote to active"}
                                </button>
                              )}
                            </div>
                            <div className="text-muted">
                              {algorithmLabel(v.algorithm)} &middot; trained on{" "}
                              {v.trained_row_count?.toLocaleString() ?? "an unknown number of"} rows &middot; {timeAgo(v.created_at)}
                            </div>
                            {v.metrics && (
                              <div className="flex items-center gap-2 flex-wrap mt-1">
                                {Object.entries(v.metrics).map(([k, val]) => (
                                  <span key={k} className="px-1.5 py-0.5 rounded-full bg-surface2 border border-border">
                                    {metricLabel(k)}: {typeof val === "number" ? formatNumber(val) : String(val)}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
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
