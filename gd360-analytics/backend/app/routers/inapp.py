"""
In-app endpoints for signed-in customers (2026-10-10), published from
Mission Control:

  GET  /inapp/announcements              live announcements for me (not dismissed)
  POST /inapp/announcements/{id}/{event}  seen | click | dismiss
  GET  /inapp/flags                      {flag_key: true|false} for me
  POST /inapp/support                    open a support ticket from inside the app
"""
from __future__ import annotations

import time
from collections import defaultdict, deque
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..services import admin_metrics as M
from ..services.admin_access import staff_role

router = APIRouter(prefix="/inapp", tags=["in-app"])


def _my_row(db: Session, user: models.User) -> dict | None:
    return next((r for r in M.user_rows(db) if r["id"] == user.id), None)


@router.get("/announcements")
def my_announcements(user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    live = db.query(models.Announcement).filter(models.Announcement.status == "live").order_by(models.Announcement.created_at.desc()).all()
    if not live:
        return {"announcements": []}
    dismissed = {r.announcement_id for r in db.query(models.AnnouncementReceipt).filter(
        models.AnnouncementReceipt.user_id == user.id, models.AnnouncementReceipt.dismissed_at.isnot(None)).all()}
    row = None
    out = []
    for a in live:
        if a.id in dismissed:
            continue
        if a.segment_id:
            seg = db.get(models.Segment, a.segment_id)
            if seg:
                row = row or _my_row(db, user)
                if not row or not M.segment_members([row], seg.rules):
                    continue
        out.append({"id": a.id, "kind": a.kind, "title": a.title, "body": a.body, "cta_label": a.cta_label, "cta_url": a.cta_url})
    return {"announcements": out[:3]}


@router.post("/announcements/{ann_id}/{event}")
def announcement_event(ann_id: str, event: str, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if event not in ("seen", "click", "dismiss"):
        raise HTTPException(404, "Unknown event.")
    if not db.get(models.Announcement, ann_id):
        raise HTTPException(404, "Announcement not found.")
    r = db.query(models.AnnouncementReceipt).filter(models.AnnouncementReceipt.announcement_id == ann_id,
                                                    models.AnnouncementReceipt.user_id == user.id).first()
    if not r:
        r = models.AnnouncementReceipt(announcement_id=ann_id, user_id=user.id)
        db.add(r)
    now = datetime.utcnow()
    if event == "seen" and not r.seen_at:
        r.seen_at = now
    if event == "click":
        r.clicked_at = r.clicked_at or now
        r.seen_at = r.seen_at or now
    if event == "dismiss":
        r.dismissed_at = now
        r.seen_at = r.seen_at or now
    db.commit()
    return {"ok": True}


@router.get("/flags")
def my_flags(user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    flags = db.query(models.FeatureFlag).all()
    is_staff = bool(staff_role(db, user.email))
    row = None
    out = {}
    for f in flags:
        on = bool(f.enabled)
        if on and f.staff_only:
            on = is_staff
        elif on and f.segment_id:
            seg = db.get(models.Segment, f.segment_id)
            if seg:
                row = row or _my_row(db, user)
                on = bool(row and M.segment_members([row], seg.rules))
        if on and not f.staff_only:
            on = M.in_rollout(user.id, f.key, f.rollout_pct or 0)
        out[f.key] = on
    return out


_hits: dict[str, deque] = defaultdict(deque)


class SupportIn(BaseModel):
    subject: str = Field(min_length=3, max_length=200)
    body: str = Field(min_length=5, max_length=8000)


@router.post("/support")
def contact_support(body: SupportIn, user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    q, now = _hits[user.id], time.time()
    while q and now - q[0] > 3600:
        q.popleft()
    if len(q) >= 5:
        raise HTTPException(429, "You've sent several messages in the last hour. We'll reply to those first.")
    q.append(now)
    from .admin_ops import create_ticket
    t = create_ticket(db, subject=body.subject, body=body.body, requester_email=user.email, requester_user_id=user.id,
                      priority="P2" if M.is_corporate(user.email) else "P3", channel="in_app")
    db.commit()
    return {"number": t.number}
