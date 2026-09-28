import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { datasourceApi, DataSourceSummary, mlModelsApi, MLModel } from "../api/client";
import { connectionKindMeta } from "./DataSourceForm";
import { plainLanguageHeadline, metricLabel, formatNumber } from "../lib/mlModelText";

// 2026-09-28 (ML Models round): the no-code "train a model" wizard - four
// steps, no code and no ML jargon in the primary flow (an optional
// "Technical details" section on the result step is the one place real
// metric names show up, clearly labeled as such). Mirrors this app's
// existing modal conventions (createPortal, fixed inset-0 bg-black/60,
// .card, Escape-to-close) rather than inventing a new modal pattern.
//
// Design choice worth stating plainly (the spec's own step 2 was
// deliberately open-ended about this): this wizard never shows a
// CLIENT-SIDE guess at whether the target column will end up being
// "classification" or "regression" before training runs. A guess based on
// dtype/distinct-count alone could easily be wrong (that's exactly why
// services/ml_training.infer_task_type documents itself as a heuristic,
// not a certainty) and showing it with any confidence before the real
// computation has even happened would risk this feature's own "never
// fabricate a number/claim" discipline. Instead, step 2 only asks WHICH
// column to predict; the real, computed task_type only ever appears after
// the real POST /ml-models/train call returns it on step 4's result -
// exactly the one honest place a person should see it.

function CloseIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function CheckIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function ArrowLeftIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

type Step = 1 | 2 | 3 | 4;

const STEP_LABELS: Record<Step, string> = {
  1: "Pick a data source",
  2: "What do you want to predict?",
  3: "Review columns",
  4: "Name it and train",
};

function StepDots({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-1.5">
      {([1, 2, 3, 4] as Step[]).map((s) => (
        <span
          key={s}
          className={`h-1.5 rounded-full transition-all ${s === step ? "w-6 bg-primary" : s < step ? "w-1.5 bg-primary/50" : "w-1.5 bg-border"}`}
        />
      ))}
    </div>
  );
}

