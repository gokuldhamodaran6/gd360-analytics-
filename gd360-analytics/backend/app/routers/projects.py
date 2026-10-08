"""
Multi-source Projects (2026-10-08, round 11) - the HTTP surface of
services/project_engine.

A Project is a Conversation with kind="project" and a list of source ids.
Every question asked in it is a ProjectRun: planned and run in a
background thread while the page polls GET /projects/runs/{id} for live
progress (plan -> each step -> the answer).

  GET  /projects/sources              the sources this person can ask about
  POST /projects                      new project + first question
  GET  /projects/{id}                 the project, its sources and its questions
  PATCH /projects/{id}                rename / change its sources
  POST /projects/{id}/ask             a follow-up question
  GET  /projects/runs/{run_id}        one question: plan, steps, answer
  POST /projects/runs/{run_id}/execute   run a plan that was shown first
  POST /projects/runs/{run_id}/replan    change the plan in words
  POST /projects/runs/{run_id}/stop      stop a run
  POST /projects/{id}/dashboard       a live dashboard from an answer
"""
from __future__ import annotations

import time
from collections import defaultdict, deque
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..services import workspace_access
from ..services.project_engine import executor
from ..services.project_engine.catalog import (
    KIND_LABELS, accessible_sources, build_source, freshness_text, source_mode,
)

settings = get_settings()
router = APIRouter(prefix="/projects", tags=["projects"])

MAX_SOURCES = 12
_calls: dict[str, deque] = defaultdict(deque)


def _rate_limit(user_id: str) -> None:
    now = time.time()
    w = _calls[user_id]
    while w and now - w[0] > 60:
        w.popleft()
    if len(w) >= settings.RATE_LIMIT_PER_MINUTE:
        raise HTTPException(429, "You are asking questions a bit fast - please wait a few seconds and try again.")
    w.append(now)


