"""
2026-09-28 (ML Models round): the real ML core behind models.MLModel - see
that model's own docstring for the full design. This module is deliberately
NOT an AI feature: every function here is plain, hand-written Python calling
real scikit-learn, with zero dependency on services/ai_engine.py or
services/sandbox.py (this app's AI-code-generation/execution pipeline).
Training dispatches through a small, fixed, well-tested shortlist of real
algorithms per task_type - never AI-generated or user-authored code, and
never executed through this app's sandbox. This matches the exact same
"small fixed whitelist, zero code-execution risk" philosophy
routers/dashboard_builder.py's manual block building already established
for this codebase (see that file's own _MANUAL_AGG_FUNCS and module
docstring). A future session must NOT "fix" this module into calling out to
ai_engine/sandbox - that would break the one architectural boundary this
whole feature is built on.

Every number this module computes and hands back (a metric, a prediction, a
confidence, a row count) is real and traceable to the real data it ran
against - this app has a strict, existing discipline of never fabricating a
stat, and nothing here breaks it. When something genuinely can't be
computed (not enough data, no usable feature columns, a target column with
only one distinct value), train_model fails cleanly with a real, honest
error_message rather than raising an unhandled exception or inventing a
number - the same "never crash, never lie" contract
services/quality_checks.run_quality_rule already follows.

2026-09-30 (model trustworthiness round): three real additions, all read
straight off objects scikit-learn already computes during training/
prediction - never a new statistical technique, never an approximation
dressed up as a real number. (1) _extract_feature_importance: a trained
model's own GLOBAL feature importance (RandomForest*'s feature_importances_,
or LogisticRegression/LinearRegression's coef_), mapped back onto real
column names. (2) _explain_prediction: for a binary logistic/linear model
only, the real per-feature contribution behind one SPECIFIC prediction
(coefficient x this row's own value) - deliberately None for a random
forest or a multiclass model rather than a fabricated approximation (full
SHAP/LIME is real, separately-scoped future work - see the competitive gap
analysis). (3) _record_version/models.MLModelVersion: every call into
train_model that reaches status="ready" now appends a real, timestamped
version snapshot instead of silently overwriting the previous one - see
models.MLModelVersion's own docstring.
"""
from __future__ import annotations

import io
from datetime import datetime
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.metrics import (
    accuracy_score, f1_score, mean_absolute_error, mean_squared_error, precision_score, r2_score,
    recall_score,
)
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sqlalchemy import func

from .. import models

# The minimum number of usable rows (after dropping rows with no target
# value) this module will ever train on - below this, a held-out 80/20
# split leaves too little of either side to mean anything, and the result
# would not be a trustworthy real number. Chosen as a round, honest,
# clearly-explainable floor rather than tuned to make any one demo dataset
# pass.
MIN_TRAINING_ROWS = 30

# A column with at least this fraction of its rows holding a distinct value
# reads as an identifier (a customer id, an order number, a row number) -
# useful for looking a row up, never useful for PREDICTING anything about
# it, and including one would let a model "cheat" by memorizing individual
# rows rather than learning a real pattern.
_ID_LIKE_DISTINCT_FRACTION = 0.9

# A non-numeric (text/categorical) column with more distinct values than
# this is too wide to one-hot-encode sanely in an automatic, no-code flow -
# it would blow up into that many new columns, most seen only once, adding
# noise rather than signal. A power user can still force it in via the
# wizard's advanced column picker; it is only ever auto-excluded from the
# zero-configuration default path.
_MAX_CATEGORICAL_DISTINCT = 50

# task_type == "classification" only when a column has at most this many
# distinct non-null values - see infer_task_type's own docstring for the
# full heuristic and its honest limitations.
_MAX_CLASSIFICATION_DISTINCT = 20


