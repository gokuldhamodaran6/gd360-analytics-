"""
2026-09-30 (transformation layer v1 round): create, list, view, update, and
delete a data source's saved transforms - see models.DataTransform's own
docstring for the full design and services/transforms.py for how a
transform's output is actually computed (the one shared place every
consumer in this app - this router's own live preview, a dashboard's
transform-backed block, and services/ai_engine.py's chat integration -
resolves a transform through).

Nested under /datasources/{datasource_id}/..., the same style routers/
metric_definitions.py, routers/quality_checks.py, and routers/
data_access_rules.py already use for a data-source-scoped feature - one
router, one consistent prefix, every route below takes datasource_id as
its first path parameter. The dashboard builder's own transform-backed
block building (routers/dashboard_builder.py) and the chat engine's
transform integration (routers/chat.py + services/ai_engine.py) both query
models.DataTransform directly rather than calling through this router -
this file is the person-facing CRUD + preview surface, not the only way
this data is ever read.

Access follows this app's existing two-tier convention exactly (see
services/workspace_access.py), the same split routers/metric_definitions.py
already uses for an identical reason:
  - "editable" tier (can_edit_datasource): POST (create), PUT (update),
    POST .../preview (building/editing a transform, even before it's
    saved, is an editing action) - defining or changing what a saved table
    MEANS affects everyone who reads it, the same weight as defining a
    metric.
  - "view" tier (can_access_datasource): GET (list/get) - a workspace
    viewer can see and use an already-saved transform, same as they can
    already view an existing metric, but can't define or change one.
  - DELETE is narrower still - the transform's own creator only
    (transform.owner_id == user.id), regardless of workspace role - the
    same creator-only rule routers/metric_definitions.py's
    delete_metric_definition (and routers/ml_models.py's delete_ml_model)
    already use, for the same reason: a saved table other dashboards/chat
    answers may already depend on shouldn't disappear out from under a
    teammate just because they also happen to have edit access to the
    data source.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import audit, data_access_rules, workspace_access
from ..services.data_loader import load_dataframe
from ..services.transforms import apply_transform_steps, describe_transform

router = APIRouter(prefix="/datasources", tags=["data-transforms"])

# A builder/list preview never needs more than a handful of rows to show
# someone what their transform produces - kept well below
# dashboard_builder.py's own _MAX_TABLE_ROWS_PER_BLOCK (200), since this is
# purely a "does this look right" check, not a real table view.
_PREVIEW_ROW_LIMIT = 50


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


def _get_owned_transform(db: Session, ds: models.DataSource, transform_id: str) -> models.DataTransform:
    transform = (
        db.query(models.DataTransform)
        .filter(models.DataTransform.id == transform_id, models.DataTransform.datasource_id == ds.id)
        .first()
    )
    if not transform:
        raise HTTPException(404, "That saved table no longer exists.")
    return transform


def _preview_from_df(df, steps: list[dict]) -> tuple[list[str] | None, int | None, str | None]:
    """Runs `steps` against `df` and returns (columns, row_count, error) -
    never the actual row data (see _rows_preview_from_df below for that,
    used only by the dedicated preview endpoints, which need real rows to
    show; the list/get responses only ever need the shape + count for
    their summary card)."""
    result, error = apply_transform_steps(df, steps)
    if error:
        return None, None, error
    return [str(c) for c in result.columns], int(len(result)), None


def _rows_preview_from_df(df, steps: list[dict]) -> schemas.TransformPreviewOut:
    result, error = apply_transform_steps(df, steps)
    if error:
        return schemas.TransformPreviewOut(error=error)
    truncated = len(result) > _PREVIEW_ROW_LIMIT
    preview = result.head(_PREVIEW_ROW_LIMIT)
    # NaN/NaT/inf are not valid JSON - the same "make it JSON-safe before
    # it ever reaches a response" step every other tidy-result path in this
    # app already takes (see chart_builder.result_to_tidy).
    preview = preview.where(preview.notna(), None)
    return schemas.TransformPreviewOut(
        columns=[str(c) for c in result.columns],
        rows=preview.to_dict("records"),
        row_count=int(len(result)),
        truncated=truncated,
    )


def _load_ds_df(db: Session, ds: models.DataSource, user: models.User):
    """Returns (df, error) - never raises. Transforms are defined against
    this data source's own original, untouched data (see models.
    DataTransform's own docstring: "turns one data source's raw table into
    a new, named derived table") - the same "original" version
    build_manual_block already loads for a plain manual block."""
    try:
        df = load_dataframe(ds, table=None, version="original", db=db)
        df = data_access_rules.filter_dataframe_for_role(db, df, ds, user)
        return df, None
    except Exception as e:
        return None, f"Could not load this data source's data: {e}"


def _transform_out(
    db: Session, ds: models.DataSource, transform: models.DataTransform, user: models.User,
    df=None, load_error: str | None = None,
) -> schemas.DataTransformOut:
    """Builds the response, including a live preview shape - `df`, when
    already loaded by the caller (list_transforms loads it once and reuses
    it for every transform on this data source rather than reloading per-
    row), is reused as-is; a caller with only one transform to resolve
    (get/create/update) can leave it None and this loads it fresh. A
    data-load failure never fails the whole request - it just means every
    transform's preview comes back empty with an honest preview_error."""
    creator = db.query(models.User).filter(models.User.id == transform.owner_id).first()
    preview_columns, preview_row_count, preview_error = None, None, load_error
    if df is None and load_error is None:
        df, preview_error = _load_ds_df(db, ds, user)
    if df is not None and preview_error is None:
        preview_columns, preview_row_count, preview_error = _preview_from_df(df, transform.steps or [])
    return schemas.DataTransformOut(
        id=transform.id,
        datasource_id=transform.datasource_id,
        datasource_name=ds.name,
        name=transform.name,
        description=transform.description,
        steps=transform.steps or [],
        step_summary=describe_transform(transform.steps or []),
        created_at=transform.created_at,
        updated_at=transform.updated_at,
        owner_id=transform.owner_id,
        created_by_name=creator.full_name if creator else None,
        preview_columns=preview_columns,
        preview_row_count=preview_row_count,
        preview_error=preview_error,
        can_delete=transform.owner_id == user.id,
    )


