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
from ..services import ml_data, ml_queue, workspace_access
from .ml_models import _get_accessible_ml_model, _get_editable_ml_model

router = APIRouter(prefix="/ml-studio", tags=["ml-studio"])


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


class UnderstandBody(BaseModel):
    goal: str = Field(default="", max_length=600)
    problem_type: str | None = None
    source_id: str | None = None
    table: str | None = Field(default=None, max_length=300)
    # 2026-10-09 (round 15): learn inside a Space / from joined tables
    space_id: str | None = None
    joins: list[dict] | None = None


class JoinSuggestBody(BaseModel):
    source_id: str
    table: str | None = Field(default=None, max_length=300)
    space_id: str | None = None


class PlanBody(BaseModel):
    spec: dict


class PrepBody(BaseModel):
    spec: dict
    sql: str = Field(default="", max_length=20000)
    request: str = Field(default="", max_length=800)


class ScoreBody(BaseModel):
    table: str | None = Field(default=None, max_length=300)


class StartBody(BaseModel):
    spec: dict
    name: str = Field(default="", max_length=120)
    goal: str | None = Field(default=None, max_length=600)


def _bad(e: Exception):
    raise HTTPException(400, str(e))


@router.get("/types")
def types(space_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        tables = svc.scoped_tables(db, user, space_id)
    except svc.StudioError as e:
        _bad(e)
    s = get_settings()
    return {
        "types": svc.PROBLEMS,
        "tables": [{k: t[k] for k in ("source_id", "source", "kind", "mode", "table", "columns")} for t in tables],
        "limits": {"max_rows": s.ML_MAX_TRAIN_ROWS, "trials": s.ML_TRIALS, "tune_seconds": s.ML_TUNE_SECONDS,
                   "workers": __import__("os").cpu_count() or 1, "mode": s.ML_WORKER_MODE},
    }


@router.post("/understand")
def understand(body: UnderstandBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    if body.problem_type and body.problem_type not in svc.READY:
        raise HTTPException(400, "That kind of project isn't available yet.")
    try:
        return svc.understand(db, user, body.goal, body.problem_type, body.source_id, body.table, body.space_id, body.joins)
    except svc.StudioError as e:
        _bad(e)


@router.post("/join/suggest")
def join_suggest(body: JoinSuggestBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """2026-10-09 (round 15): tables that share a key with this one."""
    try:
        return svc.suggest_joins(db, user, body.source_id, body.table, body.space_id)
    except svc.StudioError as e:
        _bad(e)
    except Exception as e:  # noqa: BLE001 - a source that can't be read says so
        raise HTTPException(400, f"Couldn't read that table: {str(e)[:300]}")


@router.post("/join/preview")
def join_preview(body: PlanBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """2026-10-09 (round 15): the joined rows, match rates and how each join was built."""
    try:
        return svc.join_preview(db, user, dict(body.spec))
    except svc.StudioError as e:
        _bad(e)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Couldn't build the join: {str(e)[:300]}")


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
        checked = svc.make_plan(db, user, spec)  # the same checks as the plan the person saw
        if checked.get("needs_prep"):
            raise svc.StudioError(checked["needs_prep"]["text"] + " Add the data step, then train.")
        m = svc.start(db, user, spec, body.name or (body.goal or "ML project")[:80], body.goal)
    except svc.StudioError as e:
        _bad(e)
    except Exception as e:  # noqa: BLE001 - 2026-10-09 (round 15): a source that can't be read says so
        raise HTTPException(400, f"Couldn't read that table: {str(e)[:300]}")
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
        # 2026-10-12 (round 39): where the run stands in the queue
        out["queue"] = ml_queue.status(db, m.id, "train") if m.status == "training" else None
    elif m.status == "training":
        q = ml_queue.latest(db, m.id, "train")
        out["queue"] = {"state": q.state, "position": ml_queue.position(db, q)} if q else None
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


class RetrainBody(BaseModel):
    # 2026-10-12 (round 39): train again with an edited data step (None = keep it, "" = remove it)
    prep_sql: str | None = Field(default=None, max_length=20000)


@router.post("/projects/{model_id}/retrain", status_code=202)
def retrain(model_id: str, body: RetrainBody | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    m = _get_editable_ml_model(db, user, model_id)
    if not m.problem_type:
        raise HTTPException(400, "This model was made with the older wizard - retrain it from its own page.")
    if m.status == "training":
        raise HTTPException(409, "It is already training.")
    if body is not None and body.prep_sql is not None:
        spec = dict((m.plan or {}).get("spec") or {})
        spec["prep_sql"] = body.prep_sql.strip() or None
        try:
            checked = svc.make_plan(db, user, spec)
        except svc.StudioError as e:
            _bad(e)
        if checked.get("needs_prep"):
            raise HTTPException(400, checked["needs_prep"]["text"])
        m.plan = {**dict(m.plan or {}), "spec": checked["spec"]}
        db.commit()
    svc.restart(db, m)
    return {"id": m.id}



# ------------------------------------------------ 2026-10-12 (round 39) ----

@router.post("/prepare/check")
def prepare_check(body: PrepBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Runs a data-step SELECT in the run's sandbox: rows, columns, first rows - or the error."""
    try:
        return svc.check_prep(db, user, dict(body.spec), body.sql)
    except svc.StudioError as e:
        _bad(e)


@router.post("/prepare/suggest")
def prepare_suggest(body: PrepBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """The AI writes the data step from a sentence, fixing it until it runs (3 tries)."""
    if not body.request.strip():
        raise HTTPException(400, "Say what each row of the table should be.")
    try:
        return svc.suggest_prep(db, user, dict(body.spec), body.request)
    except svc.StudioError as e:
        _bad(e)


@router.post("/projects/{model_id}/score", status_code=202)
def score(model_id: str, body: ScoreBody | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Queues "score every row" on the ML worker; progress is on the project (progress.scoring)."""
    m = _get_accessible_ml_model(db, user, model_id)
    try:
        job = svc.start_scoring(db, user, m, (body.table if body else None))
    except svc.StudioError as e:
        _bad(e)
    return {"id": m.id, "job_id": job.id, "state": "queued"}


@router.post("/projects/{model_id}/score/stop")
def score_stop(model_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    m = _get_editable_ml_model(db, user, model_id)
    if not ml_queue.cancel_queued(db, m.id):
        m.stop_requested = True
    p = dict(m.progress or {})
    if (p.get("scoring") or {}).get("state") == "queued":
        p["scoring"] = {**p["scoring"], "state": "cancelled"}
        m.progress = p
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(m, "progress")
    db.commit()
    return {"id": m.id}


@router.get("/projects/{model_id}/notebook")
def notebook(model_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """The run as a Jupyter notebook (DuckDB data step + the winning model)."""
    import json as _json
    import re as _re
    from fastapi.responses import Response
    m = _get_accessible_ml_model(db, user, model_id)
    if m.status != "ready":
        raise HTTPException(409, "The notebook is ready once the model is.")
    name = _re.sub(r"[^A-Za-z0-9_-]+", "_", m.name or "ml_project").strip("_")[:60] or "ml_project"
    return Response(_json.dumps(svc.notebook(m), indent=1, default=str), media_type="application/x-ipynb+json",
                    headers={"Content-Disposition": f'attachment; filename="{name}.ipynb"'})


@router.get("/engine")
def engine(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Where ML runs and how busy it is - for the engine panel."""
    s = get_settings()
    queued = db.query(models.MLJob).filter(models.MLJob.state == "queued").count()
    running = db.query(models.MLJob).filter(models.MLJob.state == "running").count()
    return {"mode": s.ML_WORKER_MODE, "queued": queued, "running": running, "memory_free_mb": ml_data.memory_free_mb(),
            "process_mb": ml_data.rss_mb(), "max_rows": s.ML_MAX_TRAIN_ROWS, "seed": s.ML_SAMPLE_SEED}
