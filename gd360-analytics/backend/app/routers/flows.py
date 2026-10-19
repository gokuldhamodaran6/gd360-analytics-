"""R54 - Automate data. See services/flows/__init__.py."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..services import audit
from ..services.flows import plan, runner, service as svc
from ..services.flows.profile import FlowError

router = APIRouter(prefix="/flows", tags=["flows"])


def _err(e: Exception):
    if isinstance(e, svc.NotFound):
        raise HTTPException(404, str(e))
    if isinstance(e, svc.Forbidden):
        raise HTTPException(403, str(e))
    if isinstance(e, runner.FlowBusy):
        raise HTTPException(409, str(e))
    raise HTTPException(400, str(e))


class DraftBody(BaseModel):
    text: str = Field(..., max_length=2000)
    workspace_id: str | None = None
    source_ids: list[str] | None = None
    timezone: str | None = None


class SpecBody(BaseModel):
    spec: dict
    note: str | None = Field(None, max_length=300)


class PatchBody(BaseModel):
    name: str | None = Field(None, max_length=80)
    enabled: bool | None = None


class MessageBody(BaseModel):
    text: str = Field(..., max_length=2000)


class ReplanBody(BaseModel):
    source_ids: list[str] | None = None


def _out(db, user, f):
    return svc.flow_out(db, user, f)


@router.get("")
def list_flows(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return {"items": svc.list_flows(db, user, workspace_id)}


@router.get("/sources")
def sources(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return {"items": plan.source_options(db, user, workspace_id)}


@router.get("/people")
def people(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return {"items": svc.people(db, user, workspace_id)}


@router.post("/draft")
def draft(body: DraftBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        f = svc.create_draft(db, user, body.text, body.workspace_id, body.source_ids, body.timezone)
    except svc.NeedSources as e:
        db.rollback()
        return {"needs_sources": True, "message": str(e), "options": e.options}
    except FlowError as e:
        db.rollback()
        _err(e)
    audit.log_audit_event(db, actor=user, action="flow_created", workspace_id=f.workspace_id,
                          target_type="data_flow", target_id=f.id, metadata={"name": f.name})
    db.commit()
    return _out(db, user, f)


@router.get("/runs/{run_id}")
def get_run(run_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    r = db.get(models.DataFlowRun, run_id)
    if r is None:
        raise HTTPException(404, "That run doesn’t exist.")
    try:
        svc.get_flow(db, user, r.flow_id)
    except FlowError as e:
        _err(e)
    return svc._run_out(r, True)


@router.get("/{flow_id}")
def get_flow(flow_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        return _out(db, user, svc.get_flow(db, user, flow_id))
    except FlowError as e:
        _err(e)


@router.patch("/{flow_id}")
def patch_flow(flow_id: str, body: PatchBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        f = svc.get_flow(db, user, flow_id, edit=True)
        if body.name is not None and body.name.strip():
            f.name = body.name.strip()[:80]
            db.commit()
        if body.enabled is not None and body.enabled != f.enabled:
            svc.set_enabled(db, user, f, body.enabled)
            audit.log_audit_event(db, actor=user, action="flow_enabled" if body.enabled else "flow_paused",
                                  workspace_id=f.workspace_id, target_type="data_flow", target_id=f.id)
            db.commit()
        return _out(db, user, f)
    except FlowError as e:
        db.rollback()
        _err(e)


@router.put("/{flow_id}/spec")
def put_spec(flow_id: str, body: SpecBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        f = svc.get_flow(db, user, flow_id, edit=True)
        svc.save_spec(db, user, f, body.spec, body.note)
        return _out(db, user, f)
    except FlowError as e:
        db.rollback()
        _err(e)


@router.post("/{flow_id}/replan")
def replan(flow_id: str, body: ReplanBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        f = svc.get_flow(db, user, flow_id, edit=True)
        svc.replan(db, user, f, body.source_ids)
        return _out(db, user, f)
    except FlowError as e:
        db.rollback()
        _err(e)


@router.post("/{flow_id}/messages")
def post_message(flow_id: str, body: MessageBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        f = svc.get_flow(db, user, flow_id, edit=True)
        res = svc.message(db, user, f, body.text)
        return {**res, "flow": _out(db, user, f)}
    except FlowError as e:
        db.rollback()
        _err(e)


@router.post("/{flow_id}/test", status_code=202)
def test_flow(flow_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        f = svc.get_flow(db, user, flow_id, edit=True)
        run = runner.start_run(db, f, "test")
        return {"run_id": run.id}
    except FlowError as e:
        db.rollback()
        _err(e)


@router.post("/{flow_id}/run", status_code=202)
def run_flow(flow_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        f = svc.get_flow(db, user, flow_id, edit=True)
        if f.status == "draft":
            raise FlowError("Test it once first, so you can see the result before it saves anything.")
        run = runner.start_run(db, f, "manual")
        return {"run_id": run.id}
    except FlowError as e:
        db.rollback()
        _err(e)


@router.get("/{flow_id}/runs")
def list_runs(flow_id: str, limit: int = 30, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        f = svc.get_flow(db, user, flow_id)
    except FlowError as e:
        _err(e)
    rows = (db.query(models.DataFlowRun).filter(models.DataFlowRun.flow_id == f.id)
            .order_by(models.DataFlowRun.started_at.desc()).limit(max(1, min(limit, 100))).all())
    return {"items": [svc._run_out(r) for r in rows]}


@router.post("/{flow_id}/fix/apply", status_code=202)
def apply_fix(flow_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        f = svc.get_flow(db, user, flow_id, edit=True)
        run_id = svc.apply_fix(db, user, f)
        audit.log_audit_event(db, actor=user, action="flow_fix_applied", workspace_id=f.workspace_id,
                              target_type="data_flow", target_id=f.id, metadata={"version": f.version})
        db.commit()
        return {"run_id": run_id}
    except FlowError as e:
        db.rollback()
        _err(e)


@router.post("/{flow_id}/fix/dismiss")
def dismiss_fix(flow_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        f = svc.get_flow(db, user, flow_id, edit=True)
        svc.dismiss_fix(db, user, f)
        return _out(db, user, f)
    except FlowError as e:
        db.rollback()
        _err(e)


@router.get("/{flow_id}/versions")
def list_versions(flow_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        f = svc.get_flow(db, user, flow_id)
    except FlowError as e:
        _err(e)
    return {"items": svc.versions(db, f)}


@router.post("/{flow_id}/versions/{version}/restore")
def restore_version(flow_id: str, version: int, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        f = svc.get_flow(db, user, flow_id, edit=True)
        svc.restore(db, user, f, version)
        return _out(db, user, f)
    except FlowError as e:
        db.rollback()
        _err(e)


@router.delete("/{flow_id}", status_code=204)
def delete_flow(flow_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    try:
        f = svc.get_flow(db, user, flow_id, edit=True)
        ws = f.workspace_id
        svc.delete(db, user, f)
        audit.log_audit_event(db, actor=user, action="flow_deleted", workspace_id=ws, target_type="data_flow", target_id=flow_id)
        db.commit()
    except FlowError as e:
        db.rollback()
        _err(e)