def infer_task_type(series: pd.Series) -> str:
    """Guesses whether `series` (the target column's real values) is best
    modeled as classification (predicting one of a small set of discrete
    labels) or regression (predicting a number on a continuous scale).

    This is a HEURISTIC, not a perfect rule, and is documented honestly as
    one: "classification" whenever the column has at most
    _MAX_CLASSIFICATION_DISTINCT (20) distinct non-null values AND either
    (a) it isn't a float dtype at all (text/bool/integer columns with few
    distinct values are almost always categories - "yes"/"no",
    "gold"/"silver"/"bronze", a 1-5 star rating), or (b) it IS a float
    dtype but every non-null value happens to be a whole number (e.g. a
    rating stored as 4.0/5.0 rather than an int) - still almost certainly a
    small set of categories, not a continuous measurement. Otherwise
    "regression". A genuinely continuous numeric column with very few
    distinct values in a SMALL sample (e.g. a price column that happens to
    only take 15 different values in a 40-row dataset) could be
    misclassified as "classification" by this rule - a real, acknowledged
    edge case rather than a hidden one; the trained model's own honestly-
    reported task_type and metrics make it easy for a person to notice and
    override with a differently-shaped dataset if this ever guesses wrong
    for them."""
    non_null = series.dropna()
    distinct_count = non_null.nunique()
    if distinct_count > _MAX_CLASSIFICATION_DISTINCT:
        return "regression"
    if not pd.api.types.is_float_dtype(series):
        return "classification"
    # A float dtype with few distinct values - only "classification" if
    # every one of those real values is a whole number.
    all_whole = bool((non_null == non_null.round()).all()) if len(non_null) > 0 else False
    return "classification" if all_whole else "regression"


def select_features(
    df: pd.DataFrame, target_column: str, requested_features: list[str] | None = None,
) -> tuple[list[str], list[dict]]:
    """Returns (usable_feature_columns, excluded_with_reasons) - the real,
    computed answer to "which columns can this actually learn from, and
    why weren't the others used". `requested_features`, when given (the
    wizard's own "advanced: pick specific columns yourself" step), narrows
    the CANDIDATE set to just those columns - every one of them still goes
    through the exact same exclusion checks below, so an explicitly
    requested column can still legitimately end up excluded (with an
    honest reason) rather than silently forced in. `requested_features`
    left as None (the default, zero-configuration path) considers every
    column in `df` other than the target.

    Exclusion reasons, checked in this order for each candidate column:
      1. It IS the target column - can't also be used to predict itself.
      2. It is entirely null in this data - nothing to learn from.
      3. It looks like a unique identifier (at least 90% of rows hold a
         distinct value) - not useful for predicting anything. This check
         is deliberately skipped for a float-dtype column: a continuous
         measurement (a price, a duration, a precise sensor reading) is
         ALSO expected to be nearly-all-distinct across many rows, and
         that is exactly the kind of real signal this feature exists to
         use, not a reason to exclude it. An integer or text/object column
         with the same high-distinct-fraction shape is still excluded -
         that is the actual shape a customer id, an order number, or a
         row number takes in real data. Known, honest edge case: an
         integer-valued but genuinely continuous column (e.g. a value
         that happens to always be a whole number) can still be
         misidentified as an ID by this rule - a person can always force
         it back in via the wizard's "advanced: pick columns yourself"
         step, where every explicitly-requested column still goes through
         this same check and is either included or given the same honest
         reason if it's still excluded.
      4. It is non-numeric with more than 50 distinct values - too wide to
         one-hot-encode sanely in an automatic flow.
    A column that passes all four checks is usable."""
    candidates = list(requested_features) if requested_features else [c for c in df.columns if c != target_column]

    usable: list[str] = []
    excluded: list[dict] = []
    total_rows = len(df)

    for col in candidates:
        if col == target_column:
            excluded.append({
                "column": col,
                "reason": "This is the column being predicted - it can't also be used as a feature.",
            })
            continue
        if col not in df.columns:
            excluded.append({"column": col, "reason": "This column was not found in the data."})
            continue

        series = df[col]
        non_null_count = series.notna().sum()
        if non_null_count == 0:
            excluded.append({"column": col, "reason": "This column is entirely empty - nothing to learn from."})
            continue

        distinct_count = series.nunique(dropna=True)
        is_float = pd.api.types.is_float_dtype(series)
        if (
            not is_float
            and total_rows > 0
            and distinct_count >= _ID_LIKE_DISTINCT_FRACTION * total_rows
            and distinct_count > 1
        ):
            excluded.append({
                "column": col,
                "reason": "Looks like a unique identifier, not useful for predicting.",
            })
            continue

        is_numeric = pd.api.types.is_numeric_dtype(series)
        if not is_numeric and distinct_count > _MAX_CATEGORICAL_DISTINCT:
            excluded.append({
                "column": col,
                "reason": f"Too many different values to use automatically ({distinct_count} distinct values).",
            })
            continue

        usable.append(col)

    return usable, excluded