@router.post("/{datasource_id}/transforms", response_model=schemas.DataTransformOut, status_code=201)
def create_transform(
    datasource_id: str,
    payload: schemas.DataTransformCreate,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ds = _get_editable_datasource(db, user, datasource_id)

    name = payload.name.strip()
    existing = (
        db.query(models.DataTransform)
        .filter(models.DataTransform.datasource_id == ds.id, models.DataTransform.name.ilike(name))
        .first()
    )
    if existing:
        raise HTTPException(400, f'A saved table named "{name}" already exists for this data source.')

    transform = models.DataTransform(
        datasource_id=ds.id,
        owner_id=user.id,
        name=name,
        description=(payload.description or "").strip() or None,
        steps=payload.steps or [],
    )
    db.add(transform)
    db.flush()

    audit.log_audit_event(
        db, actor=user, action="data_transform_created", workspace_id=ds.workspace_id,
        target_type="data_transform", target_id=transform.id, metadata={"name": transform.name},
    )
    db.commit()
    db.refresh(transform)
    return _transform_out(db, ds, transform, user)


@router.get("/{datasource_id}/transforms", response_model=list[schemas.DataTransformOut])
def list_transforms(datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ds = _get_accessible_datasource(db, user, datasource_id)
    rows = (
        db.query(models.DataTransform)
        .filter(models.DataTransform.datasource_id == ds.id)
        .order_by(models.DataTransform.name.asc())
        .all()
    )
    if not rows:
        return []
    df, load_error = _load_ds_df(db, ds, user)
    return [_transform_out(db, ds, t, user, df=df, load_error=load_error) for t in rows]


@router.get("/{datasource_id}/transforms/{transform_id}", response_model=schemas.DataTransformOut)
def get_transform(
    datasource_id: str, transform_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user),
):
    ds = _get_accessible_datasource(db, user, datasource_id)
    transform = _get_owned_transform(db, ds, transform_id)
    return _transform_out(db, ds, transform, user)


@router.put("/{datasource_id}/transforms/{transform_id}", response_model=schemas.DataTransformOut)
def update_transform(
    datasource_id: str,
    transform_id: str,
    payload: schemas.DataTransformUpdate,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ds = _get_editable_datasource(db, user, datasource_id)
    transform = _get_owned_transform(db, ds, transform_id)

    name = payload.name.strip()
    existing = (
        db.query(models.DataTransform)
        .filter(
            models.DataTransform.datasource_id == ds.id,
            models.DataTransform.id != transform.id,
            models.DataTransform.name.ilike(name),
        )
        .first()
    )
    if existing:
        raise HTTPException(400, f'A saved table named "{name}" already exists for this data source.')

    transform.name = name
    transform.description = (payload.description or "").strip() or None
    transform.steps = payload.steps or []

    audit.log_audit_event(
        db, actor=user, action="data_transform_updated", workspace_id=ds.workspace_id,
        target_type="data_transform", target_id=transform.id, metadata={"name": transform.name},
    )
    db.commit()
    db.refresh(transform)
    return _transform_out(db, ds, transform, user)


@router.delete("/{datasource_id}/transforms/{transform_id}", status_code=204)
def delete_transform(
    datasource_id: str, transform_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user),
):
    """Creator-only, regardless of workspace edit access - see this
    module's own docstring for why (mirrors routers/metric_definitions.py's
    delete_metric_definition)."""
    ds = _get_accessible_datasource(db, user, datasource_id)
    transform = _get_owned_transform(db, ds, transform_id)
    if transform.owner_id != user.id:
        raise HTTPException(403, "Only the person who created this saved table can delete it.")

    audit.log_audit_event(
        db, actor=user, action="data_transform_deleted", workspace_id=ds.workspace_id,
        target_type="data_transform", target_id=transform.id, metadata={"name": transform.name},
    )
    db.delete(transform)
    db.commit()
    return None


@router.post("/{datasource_id}/transforms/preview", response_model=schemas.TransformPreviewOut)
def preview_transform(
    datasource_id: str,
    payload: schemas.TransformPreviewRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Live preview of UNSAVED steps, posted directly (not a saved
    transform id) - see schemas.TransformPreviewRequest's own docstring.
    Editable tier, same as create/update: this is only ever called from
    the transform builder form itself."""
    ds = _get_editable_datasource(db, user, datasource_id)
    df, load_error = _load_ds_df(db, ds, user)
    if load_error:
        return schemas.TransformPreviewOut(error=load_error)
    return _rows_preview_from_df(df, payload.steps or [])


@router.get("/{datasource_id}/transforms/{transform_id}/data", response_model=schemas.TransformPreviewOut)
def get_transform_data(
    datasource_id: str, transform_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user),
):
    """The actual preview ROWS for an already-saved transform (view tier -
    unlike preview_transform above, this is also used just to look at an
    existing saved table's output, not only while editing it)."""
    ds = _get_accessible_datasource(db, user, datasource_id)
    transform = _get_owned_transform(db, ds, transform_id)
    df, load_error = _load_ds_df(db, ds, user)
    if load_error:
        return schemas.TransformPreviewOut(error=load_error)
    return _rows_preview_from_df(df, transform.steps or [])
