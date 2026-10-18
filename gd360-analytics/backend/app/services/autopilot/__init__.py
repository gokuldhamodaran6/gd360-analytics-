"""2026-10-17 (R53): Initiatives Autopilot - plan it once, approve and prove.

  brain      the business brain the planner reads (website, audiences, every source's numbers, history)
  packs      14 industry packs with benchmark ranges (labelled benchmark, never presented as your numbers)
  contract   the tracking contract (code, hashtag, UTM, keywords) and where each target's number comes from
  evidence   posts, ad spend, UTM sessions, deals, live pages, emails - matched, with confidence and a review queue
  rules      tasks that close themselves when their evidence arrives
  pace       daily snapshots, the forecast with odds, three ranked moves, the back-test
  mix        response curves per paid channel and the budget move (plan B)
  proof      lift against what would have happened anyway, the geo test, pipeline, show-up calibration, the report
  policy     what the agents may do alone, the actions log, undo
  crew       the nine agents
  digest     the morning digest (email, Slack, Teams, WhatsApp)
  hooks      Luma, Microsoft Teams, LinkedIn @mentions, conversions APIs (Meta, LinkedIn, Google)
  events360  webinar 360, online event tracks, the solo meetup report card
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ... import models

logger = logging.getLogger(__name__)
_last = {"scan": None, "digest": None}


def run(db: Session, i: models.Initiative, scan: bool = True) -> dict:
    """One pass for one initiative: contract, task rules, evidence, numbers, closes, today's snapshot."""
    from ..initiatives import metrics
    from . import contract, evidence, pace, rules
    contract.ensure(db, i)
    rules.assign(db, i)
    found = evidence.scan(db, i) if scan else None
    res = metrics.compute(db, i)
    closes = rules.evaluate(db, i, res["values"])
    pace.snapshot(db, i, res["values"])
    db.commit()
    return {"evidence": found, "closed": [a.id for a in closes if a.state == "done"], "proposed": [a.id for a in closes if a.state == "proposed"],
            "values": res["values"]}


def tick(db: Session, now: datetime | None = None) -> None:
    """The scheduler's minute tick: event extras every minute; evidence for active initiatives every 30 minutes (each at
    most every 3 hours, 6 per pass); the digest check every 10 minutes."""
    from . import digest, events360
    now = now or datetime.utcnow()
    try:
        events360.tick(db, now)
    except Exception as e:  # noqa: BLE001
        logger.warning("[autopilot] events360 tick failed: %s", e)
        db.rollback()
    if _last["digest"] is None or now - _last["digest"] >= timedelta(minutes=10):
        _last["digest"] = now
        try:
            digest.tick(db, now)
        except Exception as e:  # noqa: BLE001
            logger.warning("[autopilot] digest tick failed: %s", e)
            db.rollback()
    if _last["scan"] is not None and now - _last["scan"] < timedelta(minutes=30):
        return
    _last["scan"] = now
    done = 0
    for i in db.query(models.Initiative).filter(models.Initiative.status.in_(("active", "planning"))).order_by(models.Initiative.updated_at.desc()).limit(200):
        if done >= 6:
            break
        c = db.get(models.InitiativeContract, i.id)
        last = ((c.data or {}).get("last_scan") if c else None)
        if last:
            try:
                if now - datetime.fromisoformat(last.rstrip("Z")) < timedelta(hours=3):
                    continue
            except ValueError:
                pass
        try:
            run(db, i)
            done += 1
        except Exception as e:  # noqa: BLE001 - one initiative never stops the others
            logger.warning("[autopilot] run failed for %s: %s", i.id, e)
            db.rollback()
