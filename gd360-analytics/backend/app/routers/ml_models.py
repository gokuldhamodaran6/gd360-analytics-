"""
2026-09-28 (ML Models round): train, list, view, predict with, bulk-score
with, retrain, and delete a real, deterministic machine learning model -
see models.MLModel/MLPrediction's own docstrings for the full design and
services/ml_training.py for how training/prediction/scoring actually work.

Always "ML Model(s)" in every route/response/docstring here - never just
"Model(s)" - a naming collision with the old "Saved Tables" feature (since
removed - see models.MLModel's own docstring) made that distinction matter
enough to keep the habit even now that the other feature is gone.

2026-09-30 (model trustworthiness round): two additions on top of the
above. (1) predict_with_ml_model now also returns and saves a real
per-prediction explanation (see models.MLPrediction.explanation's own
docstring and services/ml_training._explain_prediction) alongside which
exact MLModelVersion made the prediction. (2) two new endpoints -
GET /{id}/versions and POST /{id}/versions/{version_id}/promote - expose
the real, append-only version history retrain_ml_model now builds (see
models.MLModelVersion's own docstring) instead of the "no history is kept"
limitation this file used to state plainly.

2026-09-30 (leakage-guardrail round): a real, confirmed case of target
leakage in a live model ("predict Sales" scoring r2=0.9999999999913826
because two of its own auto-picked features were a simple arithmetic
decomposition of Sales itself - see services/ml_training.py's own module
docstring for the full story) exposed that this file had no way to see
what a training run was ABOUT to use before committing to it, and no way
to flag a suspicious RESULT after the fact either. Two additions close
that gap, both "view" tier since neither trains or mutates anything:
POST /preview-features (new) runs services/ml_training.preview_features
against real data with zero side effects - no MLModel row created, no
training run - so TrainModelWizard.tsx's step 3 can show real leakage-risk
information BEFORE a person commits to training, not after. quality_
warnings (already returned wherever an MLModelOut/MLModelVersionOut is)
is real, threshold-based information about an ALREADY-trained result -
see models.MLModel.quality_warnings's own docstring. retrain_ml_model also
now optionally accepts a narrower feature_columns list (schemas.
RetrainMLModelRequest), the one gap that made fixing that exact live model
require a direct database edit rather than a real product action.

Access follows this app's existing two-tier convention exactly (see
services/workspace_access.py), the same split routers/quality_checks.py
already uses for an identical reason - training/retraining/deleting/
promoting a version are real building/destructive actions, predicting/
scoring/viewing history/previewing are not:
  - "editable" tier (can_edit_datasource): POST /train, POST /{id}/retrain,
    POST /{id}/versions/{version_id}/promote - promoting changes what
    predict/score actually do, same weight as a retrain.
  - "view" tier (can_access_datasource): GET /, GET /{id},
    GET /{id}/versions, POST /preview-features, POST /{id}/predict,
    POST /{id}/score - a workspace viewer can USE an already-trained
    model, see its real history, and preview what a hypothetical training
    run would use, same as they can already re-run an existing quality
    check, but can't train, retrain, or promote a version.
  - DELETE /{id} is narrower still - the model's own creator only
    (ml_model.owner_id == user.id), regardless of workspace role; not even
    the data source's own owner can delete another person's trained model
    out from under them here (see delete_ml_model's own docstring).
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import audit, data_access_rules, ml_training, workspace_access
from ..services.data_loader import dataframe_to_csv_bytes, load_dataframe, purpose_label

router = APIRouter(prefix="/ml-models", tags=["ml-models"])


def _get_accessible_datasource(db: Session, user: models.User, datasource_id: str) -> models.DataSource:
    ds = db.query(models.DataSource).filter(models.DataSource.id == datasource_id).first()
    if not ds or not workspace_access.can_access_datasource(db, ds, user):
        raise HTTPException(404, "Data source not found.")
    return ds


def _get_editable_datasource(db: Session, user: models.User, datasource_id: str) -> models.DataSource:
    ds = _get_accessible_datasource(db, user, datasource_id)
    if not workspace_access.can_edit_datasource(db, ds, user):
        raise HTTPException(403, "You have view-only access to this data source.")
    return ds


def _get_accessible_ml_model(db: Session, user: models.User, ml_model_id: str) -> models.MLModel:
    """The "view" tier check for one ML model - fetches it and its
    datasource together, 404s (never 403) if either doesn't exist or the
    caller can't see the underlying data source, matching
    services/workspace_access.py's own "not accessible 404s, never leaks
    existence" convention."""
    ml_model = db.query(models.MLModel).filter(models.MLModel.id == ml_model_id).first()
    if not ml_model:
        raise HTTPException(404, "That ML model no longer exists.")
    ds = db.query(models.DataSource).filter(models.DataSource.id == ml_model.datasource_id).first()
    if not ds or not workspace_access.can_access_datasource(db, ds, user):
        raise HTTPException(404, "That ML model no longer exists.")
    return ml_model