def build_preprocessing_pipeline(df: pd.DataFrame, feature_columns: list[str]) -> ColumnTransformer:
    """A ColumnTransformer that turns any mix of numeric/categorical feature
    columns into a clean, fully-numeric matrix a scikit-learn model can fit
    on - numeric columns get median-imputed then scaled (the scaling only
    genuinely matters for the linear candidates; applying it uniformly is
    harmless for the tree-based candidates, which are scale-invariant, so
    one shared pipeline shape works for every candidate model rather than
    building a second, parallel unscaled version just for the trees).
    Categorical/text columns get most-frequent-imputed then one-hot
    encoded, with unknown categories at predict time ignored (encoded as
    all-zeros) rather than raising, since a "Try it" prediction later may
    legitimately type in a value the training data never saw."""
    numeric_cols = [c for c in feature_columns if pd.api.types.is_numeric_dtype(df[c])]
    categorical_cols = [c for c in feature_columns if c not in numeric_cols]

    numeric_pipeline = Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
    ])
    categorical_pipeline = Pipeline([
        ("impute", SimpleImputer(strategy="most_frequent")),
        ("onehot", OneHotEncoder(handle_unknown="ignore")),
    ])

    transformers = []
    if numeric_cols:
        transformers.append(("num", numeric_pipeline, numeric_cols))
    if categorical_cols:
        transformers.append(("cat", categorical_pipeline, categorical_cols))
    return ColumnTransformer(transformers, remainder="drop")


def _original_feature_weights(preprocessing: ColumnTransformer, raw_weights: np.ndarray) -> dict[str, float]:
    """2026-09-30 (model trustworthiness round): maps `raw_weights` (one
    real weight per column of `preprocessing`'s fitted OUTPUT - e.g. a
    RandomForest's own feature_importances_, or abs(LogisticRegression/
    LinearRegression's coef_)) back onto this model's real, original
    feature columns - summing a one-hot-encoded categorical column's
    several dummy weights into one honest entry for that column, so
    "plan_tier" reads as one number, never three confusing fragments
    ("plan_tier_Pro"/"plan_tier_Basic"/"plan_tier_Enterprise").

    Walks `preprocessing.transformers_` (the fitted ColumnTransformer's
    own record of what it actually did, in the exact order it
    concatenates output columns) rather than parsing a generated name
    like "cat__plan_tier_Pro" back apart - a real column name can itself
    contain underscores, so there is no honest way to un-parse that
    string. A fitted OneHotEncoder's own `categories_` (one array per
    input column, in the same order build_preprocessing_pipeline passed
    them in) says exactly how many output columns each real categorical
    column expanded into, with zero guessing."""
    weights: dict[str, float] = {}
    offset = 0
    for name, transformer, columns in preprocessing.transformers_:
        if name == "num":
            for col in columns:
                weights[col] = weights.get(col, 0.0) + float(raw_weights[offset])
                offset += 1
        elif name == "cat":
            onehot = transformer.named_steps["onehot"]
            for col, categories in zip(columns, onehot.categories_):
                width = len(categories)
                weights[col] = weights.get(col, 0.0) + float(np.sum(raw_weights[offset:offset + width]))
                offset += width
        # "remainder" (remainder="drop") produces zero output columns and
        # is never anything but the literal string "drop" here - nothing
        # to walk, so it's simply skipped rather than matched explicitly.
    return weights


