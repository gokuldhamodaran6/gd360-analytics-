"""
2026-09-30 (semantic layer v1 round): create, list, view, update, and
delete a data source's saved metric glossary - see models.MetricDefinition's
own docstring for the full design and services/metrics.py for how a
metric's value is actually computed (the one shared place every consumer
in this app - this router's own live current_value, a dashboard's
metric-backed kpi/gauge block, and services/ai_engine.py's chat
integration - resolves a metric through).

Nested under /datasources/{datasource_id}/..., the same style routers/
quality_checks.py and routers/data_access_rules.py already use for a
data-source-scoped feature - one router, one consistent prefix, every
route below takes datasource_id as its first path parameter. The
dashboard builder's own metric-backed block building (routers/
dashboard_builder.py) and the chat engine's metric integration
(routers/chat.py + services/ai_engine.py) both query models.MetricDefinition
directly rather than calling through this router - this file is the
person-facing CRUD surface, not the only way this data is ever read.

Access follows this app's existing two-tier convention exactly (see
services/workspace_access.py), the same split routers/quality_checks.py
already uses for an identical reason:
  - "editable" tier (can_edit_datasource): POST (create), PUT (update) -
    defining or changing what a metric MEANS affects everyone who reads
    it, the same weight as adding/removing a quality check.
  - "view" tier (can_access_datasource): GET (list/get) - a workspace
    viewer can see and use an already-defined metric, same as they can
    already view an existing quality check, but can't define or change one.
  - DELETE is narrower still - the metric's own creator only
    (metric.owner_id == user.id), regardless of workspace role - the same
    creator-only rule routers/ml_models.py's delete_ml_model already uses,
    for the same reason: a metric other dashboards/chat answers may already
    depend on shouldn't disappear out from under a teammate just because
    they also happen to have edit access to the data source.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import audit, data_access_rules, workspace_access
from ..services.data_loader import load_dataframe
from ..services.metrics import resolve_metric_value

router = APIRouter(prefix="/datasources", tags=["metric-definitions"])


def _get_accessible_datasource(db: Session, user: models.User, datasource_id: str) -> models.DataSource:
    ds = db.query(models.DataSource).filter(models.DataSource.id == datasource_id).first()
    if not ds or not workspace_access.can_access_datasource(db, ds, user):
        raise HTTPException(404, "Datasource not found.")
    return ds


def _get_editable_datasource(db: Session, user: models.User, datasource_id: str) -> models.DataSource:
    ds = _get_accessible_datasource(db, user, datasource_id)
    if not workspace_access.can_edit_datasource(db, ds, user):
        raise HTTPException(403, "You have view-only access to this data source.")
    return ds


def _get_owned_metric(db: Session, ds: models.DataSource, metric_id: str) -> models.MetricDefinition:
    metric = (
        db.query(models.MetricDefinition)
        .filter(models.MetricDefinition.id == metric_id, models.MetricDefinition.datasource_id == ds.id)
        .first()
    )
    if not metric:
        raise HTTPException(404, "That metric no longer exists.")
    return metric


def _filters_payload(filters) -> list[dict]:
    """FilterCriterion objects (from a request body) -> plain dicts, the
    shape actually stored in MetricDefinition.filters and handed to
    services/metrics.py - never persists the Pydantic model itself."""
    return [{"column": f.column, "spec": f.spec} for f in (filters or [])]


def _metric_out(
    db: Session, ds: models.DataSource, metric: models.MetricDefinition, user: models.User, df=None, load_error: str | None = None,
) -> schemas.MetricDefinitionOut:
    """Builds the response, including a live current_value - `df`, when
    already loaded by the caller (list_metric_definitions loads it once
    and reuses it for every metric on this data source rather than
    reloading per-row), is reused as-is; a caller with only one metric to
    resolve (get/create/update) can leave it None and this loads it fresh.
    A data-load failure (load_error, or one raised here) never fails the
    whole request - it just means every metric's current_value comes back
    None with an honest current_value_error, exactly like a metric whose
    OWN column/filters can't resolve against otherwise-good data."""
    creator = db.query(models.User).filter(models.User.id == metric.owner_id).first()
    current_value = None
    current_value_error = load_error
    if df is None and load_error is None:
        try:
            df = load_dataframe(ds, db=db)
            df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
        except Exception as e:
            current_value_error = f"Could not load this data source's data: {e}"
    if df is not None and current_value_error is None:
        current_value, current_value_error = resolve_metric_value(
            df, metric.metric_column, metric.agg, metric.filters,
        )
    return schemas.MetricDefinitionOut(
        id=metric.id,
        datasource_id=metric.datasource_id,
        datasource_name=ds.name,
        name=metric.name,
        description=metric.description,
        metric_column=metric.metric_column,
        agg=metric.agg,
        filters=metric.filters or [],
        created_at=metric.created_at,
        updated_at=metric.updated_at,
        owner_id=metric.owner_id,
        created_by_name=creator.full_name if creator else None,
        current_value=current_value,
        current_value_error=current_value_error,
        can_delete=metric.owner_id == user.id,
    )


