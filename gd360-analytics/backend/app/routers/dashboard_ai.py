"""
/dashboard-ai - "Ask AI" on a dashboard, and alerts GD360 sets up for you
(2026-10-11, Explain & Alerts). View access to the dashboard is enough to
ask; alerts run with their owner's access, like every automation.

  POST /dashboard-ai/{id}/ask            a question or "alert me if ..." typed in the drawer
  POST /dashboard-ai/{id}/explain        one chart or tile, explained from the rows it shows
  POST /dashboard-ai/{id}/alert-draft    a draft alert (WHEN / CHECK / TELL + back-test) - never switched on
  GET  /dashboard-ai/{id}/watch          "Want me to watch this?" lines, what GD360 noticed, and this dashboard's alerts
  GET  /dashboard-ai/{id}/recipients     the people who could get an alert, and whether each can open the dashboard
  POST /dashboard-ai/{id}/give-access    add someone to the dashboard's private link
  POST /dashboard-ai/{id}/alerts         switch an alert on (only after the person confirms who gets it, and where)

Nothing here edits the dashboard itself.
"""
from __future__ import annotations

import time
from collections import defaultdict, deque
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..services import audit, dashboard_watch, notifications, workspace_access
from ..services import automations as auto
from ..services import explain as explain_svc

router = APIRouter(prefix="/dashboard-ai", tags=["dashboard-ai"])
settings = get_settings()
_calls: dict[str, deque] = defaultdict(deque)


def _rate_limit(user_id: str) -> None:
    now = time.time()
    w = _calls[user_id]
    while w and now - w[0] > 60:
        w.popleft()
    if len(w) >= settings.RATE_LIMIT_PER_MINUTE:
        raise HTTPException(429, "That's a lot of questions at once - give it a few seconds.")
    w.append(now)


class BlockIn(BaseModel):
    id: str | None = Field(default=None, max_length=64)
    title: str | None = Field(default=None, max_length=200)
    type: str | None = Field(default=None, max_length=32)
    chart_type: str | None = Field(default=None, max_length=40)
    columns: list = Field(default_factory=list, max_length=24)
    rows: list[dict] = Field(default_factory=list, max_length=200)
    dimensions: list[str] | None = Field(default=None, max_length=8)
    kpi: dict | None = None
    currency: str | None = Field(default=None, max_length=8)
    filters_text: str | None = Field(default=None, max_length=300)


class AskBody(BaseModel):
    question: str = Field(min_length=2, max_length=1000)
    page_id: str | None = None
    blocks: list[BlockIn] = Field(default_factory=list, max_length=24)
    focus_block_id: str | None = None


class ExplainBody(BaseModel):
    block: BlockIn
    question: str | None = Field(default=None, max_length=1000)


class DraftBody(BaseModel):
    text: str | None = Field(default=None, max_length=1000)
    page_id: str | None = None
    block_id: str | None = None
    den_block_id: str | None = None
    ratio_as: str | None = None
    op: str | None = None
    value: float | None = None
    window: str | None = None
    label: str | None = Field(default=None, max_length=80)


class GiveAccessBody(BaseModel):
    email: str = Field(min_length=3, max_length=200)


class AlertBody(BaseModel):
    target: dict
    op: str
    value: float
    name: str | None = Field(default=None, max_length=80)
    check: dict | None = None
    user_ids: list[str] = Field(default_factory=list, max_length=25)
    emails: list[str] = Field(default_factory=list, max_length=10)
    in_app: bool = True
    email: bool = True
    remind: str = "once"
    timezone: str = "UTC"
    workspace_id: str | None = None
    slack_url: str | None = None
    slack_label: str | None = None
    teams_url: str | None = None
    teams_label: str | None = None
    webhook_url: str | None = None
    webhook_label: str | None = None


def _board(db: Session, user: models.User, dashboard_id: str) -> models.Dashboard:
    try:
        return dashboard_watch.get_board(db, user, dashboard_id)
    except dashboard_watch.WatchError:
        raise HTTPException(404, "Dashboard not found.")


# ---------------------------------------------------------------- asking ----