def _extract_feature_importance(pipeline: Pipeline) -> list[dict] | None:
    """2026-09-30 (model trustworthiness round): real, GLOBAL feature
    importance for a freshly-fitted `pipeline` - see
    models.MLModel.feature_importance's own docstring. Reads whichever
    real attribute this winning algorithm actually exposes -
    RandomForest*'s own feature_importances_ (already non-negative,
    already meaningful as relative magnitudes), or LogisticRegression/
    LinearRegression's own coef_ (made non-negative via abs() first,
    since here only MAGNITUDE is being compared across features - see
    explain_prediction below for where a coefficient's real SIGN is what
    actually matters). Never invents a number for an algorithm that
    exposes neither - returns None in that case, this module's own
    "never fabricate, never crash" contract (see this module's own
    docstring) applied to a hypothetical future candidate algorithm,
    not any of the four this app trains today."""
    estimator = pipeline.named_steps["model"]
    if hasattr(estimator, "feature_importances_"):
        raw = np.asarray(estimator.feature_importances_, dtype=float)
    elif hasattr(estimator, "coef_"):
        coef = np.asarray(estimator.coef_, dtype=float)
        # LogisticRegression's coef_ is shape (1, n_features) for binary
        # classification, (n_classes, n_features) for multiclass - either
        # way, collapse to one real magnitude per feature by averaging the
        # absolute weight across whichever classes exist.
        raw = np.mean(np.abs(coef), axis=0) if coef.ndim > 1 else np.abs(coef)
    else:
        return None

    weights = _original_feature_weights(pipeline.named_steps["preprocess"], raw)
    total = sum(weights.values())
    if total <= 0:
        return None
    return sorted(
        ({"feature": f, "importance": w / total} for f, w in weights.items()),
        key=lambda e: e["importance"], reverse=True,
    )


def _explain_prediction(
    pipeline: Pipeline, algorithm: str | None, row: dict, feature_columns: list[str],
) -> list[dict] | None:
    """2026-09-30 (model trustworthiness round): the real, per-feature
    contribution breakdown for ONE specific prediction - see
    models.MLPrediction.explanation's own docstring for the full design.
    `row` is this prediction's own already-coerced input values (see
    _coerce_form_value) - the exact values the pipeline itself used.

    Only ever computed for a binary logistic_regression or a
    linear_regression winning algorithm. The honest reason: a linear
    model's own coefficient times this row's own (preprocessed) value IS
    the real number that model actually added toward (positive) or away
    from (negative) its prediction for that feature - nothing
    approximated. A random forest has no equivalent single real number
    per feature per prediction without a genuinely different technique
    (SHAP/LIME - a real, separately-scoped piece of work; see the
    competitive gap analysis's own "model explainability" entry) - rather
    than fabricate a plausible-looking number for a tree model, this
    returns None, and the UI shows this model's real GLOBAL
    feature_importance instead (see routers/ml_models.py/pages/
    MLModelDetail.tsx). A multiclass logistic regression (coef_ holding
    more than one class's row) returns None for the same reason: no
    single feature-level number honestly describes "up or down" across
    more than two classes at once."""
    if algorithm not in ("logistic_regression", "linear_regression"):
        return None

    estimator = pipeline.named_steps["model"]
    coef = np.asarray(estimator.coef_, dtype=float)
    if coef.ndim > 1 and coef.shape[0] > 1:
        return None
    coef = coef.reshape(-1)

    preprocessing = pipeline.named_steps["preprocess"]
    X = pd.DataFrame([row], columns=feature_columns)
    transformed = preprocessing.transform(X)
    if hasattr(transformed, "toarray"):
        transformed = transformed.toarray()
    transformed = np.asarray(transformed, dtype=float)[0]

    contributions: dict[str, float] = {}
    offset = 0
    for name, transformer, columns in preprocessing.transformers_:
        if name == "num":
            for col in columns:
                contributions[col] = contributions.get(col, 0.0) + float(coef[offset] * transformed[offset])
                offset += 1
        elif name == "cat":
            onehot = transformer.named_steps["onehot"]
            for col, categories in zip(columns, onehot.categories_):
                width = len(categories)
                segment = coef[offset:offset + width] * transformed[offset:offset + width]
                contributions[col] = contributions.get(col, 0.0) + float(np.sum(segment))
                offset += width

    return sorted(
        ({"feature": f, "value": row.get(f), "contribution": c} for f, c in contributions.items()),
        key=lambda e: abs(e["contribution"]), reverse=True,
    )


