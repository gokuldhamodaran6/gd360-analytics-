"""
/ml-studio - start a model from a goal in words (2026-10-08, round 13).
See services/ml_studio.py. Models made here are ordinary MLModel rows, so
scoring, versions and deletion keep using /ml-models.
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..services import ml_studio as svc
from ..services import workspace_access
from .ml_models import _get_accessible_ml_model, _get_editable_ml_model

router = APIRouter(prefix="/ml-studio", tags=["ml-studio"])


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


class UnderstandBody(BaseModel):
    goal: str = Field(default="", max_length=600)
    problem_type: str | None = None
    source_id: str | None = None


class PlanBody(BaseModel):
    spec: dict


class StartBody(BaseModel):
    spec: dict
    name: str = Field(default="", max_length=120)
    goal: str | None = Field(default=None, max_length=600)


def _bad(e: Exception):
    raise HTTPException(400, str(e))


@router.get("/types")
def types(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    tables = svc.source_tables(db, user)
    s = get_settings()
    return {
        "types": svc.PROBLEMS,
        "tables": [{k: t[k] for k in ("source_id", "source", "kind", "mode", "table", "columns")} for t in tables],
        "limits": {"max_rows": s.ML_MAX_TRAIN_ROWS, "trials": s.ML_TRIALS, "tune_seconds": s.ML_TUNE_SECONDS,
                   "workers": __import__("os").cpu_count() or 1},
    }


@router.post("/understand")
def understand(body: UnderstandBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    if body.problem_type and body.problem_type not in svc.READY:
        raise HTTPException(400, "That kind of project isn't available yet.")
    try:
        return svc.understand(db, user, body.goal, body.problem_type, body.source_id)
    except svc.StudioError as e:
        _bad(e)


@router.post("/plan")
def plan(body: PlanBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        return svc.make_plan(db, user, dict(body.spec))
    except svc.StudioError as e:
        _bad(e)
    except Exception as e:  # noqa: BLE001 - a source that can't be read says so
        raise HTTPException(400, f"Couldn't read that table: {str(e)[:300]}")


@router.post("/projects", status_code=201)
def start(body: StartBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    spec = dict(body.spec)
    try:
        svc.make_plan(db, user, spec)  # the same checks as the plan the person saw
        m = svc.start(db, user, spec, body.name or (body.goal or "ML project")[:80], body.goal)
    except svc.StudioError as e:
        _bad(e)
    return {"id": m.id}


def _out(db: Session, m: models.MLModel, user: models.User, full: bool = True) -> dict:
    ds = db.get(models.DataSource, m.datasource_id)
    elapsed = None
    if m.started_at:
        end = m.trained_at if m.status != "training" and m.trained_at else datetime.utcnow()
        elapsed = round(max(0.0, (end - m.started_at).total_seconds()), 1)
    out = {
        "id": m.id, "name": m.name, "goal": m.goal, "problem_type": m.problem_type, "status": m.status,
        "error": m.error_message, "source": ds.name if ds else None, "source_id": m.datasource_id, "table": m.table_name,
        "target": m.target_column, "task_type": m.task_type, "metrics": m.metrics, "rows": m.trained_row_count,
        "created_at": iso(m.created_at), "started_at": iso(m.started_at), "trained_at": iso(m.trained_at), "elapsed": elapsed,
        "can_edit": bool(ds and workspace_access.can_edit_datasource(db, ds, user)), "can_delete": m.owner_id == user.id,
        "version": m.version_number, "predictions": m.prediction_count,
    }
    if full:
        out.update(plan=m.plan, progress=m.progress, results=m.results, features=m.feature_columns,
                   excluded=m.excluded_columns, importance=m.feature_importance)
    return out


@router.get("/projects")
def list_projects(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ds_ids = {r[0] for r in db.query(models.DataSource.id).filter(workspace_access.datasource_access_filter(db, user)).all()}
    if not ds_ids:
        return {"projects": []}
    rows = (
        db.query(models.MLModel)
        .filter(models.MLModel.datasource_id.in_(ds_ids))
        .order_by(models.MLModel.created_at.desc())
        .limit(200)
        .all()
    )
    return {"projects": [_out(db, m, user, full=False) for m in rows]}


@router.get("/projects/{model_id}")
def get_project(model_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return _out(db, _get_accessible_ml_model(db, user, model_id), user)


@router.post("/projects/{model_id}/stop")
def stop(model_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    m = _get_editable_ml_model(db, user, model_id)
    if m.status != "training":
        raise HTTPException(409, "It isn't training.")
    svc.request_stop(db, m)
    return {"id": m.id, "status": "stopping"}


@router.post("/projects/{model_id}/retrain", status_code=202)
def retrain(model_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    m = _get_editable_ml_model(db, user, model_id)
    if not m.problem_type:
        raise HTTPException(400, "This model was made with the older wizard - retrain it from its own page.")
    if m.status == "training":
        raise HTTPException(409, "It is already training.")
    svc.restart(db, m)
    return {"id": m.id}
