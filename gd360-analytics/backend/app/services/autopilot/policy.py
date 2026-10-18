"""2026-10-17 (R53): the Autopilot policy - what the agents may do on their own, what they must ask first - and the
actions log with undo.

Default (the plan's): attach matches at 0.90 or more, close tasks from evidence, send reminders and the digest on
their own; always ask before a new email to people or any budget move (cap per move). Every action is kept with the
policy that allowed it; reversible ones can be undone.

What "doing" means, honestly:
  attach / close_task / reminder / task   done in GD360, undoable
  email     approving makes a GD360 email draft for this initiative - you review and send it
  budget    GD360 can't change budgets inside Meta or Google Ads; approving records the decision and opens a task
            with the exact move, and the next scan shows whether it happened
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ... import models

DEFAULT = {"paused": False, "auto_attach_at": 0.90, "budget_cap": 500.0,
           "alone": {"attach": True, "close_task": True, "reminder": True, "digest": True, "task": False},
           "ask": {"email": True, "budget": True}}
KIND_LABEL = {"attach": "Attach matched evidence", "close_task": "Close a task when its evidence arrives", "reminder": "Send reminders",
              "digest": "Send the morning digest", "task": "Add follow-up tasks", "email": "Send new emails to people", "budget": "Move budget"}


def get(i: models.Initiative) -> dict:
    p = dict(DEFAULT)
    saved = ((i.details or {}).get("autopilot") or {}) if i is not None else {}
    p.update({k: v for k, v in saved.items() if k in ("paused", "auto_attach_at", "budget_cap")})
    p["alone"] = {**DEFAULT["alone"], **(saved.get("alone") or {})}
    p["ask"] = dict(DEFAULT["ask"])  # emails and budget always ask: not a setting
    try:
        p["auto_attach_at"] = max(0.8, min(1.0, float(p["auto_attach_at"])))
    except (TypeError, ValueError):
        p["auto_attach_at"] = 0.9
    return p


def set_policy(db: Session, i: models.Initiative, changes: dict) -> dict:
    cur = get(i)
    if "paused" in changes:
        cur["paused"] = bool(changes["paused"])
    if changes.get("auto_attach_at") is not None:
        cur["auto_attach_at"] = max(0.8, min(1.0, float(changes["auto_attach_at"])))
    if changes.get("budget_cap") is not None:
        cur["budget_cap"] = max(0.0, min(1_000_000.0, float(changes["budget_cap"])))
    for k, v in (changes.get("alone") or {}).items():
        if k in DEFAULT["alone"]:
            cur["alone"][k] = bool(v)
    i.details = {**(i.details or {}), "autopilot": {k: cur[k] for k in ("paused", "auto_attach_at", "budget_cap", "alone")}}
    flag_modified(i, "details")
    db.commit()
    return get(i)


def allowed_alone(i: models.Initiative, kind: str) -> bool:
    p = get(i)
    if p["paused"] or kind in p["ask"]:
        return False
    return bool(p["alone"].get(kind))


def propose(db: Session, i: models.Initiative | None, agent: str, kind: str, title: str, *, detail: str | None = None,
            payload: dict | None = None, impact: str | None = None, cost: float | None = None, key: str | None = None,
            reversible: bool = True, workspace_id: str | None = None) -> models.AgentAction | None:
    """Records a proposal - or, when the policy lets this agent do it alone, does it at once. One live proposal per key."""
    ws = workspace_id or (i.workspace_id if i is not None else None)
    if key:
        dup = db.query(models.AgentAction).filter(models.AgentAction.key == key,
                                                  models.AgentAction.state.in_(("proposed", "done"))).first()
        if dup is not None:
            return dup
    a = models.AgentAction(workspace_id=ws, initiative_id=i.id if i is not None else None, agent=agent, kind=kind, title=title[:300],
                           detail=detail, impact=impact, cost=cost, payload=payload or {}, key=key, reversible=reversible)
    db.add(a)
    db.flush()
    if i is not None and allowed_alone(i, kind) and not (kind == "budget" and (cost or 0) > get(i)["budget_cap"]):
        do(db, a, by="Autopilot (policy)", auto=True)
    db.commit()
    return a


def do(db: Session, a: models.AgentAction, by: str, auto: bool = False) -> models.AgentAction:
    if a.state not in ("proposed",):
        return a
    i = db.get(models.Initiative, a.initiative_id) if a.initiative_id else None
    p = dict(a.payload or {})
    try:
        if a.kind == "attach":
            e = db.get(models.InitiativeEvidence, p.get("evidence_id"))
            if e is not None:
                a.undo = {"evidence_id": e.id, "state": e.state}
                e.state, e.decided_by = "confirmed" if not auto else "auto", by
            a.result = "Attached."
        elif a.kind == "close_task":
            t = db.get(models.InitiativeTask, p.get("task_id"))
            if t is not None:
                a.undo = {"task_id": t.id, "status": t.status, "completed_by": t.completed_by, "evidence_id": t.evidence_id, "done_at": t.done_at.isoformat() if t.done_at else None}
                t.status, t.completed_by, t.evidence_id, t.done_at = "done", "evidence", p.get("evidence_id"), datetime.utcnow()
                a.result = f"Closed “{t.title}”."
        elif a.kind == "reminder":
            r = models.GtmReminder(workspace_id=a.workspace_id, owner_id=p.get("owner_id") or (i.owner_id if i else ""), initiative_id=a.initiative_id,
                                   task_id=p.get("task_id"), note=p.get("note") or a.title, remind_at=datetime.fromisoformat(p["at"]) if p.get("at") else datetime.utcnow() + timedelta(hours=1))
            db.add(r)
            db.flush()
            a.undo, a.result = {"reminder_id": r.id}, "Reminder set."
        elif a.kind == "task" and i is not None:
            t = models.InitiativeTask(initiative_id=i.id, title=(p.get("title") or a.title)[:200], detail=p.get("detail") or a.detail,
                                      due_on=p.get("due_on"), origin="assistant", position=999, auto_rule=p.get("auto_rule"))
            db.add(t)
            db.flush()
            a.undo, a.result = {"created_task_id": t.id}, f"Task added: {t.title}."
        elif a.kind == "email" and i is not None:
            c = models.GtmCampaign(workspace_id=i.workspace_id, initiative_id=i.id, owner_id=i.owner_id, name=(p.get("name") or a.title)[:120],
                                   subject=(p.get("subject") or a.title)[:200], body=p.get("body") or a.detail or "", audience=p.get("audience"), status="draft")
            db.add(c)
            db.flush()
            a.undo, a.result = {"campaign_id": c.id}, "Draft email made - review and send it from Campaigns."
        elif a.kind == "budget" and i is not None:
            t = models.InitiativeTask(initiative_id=i.id, title=(p.get("task") or a.title)[:200], detail=a.detail, origin="assistant", position=999,
                                      due_on=datetime.utcnow().date().isoformat(), auto_rule={"kind": "none"})
            db.add(t)
            db.flush()
            a.undo, a.result = {"created_task_id": t.id}, "Decision recorded. GD360 can't change budgets inside the ad platforms - the move is a task."
        elif a.kind == "digest":
            a.result = p.get("result") or "Sent."
        else:
            a.result = "Recorded."
        a.state, a.auto, a.decided_by, a.decided_at = "done", auto, by, datetime.utcnow()
    except Exception as e:  # noqa: BLE001 - an action that can't run says so
        a.state, a.result = "failed", str(e)[:300]
    if i is not None:
        from ..initiatives import tracking
        tracking.log(db, i, f"{'Autopilot' if auto else by}: {a.result or a.title}", "Autopilot" if auto else by, kind="system")
    return a


def undo(db: Session, a: models.AgentAction, by: str) -> models.AgentAction:
    if a.state != "done" or not a.reversible:
        raise ValueError("Only a done, reversible action can be undone.")
    u = a.undo or {}
    if u.get("evidence_id"):
        e = db.get(models.InitiativeEvidence, u["evidence_id"])
        if e is not None:
            e.state, e.decided_by = "rejected", by
    if u.get("task_id"):
        t = db.get(models.InitiativeTask, u["task_id"])
        if t is not None:
            t.status, t.completed_by, t.evidence_id = u.get("status") or "todo", u.get("completed_by"), u.get("evidence_id")
            t.done_at = datetime.fromisoformat(u["done_at"]) if u.get("done_at") else None
            if t.auto_rule:
                t.auto_rule = {**t.auto_rule, "paused": True}  # don't close it again by itself
    if u.get("reminder_id"):
        r = db.get(models.GtmReminder, u["reminder_id"])
        if r is not None:
            db.delete(r)
    if u.get("created_task_id"):
        t = db.get(models.InitiativeTask, u["created_task_id"])
        if t is not None:
            db.delete(t)
    if u.get("campaign_id"):
        c = db.get(models.GtmCampaign, u["campaign_id"])
        if c is not None and c.status == "draft":
            db.delete(c)
    a.state, a.decided_by, a.decided_at = "undone", by, datetime.utcnow()
    db.commit()
    return a


def row(a: models.AgentAction) -> dict:
    return {"id": a.id, "initiative_id": a.initiative_id, "agent": a.agent, "kind": a.kind, "kind_label": KIND_LABEL.get(a.kind, a.kind),
            "title": a.title, "detail": a.detail, "impact": a.impact, "cost": a.cost, "state": a.state, "auto": bool(a.auto),
            "reversible": bool(a.reversible), "result": a.result, "decided_by": a.decided_by,
            "decided_at": a.decided_at.isoformat() + "Z" if a.decided_at else None, "created_at": a.created_at.isoformat() + "Z" if a.created_at else None,
            "payload": a.payload or {}}