def _record_version(db, ml_model_row: models.MLModel) -> None:
    """2026-09-30 (model trustworthiness round): appends one new
    MLModelVersion snapshot of `ml_model_row`'s own just-updated fields
    and makes it the current one - see that model's own docstring. Called
    from train_model only on the success path (status == "ready"), so
    both a model's very first training run and every later retrain go
    through this exact same path - there is no separate, second place
    that ever creates a version row. Flips every OTHER version of this
    model to is_current=False first (there is normally at most one, but
    this is written to be correct even if that is ever not true), then
    keeps ml_model_row.version_number in sync with the new version's own
    number."""
    db.query(models.MLModelVersion).filter(
        models.MLModelVersion.ml_model_id == ml_model_row.id,
        models.MLModelVersion.is_current.is_(True),
    ).update({"is_current": False})

    previous_max = (
        db.query(func.max(models.MLModelVersion.version_number))
        .filter(models.MLModelVersion.ml_model_id == ml_model_row.id)
        .scalar()
        or 0
    )
    next_version = previous_max + 1
    db.add(models.MLModelVersion(
        ml_model_id=ml_model_row.id,
        version_number=next_version,
        is_current=True,
        created_reason="trained",
        algorithm=ml_model_row.algorithm,
        feature_columns=ml_model_row.feature_columns,
        excluded_columns=ml_model_row.excluded_columns,
        model_artifact=ml_model_row.model_artifact,
        metrics=ml_model_row.metrics,
        feature_importance=ml_model_row.feature_importance,
        trained_row_count=ml_model_row.trained_row_count,
    ))
    ml_model_row.version_number = next_version


def _json_safe(value: Any) -> Any:
    """Converts a numpy scalar (what pandas/scikit-learn hand back from
    .predict()/.agg()/etc) into a plain Python type - neither this app's
    JSON DB columns nor its API responses can serialize a numpy type
    directly, the same conversion routers/dashboard_builder.py's own
    build_manual_block already needs for the identical reason."""
    if hasattr(value, "item"):
        try:
            return value.item()
        except (ValueError, TypeError):
            return value
    return value


def _candidates_for(task_type: str) -> list[tuple[str, Any]]:
    if task_type == "classification":
        return [
            ("logistic_regression", LogisticRegression(max_iter=1000)),
            ("random_forest_classifier", RandomForestClassifier(n_estimators=100, random_state=42)),
        ]
    return [
        ("linear_regression", LinearRegression()),
        ("random_forest_regressor", RandomForestRegressor(n_estimators=100, random_state=42)),
    ]


def _fail(ml_model_row: models.MLModel, message: str) -> None:
    ml_model_row.status = "failed"
    ml_model_row.error_message = message
    ml_model_row.model_artifact = None
    ml_model_row.metrics = None
    ml_model_row.algorithm = None
    ml_model_row.trained_at = datetime.utcnow()


