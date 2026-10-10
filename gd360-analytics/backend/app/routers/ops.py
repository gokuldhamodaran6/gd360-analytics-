"""
/ops - the Automations home (2026-10-10, round 19). One read model over
automations, alerts, dashboard refreshes, chains and data syncs, plus the
few actions the home page needs that the older routers didn't have:
background "run now" for refreshes and chains, a schedule change that works
for any kind, and bulk "refresh daily" for shared dashboards that never
refresh. See services/ops_home.py.
"""
from __future__ import annotations

import threading
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..database import SessionLocal, get_db
from ..deps import get_current_user
from ..services import audit, ops_home, workspace_access
from ..services.scheduler import compute_next_refresh_at

router = APIRouter(prefix="/ops", tags=["ops"])

_RUNNING: set[str] = set()
_LOCK = threading.Lock()


def _scope_or_404(fn, *a, **k):
    try:
        return fn(*a, **k)
    except ops_home.ScopeError as e:
        raise HTTPException(404, str(e))


@router.get("/overview")
def overview(workspace_id: str | None = None, space_id: str | None = None, db: Session = Depends(get_db),
             user: models.User = Depends(get_current_user)):
    out = _scope_or_404(ops_home.overview, db, user, workspace_id, space_id)
    for it in out["items"]:
        if it["key"] in _RUNNING:
            it["running"] = True
    out["tiles"]["running_now"] = sum(1 for it in out["items"] if it.get("running"))
    return out


