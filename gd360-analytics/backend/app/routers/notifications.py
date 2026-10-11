"""
/notifications - the GD360 bell (2026-10-11, Explain & Alerts).

  GET  /notifications                 the latest 40, newest first, and the unread count
  GET  /notifications/unread?since=   the unread count and anything new since `since` (the bell polls this)
  POST /notifications/read            mark some ({"ids": [...]}) or all ({}) read
  POST /notifications/{id}/snooze     "Snooze a week" - this alert stops reaching you (only you) for N days
  POST /notifications/{id}/unsnooze
  POST /notifications/{id}/why        the alert's number now and why it moved (from the dashboard, no new setup)
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..services import notifications as svc

router = APIRouter(prefix="/notifications", tags=["notifications"])


class ReadBody(BaseModel):
    ids: list[str] | None = Field(default=None, max_length=200)


class SnoozeBody(BaseModel):
    days: int = Field(default=7, ge=1, le=30)


def _mine(db: Session, user: models.User, nid: str) -> models.Notification:
    n = db.get(models.Notification, nid)
    if not n or n.user_id != user.id:
        raise HTTPException(404, "Notification not found.")
    return n


def _alert_of(db: Session, user: models.User, n: models.Notification) -> models.Automation:
    a = db.get(models.Automation, n.automation_id or "")
    if not a or not (a.owner_id == user.id or svc.recipient_of(a, user)):
        raise HTTPException(404, "That alert no longer exists.")
    return a


@router.get("")
def list_notifications(limit: int = 40, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return svc.list_for(db, user, limit)


@router.get("/unread")
def unread(since: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    after = None
    if since:
        try:
            after = datetime.fromisoformat(since.rstrip("Z"))
        except ValueError:
            after = None
    return {"unread": svc.unread_count(db, user), "latest": svc.latest_unread(db, user, after) if after else [],
            "now": datetime.utcnow().isoformat() + "Z"}


@router.post("/read")
def mark_read(body: ReadBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    n = svc.mark_read(db, user, body.ids)
    db.commit()
    return {"marked": n, "unread": svc.unread_count(db, user)}


@router.post("/{notification_id}/snooze")
def snooze(notification_id: str, body: SnoozeBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    n = _mine(db, user, notification_id)
    a = _alert_of(db, user, n)
    until = svc.snooze(db, a, user, body.days)
    if n.read_at is None:
        n.read_at = datetime.utcnow()
    db.commit()
    return {"automation_id": a.id, "until": svc.iso(until), "name": a.name}


@router.post("/{notification_id}/unsnooze")
def unsnooze(notification_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    n = _mine(db, user, notification_id)
    a = _alert_of(db, user, n)
    svc.unsnooze(db, a, user)
    db.commit()
    return {"automation_id": a.id, "until": None}


@router.post("/{notification_id}/why")
def why(notification_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """The watched number as it is now, and what moved it - from the
    dashboard's own tiles (the same numbers the alert used)."""
    from ..services import dashboard_watch
    n = _mine(db, user, notification_id)
    if n.read_at is None:
        n.read_at = datetime.utcnow()
        db.commit()
    a = db.get(models.Automation, n.automation_id or "")
    target = ((a.trigger or {}).get("target") or {}) if a else {}
    if not a or target.get("kind") != "board":
        data = n.data or {}
        return {"why": data.get("why"), "current": None, "link": n.link}
    try:
        ev = dashboard_watch.evaluate(db, user, target)
    except dashboard_watch.WatchError as e:
        return {"why": (n.data or {}).get("why"), "current": None, "link": n.link, "error": str(e)}
    return {
        "why": ev.get("why") or (n.data or {}).get("why"),
        "current": {"label": ev["label"], "display": ev["display"], "window_text": ev["window_text"], "as_of": ev.get("as_of"),
                    "prior_display": ev.get("prior_display"), "formula": ev.get("formula")},
        "link": ev["link"],
    }
