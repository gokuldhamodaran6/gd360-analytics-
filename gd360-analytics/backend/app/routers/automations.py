"""
/automations - work that runs by itself (2026-10-08, round 12).

WHEN -> DO -> TELL; see services/automations.py for how runs work. An
automation belongs to the person who made it (it runs with their access,
so it can only ever touch what they can see).
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..deps import get_current_user
from ..database import get_db
from ..services import automations as svc
from ..services.project_engine.catalog import KIND_LABELS, accessible_sources, freshness_text, source_mode

router = APIRouter(prefix="/automations", tags=["automations"])

SYNC_LABELS = {"15m": "Every 15 minutes", "1h": "Every hour", "6h": "Every 6 hours", "daily": "Once a day"}


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


class AutomationBody(BaseModel):
    id: str | None = None  # set when testing an automation that is already saved (keeps its webhooks)
    name: str = Field(default="", max_length=120)
    enabled: bool = True
    trigger: dict = Field(default_factory=dict)
    timezone: str = "UTC"
    steps: list[dict] = Field(default_factory=list)
    stop_on_quality_fail: bool = True
    tell: dict = Field(default_factory=dict)


class ToggleBody(BaseModel):
    enabled: bool


def _get(db: Session, user: models.User, automation_id: str) -> models.Automation:
    a = db.get(models.Automation, automation_id)
    if not a or a.owner_id != user.id:
        raise HTTPException(404, "Automation not found.")
    return a


def _tell_out(tell: dict) -> dict:
    out = {"email": tell.get("email") or [], "mode": tell.get("mode") or "always"}
    for kind in ("slack", "teams"):
        h = tell.get(kind)
        out[kind] = {"masked": h.get("masked"), "label": h.get("label")} if h else None
    return out


def _run_out(r: models.AutomationRun | None) -> dict | None:
    if not r:
        return None
    return {
        "id": r.id, "automation_id": r.automation_id, "name": r.automation_name, "reason": r.reason, "status": r.status,
        "steps": r.step_results or [], "message": r.message, "deliveries": r.deliveries or [], "notified": bool(r.notified),
        "error": r.error_message, "started_at": iso(r.started_at), "finished_at": iso(r.finished_at),
        "seconds": round((r.finished_at - r.started_at).total_seconds(), 1) if r.finished_at else None,
    }


def _out(db: Session, a: models.Automation) -> dict:
    last = (
        db.query(models.AutomationRun)
        .filter(models.AutomationRun.automation_id == a.id)
        .order_by(models.AutomationRun.started_at.desc())
        .first()
    )
    triggered = None
    if (a.trigger or {}).get("type") == "threshold":
        q = db.query(models.AutomationRun).filter(models.AutomationRun.automation_id == a.id,
                                                  models.AutomationRun.reason == "threshold")
        first = q.order_by(models.AutomationRun.started_at).first()
        triggered = {"count": q.count(), "since": iso(first.started_at) if first else None}
    body = {"trigger": a.trigger or {}, "steps": a.steps or [], "tell": a.tell or {}}
    return {
        "id": a.id, "name": a.name, "enabled": a.enabled, "trigger": a.trigger or {}, "timezone": a.timezone,
        "steps": a.steps or [], "stop_on_quality_fail": a.stop_on_quality_fail, "tell": _tell_out(a.tell or {}),
        "sentence": svc.sentence(db, body),
        "next_run_at": iso(a.next_run_at) if a.enabled else None,
        "last_run_at": iso(a.last_run_at), "last_status": a.last_status,
        "last_run": _run_out(last), "running": svc.is_running(a.id),
        "last_value": a.last_value, "last_checked_at": iso(a.last_checked_at), "last_condition": a.last_condition,
        "triggered": triggered, "created_at": iso(a.created_at),
    }


def _bad(e: Exception):
    raise HTTPException(400, str(e))


@router.get("")
def list_automations(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    rows = (
        db.query(models.Automation)
        .filter(models.Automation.owner_id == user.id)
        .order_by(models.Automation.enabled.desc(), models.Automation.created_at.desc())
        .all()
    )
    return {"automations": [_out(db, a) for a in rows], "email_ready": svc.email_configured()}


@router.post("", status_code=201)
def create_automation(body: AutomationBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    if db.query(models.Automation).filter(models.Automation.owner_id == user.id).count() >= svc.MAX_PER_OWNER:
        raise HTTPException(400, f"You can have up to {svc.MAX_PER_OWNER} automations - turn off or delete one first.")
    try:
        fields = svc.validate(db, user, body.model_dump())
    except svc.AutomationError as e:
        _bad(e)
    a = models.Automation(owner_id=user.id, **fields)
    if fields["trigger"]["type"] == "new_data":
        a.last_seen_data_at = svc.data_version(db.get(models.DataSource, fields["trigger"]["datasource_id"]))
    svc.schedule_initial(a)
    db.add(a)
    db.commit()
    db.refresh(a)
    return _out(db, a)


@router.get("/options")
def options(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Everything an automation can point at, for the pickers."""
    from ..routers.dashboards import _can_view
    dashes = (
        db.query(models.Dashboard)
        .filter((models.Dashboard.owner_id == user.id) | (models.Dashboard.workspace_id.isnot(None)))
        .order_by(models.Dashboard.created_at.desc())
        .limit(300)
        .all()
    )
    project_dashboards, classic = [], []
    for d in dashes:
        if not _can_view(db, d, user):
            continue
        if d.layout_version == 3:
            kpis = [{k: x.get(k) for k in ("key", "label", "display", "kind", "delta")} for x in (d.project_snapshot or {}).get("kpis") or []]
            project_dashboards.append({"id": d.id, "name": d.name, "kpis": kpis,
                                       "queries": len((d.project_snapshot or {}).get("steps") or [])})
        elif d.layout_version == 2:
            classic.append({"id": d.id, "name": d.name})
    runs = (
        db.query(models.ProjectRun, models.Conversation)
        .join(models.Conversation, models.Conversation.id == models.ProjectRun.conversation_id)
        .filter(models.ProjectRun.owner_id == user.id, models.ProjectRun.status == "done")
        .order_by(models.ProjectRun.created_at.desc())
        .limit(40)
        .all()
    )
    questions = [
        {"id": r.id, "question": r.question, "project_id": c.id, "project": c.title,
         "kpis": [{k: x.get(k) for k in ("key", "label", "display", "kind", "delta")} for x in (r.result or {}).get("kpis") or []]}
        for r, c in runs
    ]
    sources = []
    for ds in accessible_sources(db, user):
        rules = db.query(models.DataQualityRule).filter(models.DataQualityRule.datasource_id == ds.id).count()
        sources.append({
            "id": ds.id, "name": ds.name, "kind": ds.kind, "label": KIND_LABELS.get(ds.kind, ds.kind),
            "mode": source_mode(ds.kind), "can_sync": ds.kind in svc.SYNCED_KINDS + ("api",),  # 2026-10-09 (round 15): every synced app
            "new_data": ds.kind in svc.NEW_DATA_KINDS, "quality_rules": rules,
        })
    models_ = (
        db.query(models.MLModel)
        .filter(models.MLModel.owner_id == user.id, models.MLModel.status == "ready")
        .order_by(models.MLModel.created_at.desc())
        .limit(50)
        .all()
    )
    return {
        "project_dashboards": project_dashboards, "dashboards": classic, "questions": questions, "sources": sources,
        "models": [{"id": m.id, "name": m.name} for m in models_],
        "email_ready": svc.email_configured(), "me": user.email,
    }