@router.get("/runs")
def runs(workspace_id: str | None = None, page: int = 1, page_size: int = 25, kind: str | None = None,
         status: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return _scope_or_404(ops_home.run_feed, db, user, workspace_id, page, page_size, kind, status)


@router.get("/items/{kind}/{item_id}/runs")
def item_runs(kind: str, item_id: str, workspace_id: str | None = None, limit: int = 30,
              db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return _scope_or_404(ops_home.item_runs, db, user, workspace_id, f"{kind}:{item_id}", limit)


def _background(key: str, work) -> None:
    with _LOCK:
        if key in _RUNNING:
            raise HTTPException(409, "It's already running.")
        _RUNNING.add(key)

    def job():
        db = SessionLocal()
        try:
            work(db)
        except Exception as e:  # noqa: BLE001 - the engines record their own failures
            print(f"[ops] background run {key} failed: {e}")
            db.rollback()
        finally:
            db.close()
            with _LOCK:
                _RUNNING.discard(key)

    threading.Thread(target=job, daemon=True, name=f"ops-{key[:20]}").start()


@router.post("/items/{kind}/{item_id}/run", status_code=202)
def run_now(kind: str, item_id: str, workspace_id: str | None = None, db: Session = Depends(get_db),
            user: models.User = Depends(get_current_user)):
    """Starts one item now, in the background, and returns at once - the
    home page follows it through the overview's `running` flag."""
    data = _scope_or_404(ops_home.item_runs, db, user, workspace_id, f"{kind}:{item_id}", 1)
    item = data["item"]
    if not item.get("can_run"):
        raise HTTPException(403, "You can't run this one.")
    key = f"{kind}:{item_id}"
    if kind in ("automation", "alert"):
        from ..services import automations as auto_svc
        a = db.get(models.Automation, item_id)
        if a.approval_status == "pending":
            raise HTTPException(409, "This automation is waiting for an owner's or admin's OK.")
        try:
            run_id = auto_svc.start_manual_run(a.id, a.owner_id)
        except auto_svc.AutomationError as e:
            raise HTTPException(409, str(e))
        return {"started": True, "run_id": run_id}
    if kind == "refresh":
        from ..services.scheduler import refresh_dashboard

        def work(s):
            d = s.get(models.Dashboard, item_id)
            if d:
                refresh_dashboard(s, d, job_type="manual_refresh")
                s.commit()
        _background(key, work)
    elif kind == "chain":
        from ..services.pipelines import run_pipeline
        p = db.get(models.Pipeline, item_id)
        if not p or not p.steps:
            raise HTTPException(400, "This chain has no steps yet - add one before running it.")

        def work(s):
            pp = s.get(models.Pipeline, item_id)
            if pp:
                run_pipeline(s, pp, run_type="manual")
                s.commit()
        _background(key, work)
    elif kind == "sync":
        from . import apps as apps_router
        if item_id in apps_router._SYNCING:  # noqa: SLF001
            raise HTTPException(409, "It's already syncing.")
        apps_router._sync_in_background(item_id)  # noqa: SLF001
    else:
        raise HTTPException(404, "Not found.")
    return {"started": True}


class ScheduleBody(BaseModel):
    items: list[str] = Field(default_factory=list)   # ["refresh:<id>", "chain:<id>", "sync:<id>"]
    interval: str


@router.post("/schedule")
def set_schedule(body: ScheduleBody, workspace_id: str | None = None, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    """Changes how often one or more refreshes, chains or syncs run."""
    from ..services.synced_sources import SYNC_INTERVALS, next_sync_time
    scope = _scope_or_404(ops_home.Scope, db, user, workspace_id)
    allowed = {it["key"]: it for it in ops_home.collect(scope)}
    if not body.items:
        raise HTTPException(400, "Pick at least one item.")
    changed = []
    now = datetime.utcnow()
    for key in body.items[:200]:
        it = allowed.get(key)
        if not it:
            raise HTTPException(404, "One of those isn't in this workspace any more - reload the page.")
        if not it["schedule"].get("editable"):
            raise HTTPException(403, f"You can't change how often “{it['name']}” runs.")
        kind, _, item_id = key.partition(":")
        if kind == "refresh":
            if body.interval not in ("off", "15m", "1h", "6h", "daily"):
                raise HTTPException(400, "Pick every 15 minutes, every hour, every 6 hours, once a day or off.")
            d = db.get(models.Dashboard, item_id)
            d.refresh_interval = None if body.interval == "off" else body.interval
            d.next_refresh_at = compute_next_refresh_at(d.refresh_interval, now)
        elif kind == "chain":
            if body.interval not in ("off", "15m", "1h", "6h", "daily"):
                raise HTTPException(400, "Pick every 15 minutes, every hour, every 6 hours, once a day or off.")
            p = db.get(models.Pipeline, item_id)
            p.schedule_interval = None if body.interval == "off" else body.interval
            p.next_run_at = compute_next_refresh_at(p.schedule_interval, now)
        elif kind == "sync":
            if body.interval not in SYNC_INTERVALS:
                raise HTTPException(400, "Pick one of the sync intervals offered.")
            ds = db.get(models.DataSource, item_id)
            ds.connection_info = {**(ds.connection_info or {}), "sync_interval": body.interval}
            ds.next_sync_at = next_sync_time(ds, ds.last_synced_at or now)
        else:
            raise HTTPException(400, "Automations keep their own schedule - edit the automation.")
        changed.append({"key": key, "name": it["name"]})
    audit.log_audit_event(db, actor=user, action="schedule_changed",
                          workspace_id=None if scope.personal else scope.ws.id,
                          target_type="schedule", target_id=None,
                          metadata={"interval": body.interval, "items": [c["name"] for c in changed][:20]})
    db.commit()
    return {"changed": changed}


class RefreshAllBody(BaseModel):
    items: list[str] = Field(default_factory=list)


@router.post("/refresh-all", status_code=202)
def refresh_all(body: RefreshAllBody, workspace_id: str | None = None, db: Session = Depends(get_db),
                user: models.User = Depends(get_current_user)):
    """Refreshes several dashboards now, one after another, in the background."""
    from ..services.scheduler import refresh_dashboard
    scope = _scope_or_404(ops_home.Scope, db, user, workspace_id)
    allowed = {it["key"]: it for it in ops_home.collect(scope)}
    ids = []
    for key in body.items[:50]:
        it = allowed.get(key)
        if it and it["kind"] == "refresh" and it.get("can_run"):
            ids.append(it["id"])
    if not ids:
        raise HTTPException(400, "Nothing here you can refresh.")
    started = []
    for dash_id in ids:
        key = f"refresh:{dash_id}"
        try:
            def work(s, dash_id=dash_id):
                d = s.get(models.Dashboard, dash_id)
                if d:
                    refresh_dashboard(s, d, job_type="manual_refresh")
                    s.commit()
            _background(key, work)
            started.append(key)
        except HTTPException:
            continue
    return {"started": started}


# ------------------------------------------------------- automation OKs ----

class DecisionBody(BaseModel):
    note: str | None = Field(default=None, max_length=500)


def _approvable(db: Session, user: models.User, automation_id: str) -> models.Automation:
    a = db.get(models.Automation, automation_id)
    if not a or not a.workspace_id or not workspace_access.is_admin(db, user.id, a.workspace_id):
        raise HTTPException(404, "Automation not found.")
    if a.approval_status != "pending":
        raise HTTPException(409, "This automation isn't waiting for an OK.")
    return a


@router.post("/automations/{automation_id}/approve")
def approve(automation_id: str, body: DecisionBody, db: Session = Depends(get_db),
            user: models.User = Depends(get_current_user)):
    from ..services import automations as auto_svc
    a = _approvable(db, user, automation_id)
    a.approval_status = "approved"
    a.approved_by_id = user.id
    a.approved_at = datetime.utcnow()
    a.approved_recipients = list((a.tell or {}).get("email") or [])
    a.approval_note = body.note
    a.enabled = True
    if (a.trigger or {}).get("type") == "new_data":
        a.last_seen_data_at = auto_svc.data_version(db.get(models.DataSource, (a.trigger or {}).get("datasource_id")))
    auto_svc.schedule_initial(a)
    audit.log_audit_event(db, actor=user, action="automation_approved", workspace_id=a.workspace_id,
                          target_type="automation", target_id=a.id,
                          metadata={"name": a.name, "recipients": a.approved_recipients})
    db.commit()
    return {"ok": True}


@router.post("/automations/{automation_id}/reject")
def reject(automation_id: str, body: DecisionBody, db: Session = Depends(get_db),
           user: models.User = Depends(get_current_user)):
    a = _approvable(db, user, automation_id)
    a.approval_status = "rejected"
    a.approved_by_id = user.id
    a.approved_at = datetime.utcnow()
    a.approval_note = body.note
    a.enabled = False
    a.next_run_at = None
    audit.log_audit_event(db, actor=user, action="automation_rejected", workspace_id=a.workspace_id,
                          target_type="automation", target_id=a.id, metadata={"name": a.name, "note": body.note})
    db.commit()
    return {"ok": True}