def _get_editable_ml_model(db: Session, user: models.User, ml_model_id: str) -> models.MLModel:
    ml_model = _get_accessible_ml_model(db, user, ml_model_id)
    ds = db.query(models.DataSource).filter(models.DataSource.id == ml_model.datasource_id).first()
    if not ds or not workspace_access.can_edit_datasource(db, ds, user):
        raise HTTPException(403, "You have view-only access to this data source.")
    return ml_model


def _model_out(db: Session, ml_model: models.MLModel, user: models.User) -> schemas.MLModelOut:
    ds = db.query(models.DataSource).filter(models.DataSource.id == ml_model.datasource_id).first()
    return schemas.MLModelOut(
        id=ml_model.id,
        datasource_id=ml_model.datasource_id,
        datasource_name=ds.name if ds else "(deleted data source)",
        name=ml_model.name,
        description=ml_model.description,
        task_type=ml_model.task_type,
        target_column=ml_model.target_column,
        feature_columns=ml_model.feature_columns,
        excluded_columns=ml_model.excluded_columns or [],
        algorithm=ml_model.algorithm,
        metrics=ml_model.metrics,
        feature_importance=ml_model.feature_importance,
        # See models.MLModel.quality_warnings's own docstring - None stays
        # None (a model trained before this round existed), never coerced
        # into a fabricated empty list that would misread as "checked,
        # clean".
        quality_warnings=ml_model.quality_warnings,
        status=ml_model.status,
        error_message=ml_model.error_message,
        trained_row_count=ml_model.trained_row_count,
        created_at=ml_model.created_at,
        trained_at=ml_model.trained_at,
        prediction_count=ml_model.prediction_count,
        last_predicted_at=ml_model.last_predicted_at,
        version_number=ml_model.version_number,
        owner_id=ml_model.owner_id,
        can_delete=ml_model.owner_id == user.id,
    )


def _current_version(db: Session, ml_model_id: str) -> models.MLModelVersion | None:
    """The one MLModelVersion with is_current=True for this model, or None
    for a model trained before this round ever ran (or one still
    training/failed, which never gets a version row - see
    services/ml_training._record_version)."""
    return (
        db.query(models.MLModelVersion)
        .filter(models.MLModelVersion.ml_model_id == ml_model_id, models.MLModelVersion.is_current.is_(True))
        .first()
    )