@router.get("/freshness")
def freshness(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """How fresh each source is - live sources are always current; synced
    apps copy new records on their own timing."""
    rows = []
    for ds in accessible_sources(db, user):
        mode = source_mode(ds.kind)
        if mode == "live":
            arrives, updated, type_ = "Always current - queried directly", None, "LIVE"
        elif mode == "synced":
            interval = (ds.connection_info or {}).get("sync_interval") or "1h"
            arrives = SYNC_LABELS.get(interval, "On a schedule")
            if ds.kind == "ga4":
                arrives += " (Google can take a few hours to finalise)"
            updated, type_ = ds.last_synced_at, "SYNCED"
        elif ds.kind == "api":
            arrives, updated, type_ = "When it is refreshed (by hand or an automation)", ds.api_last_refreshed_at, "API"
        elif ds.kind == "streaming":
            arrives, updated, type_ = "As events arrive", ds.last_event_at, "STREAM"
        elif ds.kind in ("google_sheets", "microsoft_excel", "mongodb"):
            arrives, updated, type_ = "Read fresh every time it is asked", None, "LIVE"
        else:
            arrives, updated, type_ = "When a new version is uploaded", ds.created_at, "FILE"
        rows.append({"id": ds.id, "name": ds.name, "type": type_, "arrives": arrives,
                     "updated_at": iso(updated), "freshness": freshness_text(ds), "error": ds.sync_error})
    return {"sources": rows}


class PreviewBody(AutomationBody):
    pass


@router.post("/preview")
def preview(body: PreviewBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """The sentence, the next five runs, what each run costs and the message
    people would receive - for the editor, while it is being filled in.
    Never runs anything."""
    raw = body.model_dump()
    trig = raw.get("trigger") or {}
    tz = raw.get("timezone") or "UTC"
    try:
        svc.zone(tz)
    except svc.AutomationError:
        tz = "UTC"
    if trig.get("type") == "threshold" and trig.get("kpi") and not trig.get("kpi_label"):
        try:
            k = next((x for x in svc.target_kpis(db, user, trig.get("target") or {}) if x.get("key") == trig["kpi"]), None)
            if k:
                trig = {**trig, "kpi_label": k.get("label"),
                        "unit": "%" if svc.is_percent(k) and trig.get("op") in ("below", "above") else ""}
        except svc.AutomationError:
            pass
    tell = raw.get("tell") or {}
    tell_view = {"email": tell.get("email") or [], "mode": tell.get("mode") or "always",
                 "slack": {"label": tell.get("slack_label") or "#channel"} if (tell.get("slack_url") or tell.get("slack_keep")) else None,
                 "teams": {"label": tell.get("teams_label") or "channel"} if (tell.get("teams_url") or tell.get("teams_keep")) else None}
    steps = [s for s in raw.get("steps") or [] if s.get("type") in svc.STEP_TYPES]
    try:
        runs = svc.next_runs(trig, tz, 5) if trig.get("type") in ("schedule", "threshold") else []
    except svc.AutomationError:
        runs = []
    try:
        message = svc.preview_message(db, user, raw.get("name") or "", tz, trig, steps)
    except Exception:  # noqa: BLE001 - a preview never fails the editor
        message = None
    return {
        "sentence": svc.sentence(db, {"trigger": trig, "steps": steps, "tell": tell_view}),
        "next_runs": [iso(r) for r in runs],
        "estimate": svc.estimate(db, user, trig, steps),
        "message": message,
        "email_ready": svc.email_configured(),
    }


@router.post("/test", status_code=202)
def test_draft(body: AutomationBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """'Test it now': runs the steps and sends the message once, without
    saving or scheduling anything."""
    raw = body.model_dump()
    existing = db.get(models.Automation, raw["id"]) if raw.get("id") else None
    if existing and existing.owner_id != user.id:
        existing = None
    try:
        fields = svc.validate(db, user, raw, existing)
    except svc.AutomationError as e:
        _bad(e)
    run_id = svc.start_test_run(user.id, fields)
    return {"run_id": run_id}


@router.get("/runs/{run_id}")
def get_run(run_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    r = db.get(models.AutomationRun, run_id)
    if not r or r.owner_id != user.id:
        raise HTTPException(404, "Run not found.")
    return _run_out(r)


@router.get("/{automation_id}")
def get_automation(automation_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return _out(db, _get(db, user, automation_id))


@router.put("/{automation_id}")
def update_automation(automation_id: str, body: AutomationBody, db: Session = Depends(get_db),
                      user: models.User = Depends(get_current_user)):
    a = _get(db, user, automation_id)
    try:
        fields = svc.validate(db, user, body.model_dump(), a)
    except svc.AutomationError as e:
        _bad(e)
    trigger_changed = fields["trigger"] != (a.trigger or {}) or fields["timezone"] != a.timezone
    for k, v in fields.items():
        setattr(a, k, v)
    if trigger_changed:
        a.last_condition = None
        if fields["trigger"]["type"] == "new_data":
            a.last_seen_data_at = svc.data_version(db.get(models.DataSource, fields["trigger"]["datasource_id"]))
    svc.schedule_initial(a)
    db.commit()
    db.refresh(a)
    return _out(db, a)


@router.patch("/{automation_id}")
def toggle_automation(automation_id: str, body: ToggleBody, db: Session = Depends(get_db),
                      user: models.User = Depends(get_current_user)):
    a = _get(db, user, automation_id)
    a.enabled = body.enabled
    if body.enabled and (a.trigger or {}).get("type") == "new_data":
        # turning back on never replays data that landed while it was off
        a.last_seen_data_at = svc.data_version(db.get(models.DataSource, (a.trigger or {}).get("datasource_id")))
    svc.schedule_initial(a)
    db.commit()
    db.refresh(a)
    return _out(db, a)


@router.delete("/{automation_id}", status_code=204)
def delete_automation(automation_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    a = _get(db, user, automation_id)
    db.query(models.AutomationRun).filter(models.AutomationRun.automation_id == a.id).update(
        {models.AutomationRun.automation_id: None}, synchronize_session=False
    )
    db.delete(a)
    db.commit()


@router.post("/{automation_id}/run", status_code=202)
def run_now(automation_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    a = _get(db, user, automation_id)
    try:
        run_id = svc.start_manual_run(a.id, user.id)
    except svc.AutomationError as e:
        raise HTTPException(409, str(e))
    return {"run_id": run_id}


@router.get("/{automation_id}/runs")
def list_runs(automation_id: str, limit: int = 20, db: Session = Depends(get_db),
              user: models.User = Depends(get_current_user)):
    a = _get(db, user, automation_id)
    rows = (
        db.query(models.AutomationRun)
        .filter(models.AutomationRun.automation_id == a.id)
        .order_by(models.AutomationRun.started_at.desc())
        .limit(max(1, min(limit, 100)))
        .all()
    )
    return {"runs": [_run_out(r) for r in rows]}