@router.post("/{dashboard_id}/ask")
def ask(dashboard_id: str, body: AskBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _rate_limit(user.id)
    d = _board(db, user, dashboard_id)
    q = body.question.strip()
    if dashboard_watch.looks_like_alert(q):
        out = dashboard_watch.draft(db, user, d.id, text=q, page_id=body.page_id)
        return {"kind": "alert", **out}
    blocks = [b.model_dump() for b in body.blocks]
    for b in blocks:
        b["dashboard_name"] = d.name
    try:
        if body.focus_block_id:
            focus = next((b for b in blocks if b.get("id") == body.focus_block_id), None)
            if not focus:
                raise HTTPException(400, "That chart isn't on this page any more.")
            ex = explain_svc.explain_block(focus, q)
        else:
            ex = explain_svc.answer_page(q, blocks, d.name)
    except explain_svc.ExplainError as e:
        raise HTTPException(400, str(e))
    return {"kind": "explain", "explain": ex}


@router.post("/{dashboard_id}/explain")
def explain_block(dashboard_id: str, body: ExplainBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _rate_limit(user.id)
    d = _board(db, user, dashboard_id)
    block = body.block.model_dump()
    block["dashboard_name"] = d.name
    try:
        return explain_svc.explain_block(block, body.question)
    except explain_svc.ExplainError as e:
        raise HTTPException(400, str(e))


@router.post("/{dashboard_id}/alert-draft")
def alert_draft(dashboard_id: str, body: DraftBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _rate_limit(user.id)
    d = _board(db, user, dashboard_id)
    if body.op and body.op not in dashboard_watch.OP_WORDS:
        raise HTTPException(400, "Choose below, above, falls by or rises by.")
    return dashboard_watch.draft(
        db, user, d.id, text=body.text, page_id=body.page_id, block_id=body.block_id, den_block_id=body.den_block_id,
        ratio_as=body.ratio_as, op=body.op, value=body.value, window=body.window, label=body.label,
    )


# -------------------------------------------------------------- watching ----

def _alerts_on(db: Session, user: models.User, d: models.Dashboard) -> list[dict]:
    rows = db.query(models.Automation).filter(models.Automation.owner_id == user.id).all()
    if d.workspace_id:  # someone else's alert on a shared dashboard that tells this person
        rows += [a for a in db.query(models.Automation).filter(models.Automation.owner_id != user.id,
                                                                models.Automation.workspace_id == d.workspace_id).all()
                 if notifications.recipient_of(a, user)]
    out = []
    for a in rows:
        t = a.trigger or {}
        tg = t.get("target") or {}
        if t.get("type") != "threshold" or tg.get("kind") != "board" or tg.get("dashboard_id") != d.id:
            continue
        tell = a.tell or {}
        out.append({
            "id": a.id, "name": a.name, "enabled": a.enabled, "mine": a.owner_id == user.id,
            "block_id": tg.get("block_id"), "den_block_id": tg.get("den_block_id"), "page_id": tg.get("page_id"),
            "label": t.get("kpi_label") or tg.get("label"), "op": t.get("op"), "value": t.get("value"), "unit": t.get("unit") or "",
            "line": auto.line_text(t), "last_value": a.last_value, "last_condition": a.last_condition,
            "last_checked_at": notifications.iso(a.last_checked_at), "remind": tell.get("remind") or "once",
            "snoozed": notifications.is_muted(tell, user_id=user.id),
            "people": len(tell.get("in_app") or []) + len([e for e in tell.get("email") or []]),
            "waiting_for_ok": a.approval_status == "pending",
            "tell": auto.sentence(db, {"trigger": t, "steps": a.steps or [], "tell": tell}).get("tell"),
        })
    return out


@router.get("/{dashboard_id}/watch")
def watch(dashboard_id: str, page_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    d = _board(db, user, dashboard_id)
    sug = dashboard_watch.suggestions(db, user, d.id, page_id)
    alerts = _alerts_on(db, user, d)
    watched = {(a["block_id"], a.get("den_block_id")) for a in alerts}
    sug["suggestions"] = [s for s in sug["suggestions"] if (s["block_id"], None) not in watched]
    if sug.get("noticed") and (sug["noticed"]["block_id"], None) in watched:
        sug["noticed"] = None
    return {**sug, "alerts": alerts, "email_ready": auto.email_configured()}


# ------------------------------------------------------------ recipients ----

def _share_access(d: models.Dashboard, email: str) -> bool:
    share = d.share
    if not share or not share.published_at:
        return False
    if share.mode == "public":
        return True
    return any(e.email.lower() == email.lower() for e in share.allowed_emails)


def _access_of(db: Session, d: models.Dashboard, u: models.User | None, email: str) -> str:
    from .dashboards import _can_view
    if u is not None and _can_view(db, d, u):
        return "app"
    if _share_access(d, email):
        return "link"
    return "none"


@router.get("/{dashboard_id}/recipients")
def recipients(dashboard_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    from .dashboards import _can_edit
    d = _board(db, user, dashboard_id)
    if d.workspace_id:
        ws_ids = [d.workspace_id]
    else:
        ws_ids = [w.id for w in db.query(models.Workspace).filter(
            models.Workspace.id.in_(workspace_access.member_workspace_ids(db, user.id)), models.Workspace.is_personal.is_(False)).all()]
    people: dict[str, dict] = {}
    if ws_ids:
        rows = (db.query(models.User, models.WorkspaceMember.role)
                .join(models.WorkspaceMember, models.WorkspaceMember.user_id == models.User.id)
                .filter(models.WorkspaceMember.workspace_id.in_(ws_ids)).limit(200).all())
        for u, role in rows:
            if u.id not in people:
                people[u.id] = {"id": u.id, "name": u.full_name or u.email.split("@")[0], "email": u.email, "role": role,
                                "access": _access_of(db, d, u, u.email), "me": u.id == user.id}
    if user.id not in people:
        people[user.id] = {"id": user.id, "name": user.full_name or user.email.split("@")[0], "email": user.email,
                           "role": "owner" if d.owner_id == user.id else None, "access": "app", "me": True}
    ordered = sorted(people.values(), key=lambda p: (not p["me"], p["access"] != "app", (p["name"] or "").lower()))
    share = d.share
    return {
        "people": ordered[:60], "can_edit": _can_edit(db, d, user), "workspace_id": d.workspace_id,
        "share": {"mode": share.mode, "published": bool(share.published_at), "slug": share.slug} if share else None,
        "email_ready": auto.email_configured(),
    }


@router.post("/{dashboard_id}/give-access")
def give_access(dashboard_id: str, body: GiveAccessBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Adds the person to the dashboard's private link (only named people can
    open it). Publishes it privately when it isn't published yet; a public
    link already lets anyone open it."""
    from .dashboard_builder import _make_unique_slug
    from .dashboards import _can_edit
    d = _board(db, user, dashboard_id)
    if not _can_edit(db, d, user):
        raise HTTPException(403, "Only people who can edit this dashboard can share it.")
    email = body.email.strip().lower()
    if not auto.EMAIL_RE.match(email):
        raise HTTPException(400, f"“{email}” doesn't look like an email address.")
    share = d.share
    if not share:
        share = models.DashboardShare(dashboard_id=d.id, slug=_make_unique_slug(db, d.name), mode="private")
        db.add(share)
        db.flush()
    if share.mode == "public" and share.published_at:
        return {"access": "link", "link": f"/d/{share.slug}", "note": "This dashboard's link is public - they can already open it."}
    if not any(e.email.lower() == email for e in share.allowed_emails):
        db.add(models.DashboardShareEmail(share_id=share.id, email=email))
        audit.log_audit_event(db, actor=user, action="dashboard_share_email_added", workspace_id=d.workspace_id,
                              target_type="dashboard", target_id=d.id, metadata={"name": d.name, "email": email, "via": "alert"})
    if not share.published_at:
        share.mode = "private"
        share.published_at = datetime.utcnow()
        audit.log_audit_event(db, actor=user, action="dashboard_published", workspace_id=d.workspace_id,
                              target_type="dashboard", target_id=d.id,
                              metadata={"name": d.name, "mode": "private", "password": bool(share.password_hash), "via": "alert"})
    db.commit()
    return {"access": "link", "link": f"/d/{share.slug}", "note": "They can open it through its private link - only people on its list can."}


# ---------------------------------------------------------------- alerts ----

@router.post("/{dashboard_id}/alerts", status_code=201)
def create_alert(dashboard_id: str, body: AlertBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    from .automations import _apply_approval, _out
    d = _board(db, user, dashboard_id)
    target = {**(body.target or {}), "kind": "board", "dashboard_id": d.id}
    if body.op not in dashboard_watch.OP_WORDS:
        raise HTTPException(400, "Choose below, above, falls by or rises by.")
    if db.query(models.Automation).filter(models.Automation.owner_id == user.id).count() >= auto.MAX_PER_OWNER:
        raise HTTPException(400, f"You can have up to {auto.MAX_PER_OWNER} automations - turn off or delete one first.")
    if not body.in_app and not body.email and not (body.slack_url or body.teams_url or body.webhook_url):
        raise HTTPException(400, "Choose at least one place to tell people - in GD360 or by email.")
    picked = {u.id: u for u in db.query(models.User).filter(models.User.id.in_(body.user_ids or [user.id])).all()}
    in_app = [uid for uid in (body.user_ids or [user.id]) if uid in picked] if body.in_app else []
    emails: list[str] = []
    if body.email:
        for uid in body.user_ids or [user.id]:
            u = picked.get(uid)
            if u and u.email and u.email.lower() not in [e.lower() for e in emails]:
                emails.append(u.email)
        for e in body.emails:
            e = e.strip()
            if e and e.lower() not in [x.lower() for x in emails]:
                emails.append(e)
    by_email = {u.email.lower(): u for u in picked.values() if u.email}
    guests = [e for e in emails if _access_of(db, d, by_email.get(e.lower()), e) == "link"]
    check = body.check if isinstance(body.check, dict) and body.check.get("every") in auto.EVERY else {"every": "hour", "minute": 0}
    name = (body.name or "").strip() or f"{target.get('label') or 'Dashboard number'} {dashboard_watch.OP_WORDS[body.op].replace('goes ', '')} {body.value:g}"
    payload = {
        "name": name, "timezone": body.timezone or "UTC", "enabled": True,
        "trigger": {"type": "threshold", "target": target, "kpi": "value", "op": body.op, "value": body.value, "check": check},
        "steps": [],
        "tell": {
            "email": emails, "in_app": in_app, "mode": "always", "remind": body.remind if body.remind in auto.REMIND else "once",
            "slack_url": body.slack_url or None, "slack_label": body.slack_label, "teams_url": body.teams_url or None,
            "teams_label": body.teams_label, "webhook_url": body.webhook_url or None, "webhook_label": body.webhook_label,
            "guests": guests, "guest_link": f"/d/{d.share.slug}" if guests and d.share else None,
        },
    }
    try:
        fields = auto.validate(db, user, payload)
    except auto.AutomationError as e:
        raise HTTPException(400, str(e))
    ws_id = d.workspace_id or body.workspace_id
    if ws_id:
        role = workspace_access.member_role(db, user.id, ws_id)
        if role is None:
            ws_id = None
        elif role == "viewer":
            raise HTTPException(403, "You have view-only access to this workspace.")
    a = models.Automation(owner_id=user.id, workspace_id=ws_id, **fields)
    _apply_approval(db, user, a)
    # The first check runs within a minute (the scheduler's tick): if the
    # number is already past the line, people hear about it now - not at
    # the next hour, and never "tomorrow morning".
    a.next_run_at = datetime.utcnow() if a.enabled else None
    db.add(a)
    db.flush()
    others = [uid for uid in in_app if uid != user.id]
    if others:
        who = user.full_name or user.email
        notifications.create(
            db, others, kind="info", title=f"{who} added you to an alert: {a.name}",
            body=auto.sentence(db, {"trigger": a.trigger, "steps": [], "tell": a.tell}).get("tell"),
            link=f"/dashboard-builder/{d.id}" + (f"?page={target.get('page_id')}" if target.get("page_id") else ""),
            data={"automation_id": a.id, "dashboard_id": d.id}, automation_id=a.id, workspace_id=ws_id,
        )
    audit.log_audit_event(db, actor=user, action="automation_created", workspace_id=ws_id, target_type="automation",
                          target_id=a.id, metadata={"name": a.name, "from": "dashboard_alert", "dashboard_id": d.id,
                                                    "waiting_for_ok": a.approval_status == "pending"})
    db.commit()
    db.refresh(a)
    return {**_out(db, a), "people": len(set(in_app) | {e.lower() for e in emails}), "guests": guests}