def train_model(db, ml_model_row: models.MLModel, df: pd.DataFrame) -> None:
    """Trains `ml_model_row` against `df` and mutates it in place with the
    real result - never raises; every failure path (guard rail, or any
    other unexpected error) ends in a clean status="failed" plus an honest
    error_message, matching services/quality_checks.run_quality_rule's own
    "never crash, never leave a stale/ambiguous result" contract. The
    caller (routers/ml_models.py) still owns db.add/db.commit, same
    convention as run_quality_rule/log_audit_event elsewhere in this app -
    this function only mutates the row and returns.

    `ml_model_row.feature_columns` is read on entry as the REQUESTED
    feature list (None means "auto-select every usable column" - the
    wizard's zero-configuration default; a list means the wizard's
    "advanced: pick specific columns yourself" step, or - on a retrain -
    whichever real columns the previous training run actually used, since
    that is the closest honest proxy this app has for "the same feature
    config" once a request is no longer separately stored - see
    routers/ml_models.py's own retrain docstring for that limitation
    stated plainly) - it is then OVERWRITTEN with the real, actually-used
    list once training succeeds."""
    target_column = ml_model_row.target_column
    requested_features = ml_model_row.feature_columns

    try:
        if target_column not in df.columns:
            _fail(ml_model_row, f"Column '{target_column}' was not found in this data source's current data.")
            return

        usable_df = df.dropna(subset=[target_column]).copy()
        if len(usable_df) < MIN_TRAINING_ROWS:
            _fail(
                ml_model_row,
                f"Not enough data to train a reliable model - need at least {MIN_TRAINING_ROWS} rows with a "
                f"value in '{target_column}', this data only has {len(usable_df)}.",
            )
            return

        task_type = ml_model_row.task_type or infer_task_type(usable_df[target_column])

        if task_type == "classification":
            class_counts = usable_df[target_column].value_counts(dropna=True)
            if len(class_counts) < 2:
                _fail(
                    ml_model_row,
                    f"'{target_column}' only has one distinct value in this data, so there's nothing to "
                    "learn - every row would already get the same answer.",
                )
                return

        usable_features, excluded = select_features(usable_df, target_column, requested_features)
        if not usable_features:
            _fail(
                ml_model_row,
                "None of this data's other columns could be used to predict "
                f"'{target_column}' automatically - " + (
                    "; ".join(f"{e['column']}: {e['reason']}" for e in excluded)
                    if excluded else "there were no other columns to try."
                ),
            )
            return

        X = usable_df[usable_features]
        y = usable_df[target_column]

        stratify = None
        if task_type == "classification":
            class_counts = y.value_counts(dropna=True)
            if (class_counts >= 2).all():
                stratify = y

        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.2, random_state=42, stratify=stratify,
        )

        best_name = None
        best_pipeline = None
        best_score = None
        for algo_name, estimator in _candidates_for(task_type):
            preprocessing = build_preprocessing_pipeline(usable_df, usable_features)
            pipeline = Pipeline([("preprocess", preprocessing), ("model", estimator)])
            pipeline.fit(X_train, y_train)
            preds = pipeline.predict(X_test)
            score = accuracy_score(y_test, preds) if task_type == "classification" else r2_score(y_test, preds)
            # Ties go to the simpler model - _candidates_for lists the
            # simple linear/logistic candidate FIRST, so a strict ">" here
            # (rather than ">=") means the second, more complex candidate
            # (random forest) only ever wins when it is genuinely better.
            if best_score is None or score > best_score:
                best_name, best_pipeline, best_score = algo_name, pipeline, score

        test_preds = best_pipeline.predict(X_test)
        if task_type == "classification":
            metrics = {
                "accuracy": float(accuracy_score(y_test, test_preds)),
                "precision": float(precision_score(y_test, test_preds, average="weighted", zero_division=0)),
                "recall": float(recall_score(y_test, test_preds, average="weighted", zero_division=0)),
                "f1": float(f1_score(y_test, test_preds, average="weighted", zero_division=0)),
            }
        else:
            mse = mean_squared_error(y_test, test_preds)
            metrics = {
                "mae": float(mean_absolute_error(y_test, test_preds)),
                "rmse": float(np.sqrt(mse)),
                "r2": float(r2_score(y_test, test_preds)),
            }

        buffer = io.BytesIO()
        joblib.dump(best_pipeline, buffer)

        ml_model_row.task_type = task_type
        ml_model_row.feature_columns = usable_features
        ml_model_row.excluded_columns = excluded
        ml_model_row.algorithm = best_name
        ml_model_row.model_artifact = buffer.getvalue()
        ml_model_row.metrics = metrics
        # 2026-09-30 (model trustworthiness round): real, global feature
        # importance - see models.MLModel.feature_importance's own
        # docstring and _extract_feature_importance above.
        ml_model_row.feature_importance = _extract_feature_importance(best_pipeline)
        ml_model_row.status = "ready"
        ml_model_row.error_message = None
        ml_model_row.trained_row_count = len(usable_df)
        ml_model_row.trained_at = datetime.utcnow()
        # 2026-09-30 (model trustworthiness round): appends a real version
        # snapshot instead of letting the assignments above be this
        # model's only, silently-overwritten record of itself - see
        # _record_version's own docstring.
        _record_version(db, ml_model_row)
    except Exception as e:  # noqa: BLE001 - see this function's own docstring: never raise, always an honest failure
        _fail(ml_model_row, f"Training failed unexpectedly: {e}")


