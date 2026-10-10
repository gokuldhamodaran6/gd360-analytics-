"""
Runs on the scheduler's 60-second tick: emails reminders that are due to
their owner (once), and starts campaigns whose scheduled time has come.
Reminders also show in "Needs you today" whether or not email is set up.
"""
from __future__ import annotations

import html
import logging
from datetime import datetime

from sqlalchemy.orm import Session

from ... import models
from ..automations import NotConfigured, app_url, email_configured, send_email
from . import campaigns

logger = logging.getLogger(__name__)


def tick(db: Session, now: datetime | None = None) -> None:
    now = now or datetime.utcnow()
    for cid in campaigns.due_scheduled(db, now):
        c = db.get(models.GtmCampaign, cid)
        if c:
            c.status = "queued"
            db.commit()
            campaigns.start(cid)
    if not email_configured():
        return
    due = (db.query(models.GtmReminder).filter(models.GtmReminder.sent_at.is_(None), models.GtmReminder.done.is_(False),
                                              models.GtmReminder.remind_at <= now).limit(20).all())
    for r in due:
        owner = db.get(models.User, r.owner_id)
        r.sent_at = now  # once, even if the send fails: it still shows in the app
        if not owner or not owner.email:
            continue
        where = ""
        link = f"{app_url()}/initiatives"
        if r.initiative_id:
            i = db.get(models.Initiative, r.initiative_id)
            if i:
                where = f" · {i.title}"
                link = f"{app_url()}/initiatives/{i.id}"
        if r.account_id:
            a = db.get(models.GtmAccount, r.account_id)
            if a:
                where += f" · {a.name}"
                link = f"{app_url()}/accounts?account={a.id}"
        subject = f"Reminder: {r.note[:80]}"
        text = f"{r.note}{where}\n\nOpen in GD360: {link}"
        body = (f'<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1B2321;max-width:560px">'
                f'<p style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;color:#7A8582">GD360 REMINDER{html.escape(where.upper())}</p>'
                f'<p style="margin:0 0 18px;font-size:17px;line-height:1.5">{html.escape(r.note)}</p>'
                f'<a href="{link}" style="display:inline-block;background:#0E7C5A;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open in GD360</a></div>')
        try:
            send_email([owner.email], subject, body, text)
        except NotConfigured:
            break
        except Exception as e:  # noqa: BLE001
            logger.warning("[initiatives] reminder %s failed: %s", r.id, e)
    db.commit()
