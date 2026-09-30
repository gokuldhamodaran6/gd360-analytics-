"""
2026-09-30 (orchestration v1): CRUD + run-now + run history for
models.Pipeline - see that model's own docstring for exactly what a
pipeline is and services/pipelines.py for how one actually runs.

Deliberately NOT nested under /datasources/{id}/... the way
routers/transforms.py and routers/metric_definitions.py are - a
pipeline's own steps can each target a DIFFERENT data source or
dashboard, so it isn't scoped to one parent resource the way a transform
or a metric definition is. Sits flat under /pipelines instead, matching
routers/jobs.py's own precedent for the one other account-wide (not
datasource-scoped) feature this app already has.

Access: a pipeline's own owner, or any member of workspace_id if it was
shared into one - mirrors services/workspace_access.py's "editable"/
"accessible" split, applied at the workspace-MEMBERSHIP level (via
services/workspace_access.member_workspace_ids / member_role) rather than
through one parent datasource, since Pipeline has no single datasource_id
to check access through the way a datasource-scoped router would. A
workspace "viewer" can see a shared pipeline and its run history, but not
edit/run/delete it - matching every other shared-resource split in this
app. Deleting is creator-only, same as transforms.py/metric_definitions.py's
own convention.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import audit, workspace_access
from ..services.pipelines import describe_pipeline, run_pipeline

router = APIRouter(prefix="/pipelines", tags=["pipelines"])


def _can_view_pipeline(db: Session, p: models.Pipeline, user: models.User) -> bool:
    if p.owner_id == user.id:
        return True
    if not p.workspace_id:
        return False
    return p.workspace_id in workspace_access.member_workspace_ids(db, user.id)


def _can_edit_pipeline(db: Session, p: models.Pipeline, user: models.User) -> bool:
    if p.owner_id == user.id:
        return True
    if not p.workspace_id:
        return False
    role = workspace_access.member_role(db, user.id, p.workspace_id)
    return role in ("owner", "member")


def _get_visible_pipeline(db: Session, user: models.User, pipeline_id: str) -> models.Pipeline:
    p = db.query(models.Pipeline).filter(models.Pipeline.id == pipeline_id).first()
    if not p or not _can_view_pipeline(db, p, user):
        # Matches services/workspace_access.py's own "not accessible always
        # 404s, never 403" info-non-leak convention - a non-member can't
        # tell "doesn't exist" apart from "exists but isn't yours to see".
        raise HTTPException(404, "That pipeline no longer exists.")
    return p


def _visible_pipelines(db: Session, user: models.User) -> list[models.Pipeline]:
    ws_ids = workspace_access.member_workspace_ids(db, user.id)
    q = db.query(models.Pipeline)
    if ws_ids:
        q = q.filter(or_(models.Pipeline.owner_id == user.id, models.Pipeline.workspace_id.in_(ws_ids)))
    else:
        q = q.filter(models.Pipeline.owner_id == user.id)
    return q.order_by(models.Pipeline.name).all()


def _validate_steps(db: Session, steps: list[dict]) -> None:
    from ..services.pipelines import MAX_STEPS

    if len(steps) > MAX_STEPS:
        raise HTTPException(400, f"A pipeline can have at most {MAX_STEPS} steps.")
    for i, step in enumerate(steps):
        op = step.get("type") if isinstance(step, dict) else None
        if op not in schemas.PIPELINE_STEP_TYPES:
            raise HTTPException(400, f'Step {i + 1}: unknown step type "{op}".')
        if op in ("refresh_datasource", "run_quality_checks"):
            ds_id = step.get("datasource_id")
            if not ds_id or not db.query(models.DataSource.id).filter(models.DataSource.id == ds_id).first():
                raise HTTPException(400, f"Step {i + 1}: that data source no longer exists.")
        elif op == "rebuild_dashboard":
            dash_id = step.get("dashboard_id")
            if not dash_id or not db.query(models.Dashboard.id).filter(models.Dashboard.id == dash_id).first():
                raise HTTPException(400, f"Step {i + 1}: that dashboard no longer exists.")


def _pipeline_out(db: Session, p: models.Pipeline, user: models.User) -> schemas.PipelineOut:
    last_run = (
        db.query(models.PipelineRun)
        .filter(models.PipelineRun.pipeline_id == p.id)
        .order_by(models.PipelineRun.started_at.desc())
        .first()
    )
    return schemas.PipelineOut(
        id=p.id,
        name=p.name,
        description=p.description,
        steps=p.steps or [],
        step_summary=describe_pipeline(db, p.steps or []),
        schedule_interval=p.schedule_interval or "off",
        next_run_at=p.next_run_at,
        last_run_at=p.last_run_at,
        last_run_status=last_run.status if last_run else None,
        can_edit=_can_edit_pipeline(db, p, user),
        can_delete=(p.owner_id == user.id),
        created_at=p.created_at,
        updated_at=p.updated_at,
    )


@router.post("", response_model=schemas.PipelineOut, status_code=201)
def create_pipeline(
    payload: schemas.PipelineCreate, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    if payload.workspace_id and payload.workspace_id not in workspace_access.member_workspace_ids(db, user.id):
        raise HTTPException(403, "You aren't a member of that workspace.")
    if payload.schedule_interval not in schemas.PIPELINE_SCHEDULE_INTERVALS:
        raise HTTPException(400, f"schedule_interval must be one of: {', '.join(schemas.PIPELINE_SCHEDULE_INTERVALS)}")
    existing = (
        db.query(models.Pipeline)
        .filter(models.Pipeline.owner_id == user.id, models.Pipeline.name.ilike(payload.name.strip()))
        .first()
    )
    if existing:
        raise HTTPException(400, f'You already have a pipeline named "{payload.name}".')
    _validate_steps(db, payload.steps)

    from ..services.scheduler import compute_next_refresh_at

    interval = None if payload.schedule_interval == "off" else payload.schedule_interval
    p = models.Pipeline(
        owner_id=user.id,
        workspace_id=payload.workspace_id,
        name=payload.name.strip(),
        description=payload.description,
        steps=payload.steps,
        schedule_interval=interval,
        next_run_at=compute_next_refresh_at(interval, datetime.utcnow()),
    )
    db.add(p)
    db.flush()
    audit.log_audit_event(
        db, actor=user, action="pipeline_created", workspace_id=p.workspace_id,
        target_type="pipeline", target_id=p.id,
    )
    db.commit()
    db.refresh(p)
    return _pipeline_out(db, p, user)


@router.get("", response_model=list[schemas.PipelineOut])
def list_pipelines(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return [_pipeline_out(db, p, user) for p in _visible_pipelines(db, user)]


@router.get("/{pipeline_id}", response_model=schemas.PipelineOut)
def get_pipeline(pipeline_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    p = _get_visible_pipeline(db, user, pipeline_id)
    return _pipeline_out(db, p, user)


@router.put("/{pipeline_id}", response_model=schemas.PipelineOut)
def update_pipeline(
    pipeline_id: str,
    payload: schemas.PipelineUpdate,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    p = _get_visible_pipeline(db, user, pipeline_id)
    if not _can_edit_pipeline(db, p, user):
        raise HTTPException(403, "You have view-only access to this pipeline.")

    if payload.name is not None:
        existing = (
            db.query(models.Pipeline)
            .filter(
                models.Pipeline.owner_id == p.owner_id,
                models.Pipeline.name.ilike(payload.name.strip()),
                models.Pipeline.id != p.id,
            )
            .first()
        )
        if existing:
            raise HTTPException(400, f'You already have a pipeline named "{payload.name}".')
        p.name = payload.name.strip()
    if payload.description is not None:
        p.description = payload.description
    if payload.steps is not None:
        _validate_steps(db, payload.steps)
        p.steps = payload.steps
    if payload.schedule_interval is not None:
        if payload.schedule_interval not in schemas.PIPELINE_SCHEDULE_INTERVALS:
            raise HTTPException(
                400, f"schedule_interval must be one of: {', '.join(schemas.PIPELINE_SCHEDULE_INTERVALS)}"
            )
        from ..services.scheduler import compute_next_refresh_at

        p.schedule_interval = None if payload.schedule_interval == "off" else payload.schedule_interval
        # Measured from now, not from this pipeline's last run - same rule
        # routers/jobs.py update_schedule already follows for a dashboard's
        # own schedule: turning a schedule on (or changing its interval)
        # always counts its first interval starting from this moment.
        p.next_run_at = compute_next_refresh_at(p.schedule_interval, datetime.utcnow())
    db.commit()
    db.refresh(p)
    return _pipeline_out(db, p, user)


@router.delete("/{pipeline_id}", status_code=204)
def delete_pipeline(pipeline_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    p = _get_visible_pipeline(db, user, pipeline_id)
    if p.owner_id != user.id:
        raise HTTPException(403, "Only this pipeline's creator can delete it.")
    audit.log_audit_event(
        db, actor=user, action="pipeline_deleted", workspace_id=p.workspace_id,
        target_type="pipeline", target_id=pipeline_id,
    )
    db.delete(p)
    db.commit()
    return None


@router.post("/{pipeline_id}/run-now", response_model=schemas.PipelineRunOut)
def run_pipeline_now(
    pipeline_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Runs this pipeline's steps immediately, outside its own schedule (or
    with none set at all) - through the exact same services.pipelines.
    run_pipeline function a scheduled tick calls, so a manual run is
    logged and behaves identically to a scheduled one, just triggered by a
    click instead of a timer."""
    p = _get_visible_pipeline(db, user, pipeline_id)
    if not _can_edit_pipeline(db, p, user):
        raise HTTPException(403, "You have view-only access to this pipeline.")
    if not p.steps:
        raise HTTPException(400, "This pipeline has no steps yet - add at least one before running it.")
    return run_pipeline(db, p, run_type="manual")


@router.get("/{pipeline_id}/runs", response_model=schemas.PipelineRunsPage)
def list_pipeline_runs(
    pipeline_id: str,
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    p = _get_visible_pipeline(db, user, pipeline_id)
    page = max(1, page)
    page_size = max(1, min(100, page_size))
    q = db.query(models.PipelineRun).filter(models.PipelineRun.pipeline_id == p.id)
    total = q.count()
    rows = (
        q.order_by(models.PipelineRun.started_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return schemas.PipelineRunsPage(runs=rows, total=total, page=page, page_size=page_size)
