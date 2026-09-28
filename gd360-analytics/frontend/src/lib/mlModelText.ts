import { MLModel } from "../api/client";

// 2026-09-28 (ML Models round): every plain-language sentence this feature
// shows about a trained model - the gallery card's one-liner, the wizard's
// result headline, and the detail page's summary - all built from this one
// place so the wording (and, more importantly, the ARITHMETIC turning a
// real metrics number into a plain sentence) can never drift between the
// three surfaces that need it. See the guiding principle in this round's
// own build notes: plain language first, a "Technical details" section
// with the real numbers for anyone who wants them, and never a fabricated
// or rounded-away-from-honest claim - every sentence here is built
// directly from a real, computed models.MLModel.metrics value, and a
// missing/impossible-to-compute number always falls back to an honest
// "not available" phrase rather than a guess.

export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(iso).toLocaleDateString();
}

export function statusLabel(model: Pick<MLModel, "status">): string {
  if (model.status === "ready") return "Ready";
  if (model.status === "training") return "Training";
  return "Couldn't train";
}

// The gallery card / detail page's one-line "what this model does and how
// well" - the single most important honest sentence in this whole feature.
export function plainLanguageSummary(model: MLModel): string {
  if (model.status === "training") return "Training now…";
  if (model.status === "failed") {
    return model.error_message || "This model couldn't be trained.";
  }
  const target = model.target_column;
  if (model.task_type === "classification" && model.metrics?.accuracy != null) {
    const pct = Math.round(model.metrics.accuracy * 100);
    return `Predicts "${target}" - correctly guesses about ${pct}% of the time.`;
  }
  if (model.task_type === "regression" && model.metrics?.r2 != null) {
    const pct = Math.round(Math.max(0, Math.min(1, model.metrics.r2)) * 100);
    const maeText = model.metrics.mae != null ? `, typically within ${formatNumber(model.metrics.mae)} of the real number` : "";
    return `Predicts "${target}" - explains about ${pct}% of what drives it${maeText}.`;
  }
  return `Predicts "${target}".`;
}

// A slightly longer version for the wizard's own big result headline and
// the detail page's hero - same honest numbers, just given more room.
export function plainLanguageHeadline(model: MLModel): string {
  if (model.status === "failed") {
    return model.error_message || "This model couldn't be trained with this data.";
  }
  if (model.status !== "ready") return "Training…";
  if (model.task_type === "classification" && model.metrics?.accuracy != null) {
    const pct = Math.round(model.metrics.accuracy * 100);
    return `This model correctly predicts "${model.target_column}" about ${pct}% of the time.`;
  }
  if (model.task_type === "regression") {
    const r2 = model.metrics?.r2;
    const mae = model.metrics?.mae;
    if (r2 != null) {
      const pct = Math.round(Math.max(0, Math.min(1, r2)) * 100);
      const maePart = mae != null ? ` On average, its guess is off by about ${formatNumber(mae)}.` : "";
      return `This model explains about ${pct}% of what drives "${model.target_column}".${maePart}`;
    }
  }
  return `This model predicts "${model.target_column}".`;
}

export function formatNumber(n: number): string {
  if (Number.isNaN(n)) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function metricLabel(key: string): string {
  const labels: Record<string, string> = {
    accuracy: "Accuracy",
    precision: "Precision",
    recall: "Recall",
    f1: "F1 score",
    mae: "Mean absolute error (MAE)",
    rmse: "Root mean squared error (RMSE)",
    r2: "R² (variance explained)",
  };
  return labels[key] || key;
}

export function algorithmLabel(algorithm: string | null): string {
  if (!algorithm) return "Not trained yet";
  const labels: Record<string, string> = {
    logistic_regression: "Logistic Regression",
    random_forest_classifier: "Random Forest (classifier)",
    linear_regression: "Linear Regression",
    random_forest_regressor: "Random Forest (regressor)",
  };
  return labels[algorithm] || algorithm;
}