def _coerce_form_value(value: Any) -> Any:
    """Predict-time input can come straight from a plain HTML form (the
    "Try it" panel - see pages/MLModelDetail.tsx), which only ever
    hands back strings, even for a column that was numeric during training.
    The fitted pipeline's own numeric transformers (SimpleImputer/
    StandardScaler - see build_preprocessing_pipeline) need real numbers,
    not the string "42", so this converts a numeric-looking or boolean-
    looking string into its real Python type before it ever reaches
    pandas/scikit-learn - the same kind of light, honest coercion
    services/quality_checks.py already does with pd.to_numeric(errors=
    "coerce") for its own min/max checks. A value that isn't a real number
    or boolean-looking string, or an empty string, is left as-is (an empty
    string becomes None, treated as missing - filled in by the pipeline's
    own imputer, exactly like a form field someone left blank)."""
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if stripped == "":
        return None
    if stripped.lower() in ("true", "false"):
        return stripped.lower() == "true"
    try:
        f = float(stripped)
        return int(f) if f.is_integer() else f
    except ValueError:
        return value


def predict_one(ml_model_row: models.MLModel, input_values: dict) -> tuple[Any, float | None, list[dict] | None]:
    """Runs one prediction through `ml_model_row`'s fitted pipeline.
    Missing expected features in `input_values` are filled with None/NaN -
    the pipeline's own imputer (see build_preprocessing_pipeline) handles
    those exactly like a missing value anywhere else, rather than this
    function raising over a form field someone left blank. Every value is
    also passed through _coerce_form_value first, so a plain HTML form's
    string input for a numeric feature doesn't break the pipeline's own
    numeric transformers. Returns (predicted_value, confidence,
    explanation) - confidence is predict_proba's top-class probability for
    a classification model whose winning algorithm exposes one, else None
    (never a fabricated number); explanation is the real per-feature
    contribution breakdown from _explain_prediction (2026-09-30, model
    trustworthiness round) - linear/logistic models only, else None (see
    that function's own docstring). The fitted pipeline is loaded once
    here and reused for both the prediction and the explanation, rather
    than loading the same joblib artifact twice."""
    pipeline = joblib.load(io.BytesIO(ml_model_row.model_artifact))
    feature_columns = ml_model_row.feature_columns or []
    row = {col: _coerce_form_value(input_values.get(col)) for col in feature_columns}
    X = pd.DataFrame([row], columns=feature_columns)

    predicted_value = _json_safe(pipeline.predict(X)[0])

    confidence = None
    if ml_model_row.task_type == "classification" and hasattr(pipeline, "predict_proba"):
        try:
            proba = pipeline.predict_proba(X)[0]
            confidence = float(max(proba))
        except Exception:
            confidence = None

    try:
        explanation = _explain_prediction(pipeline, ml_model_row.algorithm, row, feature_columns)
    except Exception:
        # Same "never crash, never fabricate" contract as the rest of this
        # module (see this module's own docstring) - a genuinely unusable
        # explanation just means None, never a broken prediction response.
        explanation = None

    return predicted_value, confidence, explanation


def score_dataframe(ml_model_row: models.MLModel, df: pd.DataFrame) -> pd.DataFrame:
    """Runs `ml_model_row`'s fitted pipeline over every row of `df`,
    returning the ORIGINAL dataframe (same rows, same order, never
    mutated) with one new column appended -
    f"predicted_{ml_model_row.target_column}" - holding each row's real
    prediction. Any expected feature column missing from `df` is added as
    all-NaN (via reindex) so the pipeline's own imputer fills it in exactly
    like a missing value anywhere else, rather than this raising over a
    table that happens not to carry every original feature column."""
    pipeline = joblib.load(io.BytesIO(ml_model_row.model_artifact))
    feature_columns = ml_model_row.feature_columns or []
    X = df.reindex(columns=feature_columns)
    preds = pipeline.predict(X)

    result = df.copy()
    result[f"predicted_{ml_model_row.target_column}"] = preds
    return result
