"""Background work on the scheduler's minute tick: every 30 minutes, posts
about live events (from 3 days before registration opens to the end of the
after window) are scanned again - each event at most every 6 hours."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ... import models
from . import core, social

logger = logging.getLogger(__name__)
_last = {"at": None}


def tick(db: Session, now: datetime | None = None) -> None:
    now = now or datetime.utcnow()
    if _last["at"] and now - _last["at"] < timedelta(minutes=30):
        return
    _last["at"] = now
    done = 0
    for cfg in db.query(models.EventConfig).all():
        if done >= 5:
            break
        data = cfg.data or {}
        if data.get("sample"):
            continue
        last = data.get("last_scan_at")
        if last:
            try:
                if now - datetime.fromisoformat(last) < timedelta(hours=6):
                    continue
            except ValueError:
                pass
        i = db.get(models.Initiative, cfg.initiative_id)
        if not i or i.status == "archived" or not core.is_event(i):
            continue
        w = core.Windows(i, cfg)
        if now < w.open - timedelta(days=3) or (w.close and now > w.close + timedelta(days=1)):
            continue
        try:
            social.scan(db, i, cfg, vision_budget=10)
            db.commit()
            done += 1
        except Exception as e:  # noqa: BLE001 - one event never stops the others
            logger.warning("[eventos] scan failed for %s: %s", i.id, e)
            db.rollback()