@router.post("/{datasource_id}/metric-definitions", response_model=schemas.MetricDefinitionOut, status_code=201)
def create_metric_definition(
    datasource_id: str,
    payload: schemas.MetricDefinitionCreate,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ds = _get_editable_datasource(db, user, datasource_id)

    name = payload.name.strip()
    existing = (
        db.query(models.MetricDefinition)
        .filter(models.MetricDefinition.datasource_id == ds.id, models.MetricDefinition.name.ilike(name))
        .first()
    )
    if existing:
        raise HTTPException(400, f'A metric named "{name}" already exists for this data source.')

    metric = models.MetricDefinition(
        datasource_id=ds.id,
        owner_id=user.id,
        name=name,
        description=(payload.description or "").strip() or None,
        metric_column=payload.metric_column,
        agg=payload.agg,
        filters=_filters_payload(payload.filters),
    )
    db.add(metric)
    db.flush()

    audit.log_audit_event(
        db, actor=user, action="metric_definition_created", workspace_id=ds.workspace_id,
        target_type="metric_definition", target_id=metric.id, metadata={"name": metric.name},
    )
    db.commit()
    db.refresh(metric)
    return _metric_out(db, ds, metric, user)


@router.get("/{datasource_id}/metric-definitions", response_model=list[schemas.MetricDefinitionOut])
def list_metric_definitions(datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ds = _get_accessible_datasource(db, user, datasource_id)
    rows = (
        db.query(models.MetricDefinition)
        .filter(models.MetricDefinition.datasource_id == ds.id)
        .order_by(models.MetricDefinition.name.asc())
        .all()
    )
    if not rows:
        return []
    df, load_error = None, None
    try:
        df = load_dataframe(ds, db=db)
        df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
    except Exception as e:
        load_error = f"Could not load this data source's data: {e}"
    return [_metric_out(db, ds, m, user, df=df, load_error=load_error) for m in rows]


@router.get("/{datasource_id}/metric-definitions/{metric_id}", response_model=schemas.MetricDefinitionOut)
def get_metric_definition(
    datasource_id: str, metric_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user),
):
    ds = _get_accessible_datasource(db, user, datasource_id)
    metric = _get_owned_metric(db, ds, metric_id)
    return _metric_out(db, ds, metric, user)


@router.put("/{datasource_id}/metric-definitions/{metric_id}", response_model=schemas.MetricDefinitionOut)
def update_metric_definition(
    datasource_id: str,
    metric_id: str,
    payload: schemas.MetricDefinitionUpdate,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ds = _get_editable_datasource(db, user, datasource_id)
    metric = _get_owned_metric(db, ds, metric_id)

    name = payload.name.strip()
    existing = (
        db.query(models.MetricDefinition)
        .filter(
            models.MetricDefinition.datasource_id == ds.id,
            models.MetricDefinition.id != metric.id,
            models.MetricDefinition.name.ilike(name),
        )
        .first()
    )
    if existing:
        raise HTTPException(400, f'A metric named "{name}" already exists for this data source.')

    metric.name = name
    metric.description = (payload.description or "").strip() or None
    metric.metric_column = payload.metric_column
    metric.agg = payload.agg
    metric.filters = _filters_payload(payload.filters)

    audit.log_audit_event(
        db, actor=user, action="metric_definition_updated", workspace_id=ds.workspace_id,
        target_type="metric_definition", target_id=metric.id, metadata={"name": metric.name},
    )
    db.commit()
    db.refresh(metric)
    return _metric_out(db, ds, metric, user)


@router.delete("/{datasource_id}/metric-definitions/{metric_id}", status_code=204)
def delete_metric_definition(
    datasource_id: str, metric_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user),
):
    """Creator-only, regardless of workspace edit access - see this
    module's own docstring for why (mirrors routers/ml_models.py's
    delete_ml_model)."""
    ds = _get_accessible_datasource(db, user, datasource_id)
    metric = _get_owned_metric(db, ds, metric_id)
    if metric.owner_id != user.id:
        raise HTTPException(403, "Only the person who created this metric can delete it.")

    audit.log_audit_event(
        db, actor=user, action="metric_definition_deleted", workspace_id=ds.workspace_id,
        target_type="metric_definition", target_id=metric.id, metadata={"name": metric.name},
    )
    db.delete(metric)
    db.commit()
    return None
