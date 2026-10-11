"""
In-app notifications - the GD360 bell (2026-10-11, Explain & Alerts).

An alert is delivered the moment it is detected: a Notification row for
every person on its in-app list (the bell polls, and an open GD360 tab also
raises a desktop notification), plus the email, in the same run. Nothing is
held for "office hours".

A person can snooze one alert for themselves ("Snooze a week") - stored on
the automation's tell as {"muted": {user_id: "iso until"}} so the other
recipients keep getting it.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from .. import models

MAX_LIST = 40
KEEP_DAYS = 90


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


def out(n: models.Notification) -> dict:
    return {
        "id": n.id, "kind": n.kind, "title": n.title, "body": n.body, "link": n.link,
        "data": n.data or {}, "automation_id": n.automation_id,
        "read": n.read_at is not None, "created_at": iso(n.created_at),
    }


def create(db: Session, user_ids: list[str], *, kind: str, title: str, body: str | None = None,
           link: str | None = None, data: dict | None = None, automation_id: str | None = None,
           workspace_id: str | None = None) -> list[models.Notification]:
    """One row per person (duplicates removed). Committed by the caller."""
    rows = []
    seen: set[str] = set()
    for uid in user_ids or []:
        if not uid or uid in seen:
            continue
        seen.add(uid)
        n = models.Notification(
            user_id=uid, workspace_id=workspace_id, kind=kind, title=str(title)[:300],
            body=(str(body)[:2000] if body else None), link=(str(link)[:500] if link else None),
            data=data or {}, automation_id=automation_id,
        )
        db.add(n)
        rows.append(n)
    return rows


def list_for(db: Session, user: models.User, limit: int = MAX_LIST) -> dict:
    q = db.query(models.Notification).filter(models.Notification.user_id == user.id)
    rows = q.order_by(models.Notification.created_at.desc()).limit(max(1, min(limit, MAX_LIST))).all()
    return {"items": [out(n) for n in rows], "unread": unread_count(db, user)}


def unread_count(db: Session, user: models.User) -> int:
    return (
        db.query(models.Notification)
        .filter(models.Notification.user_id == user.id, models.Notification.read_at.is_(None))
        .count()
    )


def latest_unread(db: Session, user: models.User, since: datetime | None) -> list[dict]:
    q = db.query(models.Notification).filter(models.Notification.user_id == user.id,
                                             models.Notification.read_at.is_(None))
    if since:
        q = q.filter(models.Notification.created_at > since)
    return [out(n) for n in q.order_by(models.Notification.created_at.desc()).limit(5).all()]


def mark_read(db: Session, user: models.User, ids: list[str] | None) -> int:
    q = db.query(models.Notification).filter(models.Notification.user_id == user.id,
                                             models.Notification.read_at.is_(None))
    if ids is not None:
        q = q.filter(models.Notification.id.in_(ids[:200]))
    n = 0
    now = datetime.utcnow()
    for row in q.all():
        row.read_at = now
        n += 1
    return n


def prune(db: Session) -> None:
    """Old read notifications go after KEEP_DAYS (called from the scheduler tick, best effort)."""
    cut = datetime.utcnow() - timedelta(days=KEEP_DAYS)
    db.query(models.Notification).filter(models.Notification.created_at < cut,
                                         models.Notification.read_at.isnot(None)).delete(synchronize_session=False)


# ---- per-person snooze -------------------------------------------------------

def is_muted(tell: dict, user_id: str | None = None, email: str | None = None, now: datetime | None = None) -> bool:
    now = now or datetime.utcnow()
    muted = (tell or {}).get("muted") or {}
    keys = [k for k in (user_id, (email or "").lower() or None) if k]
    for k in keys:
        until = muted.get(k)
        if not until:
            continue
        try:
            if datetime.fromisoformat(str(until).rstrip("Z")) > now:
                return True
        except ValueError:
            continue
    return False


def snooze(db: Session, a: models.Automation, user: models.User, days: int) -> datetime:
    days = max(1, min(int(days or 7), 30))
    until = datetime.utcnow() + timedelta(days=days)
    tell = dict(a.tell or {})
    muted = {k: v for k, v in (tell.get("muted") or {}).items() if v}
    muted[user.id] = until.isoformat()
    if user.email:
        muted[user.email.lower()] = until.isoformat()
    tell["muted"] = muted
    a.tell = tell
    flag_modified(a, "tell")
    return until


def unsnooze(db: Session, a: models.Automation, user: models.User) -> None:
    tell = dict(a.tell or {})
    muted = dict(tell.get("muted") or {})
    muted.pop(user.id, None)
    if user.email:
        muted.pop(user.email.lower(), None)
    tell["muted"] = muted
    a.tell = tell
    flag_modified(a, "tell")


def recipient_of(a: models.Automation, user: models.User) -> bool:
    tell = a.tell or {}
    if user.id in (tell.get("in_app") or []):
        return True
    return bool(user.email) and user.email.lower() in [str(e).lower() for e in tell.get("email") or []]