class CreateProjectRequest(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    source_ids: list[str] | None = None
    workspace_id: str | None = None
    auto_run: bool = True


class AskRequest(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    auto_run: bool = True


class ReplanRequest(BaseModel):
    note: str = Field(min_length=2, max_length=1000)


class UpdateProjectRequest(BaseModel):
    title: str | None = Field(default=None, max_length=80)
    source_ids: list[str] | None = None


class DashboardRequest(BaseModel):
    run_id: str | None = None
    name: str | None = Field(default=None, max_length=120)


# ---- helpers -----------------------------------------------------------------

def _source_summary(db: Session, ds: models.DataSource, user: models.User) -> dict:
    tables = ds.schema_cache if isinstance(ds.schema_cache, dict) else {}
    n_tables = 1 if list(tables.keys()) == ["columns"] else len(tables)
    return {
        "id": ds.id, "name": ds.name, "kind": ds.kind, "label": KIND_LABELS.get(ds.kind, ds.kind),
        "mode": source_mode(ds.kind), "freshness": freshness_text(ds), "tables": n_tables,
        "workspace_id": ds.workspace_id, "sync_error": ds.sync_error,
    }


def _usable_ids(db: Session, user: models.User, ids: list[str]) -> list[str]:
    out = []
    for sid in dict.fromkeys(ids):
        ds = db.get(models.DataSource, sid)
        if ds and workspace_access.can_access_datasource(db, ds, user):
            out.append(sid)
    return out[:MAX_SOURCES]


def _project(db: Session, project_id: str, user: models.User, edit: bool = False) -> models.Conversation:
    conv = db.get(models.Conversation, project_id)
    if not conv or conv.kind != "project" or not workspace_access.can_access_conversation(db, conv, user):
        raise HTTPException(404, "Project not found.")
    if edit and not workspace_access.can_edit_conversation(db, conv, user):
        raise HTTPException(403, "You have view-only access to this project.")
    return conv


def _run(db: Session, run_id: str, user: models.User, edit: bool = False) -> tuple[models.ProjectRun, models.Conversation]:
    run = db.get(models.ProjectRun, run_id)
    if not run:
        raise HTTPException(404, "Question not found.")
    conv = _project(db, run.conversation_id, user, edit=edit)
    return run, conv


def _run_out(run: models.ProjectRun, full: bool = True) -> dict:
    ans = (run.result or {}).get("answer") or {}
    out = {
        "id": run.id, "project_id": run.conversation_id, "question": run.question, "status": run.status,
        "error": run.error_message, "note": run.note, "auto_run": bool(run.auto_run),
        "created_at": run.created_at, "started_at": run.started_at, "finished_at": run.finished_at,
        "headline": ans.get("headline"),
        "duration_seconds": (
            round(((run.finished_at or datetime.utcnow()) - (run.started_at or run.created_at)).total_seconds(), 1)
            if run.started_at else None
        ),
    }
    if full:
        plan = dict(run.plan or {})
        plan.pop("replaced_plan", None)
        out.update({"plan": plan if plan.get("steps") is not None else None, "steps": run.steps or [], "result": run.result})
    return out


def _new_run(db: Session, conv: models.Conversation, user: models.User, question: str, auto_run: bool,
             note: str | None = None, replaced_plan: dict | None = None) -> models.ProjectRun:
    run = models.ProjectRun(
        conversation_id=conv.id, owner_id=user.id, question=question.strip(), status="planning",
        auto_run=auto_run, note=note, plan={"replaced_plan": replaced_plan} if replaced_plan else None,
    )
    db.add(run)
    if not note:
        db.add(models.Message(conversation_id=conv.id, role="user", content=question.strip()))
    db.commit()
    db.refresh(run)
    return run


def recover_interrupted_runs() -> None:
    """Called once at startup: a run whose thread died with the previous
    server process can never finish - say so instead of spinning forever."""
    from ..database import SessionLocal
    db = SessionLocal()
    try:
        stuck = db.query(models.ProjectRun).filter(models.ProjectRun.status.in_(("planning", "running"))).all()
        for r in stuck:
            r.status = "failed"
            r.error_message = "This was interrupted by a server restart. Ask it again to get the answer."
            r.finished_at = datetime.utcnow()
        if stuck:
            db.commit()
            print(f"[projects] marked {len(stuck)} interrupted run(s) as failed")
    except Exception as e:  # noqa: BLE001
        print(f"[projects] interrupted-run recovery skipped: {e}")
        db.rollback()
    finally:
        db.close()


# ---- endpoints ---------------------------------------------------------------

@router.get("/sources")
def list_sources(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    rows = accessible_sources(db, user, workspace_id)
    return [_source_summary(db, ds, user) for ds in rows]


@router.post("", status_code=201)
def create_project(payload: CreateProjectRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _rate_limit(user.id)
    if payload.source_ids:
        ids = _usable_ids(db, user, payload.source_ids)
    else:
        ids = [ds.id for ds in accessible_sources(db, user, payload.workspace_id)][:MAX_SOURCES]
    if not ids:
        raise HTTPException(400, "Connect a data source first - there is nothing to ask about yet.")
    # editing tier on at least the first source: a workspace viewer can read but not create work
    first = db.get(models.DataSource, ids[0])
    if not workspace_access.can_edit_datasource(db, first, user):
        editable = [i for i in ids if workspace_access.can_edit_datasource(db, db.get(models.DataSource, i), user)]
        if not editable:
            raise HTTPException(403, "You have view-only access to these sources.")
        ids = editable + [i for i in ids if i not in editable]
    conv = models.Conversation(
        owner_id=user.id, datasource_id=ids[0], kind="project", source_ids=ids,
        workspace_id=payload.workspace_id or first.workspace_id, title=payload.question.strip()[:80],
    )
    db.add(conv)
    db.commit()
    run = _new_run(db, conv, user, payload.question, payload.auto_run)
    executor.start_planning(run.id)
    return {"project_id": conv.id, "run_id": run.id}


@router.get("/runs/{run_id}")
def get_run(run_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    run, _conv = _run(db, run_id, user)
    return _run_out(run)


@router.post("/runs/{run_id}/execute")
def execute(run_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    run, _conv = _run(db, run_id, user, edit=True)
    if run.status != "planned":
        raise HTTPException(409, f"This question is {run.status}, not waiting to run.")
    executor.start_execution(run.id)
    return {"id": run.id, "status": "running"}


@router.post("/runs/{run_id}/replan")
def replan(run_id: str, payload: ReplanRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _rate_limit(user.id)
    run, conv = _run(db, run_id, user, edit=True)
    if run.status in ("planning", "running"):
        raise HTTPException(409, "Wait for the current plan to finish first.")
    new = _new_run(db, conv, user, run.question, auto_run=False, note=payload.note.strip(), replaced_plan=run.plan)
    if run.status == "planned":
        run.status = "replaced"
        db.commit()
    executor.start_planning(new.id)
    return {"run_id": new.id}


@router.post("/runs/{run_id}/stop")
def stop(run_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    run, _conv = _run(db, run_id, user, edit=True)
    if run.status in ("planning", "planned", "running"):
        executor.request_stop(run.id)
        if run.status in ("planned", "planning"):
            run.status = "stopped"
            run.finished_at = datetime.utcnow()
            db.commit()
    return {"id": run.id, "status": "stopping" if run.status == "running" else run.status}


@router.get("/{project_id}")
def get_project(project_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    conv = _project(db, project_id, user)
    sources = []
    for sid in conv.source_ids or []:
        ds = db.get(models.DataSource, sid)
        if ds and workspace_access.can_access_datasource(db, ds, user):
            sources.append(_source_summary(db, ds, user))
    runs = (
        db.query(models.ProjectRun).filter(models.ProjectRun.conversation_id == conv.id)
        .order_by(models.ProjectRun.created_at.asc()).all()
    )
    dashboards = (
        db.query(models.Dashboard.id, models.Dashboard.name)
        .filter(models.Dashboard.source_conversation_id == conv.id).all()
    )
    return {
        "id": conv.id, "title": conv.title, "source_ids": conv.source_ids or [], "sources": sources,
        "workspace_id": conv.workspace_id, "created_at": conv.created_at, "pinned": bool(conv.pinned),
        "can_edit": workspace_access.can_edit_conversation(db, conv, user),
        "runs": [_run_out(r, full=False) for r in runs if r.status != "replaced"],
        "dashboards": [{"id": d.id, "name": d.name} for d in dashboards],
    }


@router.patch("/{project_id}")
def update_project(project_id: str, payload: UpdateProjectRequest, db: Session = Depends(get_db),
                   user: models.User = Depends(get_current_user)):
    conv = _project(db, project_id, user, edit=True)
    if payload.title is not None and payload.title.strip():
        conv.title = payload.title.strip()[:80]
    if payload.source_ids is not None:
        ids = _usable_ids(db, user, payload.source_ids)
        if not ids:
            raise HTTPException(400, "A project needs at least one source you can access.")
        conv.source_ids = ids
        conv.datasource_id = ids[0]
    db.commit()
    return {"id": conv.id, "title": conv.title, "source_ids": conv.source_ids}


@router.post("/{project_id}/ask", status_code=201)
def ask(project_id: str, payload: AskRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _rate_limit(user.id)
    conv = _project(db, project_id, user, edit=True)
    busy = (
        db.query(models.ProjectRun)
        .filter(models.ProjectRun.conversation_id == conv.id, models.ProjectRun.status.in_(("planning", "running")))
        .count()
    )
    if busy:
        raise HTTPException(409, "GD360 is still working on the last question in this project.")
    run = _new_run(db, conv, user, payload.question, payload.auto_run)
    executor.start_planning(run.id)
    return {"project_id": conv.id, "run_id": run.id}


@router.post("/{project_id}/dashboard", status_code=201)
def make_dashboard(project_id: str, payload: DashboardRequest, db: Session = Depends(get_db),
                   user: models.User = Depends(get_current_user)):
    conv = _project(db, project_id, user, edit=True)
    q = db.query(models.ProjectRun).filter(models.ProjectRun.conversation_id == conv.id, models.ProjectRun.status == "done")
    run = q.filter(models.ProjectRun.id == payload.run_id).first() if payload.run_id else \
        q.order_by(models.ProjectRun.created_at.desc()).first()
    if not run:
        raise HTTPException(400, "Ask a question and let it finish first - the dashboard is built from its answer.")
    from ..services.project_engine import dashboards
    try:
        dash = dashboards.dashboard_from_run(db, conv, run, user, name=payload.name)
    except dashboards.DashboardBuildError as e:
        raise HTTPException(400, str(e))
    return {"dashboard_id": dash.id, "name": dash.name}


# ---- dashboards built from a project (layout_version 3) ---------------------

class UpdateProjectDashboardRequest(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    tiles: list[dict] | None = None


def _project_dashboard(db: Session, dashboard_id: str, user: models.User, edit: bool = False) -> models.Dashboard:
    from .dashboards import _can_edit, _can_view
    d = db.get(models.Dashboard, dashboard_id)
    if not d or d.layout_version != 3 or not _can_view(db, d, user):
        raise HTTPException(404, "Dashboard not found.")
    if edit and not _can_edit(db, d, user):
        raise HTTPException(403, "You have view-only access to this dashboard.")
    return d


def _dashboard_out(db: Session, d: models.Dashboard, user: models.User) -> dict:
    from .dashboards import _can_edit
    spec = d.project_spec or {}
    sources = []
    for sid in spec.get("source_ids") or []:
        ds = db.get(models.DataSource, sid)
        if ds and workspace_access.can_access_datasource(db, ds, user):
            sources.append(_source_summary(db, ds, user))
    return {
        "id": d.id, "name": d.name, "project_id": spec.get("project_id"), "question": spec.get("question"),
        "headline": spec.get("headline"), "tiles": spec.get("tiles") or [], "snapshot": d.project_snapshot or {},
        "snapshot_at": d.snapshot_at, "sources": sources, "can_edit": _can_edit(db, d, user),
        "workspace_id": d.workspace_id, "assumptions": (spec.get("plan") or {}).get("assumptions") or [],
    }


@router.get("/dashboards/{dashboard_id}")
def get_project_dashboard(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return _dashboard_out(db, _project_dashboard(db, dashboard_id, user), user)


@router.post("/dashboards/{dashboard_id}/refresh")
def refresh_project_dashboard(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _rate_limit(user.id)
    d = _project_dashboard(db, dashboard_id, user)
    from ..services.project_engine import dashboards
    try:
        d = dashboards.refresh(db, d, user)
    except dashboards.DashboardBuildError as e:
        raise HTTPException(400, str(e))
    return _dashboard_out(db, d, user)


@router.patch("/dashboards/{dashboard_id}")
def update_project_dashboard(dashboard_id: str, payload: UpdateProjectDashboardRequest, db: Session = Depends(get_db),
                             user: models.User = Depends(get_current_user)):
    from sqlalchemy.orm.attributes import flag_modified
    d = _project_dashboard(db, dashboard_id, user, edit=True)
    if payload.name is not None and payload.name.strip():
        d.name = payload.name.strip()[:120]
    if payload.tiles is not None:
        spec = dict(d.project_spec or {})
        known = {t["id"]: t for t in spec.get("tiles") or []}
        tiles = []
        for t in payload.tiles[:60]:
            base = known.get(str(t.get("id")))
            if not base:
                continue  # tiles come from the analysis; they can be arranged, renamed or hidden, not invented
            tiles.append({
                **base,
                "title": str(t.get("title") or base["title"])[:120],
                "hidden": bool(t.get("hidden", base.get("hidden"))),
                "span": 2 if t.get("span") == 2 else 1,
                "chart_type": t.get("chart_type") if t.get("chart_type") in (
                    None, "line", "area", "bar", "horizontal_bar", "table", "pie") else base.get("chart_type"),
            })
        spec["tiles"] = tiles
        d.project_spec = spec
        flag_modified(d, "project_spec")
    db.commit()
    return _dashboard_out(db, d, user)
