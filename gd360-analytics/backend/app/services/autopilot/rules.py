"""2026-10-17 (R53): tasks that close themselves. Every task gets a rule - the evidence that proves it is done - and
the Tracker closes it when that evidence arrives (the policy can switch this off; every close can be undone).

  page_live           the landing page has its first visit
  post                a post for this initiative is found (since it started)
  first_spend         an ad named INIT-{code} has spent money
  email_sent          a GD360 email for it went out
  first_registration  the first registration came in
  meeting             a meeting is logged
  deal                a deal is matched
  sessions            sessions arrive from its UTM campaign
  count               a target reaches a number: {"kind": "count", "metric": "registrations", "n": 100}
  none                closes only by hand or approval

GD360-provided work never becomes busywork: "Build the registration page" closes at once for an event, because the
page already exists.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ... import models
from . import policy

INFER = [
    ("page_live", r"\b(landing page|web ?page|microsite|site live|publish the page)\b"),
    ("first_registration", r"\b(open registration|registrations? open|launch registration|registration live)\b"),
    ("post", r"\b(post|announce|linkedin|instagram|social|teaser|tweet|reel|share on)\b"),
    ("first_spend", r"\b(ads?|paid|boost|sponsored|retarget|campaign live)\b"),
    ("email_sent", r"\b(email|invite|invitation|newsletter|mailer|send (the )?(reminder|save the date))\b"),
    ("meeting", r"\b(book meetings?|meetings? booked|schedule calls?)\b"),
    ("deal", r"\b(deal|pipeline|opportunit)"),
    ("sessions", r"\b(utm|traffic|drive visits)\b"),
]
LABEL = {"page_live": "the landing page's first visit", "first_registration": "the first registration", "post": "a matched post",
         "first_spend": "the first ad spend on INIT-{code}", "email_sent": "a Euliv email going out", "meeting": "a meeting logged",
         "deal": "a matched deal", "sessions": "sessions from the UTM campaign", "count": "{metric} reaching {n}", "none": "you or an approval"}
GD360_PROVIDES = r"\b(build|create|set ?up|make)\b.{0,30}\b(registration (page|form)|sign-?up (page|form)|rsvp (page|form))\b"


def infer(title: str, tool: str | None) -> dict:
    t = (title or "").lower()
    if tool in ("gd360_email",):
        return {"kind": "email_sent"}
    for kind, pat in INFER:
        if re.search(pat, t):
            return {"kind": kind}
    return {"kind": "none"}


def label(rule: dict | None, code: str | None = None) -> str:
    r = rule or {"kind": "none"}
    s = LABEL.get(r.get("kind") or "none", "you or an approval")
    if not code:
        s = s.replace("INIT-{code}", "its INIT- campaign")
    return s.replace("{code}", code or "").replace("{metric}", str(r.get("metric") or "").replace("_", " ")).replace("{n}", f"{r.get('n', '')}")


def assign(db: Session, i: models.Initiative) -> int:
    """Rules for tasks that have none (new plans and every task made before R53); GD360-provided work closes now."""
    n = 0
    for t in db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id == i.id):
        if t.auto_rule is None:
            t.auto_rule = infer(t.title, t.tool_key)
            n += 1
        if t.status != "done" and i.kind in ("event", "webinar") and re.search(GD360_PROVIDES, (t.title or "").lower()):
            t.status, t.completed_by, t.done_at = "done", "autopilot", datetime.utcnow()
            t.evidence = (t.evidence or []) + [{"label": "Euliv registration page", "url": None, "kind": "auto", "added_at": datetime.utcnow().isoformat() + "Z"}]
            t.auto_rule = {"kind": "none", "why": "Euliv provides the registration page"}
    db.commit()
    return n


def _first(rows, kind, after: datetime | None, pred=None):
    for e in sorted(rows, key=lambda x: x.occurred_at or x.created_at or datetime.min):
        if e.kind != kind:
            continue
        when = e.occurred_at or e.created_at
        if after is not None and when is not None and when < after:
            continue
        if pred is None or pred(e):
            return e
    return None


def evaluate(db: Session, i: models.Initiative, values: dict) -> list[models.AgentAction]:
    """Closes (or proposes closing) every open task whose evidence has arrived."""
    from . import evidence as ev
    from ..initiatives.metrics import start_of
    rows = ev.accepted(db, i).all()
    c = db.get(models.InitiativeContract, i.id)
    since = start_of(i) - timedelta(days=1)
    out = []
    for t in db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id == i.id, models.InitiativeTask.status != "done"):
        r = t.auto_rule or {}
        k = r.get("kind")
        if not k or k == "none" or r.get("paused"):
            continue
        hit, why = None, None
        if k == "page_live":
            hit = _first(rows, "page", None)
        elif k == "post":
            hit = _first(rows, "post", since)
        elif k == "first_spend":
            hit = _first(rows, "ad", None, lambda e: float((e.numbers or {}).get("spend") or 0) > 0)
        elif k == "email_sent":
            hit = _first(rows, "email", since)
        elif k == "deal":
            hit = _first(rows, "deal", None)
        elif k == "sessions":
            hit = _first(rows, "web", None, lambda e: float((e.numbers or {}).get("sessions") or 0) > 0)
        elif k == "first_registration" and (values.get("registrations") or 0) >= 1:
            why = f"{int(values['registrations'])} registration{'s' if values['registrations'] != 1 else ''} so far"
        elif k == "meeting" and (values.get("meetings") or 0) >= 1:
            why = f"{int(values['meetings'])} meeting{'s' if values['meetings'] != 1 else ''} logged"
        elif k == "count" and r.get("metric") and values.get(r["metric"]) is not None:
            try:
                if float(values[r["metric"]]) >= float(r.get("n") or 0):
                    why = f"{str(r['metric']).replace('_', ' ')} reached {values[r['metric']]:g}"
            except (TypeError, ValueError):
                pass
        if hit is None and why is None:
            continue
        what = (hit.title or hit.kind) if hit is not None else why
        a = policy.propose(db, i, "Tracker", "close_task", f"Close “{t.title}”: {what}", detail=f"Rule: closes on {label(r, c.code if c else None)}.",
                           payload={"task_id": t.id, "evidence_id": hit.id if hit is not None else None}, key=f"close:{t.id}")
        if a is not None:
            out.append(a)
    return out
