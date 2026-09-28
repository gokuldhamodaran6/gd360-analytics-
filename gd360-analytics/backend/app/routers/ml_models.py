"""
2026-09-28 (ML Models round): train, list, view, predict with, bulk-score
with, retrain, and delete a real, deterministic machine learning model -
see models.MLModel/MLPrediction's own docstrings for the full design and
services/ml_training.py for how training/prediction/scoring actually work.

Always "ML Model(s)" in every route/response/docstring here - never just
"Model(s)" - a naming collision with the old "Saved Tables" feature (since
removed - see models.MLModel's own docstring) made that distinction matter
enough to keep the habit even now that the other feature is gone.

Access follows this app's existing two-tier convention exactly (see
services/workspace_access.py), the same split routers/quality_checks.py
already uses for an identical reason - training/retraining/deleting are
real building/destructive actions, predicting/scoring are not:
  - "editable" tier (can_edit_datasource): POST /train, POST /{id}/retrain.
  - "view" tier (can_access_datasource): GET /, GET /{id},
    POST /{id}/predict, POST /{id}/score - a workspace viewer can USE an
    already-trained model (predict/score), same as they can already re-run
    an existing quality check, but can't train or retrain one.
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
        status=ml_model.status,
        error_message=ml_model.error_message,
        trained_row_count=ml_model.trained_row_count,
        created_at=ml_model.created_at,
        trained_at=ml_model.trained_at,
        prediction_count=ml_model.prediction_count,
        last_predicted_at=ml_model.last_predicted_at,
        owner_id=ml_model.owner_id,
        can_delete=ml_model.owner_id == user.id,
    )


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
        predicted_value, confidence = ml_training.predict_one(ml_model, payload.input_values)
    except Exception as e:
        raise HTTPException(400, f"Couldn't make a prediction with the values given: {e}")

    prediction = models.MLPrediction(
        ml_model_id=ml_model.id,
        input_values=payload.input_values,
        predicted_value=predicted_value,
        confidence=confidence,
        created_by_id=user.id,
    )
    db.add(prediction)
    ml_model.prediction_count = (ml_model.prediction_count or 0) + 1
    ml_model.last_predicted_at = datetime.utcnow()
    db.add(ml_model)
    db.commit()
    return schemas.PredictOut(predicted_value=predicted_value, confidence=confidence)


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
def retrain_ml_model(ml_model_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Re-loads this model's own data source's current data and re-runs
    training in place, overwriting the previous artifact/metrics/
    feature_columns/excluded_columns entirely - the one-click "keep this
    model current" action. "editable" tier, same as the original train.

    Known v1 limitation, stated honestly rather than silently: this does
    NOT keep any history of the model's previous version(s) - once a
    retrain completes, the earlier metrics/artifact are gone. A future
    round could version these the same way DatasetVersion already versions
    saved tables, if that turns out to matter in practice."""
    ml_model = _get_editable_ml_model(db, user, ml_model_id)
    ds = db.query(models.DataSource).filter(models.DataSource.id == ml_model.datasource_id).first()
    if not ds:
        raise HTTPException(404, "This model's data source no longer exists.")

    try:
        df = load_dataframe(ds, db=db)
        df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
    except Exception as e:
        raise HTTPException(400, f"Could not load this data source's data: {e}")

    ml_training.train_model(db, ml_model, df)

    audit.log_audit_event(
        db, actor=user, action="ml_model_retrained", workspace_id=ds.workspace_id,
        target_type="ml_model", target_id=ml_model.id,
        metadata={"status": ml_model.status},
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