export default function TrainModelWizard({
  activeWorkspaceId,
  onClose,
  onTrained,
}: {
  activeWorkspaceId: string;
  onClose: () => void;
  // Called once training actually completes with status="ready" and the
  // person chooses to go look at the real result on its own page - never
  // called for a "failed" training (that stays on this wizard's own result
  // step so "Try different columns" has somewhere to go back to).
  onTrained: (model: MLModel) => void;
}) {
  const [step, setStep] = useState<Step>(1);

  // Step 1
  const [sources, setSources] = useState<DataSourceSummary[] | null>(null);
  const [sourceQuery, setSourceQuery] = useState("");
  const [datasourceId, setDatasourceId] = useState<string | null>(null);

  // Step 2
  const [columns, setColumns] = useState<string[] | null>(null);
  const [columnsError, setColumnsError] = useState("");
  const [targetColumn, setTargetColumn] = useState("");

  // Step 3
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pickedFeatures, setPickedFeatures] = useState<string[]>([]);

  // Step 4
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [training, setTraining] = useState(false);
  const [trainError, setTrainError] = useState("");
  const [result, setResult] = useState<MLModel | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    datasourceApi
      .list(activeWorkspaceId)
      .then((list) => setSources([...list].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())))
      .catch(() => setSources([]));
  }, [activeWorkspaceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!datasourceId) return;
    setColumns(null);
    setColumnsError("");
    setTargetColumn("");
    setPickedFeatures([]);
    datasourceApi
      .preview(datasourceId, null)
      .then((p) => setColumns(p.columns))
      .catch(() => setColumnsError("Couldn't read this data source's columns. Please try another one."));
  }, [datasourceId]);

  const selectedSource = sources?.find((s) => s.id === datasourceId) || null;
  const otherColumns = useMemo(
    () => (columns || []).filter((c) => c !== targetColumn),
    [columns, targetColumn]
  );

  const filteredSources = (sources || []).filter(
    (s) => !sourceQuery.trim() || s.name.toLowerCase().includes(sourceQuery.trim().toLowerCase())
  );

  const toggleFeature = (col: string) => {
    setPickedFeatures((prev) => (prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]));
  };

  const startTraining = async () => {
    if (!datasourceId || !targetColumn || !name.trim()) return;
    setTraining(true);
    setTrainError("");
    setResult(null);
    try {
      const model = await mlModelsApi.train({
        datasource_id: datasourceId,
        target_column: targetColumn,
        feature_columns: advancedOpen && pickedFeatures.length > 0 ? pickedFeatures : undefined,
        name: name.trim(),
        description: description.trim() || undefined,
      });
      setResult(model);
    } catch (err: any) {
      setTrainError(err?.response?.data?.detail || "Couldn't train this model right now. Please try again.");
    } finally {
      setTraining(false);
    }
  };

  const tryDifferentColumns = () => {
    setResult(null);
    setTrainError("");
    setStep(2);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/60 p-4 overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card w-full max-w-lg my-8 sm:my-0 flex flex-col max-h-[88vh]">
        <div className="p-4 border-b border-border flex items-center justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <div className="font-bold text-base">Train a new model</div>
            {!result && <div className="text-xs text-muted mt-0.5">{STEP_LABELS[step]}</div>}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {!result && <StepDots step={step} />}
            <button type="button" className="text-muted hover:text-text transition" onClick={onClose} aria-label="Close">
              <CloseIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {/* ---- Result (shown instead of the step content once training has run) ---- */}
          {result ? (
            <ResultView
              model={result}
              showTechnical={showTechnical}
              setShowTechnical={setShowTechnical}
              onTryDifferent={tryDifferentColumns}
              onView={() => onTrained(result)}
            />
          ) : (
            <>
              {step === 1 && (
                <div>
                  <p className="text-xs text-muted leading-relaxed mb-3">
                    Pick the data source that has the information you want to predict from.
                  </p>
                  <input
                    autoFocus
                    className="input text-sm w-full mb-3"
                    placeholder="Search your data..."
                    value={sourceQuery}
                    onChange={(e) => setSourceQuery(e.target.value)}
                  />
                  {sources === null ? (
                    <div className="text-xs text-muted py-4 text-center">Loading&hellip;</div>
                  ) : filteredSources.length === 0 ? (
                    <div className="text-xs text-muted py-6 text-center">No data sources found.</div>
                  ) : (
                    <div className="space-y-1 max-h-72 overflow-y-auto">
                      {filteredSources.map((ds) => {
                        const meta = connectionKindMeta(ds.kind);
                        const picked = ds.id === datasourceId;
                        return (
                          <button
                            key={ds.id}
                            type="button"
                            aria-pressed={picked}
                            onClick={() => setDatasourceId(ds.id)}
                            className={`w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg text-left transition border ${
                              picked ? "bg-primary/10 border-primary/40" : "border-transparent hover:bg-surface2"
                            }`}
                          >
                            <span
                              className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                              style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}
                            >
                              <meta.Logo className="w-3.5 h-3.5" />
                            </span>
                            <span className="text-sm truncate flex-1">{ds.name}</span>
                            {picked && (
                              <span className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 bg-primary text-white">
                                <CheckIcon className="w-3 h-3" />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {step === 2 && (
                <div>
                  <p className="text-xs text-muted leading-relaxed mb-3">
                    Which column in <span className="font-semibold text-text">{selectedSource?.name}</span> do you
                    want GD360 to learn to predict?
                  </p>
                  {columnsError && (
                    <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">
                      {columnsError}
                    </div>
                  )}
                  {columns === null && !columnsError && <div className="text-xs text-muted py-4 text-center">Loading columns&hellip;</div>}
                  {columns !== null && (
                    <select
                      className="input text-sm w-full"
                      value={targetColumn}
                      onChange={(e) => setTargetColumn(e.target.value)}
                    >
                      <option value="" disabled>Choose a column&hellip;</option>
                      {columns.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  )}
                  <p className="text-[11px] text-muted leading-relaxed mt-3">
                    GD360 will figure out whether this is a yes/no-style prediction or a number prediction
                    automatically from your real data, once training runs - you don&rsquo;t need to know that in
                    advance.
                  </p>
                </div>
              )}

              {step === 3 && (
                <div>
                  <p className="text-xs text-muted leading-relaxed mb-3">
                    By default, GD360 automatically picks every other column that&rsquo;s useful for predicting{" "}
                    <span className="font-semibold text-text">{targetColumn}</span>, and explains any it leaves
                    out. Most people can skip this step entirely.
                  </p>
                  <button
                    type="button"
                    className="text-xs font-semibold text-primary hover:underline"
                    onClick={() => setAdvancedOpen((o) => !o)}
                  >
                    {advancedOpen ? "Hide advanced options" : "Advanced: pick specific columns yourself"}
                  </button>
                  {advancedOpen && (
                    <div className="mt-3 border border-border rounded-lg p-3 max-h-56 overflow-y-auto space-y-1">
                      {otherColumns.length === 0 && <div className="text-xs text-muted">No other columns available.</div>}
                      {otherColumns.map((c) => (
                        <label key={c} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
                          <input
                            type="checkbox"
                            className="rounded border-border"
                            checked={pickedFeatures.includes(c)}
                            onChange={() => toggleFeature(c)}
                          />
                          <span className="truncate">{c}</span>
                        </label>
                      ))}
                      <p className="text-[11px] text-muted pt-1">
                        Leave everything unchecked to use GD360&rsquo;s automatic picks instead.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {step === 4 && (
                <div>
                  <label className="block text-xs font-semibold text-muted mb-1.5">Model name</label>
                  <input
                    autoFocus
                    className="input text-sm w-full mb-3"
                    placeholder={`e.g. Predict ${targetColumn || "..."}`}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={120}
                  />
                  <label className="block text-xs font-semibold text-muted mb-1.5">Description (optional)</label>
                  <textarea
                    className="input text-sm w-full mb-3"
                    rows={3}
                    placeholder="What is this model for?"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={2000}
                  />
                  {trainError && (
                    <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">
                      {trainError}
                    </div>
                  )}
                  {training && (
                    <div className="text-xs text-muted text-center py-3">
                      Training a real model on your data&hellip; this usually takes just a few seconds.
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {!result && (
          <div className="p-4 border-t border-border shrink-0 flex items-center justify-between gap-2">
            <button
              type="button"
              className="btn-secondary text-sm inline-flex items-center gap-1.5 disabled:opacity-40"
              disabled={step === 1}
              onClick={() => setStep((s) => (s - 1) as Step)}
            >
              <ArrowLeftIcon /> Back
            </button>
            {step < 3 && (
              <button
                type="button"
                className="btn-primary text-sm disabled:opacity-50"
                disabled={(step === 1 && !datasourceId) || (step === 2 && !targetColumn)}
                onClick={() => setStep((s) => (s + 1) as Step)}
              >
                Next
              </button>
            )}
            {step === 3 && (
              <button type="button" className="btn-primary text-sm" onClick={() => setStep(4)}>
                Next
              </button>
            )}
            {step === 4 && (
              <button
                type="button"
                className="btn-primary text-sm disabled:opacity-50"
                disabled={training || !name.trim()}
                onClick={startTraining}
              >
                {training ? "Training…" : "Train model"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function ResultView({
  model,
  showTechnical,
  setShowTechnical,
  onTryDifferent,
  onView,
}: {
  model: MLModel;
  showTechnical: boolean;
  setShowTechnical: (v: boolean) => void;
  onTryDifferent: () => void;
  onView: () => void;
}) {
  if (model.status === "failed") {
    return (
      <div>
        <div className="text-sm font-semibold text-red-500 mb-1">This model couldn&rsquo;t be trained</div>
        <p className="text-sm text-muted leading-relaxed mb-4">{model.error_message}</p>
        <button type="button" className="btn-primary text-sm" onClick={onTryDifferent}>
          Try different columns
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="text-lg font-bold leading-snug mb-1">{plainLanguageHeadline(model)}</div>
      <div className="text-xs text-muted mb-4">
        Trained on {model.trained_row_count?.toLocaleString()} real rows of data.
      </div>

      {model.excluded_columns && model.excluded_columns.length > 0 && (
        <div className="mb-4 text-xs text-muted bg-surface2 border border-border rounded-lg p-3">
          <div className="font-semibold text-text mb-1">Columns not used, and why</div>
          <ul className="space-y-0.5">
            {model.excluded_columns.map((e) => (
              <li key={e.column}>
                <span className="font-medium text-text">{e.column}</span>: {e.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="button"
        className="text-xs font-semibold text-primary hover:underline mb-2"
        onClick={() => setShowTechnical(!showTechnical)}
      >
        {showTechnical ? "Hide technical details" : "Technical details"}
      </button>
      {showTechnical && (
        <div className="mb-4 text-xs bg-surface2 border border-border rounded-lg p-3 space-y-1">
          <div><span className="text-muted">Algorithm:</span> {model.algorithm}</div>
          <div><span className="text-muted">Task type:</span> {model.task_type}</div>
          {model.metrics && Object.entries(model.metrics).map(([k, v]) => (
            <div key={k}><span className="text-muted">{metricLabel(k)}:</span> {typeof v === "number" ? formatNumber(v) : String(v)}</div>
          ))}
        </div>
      )}

      <button type="button" className="btn-primary w-full text-sm py-2.5" onClick={onView}>
        View this model &rarr;
      </button>
    </div>
  );
}
