"""
Guided Analysis (2026-10-10) - the HTTP surface of
services/project_engine/guided.py.

A Guided Analysis is created with POST /projects (mode="guided"); its page
reads GET /projects/{id} and polls GET /projects/runs/{run_id}, like an
Instant Answer. These endpoints drive it one step at a time:

  POST   /guided/runs/{run_id}/steps/{step_id}/run      run (or re-run) a step
  POST   /guided/runs/{run_id}/steps/{step_id}/approve  approve it; runs the next step
  POST   /guided/runs/{run_id}/steps/{step_id}/revise   change it in plain English, then run it
  PUT    /guided/runs/{run_id}/steps/{step_id}/sql      replace its SQL, then run it
  DELETE /guided/runs/{run_id}/steps/{step_id}          remove it
  POST   /guided/runs/{run_id}/steps                    add a step (after_id), then run it
  POST   /guided/runs/{run_id}/run-rest                 run every remaining step, then write the answer
  POST   /guided/runs/{run_id}/finish                   write the answer from the steps that ran
  POST   /guided/runs/{run_id}/rework                   (R56) re-run every step of a conversation answer, then rewrite it

2026-10-19 (R57): a question asked as "Guided analysis" in a conversation is a run with plan["guided_v2"] - it goes
step by step here (the first step runs by itself, each later one after "Looks right") until the answer is written.

2026-10-19 (R56): a conversation (v2) answer is edited the same way on the Analysis canvas. Its edits then
rewrite the answer straight away (guided.rework) - there is no separate "approve" or "write the answer" there.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..services.project_engine import guided
from .projects import _rate_limit, _run, _run_out

router = APIRouter(prefix="/guided", tags=["guided"])


class InstructionRequest(BaseModel):
    instruction: str = Field(min_length=2, max_length=1000)


class AddStepRequest(InstructionRequest):
    after_id: str | None = Field(default=None, max_length=40)


class SqlRequest(BaseModel):
    sql: str = Field(min_length=6, max_length=20000)


class ApproveRequest(BaseModel):
    run_next: bool = True


def _guided_run(db: Session, run_id: str, user: models.User) -> models.ProjectRun:
    run, conv = _run(db, run_id, user, edit=True)
    if conv.kind != "guided" and not _v2(conv):
        raise HTTPException(404, "Guided analysis not found.")
    if run.status == "planning":
        raise HTTPException(409, "Euliv is still writing the plan.")
    if run.status in ("failed", "needs_input", "stopped", "replaced") and not run.steps:
        raise HTTPException(409, "This analysis has no steps to work on.")
    if guided.is_busy(run.id) or run.status == "running":
        raise HTTPException(409, "Euliv is still working on this analysis. Wait for the current step to finish.")
    return run


def _v2(conv: models.Conversation) -> bool:
    return bool((conv.thread_meta or {}).get("v2")) and conv.kind != "guided"


def _stepwise(conv: models.Conversation | None, run: models.ProjectRun) -> bool:
    """R57: a Guided analysis asked in a conversation goes step by step (each step waits for the person's OK) until
    its answer is written; after that its edits rewrite the answer straight away, like any conversation answer."""
    if conv is None or not _v2(conv):
        return True
    return bool((run.plan or {}).get("guided_v2")) and run.status != "done"


def _job(db: Session, run: models.ProjectRun, step_id: str | None):
    """The background job after a step changed: a step-by-step analysis runs that step; a written answer reworks."""
    conv = db.get(models.Conversation, run.conversation_id)
    if not _stepwise(conv, run):
        return guided.rework, (step_id,)
    return guided.run_step, (step_id,)


def _step(run: models.ProjectRun, step_id: str) -> dict:
    step = guided.find(run, step_id)
    if not step:
        raise HTTPException(404, "That step is not in this analysis.")
    return step


def _start(run: models.ProjectRun, fn, *args, db: Session | None = None, show: str | None = None) -> None:
    """Starts the background job; `show` is the step to mark running right
    away so the page never shows a stale state in between."""
    # marked BEFORE the job starts: the job's own writes must never be
    # overwritten by this request's older copy of the steps
    before = (guided.find(run, show) or {}).get("status") if show else None
    if db is not None and show:
        guided.mark_running(db, run, show)
    try:
        guided.start(run.id, fn, *args)
    except guided.GuidedError as e:
        if db is not None and show and before:
            guided.mark_status(db, run, show, before)
        raise HTTPException(409, str(e))


def _out(db: Session, run: models.ProjectRun) -> dict:
    db.refresh(run)
    return _run_out(run)


@router.post("/runs/{run_id}/steps/{step_id}/run")
def run_step(run_id: str, step_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    run = _guided_run(db, run_id, user)
    _step(run, step_id)
    fn, args = _job(db, run, step_id)
    _start(run, fn, *args, db=db, show=step_id)
    return _out(db, run)


@router.post("/runs/{run_id}/steps/{step_id}/approve")
def approve_step(run_id: str, step_id: str, payload: ApproveRequest | None = None, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    run = _guided_run(db, run_id, user)
    _step(run, step_id)
    try:
        guided.approve(db, run, step_id)
    except guided.GuidedError as e:
        raise HTTPException(400, str(e))
    if payload is None or payload.run_next:
        nxt = guided.next_step(run, step_id)
        _start(run, guided.approve_and_next, step_id, db=db, show=nxt["id"] if nxt else None)
    return _out(db, run)


@router.post("/runs/{run_id}/steps/{step_id}/revise")
def revise_step(run_id: str, step_id: str, payload: InstructionRequest, db: Session = Depends(get_db),
                user: models.User = Depends(get_current_user)):
    _rate_limit(user.id)
    run = _guided_run(db, run_id, user)
    _step(run, step_id)
    try:
        guided.revise_step(db, run, step_id, payload.instruction.strip())
    except guided.GuidedError as e:
        raise HTTPException(400, str(e))
    fn, args = _job(db, run, step_id)
    _start(run, fn, *args, db=db, show=step_id)
    return _out(db, run)


@router.put("/runs/{run_id}/steps/{step_id}/sql")
def set_step_sql(run_id: str, step_id: str, payload: SqlRequest, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    run = _guided_run(db, run_id, user)
    _step(run, step_id)
    try:
        guided.set_sql(db, run, step_id, payload.sql)
    except guided.GuidedError as e:
        raise HTTPException(400, str(e))
    fn, args = _job(db, run, step_id)
    _start(run, fn, *args, db=db, show=step_id)
    return _out(db, run)


@router.delete("/runs/{run_id}/steps/{step_id}")
def remove_step(run_id: str, step_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    run = _guided_run(db, run_id, user)
    _step(run, step_id)
    try:
        guided.remove_step(db, run, step_id)
    except guided.GuidedError as e:
        raise HTTPException(400, str(e))
    conv = db.get(models.Conversation, run.conversation_id)
    if not _stepwise(conv, run):
        _start(run, guided.rework, None, db=db)
    return _out(db, run)


@router.post("/runs/{run_id}/steps", status_code=201)
def add_step(run_id: str, payload: AddStepRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _rate_limit(user.id)
    run = _guided_run(db, run_id, user)
    try:
        step = guided.add_step(db, run, payload.instruction.strip(), payload.after_id)
    except guided.GuidedError as e:
        raise HTTPException(400, str(e))
    fn, args = _job(db, run, step["id"])
    _start(run, fn, *args, db=db, show=step["id"])
    return {**_out(db, run), "added_step_id": step["id"]}


@router.post("/runs/{run_id}/run-rest")
def run_rest(run_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    run = _guided_run(db, run_id, user)
    conv = db.get(models.Conversation, run.conversation_id)
    # R57: "Looks right, run the rest" in a conversation - what ran is approved, the rest runs, then the answer
    nxt = next((s for s in run.steps or [] if s.get("status") != "done"), None)
    _start(run, guided._run_all if conv is not None and _v2(conv) else guided.run_rest, db=db, show=nxt["id"] if nxt else None)
    return _out(db, run)


@router.post("/runs/{run_id}/finish")
def finish(run_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    run = _guided_run(db, run_id, user)
    if not any(s.get("status") == "done" for s in run.steps or []):
        raise HTTPException(400, "Run at least one step before writing the answer.")
    _start(run, guided.finish)
    return _out(db, run)


@router.post("/runs/{run_id}/rework")
def rework(run_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """R56: "Run all" on the Analysis canvas - every step again on today's data, then the answer rewritten."""
    run = _guided_run(db, run_id, user)
    if not run.steps:
        raise HTTPException(400, "This answer has no steps to run.")
    _start(run, guided.rework, None, True, db=db, show=(run.steps or [{}])[0].get("id"))
    return _out(db, run)