@router.post("/preview-features", response_model=schemas.PreviewMLFeaturesResponse)
def preview_ml_features(
    payload: schemas.PreviewMLFeaturesRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """2026-09-30 (leakage-guardrail round): the real, computed "what would
    training actually use, and does any of it look risky" answer - WITHOUT
    training anything. No MLModel row is created, nothing is written to
    the database at all; this loads real data and runs services/
    ml_training.preview_features against it, same as GET /{id}/versions
    reads real history without changing anything. "view" tier
    (can_access_datasource) rather than "editable" - this genuinely can't
    mutate anything a viewer shouldn't be allowed to see the shape of, the
    same reasoning GET /{id} already uses for an already-trained model.

    Exists specifically so TrainModelWizard.tsx's step 3 can show real
    leakage-risk information (a numeric feature highly correlated with a
    regression target) BEFORE a person commits to training, not after -
    the direct fix for the "predict Sales" case this whole round is named
    after, where nothing in the product ever surfaced that Gross Profit/
    Cost were about to go in as features until the (already leaked) result
    came back. MLModelDetail.tsx's own "change which columns are used"
    retrain flow reuses this exact same endpoint against an EXISTING
    model's datasource/target_column, so the same real risk information is
    available there too, not just at initial training."""
    ds = _get_accessible_datasource(db, user, payload.datasource_id)

    try:
        df = load_dataframe(ds, db=db)
        df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
    except Exception as e:
        raise HTTPException(400, f"Could not load this data source's data: {e}")

    try:
        preview = ml_training.preview_features(df, payload.target_column)
    except ValueError as e:
        raise HTTPException(400, str(e))

    return schemas.PreviewMLFeaturesResponse(**preview)


@router.post("/train", response_model=schemas.MLModelOut, status_code=201)
def train_ml_model(
    payload: schemas.TrainMLModelRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Creates a new ML model and trains it immediately, synchronously, in
    this same request - the same "no separate save-a-draft-then-run-it-
    later step" convention routers/quality_checks.py's create_quality_rule
    already uses. Training on the realistic dataset sizes this app deals
    with (hundreds to low tens-of-thousands of rows, two small model
    candidates) takes a few seconds - fine to run inline rather than
    standing up a background job queue this app doesn't otherwise have.

    A training run that completes but can't produce a usable model (not
    enough data, a target with only one distinct value, no usable feature
    columns) is still a 200/201 with status="failed" and a real, honest
    error_message on the returned row - the REQUEST itself was valid, the
    DATA just wasn't trainable, so this is never a 400/500. See
    services/ml_training.train_model's own docstring for the complete list
    of guard rails."""
    ds = _get_editable_datasource(db, user, payload.datasource_id)

    try:
        df = load_dataframe(ds, db=db)
        df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
    except Exception as e:
        raise HTTPException(400, f"Could not load this data source's data: {e}")

    ml_model = models.MLModel(
        owner_id=user.id,
        workspace_id=ds.workspace_id,
        datasource_id=ds.id,
        name=payload.name.strip(),
        description=(payload.description or "").strip() or None,
        target_column=payload.target_column,
        feature_columns=payload.feature_columns,  # read as the REQUESTED list by train_model, then overwritten
        status="training",
    )
    db.add(ml_model)
    db.flush()

    ml_training.train_model(db, ml_model, df)

    audit.log_audit_event(
        db, actor=user, action="ml_model_trained", workspace_id=ds.workspace_id,
        target_type="ml_model", target_id=ml_model.id,
        metadata={"status": ml_model.status, "task_type": ml_model.task_type},
    )
    db.commit()
    db.refresh(ml_model)
    return _model_out(db, ml_model, user)


@router.get("", response_model=list[schemas.MLModelOut])
def list_ml_models(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Every ML model this caller can at least view, across EVERY data
    source they have access to - their own, plus anything shared into a
    workspace they're a member of - newest-trained first. Uses this app's
    standard cross-datasource access-filter pattern
    (workspace_access.datasource_access_filter) rather than inventing a
    second, parallel access model just for this gallery."""
    ds_ids = {
        row[0]
        for row in db.query(models.DataSource.id).filter(workspace_access.datasource_access_filter(db, user)).all()
    }
    if not ds_ids:
        return []
    rows = (
        db.query(models.MLModel)
        .filter(models.MLModel.datasource_id.in_(ds_ids))
        .order_by(models.MLModel.created_at.desc())
        .all()
    )
    return [_model_out(db, m, user) for m in rows]


@router.get("/{ml_model_id}", response_model=schemas.MLModelOut)
def get_ml_model(ml_model_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ml_model = _get_accessible_ml_model(db, user, ml_model_id)
    return _model_out(db, ml_model, user)


@router.post("/{ml_model_id}/predict", response_model=schemas.PredictOut)
def predict_with_ml_model(
    ml_model_id: str,
    payload: schemas.PredictRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """A single real prediction from one already-trained model - "view"
    tier (a workspace viewer can use an already-trained model, same as
    they can already re-run an existing quality check). 400 if the model
    isn't status="ready" yet (still training is not possible by the time a
    request can reach this - training is synchronous - so in practice this
    only ever fires for status="failed": there is no usable model to
    predict with)."""
    ml_model = _get_accessible_ml_model(db, user, ml_model_id)
    if ml_model.status != "ready":
        raise HTTPException(400, "This model isn't ready to use yet - " + (ml_model.error_message or "training hasn't completed successfully."))

    try:
        predicted_value, confidence, explanation = ml_training.predict_one(ml_model, payload.input_values)
    except Exception as e:
        raise HTTPException(400, f"Couldn't make a prediction with the values given: {e}")

    current_version = _current_version(db, ml_model.id)
    prediction = models.MLPrediction(
        ml_model_id=ml_model.id,
        model_version_id=current_version.id if current_version else None,
        input_values=payload.input_values,
        predicted_value=predicted_value,
        confidence=confidence,
        explanation=explanation,
        created_by_id=user.id,
    )
    db.add(prediction)
    ml_model.prediction_count = (ml_model.prediction_count or 0) + 1
    ml_model.last_predicted_at = datetime.utcnow()
    db.add(ml_model)
    db.commit()
    return schemas.PredictOut(predicted_value=predicted_value, confidence=confidence, explanation=explanation)


@router.post("/{ml_model_id}/score", response_model=schemas.ScoreTableOut)
def score_table_with_ml_model(
    ml_model_id: str,
    payload: schemas.ScoreTableRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Scores every row of one table/sheet of this model's OWN data source
    (payload.table - None means the source's default/original table) and
    saves the result as a new saved table (DatasetVersion) on that same
    data source, exactly the way a chat cleaning/prep prompt already
    becomes its own new saved table (see routers/chat.py
    _save_cleaning_result, whose position-numbering/cleaning_log pattern
    this mirrors) - never overwriting anything, and immediately browsable
    from the Data tab. "view" tier, same reasoning as predict above."""
    ml_model = _get_accessible_ml_model(db, user, ml_model_id)
    if ml_model.status != "ready":
        raise HTTPException(400, "This model isn't ready to use yet - " + (ml_model.error_message or "training hasn't completed successfully."))

    ds = db.query(models.DataSource).filter(models.DataSource.id == ml_model.datasource_id).first()
    if not ds:
        raise HTTPException(404, "This model's data source no longer exists.")

    try:
        df = load_dataframe(ds, table=payload.table, version="original", db=db)
        df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
    except Exception as e:
        raise HTTPException(400, f"Could not load this data source's data: {e}")

    try:
        scored_df = ml_training.score_dataframe(ml_model, df)
    except Exception as e:
        raise HTTPException(400, f"Couldn't score this table: {e}")

    max_position = (
        db.query(func.max(models.DatasetVersion.position))
        .filter(models.DatasetVersion.datasource_id == ds.id)
        .scalar()
        or 0
    )
    label = purpose_label(f"Scored with {ml_model.name}")
    log_entry = {
        "prompt": f"Scored with ML model '{ml_model.name}' (predicted '{ml_model.target_column}')",
        "summary": f"Added a predicted_{ml_model.target_column} column using the '{ml_model.name}' ML model.",
        "rows_before": len(df),
        "rows_after": len(scored_df),
        "nulls_before": None,
        "nulls_after": None,
        "created_at": datetime.utcnow().isoformat(),
    }
    new_version = models.DatasetVersion(
        datasource_id=ds.id,
        name=label,
        parent_version_id=None,
        parent_version_ids=None,
        data=dataframe_to_csv_bytes(scored_df),
        cleaning_log=[log_entry],
        position=max_position + 1,
    )
    db.add(new_version)

    ml_model.prediction_count = (ml_model.prediction_count or 0) + len(scored_df)
    ml_model.last_predicted_at = datetime.utcnow()
    db.add(ml_model)

    audit.log_audit_event(
        db, actor=user, action="ml_model_scored", workspace_id=ds.workspace_id,
        target_type="ml_model", target_id=ml_model.id, metadata={"row_count": len(scored_df)},
    )
    db.commit()
    db.refresh(new_version)

    return schemas.ScoreTableOut(new_version_id=new_version.id, new_version_name=new_version.name, row_count=len(scored_df))


@router.post("/{ml_model_id}/retrain", response_model=schemas.MLModelOut)
def retrain_ml_model(
    ml_model_id: str,
    payload: schemas.RetrainMLModelRequest | None = None,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Re-loads this model's own data source's current data and re-runs
    training, replacing MLModel's own current artifact/metrics/
    feature_columns/excluded_columns with the new result - the one-click
    "keep this model current" action. "editable" tier, same as the
    original train.

    2026-09-30 (model trustworthiness round): this no longer discards the
    model's previous version. services/ml_training.train_model appends a
    real MLModelVersion snapshot on every successful run (this one
    included) before returning - see that function's own docstring and
    models.MLModelVersion's. GET /{id}/versions lists the full history;
    POST /{id}/versions/{version_id}/promote rolls back to an earlier one
    with no retraining involved.

    2026-09-30 (leakage-guardrail round): `payload` is now optional and,
    when omitted (a plain "Retrain with latest data" click still sends no
    body at all - unchanged from before this round), behaves exactly as it
    always has. When given with a real feature_columns list (Mldetail.tsx's
    new "change which columns are used" flow), that list REPLACES this
    model's own feature_columns BEFORE train_model runs, narrowing the
    candidate columns train_model reads as `requested_features` - see that
    function's own docstring for why that's the honest way to change a
    model's feature config: every requested column still goes through
    select_features's exact same exclusion checks, so this can't be used
    to force in a column that genuinely isn't usable."""
    ml_model = _get_editable_ml_model(db, user, ml_model_id)
    ds = db.query(models.DataSource).filter(models.DataSource.id == ml_model.datasource_id).first()
    if not ds:
        raise HTTPException(404, "This model's data source no longer exists.")

    try:
        df = load_dataframe(ds, db=db)
        df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
    except Exception as e:
        raise HTTPException(400, f"Could not load this data source's data: {e}")

    if payload is not None and payload.feature_columns is not None:
        ml_model.feature_columns = payload.feature_columns

    ml_training.train_model(db, ml_model, df)

    audit.log_audit_event(
        db, actor=user, action="ml_model_retrained", workspace_id=ds.workspace_id,
        target_type="ml_model", target_id=ml_model.id,
        metadata={"status": ml_model.status},
    )
    db.commit()
    db.refresh(ml_model)
    return _model_out(db, ml_model, user)


@router.get("/{ml_model_id}/versions", response_model=list[schemas.MLModelVersionOut])
def list_ml_model_versions(
    ml_model_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user),
):
    """Every real version of this model, newest first - "view" tier, same
    as GET /{id}: a workspace viewer can see a model's real history
    exactly like they can already see its current results, without being
    able to change which version is active (that's promote, below,
    "editable" tier). See models.MLModelVersion's own docstring - a model
    trained before this round has zero versions here rather than a
    backfilled/guessed one, an honest gap rather than invented history."""
    ml_model = _get_accessible_ml_model(db, user, ml_model_id)
    rows = (
        db.query(models.MLModelVersion)
        .filter(models.MLModelVersion.ml_model_id == ml_model.id)
        .order_by(models.MLModelVersion.version_number.desc())
        .all()
    )
    return [
        schemas.MLModelVersionOut(
            id=v.id,
            version_number=v.version_number,
            is_current=v.is_current,
            created_reason=v.created_reason,
            algorithm=v.algorithm,
            metrics=v.metrics,
            feature_importance=v.feature_importance,
            quality_warnings=v.quality_warnings,
            trained_row_count=v.trained_row_count,
            created_at=v.created_at,
        )
        for v in rows
    ]


@router.post("/{ml_model_id}/versions/{version_id}/promote", response_model=schemas.MLModelOut)
def promote_ml_model_version(
    ml_model_id: str,
    version_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Makes an earlier MLModelVersion active again, with no retraining
    involved - the "roll back to this version" action (see
    models.MLModelVersion's own docstring for the full design). Copies
    that version's own algorithm/feature_columns/excluded_columns/
    model_artifact/metrics/feature_importance/trained_row_count straight
    onto the live MLModel row (exactly what predict/score/score actually
    read), then appends ONE MORE new version (created_reason="promoted")
    at the next version number rather than reaching back and re-activating
    old history in place - promoting is itself a real, timestamped event
    in this model's own history, and "what's active right now" always has
    exactly one honest answer. "editable" tier, same weight as retrain -
    this changes what predict/score actually do for every future call."""
    ml_model = _get_editable_ml_model(db, user, ml_model_id)
    version = (
        db.query(models.MLModelVersion)
        .filter(models.MLModelVersion.id == version_id, models.MLModelVersion.ml_model_id == ml_model.id)
        .first()
    )
    if not version:
        raise HTTPException(404, "That version no longer exists.")

    db.query(models.MLModelVersion).filter(
        models.MLModelVersion.ml_model_id == ml_model.id,
        models.MLModelVersion.is_current.is_(True),
    ).update({"is_current": False})

    next_version_number = (
        db.query(func.max(models.MLModelVersion.version_number))
        .filter(models.MLModelVersion.ml_model_id == ml_model.id)
        .scalar()
        or 0
    ) + 1
    db.add(models.MLModelVersion(
        ml_model_id=ml_model.id,
        version_number=next_version_number,
        is_current=True,
        created_reason="promoted",
        algorithm=version.algorithm,
        feature_columns=version.feature_columns,
        excluded_columns=version.excluded_columns,
        model_artifact=version.model_artifact,
        metrics=version.metrics,
        feature_importance=version.feature_importance,
        quality_warnings=version.quality_warnings,
        trained_row_count=version.trained_row_count,
    ))

    ml_model.algorithm = version.algorithm
    ml_model.feature_columns = version.feature_columns
    ml_model.excluded_columns = version.excluded_columns
    ml_model.model_artifact = version.model_artifact
    ml_model.metrics = version.metrics
    ml_model.feature_importance = version.feature_importance
    ml_model.quality_warnings = version.quality_warnings
    ml_model.trained_row_count = version.trained_row_count
    ml_model.status = "ready"
    ml_model.error_message = None
    ml_model.version_number = next_version_number

    ds = db.query(models.DataSource).filter(models.DataSource.id == ml_model.datasource_id).first()
    audit.log_audit_event(
        db, actor=user, action="ml_model_version_promoted", workspace_id=ds.workspace_id if ds else None,
        target_type="ml_model", target_id=ml_model.id,
        metadata={"promoted_version_number": version.version_number, "new_version_number": next_version_number},
    )
    db.commit()
    db.refresh(ml_model)
    return _model_out(db, ml_model, user)


@router.delete("/{ml_model_id}", status_code=204)
def delete_ml_model(ml_model_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Creator-only - deliberately narrower than the "editable" tier every
    other write in this router uses: this is one person deleting their OWN
    trained model, not a shared-datasource collaboration action, so not
    even a teammate with edit access on the underlying data source (let
    alone its owner) can delete a model here that they didn't train
    themselves."""
    ml_model = _get_accessible_ml_model(db, user, ml_model_id)
    if ml_model.owner_id != user.id:
        raise HTTPException(403, "Only the person who trained this model can delete it.")
    ds = db.query(models.DataSource).filter(models.DataSource.id == ml_model.datasource_id).first()
    db.delete(ml_model)
    audit.log_audit_event(
        db, actor=user, action="ml_model_deleted", workspace_id=ds.workspace_id if ds else None,
        target_type="ml_model", target_id=ml_model_id,
    )
    db.commit()
    return None
