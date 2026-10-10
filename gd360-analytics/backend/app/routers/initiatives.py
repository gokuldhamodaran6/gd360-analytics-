"""
Initiatives (2026-10-10) - plan, run and prove any activity. See
services/initiatives/__init__.py for the model.

Everything is workspace-scoped: owners and members edit, viewers read.
Sensitive actions (create, delete, approvals, imports) go to the audit log.

  GET    /initiatives                         the hub: initiatives, needs-you-today, counts
  GET    /initiatives/catalog                 kinds, tools, metrics, questions
  POST   /initiatives/draft                   brief -> plan (nothing saved)
  POST   /initiatives                         create from a plan
  GET    /initiatives/{id}                    everything on the initiative page
  PATCH  /initiatives/{id}                    edit fields, scope, targets, status
  DELETE /initiatives/{id}
  tasks, approvals, board items, updates, tracked links, people, results,
  today, the assistant and reminders - below.
"""
from __future__ import annotations

import csv
import io
import re
import threading
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..services import workspace_access
from ..services.audit import log_audit_event
from ..services.automations import app_url, email_configured, send_email
from ..services.initiatives import assistant, campaigns, catalog, connected, gtm, metrics, planner, team, tracking
from .projects import _rate_limit

router = APIRouter(prefix="/initiatives", tags=["initiatives"])
MAX_UPLOAD = 15 * 1024 * 1024


# ================================================================ access ==

def workspace_for(db: Session, user: models.User, workspace_id: str | None, edit: bool = False) -> str:
    if not workspace_id:
        ws = (db.query(models.Workspace).filter(models.Workspace.owner_id == user.id,
                                                models.Workspace.is_personal.is_(True)).first())
        if not ws:
            raise HTTPException(404, "No workspace found for this account.")
        return ws.id
    ws = db.get(models.Workspace, workspace_id)
    role = workspace_access.member_role(db, user.id, workspace_id)
    if ws and ws.owner_id == user.id:
        role = "owner"
    if not ws or not role:
        raise HTTPException(404, "Workspace not found.")
    if edit and role not in ("owner", "member"):
        raise HTTPException(403, "You have view access to this workspace. Ask an owner for edit access to make changes.")
    return workspace_id


def initiative_for(db: Session, user: models.User, initiative_id: str, edit: bool = False) -> models.Initiative:
    i = db.get(models.Initiative, initiative_id)
    if not i:
        raise HTTPException(404, "Initiative not found.")
    workspace_for(db, user, i.workspace_id, edit=edit)
    return i


def author(user: models.User) -> str:
    return user.full_name or user.email.split("@")[0]


def _iso(d) -> str | None:
    if d is None:
        return None
    return d.isoformat() + ("Z" if isinstance(d, datetime) else "")


def _date(v) -> str | None:
    try:
        return date.fromisoformat(str(v)[:10]).isoformat() if v else None
    except ValueError:
        raise HTTPException(422, "Dates are written as YYYY-MM-DD.")


def public_links(i: models.Initiative) -> dict:
    base = app_url()
    return {"registration": f"{base}/e/{i.public_token}", "walk_in": f"{base}/w/{i.public_token}?k={i.walkin_key}"}


# ===================================================================== hub ==

@router.get("")
def hub(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, workspace_id)
    out = metrics.hub(db, user, ws)
    for x in out["initiatives"]:
        for k in ("updated_at", "created_at"):
            x[k] = _iso(x[k])
    for n in out["needs_you"]:
        if isinstance(n.get("remind_at"), datetime):
            n["remind_at"] = _iso(n["remind_at"])
    out["workspace_id"] = ws
    return out


@router.get("/catalog")
def get_catalog(user: models.User = Depends(get_current_user)):
    return {"kinds": catalog.KINDS, "tools": catalog.TOOLS, "metrics": catalog.METRICS, "questions": catalog.QUESTIONS}


class DraftRequest(BaseModel):
    workspace_id: str | None = None
    brief: str = Field(min_length=3, max_length=4000)
    kind: str | None = None
    answers: dict | None = None
    key_date: str | None = None
    previous: dict | None = None
    instruction: str | None = Field(default=None, max_length=1000)


@router.post("/draft")
def draft(body: DraftRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _rate_limit(user.id)
    ws = workspace_for(db, user, body.workspace_id)
    return planner.draft(db, ws, body.brief, body.kind, body.answers, body.key_date, body.previous, body.instruction)


class CreateRequest(BaseModel):
    workspace_id: str | None = None
    brief: str | None = Field(default=None, max_length=4000)
    plan: dict


@router.post("")
def create(body: CreateRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, body.workspace_id, edit=True)
    p = body.plan or {}
    kind = p.get("kind") if p.get("kind") in catalog.KINDS else "custom"
    # re-validate whatever came back from the page
    plan = planner.validate(p, body.brief or p.get("title") or "", kind, {}, p.get("key_date"), {})
    # dates the person edited on the page win over the scheduled ones
    raw_tasks = [t for t in (p.get("tasks") or []) if isinstance(t, dict) and str(t.get("title") or "").strip()]
    if len(raw_tasks) == len(plan["tasks"]):
        for t, r in zip(plan["tasks"], raw_tasks):
            try:
                if r.get("due_on"):
                    t["due_on"] = date.fromisoformat(str(r["due_on"])[:10]).isoformat()
            except ValueError:
                pass
            if r.get("owner"):
                t["owner"] = str(r["owner"])[:120]
    i = models.Initiative(
        owner_id=user.id, workspace_id=ws, title=plan["title"], kind=plan["kind"], department=plan["department"],
        status="active", brief=(body.brief or "")[:4000] or None, summary=plan["summary"],
        starts_on=plan.get("starts_on"), key_date=plan.get("key_date"), location=plan.get("location"),
        budget=plan.get("budget"), details={**(plan.get("details") or {}), **({"scope": p["scope"]} if isinstance(p.get("scope"), dict) else {})},
        targets=plan["targets"], phases=plan["phases"], tools=plan["tools"], audience=plan.get("audience"),
        plan_meta={"roles": plan.get("roles"), "strategy": plan.get("strategy"), "assumptions": plan.get("assumptions"),
                   "learned": plan.get("learned"), "ai": bool(p.get("ai")), "compressed": plan.get("compressed")},
    )
    db.add(i)
    db.flush()
    for n, t in enumerate(plan["tasks"]):
        db.add(models.InitiativeTask(initiative_id=i.id, phase_id=t.get("phase"), title=t["title"], detail=t.get("detail"),
                                     due_on=t.get("due_on"), tool_key=t.get("tool"), position=n, origin="planner",
                                     owner_name=(t.get("owner") or None)))
    for n, it in enumerate(plan.get("board_items") or []):
        db.add(models.InitiativeItem(initiative_id=i.id, title=it["title"], group_name=it.get("group"), stage=it["stage"],
                                     position=n))
    tracking.log(db, i, f"Initiative created from the {'AI' if p.get('ai') else 'standard'} plan: {len(plan['tasks'])} tasks, "
                        f"{len(plan['targets'])} targets.", author(user), kind="system")
    log_audit_event(db, actor=user, action="initiative.create", workspace_id=ws, target_type="initiative", target_id=i.id,
                    metadata={"title": i.title, "kind": i.kind})
    db.commit()
    return {"id": i.id}


# ================================================================== detail ==

def _task(t: models.InitiativeTask) -> dict:
    a = dict(t.approval or {})
    return {"id": t.id, "phase_id": t.phase_id, "title": t.title, "detail": t.detail, "owner_name": t.owner_name,
            "due_on": t.due_on, "status": t.status, "tool_key": t.tool_key, "position": t.position, "origin": t.origin,
            "done_at": _iso(t.done_at), "evidence": t.evidence or [], "approval": a or None,
            "approval_link": f"{app_url()}/a/{t.approval_token}" if t.approval_token else None}


def _item(it: models.InitiativeItem) -> dict:
    return {"id": it.id, "group": it.group_name, "title": it.title, "subtitle": it.subtitle, "stage": it.stage,
            "email": it.email, "link": it.link, "account_id": it.account_id, "owner_name": it.owner_name,
            "notes": it.notes, "data": it.data or {}, "position": it.position, "stage_changed_at": _iso(it.stage_changed_at)}


def _link(l: dict) -> dict:
    l = dict(l)
    l["tracked_url"] = f"{campaigns.backend_url()}/public/gtm/l/{l['code']}"
    l["last_click_at"] = _iso(l.get("last_click_at"))
    l["created_at"] = _iso(l.get("created_at"))
    if l.get("tracking"):
        l["tracking"] = {**l["tracking"], "last_seen": _iso(l["tracking"].get("last_seen"))}
    return l


def _tools(db: Session, i: models.Initiative) -> list[dict]:
    conns = {c.provider: c for c in db.query(models.GtmConnection).filter(models.GtmConnection.workspace_id == i.workspace_id)}
    out = []
    for t in i.tools or []:
        meta = catalog.TOOLS.get(t.get("key"))
        if not meta:
            continue
        status = {"native": "ready", "import": "import", "link": "link"}.get(meta["mode"], "connect")
        if meta["mode"] == "connect":
            c = conns.get(t["key"])
            status = "connected" if c and c.status != "error" else ("error" if c else "connect")
        if t["key"] == "gd360_email" and not email_configured():
            status = "needs_setup"
        out.append({"key": t["key"], "name": meta["name"], "mode": meta["mode"], "category": meta["category"],
                    "does": meta["does"], "why": t.get("why"), "status": status})
    return out


@router.get("/{initiative_id}")
def get_initiative(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id)
    res = metrics.compute(db, i)
    s = metrics.summary(db, i, res)
    tasks = db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id == i.id) \
        .order_by(models.InitiativeTask.due_on.nullslast(), models.InitiativeTask.position).all()
    items = db.query(models.InitiativeItem).filter(models.InitiativeItem.initiative_id == i.id) \
        .order_by(models.InitiativeItem.position).all()
    camps = db.query(models.GtmCampaign).filter(models.GtmCampaign.initiative_id == i.id) \
        .order_by(models.GtmCampaign.created_at.desc()).all()
    links = res.get("links") or []
    conn = connected.for_initiative(db, user, i)
    role = workspace_access.member_role(db, user.id, i.workspace_id)
    ws = db.get(models.Workspace, i.workspace_id)
    can_edit = role in ("owner", "member") or (ws and ws.owner_id == user.id)
    meta = catalog.KINDS.get(i.kind) or catalog.KINDS["custom"]
    return {
        **{k: (_iso(v) if isinstance(v, datetime) else v) for k, v in s.items()},
        "workspace_id": i.workspace_id, "brief": i.brief, "summary": i.summary, "budget": i.budget,
        "details": i.details or {}, "scope": (i.details or {}).get("scope") or {},
        "phases": i.phases or [], "plan_meta": i.plan_meta or {}, "audience": i.audience,
        "audience_text": metrics.audience_text(i.audience) if i.audience else None,
        "registration_open": bool(i.registration_open), "links_public": public_links(i),
        "board": {"label": meta["board"], "stages": meta["stages"] + (["Rejected"] if i.kind == "hiring" else ["Dropped"] if i.kind == "product" else ["Lost"] if i.kind in ("abm", "event", "webinar", "campaign") else [])},
        "tasks": [_task(t) for t in tasks], "items": [_item(x) for x in items],
        "tools": _tools(db, i), "values": res["values"],
        "tracked": [_link(l) for l in links], "ab": tracking.ab_verdict(links), "breakdown": tracking.breakdown(links),
        "tracking_plan": connected.apply_to_plan(tracking.tracking_plan(db, i, res["values"], links), conn),
        "connected_data": conn,
        "campaigns": [{"id": c.id, "name": c.name, "status": c.status, "subject": c.subject,
                       "sent_at": _iso(c.sent_at), "scheduled_at": _iso(c.scheduled_at), **campaigns.stats(db, c)} for c in camps],
        "email_ready": email_configured(), "can_edit": bool(can_edit),
        "owner": author(db.get(models.User, i.owner_id)) if db.get(models.User, i.owner_id) else None,
    }


class PatchInitiative(BaseModel):
    title: str | None = Field(default=None, max_length=120)
    status: str | None = None
    key_date: str | None = None
    starts_on: str | None = None
    location: str | None = Field(default=None, max_length=160)
    budget: float | None = None
    summary: str | None = Field(default=None, max_length=2000)
    department: str | None = Field(default=None, max_length=60)
    audience: dict | None = None
    targets: list[dict] | None = None
    scope: dict | None = None
    registration_open: bool | None = None
    outcome: str | None = Field(default=None, max_length=2000)
    details: dict | None = None


@router.patch("/{initiative_id}")
def patch_initiative(initiative_id: str, body: PatchInitiative, db: Session = Depends(get_db),
                     user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    data = body.model_dump(exclude_unset=True)
    if "title" in data and (data["title"] or "").strip():
        i.title = data["title"].strip()
    if "status" in data:
        if data["status"] not in ("planning", "active", "done", "archived"):
            raise HTTPException(422, "Status is planning, active, done or archived.")
        if data["status"] != i.status:
            tracking.log(db, i, f"Status changed to {data['status']}.", author(user), kind="system")
        i.status = data["status"]
    for f in ("key_date", "starts_on"):
        if f in data:
            setattr(i, f, _date(data[f]))
    for f in ("location", "summary", "department"):
        if f in data:
            setattr(i, f, (data[f] or "").strip() or None)
    if "budget" in data:
        i.budget = data["budget"]
    if "audience" in data:
        a = data["audience"] or {}
        i.audience = {k: [str(x)[:80] for x in (a.get(k) or [])][:50] for k in ("tiers", "segments", "lists", "countries")
                      if a.get(k)} or None
    if "targets" in data and data["targets"] is not None:
        clean = []
        for t in data["targets"][:12]:
            key = re.sub(r"[^a-z0-9_]+", "_", str(t.get("key") or "").lower())[:40]
            if not key:
                continue
            m = catalog.METRICS.get(key) or {}
            row = {"key": key, "label": str(t.get("label") or catalog.metric_label(key))[:60],
                   "target": float(t["target"]) if t.get("target") not in (None, "") else None,
                   "unit": t.get("unit") or m.get("unit") or "count",
                   "auto": bool(m.get("auto")) and t.get("auto", True) is not False, "why": t.get("why")}
            if t.get("actual") not in (None, ""):
                try:
                    row["actual"] = float(t["actual"])
                except (TypeError, ValueError):
                    pass
            clean.append(row)
        i.targets = clean
    if "scope" in data:
        sc = data["scope"] or {}
        i.details = {**(i.details or {}), "scope": {
            "regions": [str(x)[:40] for x in (sc.get("regions") or [])][:20],
            "channels": [str(x)[:40] for x in (sc.get("channels") or [])][:20],
            "note": str(sc.get("note") or "")[:400] or None}}
    if "details" in data and isinstance(data["details"], dict):
        d = dict(i.details or {})
        for k, v in data["details"].items():
            if k != "scope":
                d[str(k)[:40]] = str(v)[:400] if v is not None else None
        i.details = d
    if "registration_open" in data:
        i.registration_open = bool(data["registration_open"])
    if "outcome" in data:
        i.plan_meta = {**(i.plan_meta or {}), "outcome": (data["outcome"] or "").strip() or None}
    i.updated_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


@router.delete("/{initiative_id}")
def delete_initiative(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    for M in (models.InitiativeTask, models.InitiativeItem, models.InitiativeUpdate, models.InitiativeMessage,
              models.InitiativeLink, models.InitiativeMember, models.InitiativeOutreach):
        db.query(M).filter(M.initiative_id == i.id).delete(synchronize_session=False)
    db.query(models.GtmReminder).filter(models.GtmReminder.initiative_id == i.id).delete(synchronize_session=False)
    # engagements stay on the accounts (they happened); they just lose the link
    db.query(models.GtmEngagement).filter(models.GtmEngagement.initiative_id == i.id).update(
        {models.GtmEngagement.initiative_id: None}, synchronize_session=False)
    db.query(models.GtmCampaign).filter(models.GtmCampaign.initiative_id == i.id).update(
        {models.GtmCampaign.initiative_id: None}, synchronize_session=False)
    log_audit_event(db, actor=user, action="initiative.delete", workspace_id=i.workspace_id, target_type="initiative",
                    target_id=i.id, metadata={"title": i.title})
    db.delete(i)
    db.commit()
    return {"ok": True}


# =================================================================== tasks ==

class TaskBody(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    detail: str | None = Field(default=None, max_length=2000)
    owner_name: str | None = Field(default=None, max_length=120)
    due_on: str | None = None
    status: str | None = None
    phase_id: str | None = None
    tool_key: str | None = None
    position: int | None = None


def _task_of(db: Session, i: models.Initiative, task_id: str) -> models.InitiativeTask:
    t = db.get(models.InitiativeTask, task_id)
    if not t or t.initiative_id != i.id:
        raise HTTPException(404, "Task not found.")
    return t


@router.post("/{initiative_id}/tasks")
def add_task(initiative_id: str, body: TaskBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    if not (body.title or "").strip():
        raise HTTPException(422, "Give the task a title.")
    n = db.query(func.count(models.InitiativeTask.id)).filter(models.InitiativeTask.initiative_id == i.id).scalar() or 0
    if n >= 500:
        raise HTTPException(409, "An initiative holds up to 500 tasks.")
    t = models.InitiativeTask(initiative_id=i.id, title=body.title.strip(), detail=body.detail, owner_name=body.owner_name,
                              due_on=_date(body.due_on), phase_id=body.phase_id or ((i.phases or [{}])[0].get("id")),
                              tool_key=body.tool_key if body.tool_key in catalog.TOOLS else None, position=n + 1, origin="you")
    db.add(t)
    i.updated_at = datetime.utcnow()
    db.commit()
    return _task(t)


@router.patch("/{initiative_id}/tasks/{task_id}")
def patch_task(initiative_id: str, task_id: str, body: TaskBody, db: Session = Depends(get_db),
               user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    t = _task_of(db, i, task_id)
    data = body.model_dump(exclude_unset=True)
    if "status" in data:
        if data["status"] not in ("todo", "doing", "review", "done", "blocked"):
            raise HTTPException(422, "Unknown status.")
        if data["status"] == "done" and t.status != "done":
            t.done_at = datetime.utcnow()
            tracking.log(db, i, f"Done: {t.title}", author(user), kind="milestone", task_id=t.id)
        elif data["status"] != "done":
            t.done_at = None
        if data["status"] == "blocked" and t.status != "blocked":
            tracking.log(db, i, f"Blocked: {t.title}", author(user), kind="risk", task_id=t.id)
        t.status = data["status"]
    if "title" in data and (data["title"] or "").strip():
        t.title = data["title"].strip()
    for f in ("detail", "owner_name", "phase_id"):
        if f in data:
            setattr(t, f, (data[f] or "").strip() or None)
    if "due_on" in data:
        t.due_on = _date(data["due_on"])
    if "tool_key" in data:
        t.tool_key = data["tool_key"] if data["tool_key"] in catalog.TOOLS else None
    if "position" in data and data["position"] is not None:
        t.position = data["position"]
    i.updated_at = datetime.utcnow()
    db.commit()
    return _task(t)


@router.delete("/{initiative_id}/tasks/{task_id}")
def delete_task(initiative_id: str, task_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    db.delete(_task_of(db, i, task_id))
    db.commit()
    return {"ok": True}


class EvidenceBody(BaseModel):
    label: str | None = Field(default=None, max_length=120)
    url: str | None = Field(default=None, max_length=600)
    version: str | None = Field(default=None, max_length=40)
    remove_index: int | None = None


@router.post("/{initiative_id}/tasks/{task_id}/evidence")
def add_evidence(initiative_id: str, task_id: str, body: EvidenceBody, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    t = _task_of(db, i, task_id)
    ev = list(t.evidence or [])
    if body.remove_index is not None:
        if 0 <= body.remove_index < len(ev):
            ev.pop(body.remove_index)
    else:
        new = tracking.evidence_clean([body.model_dump()])
        if not new:
            raise HTTPException(422, "Add a link or a name for the deliverable.")
        ev.append(new[0])
        tracking.log(db, i, f"Deliverable added to “{t.title}”: {new[0]['label']}" + (f" (v{new[0]['version']})" if new[0].get("version") else ""),
                     author(user), kind="deliverable", task_id=t.id, link=new[0].get("url"))
        a = tracking.approval_state(t)
        if a["state"] in ("approved", "changes"):
            # a new version after a decision needs a new decision
            a["state"] = "none"
            t.approval = a
    t.evidence = ev
    db.commit()
    return _task(t)


class ApprovalRequestBody(BaseModel):
    approver: str = Field(min_length=1, max_length=120)
    approver_email: str | None = Field(default=None, max_length=200)
    note: str | None = Field(default=None, max_length=600)


def _send_approval_email(to: str, who: str, title: str, task: str, link: str, note: str | None) -> None:
    def go():
        try:
            send_email([to], f"Approval needed: {task}",
                       f'<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1B2321;max-width:560px">'
                       f'<p style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;color:#7A8582">{title.upper()}</p>'
                       f'<p style="margin:0 0 12px;font-size:17px">{who} asked you to review <b>{task}</b>.</p>'
                       + (f'<p style="margin:0 0 16px;color:#46504D">{note}</p>' if note else "") +
                       f'<a href="{link}" style="display:inline-block;background:#0E7C5A;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Review and decide</a></div>',
                       f"{who} asked you to review {task} ({title}).\n{note or ''}\nReview: {link}")
        except Exception:  # noqa: BLE001 - the link is shown in the app either way
            pass
    threading.Thread(target=go, daemon=True).start()


@router.post("/{initiative_id}/tasks/{task_id}/approval")
def request_approval(initiative_id: str, task_id: str, body: ApprovalRequestBody, db: Session = Depends(get_db),
                     user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    t = _task_of(db, i, task_id)
    if body.approver_email and not gtm.valid_email(body.approver_email):
        raise HTTPException(422, "That approver email doesn't look right.")
    tracking.request_approval(t, body.approver.strip(), body.approver_email, body.note, author(user))
    tracking.log(db, i, f"Sent “{t.title}” to {body.approver.strip()} for approval.", author(user), kind="approval", task_id=t.id)
    log_audit_event(db, actor=user, action="initiative.approval_request", workspace_id=i.workspace_id,
                    target_type="initiative_task", target_id=t.id, metadata={"approver": body.approver})
    db.commit()
    link = f"{app_url()}/a/{t.approval_token}"
    emailed = False
    if body.approver_email and email_configured():
        _send_approval_email(body.approver_email, author(user), i.title, t.title, link, body.note)
        emailed = True
    return {**_task(t), "emailed": emailed}


class DecisionBody(BaseModel):
    decision: str
    note: str | None = Field(default=None, max_length=1000)


@router.post("/{initiative_id}/tasks/{task_id}/decision")
def decide(initiative_id: str, task_id: str, body: DecisionBody, db: Session = Depends(get_db),
           user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    t = _task_of(db, i, task_id)
    if body.decision not in ("approve", "changes"):
        raise HTTPException(422, "Decide approve or changes.")
    a = tracking.decide(t, body.decision, author(user), body.note)
    v = f" (v{a['version']})" if a.get("version") else ""
    tracking.log(db, i, (f"Approved{v}: {t.title}" if body.decision == "approve" else f"Changes requested{v}: {t.title}")
                 + (f" - {body.note}" if body.note else ""), author(user), kind="approval", task_id=t.id)
    log_audit_event(db, actor=user, action=f"initiative.approval_{a['state']}", workspace_id=i.workspace_id,
                    target_type="initiative_task", target_id=t.id)
    db.commit()
    return _task(t)


# =================================================================== board ==

class ItemBody(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    subtitle: str | None = Field(default=None, max_length=200)
    group: str | None = Field(default=None, max_length=60)
    stage: str | None = None
    email: str | None = Field(default=None, max_length=200)
    link: str | None = Field(default=None, max_length=600)
    account_id: str | None = None
    owner_name: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=4000)
    position: int | None = None


def _stages(i: models.Initiative) -> list[str]:
    return (catalog.KINDS.get(i.kind) or catalog.KINDS["custom"])["stages"] + ["Rejected", "Dropped", "Lost"]


@router.post("/{initiative_id}/items")
def add_item(initiative_id: str, body: ItemBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    title = (body.title or "").strip()
    acc = None
    if body.account_id:
        acc = db.get(models.GtmAccount, body.account_id)
        if not acc or acc.workspace_id != i.workspace_id:
            raise HTTPException(404, "Account not found.")
        title = title or acc.name
    if not title:
        raise HTTPException(422, "Give the card a title.")
    stages = _stages(i)
    n = db.query(func.count(models.InitiativeItem.id)).filter(models.InitiativeItem.initiative_id == i.id).scalar() or 0
    it = models.InitiativeItem(initiative_id=i.id, title=title, subtitle=body.subtitle, group_name=body.group,
                               stage=body.stage if body.stage in stages else stages[0], email=body.email,
                               link=body.link, account_id=acc.id if acc else None, owner_name=body.owner_name,
                               notes=body.notes, position=n + 1)
    db.add(it)
    db.commit()
    return _item(it)


@router.patch("/{initiative_id}/items/{item_id}")
def patch_item(initiative_id: str, item_id: str, body: ItemBody, db: Session = Depends(get_db),
               user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    it = db.get(models.InitiativeItem, item_id)
    if not it or it.initiative_id != i.id:
        raise HTTPException(404, "Card not found.")
    data = body.model_dump(exclude_unset=True)
    if "stage" in data and data["stage"] != it.stage:
        if data["stage"] not in _stages(i):
            raise HTTPException(422, "Unknown stage.")
        old, it.stage, it.stage_changed_at = it.stage, data["stage"], datetime.utcnow()
        tracking.log(db, i, f"{it.title}: {old} → {it.stage}", author(user), kind="milestone")
        # a target account reaching Meeting / Opportunity is a real signal on the account
        if it.account_id and it.stage in ("Meeting", "Opportunity", "Customer"):
            gtm.record(db, i.workspace_id, "meeting" if it.stage == "Meeting" else "opportunity",
                       account_id=it.account_id, initiative_id=i.id, channel="board",
                       detail={"text": f"Moved to {it.stage} on {i.title}"})
    if "title" in data and (data["title"] or "").strip():
        it.title = data["title"].strip()
    if "group" in data:
        it.group_name = (data["group"] or "").strip() or None
    for f in ("subtitle", "email", "link", "owner_name", "notes"):
        if f in data:
            setattr(it, f, (data[f] or "").strip() or None)
    if "position" in data and data["position"] is not None:
        it.position = data["position"]
    db.commit()
    return _item(it)


@router.delete("/{initiative_id}/items/{item_id}")
def delete_item(initiative_id: str, item_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    it = db.get(models.InitiativeItem, item_id)
    if not it or it.initiative_id != i.id:
        raise HTTPException(404, "Card not found.")
    db.delete(it)
    db.commit()
    return {"ok": True}


async def _read_upload(file: UploadFile) -> bytes:
    raw = await file.read()
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, "That file is over 15 MB - export fewer columns or split it.")
    if not raw:
        raise HTTPException(422, "The file is empty.")
    return raw


@router.post("/{initiative_id}/items/import")
async def import_items(initiative_id: str, file: UploadFile = File(...), source: str = Form("csv"),
                       commit: bool = Form(False), db: Session = Depends(get_db),
                       user: models.User = Depends(get_current_user)):
    """Cards from any tracker's CSV export. commit=false previews the
    column matching and stage mapping; commit=true imports."""
    i = initiative_for(db, user, initiative_id, edit=True)
    raw = await _read_upload(file)
    try:
        headers, rows = gtm.read_csv(raw)
    except ValueError as e:
        raise HTTPException(422, str(e))
    mapping = tracking.map_board(headers)
    if "title" not in mapping:
        raise HTTPException(422, "Couldn't find a title column (Summary, Title, Name or Task name).")
    if not commit:
        from collections import Counter as _C
        st = _C(tracking.stage_for(i.kind, r.get(mapping.get("status", ""))) for r in rows)
        return {"rows": len(rows), "mapping": mapping, "stages": dict(st),
                "sample": [{"title": r.get(mapping["title"]), "status": r.get(mapping.get("status", "")),
                            "stage": tracking.stage_for(i.kind, r.get(mapping.get("status", "")))} for r in rows[:6]]}
    stats = tracking.import_board(db, i, rows, mapping, source[:30])
    tracking.log(db, i, f"Imported {stats.get('created', 0)} cards from {source} ({stats.get('moved', 0)} moved).",
                 author(user), kind="system")
    log_audit_event(db, actor=user, action="initiative.board_import", workspace_id=i.workspace_id,
                    target_type="initiative", target_id=i.id, metadata={"source": source, **stats})
    db.commit()
    return {"ok": True, **stats}


# ================================================================= updates ==

class UpdateBody(BaseModel):
    text: str = Field(min_length=2, max_length=2000)
    kind: str | None = None
    channel: str | None = Field(default=None, max_length=40)
    link: str | None = Field(default=None, max_length=600)
    numbers: dict | None = None
    task_id: str | None = None
    link_id: str | None = None
    paid: bool | None = None
    region: str | None = Field(default=None, max_length=40)
    occurred_at: str | None = None


@router.get("/{initiative_id}/updates")
def list_updates(initiative_id: str, limit: int = 100, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id)
    rows = db.query(models.InitiativeUpdate).filter(models.InitiativeUpdate.initiative_id == i.id) \
        .order_by(models.InitiativeUpdate.occurred_at.desc()).limit(min(max(limit, 1), 500)).all()
    return [{**tracking.update_row(u), "occurred_at": _iso(u.occurred_at)} for u in rows]


@router.post("/{initiative_id}/updates")
def add_update(initiative_id: str, body: UpdateBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    when = None
    if body.occurred_at:
        try:
            when = datetime.fromisoformat(body.occurred_at.replace("Z", "")[:19])
        except ValueError:
            raise HTTPException(422, "Use a date like 2026-10-10 or 2026-10-10T14:30.")
    kind = body.kind if body.kind in ("update", "approval", "post", "metric", "milestone", "risk", "deliverable") else None
    u = tracking.log(db, i, body.text, author(user), kind=kind, channel=body.channel, link=body.link,
                     numbers=body.numbers, task_id=body.task_id, occurred_at=when, link_id=body.link_id,
                     paid=body.paid, region=body.region)
    db.commit()
    return {**tracking.update_row(u), "occurred_at": _iso(u.occurred_at)}


@router.delete("/{initiative_id}/updates/{update_id}")
def delete_update(initiative_id: str, update_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    u = db.get(models.InitiativeUpdate, update_id)
    if not u or u.initiative_id != i.id:
        raise HTTPException(404, "Update not found.")
    db.delete(u)
    db.commit()
    return {"ok": True}


@router.get("/{initiative_id}/today")
def get_today(initiative_id: str, day: str | None = None, db: Session = Depends(get_db),
              user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id)
    d = date.fromisoformat(_date(day)) if day else date.today()
    t = tracking.today(db, i, d)
    for u in t["updates"]:
        u["occurred_at"] = _iso(u["occurred_at"])
    for a in t["approvals"]:
        a["at"] = _iso(a["at"])
    return t


# =================================================================== links ==

class LinkBody(BaseModel):
    kind: str = "landing_page"
    label: str | None = Field(default=None, max_length=120)
    url: str | None = Field(default=None, max_length=800)
    channel: str | None = Field(default=None, max_length=40)
    variant: str | None = Field(default=None, max_length=8)
    paid: bool | None = None
    region: str | None = Field(default=None, max_length=40)


@router.post("/{initiative_id}/links")
def add_link(initiative_id: str, body: LinkBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    url = (body.url or "").strip()
    if not url:
        raise HTTPException(422, "Paste the page or post address.")
    if not re.match(r"^https?://", url):
        url = "https://" + url
    if not tracking.page_key(url):
        raise HTTPException(422, "That doesn't look like a web address.")
    if body.kind not in ("landing_page", "social_post", "ad", "email", "other"):
        raise HTTPException(422, "Unknown link type.")
    n = db.query(func.count(models.InitiativeLink.id)).filter(models.InitiativeLink.initiative_id == i.id).scalar() or 0
    if n >= 100:
        raise HTTPException(409, "An initiative tracks up to 100 links.")
    host = tracking.page_key(url).split("/")[0]
    l = models.InitiativeLink(initiative_id=i.id, workspace_id=i.workspace_id, kind=body.kind,
                              label=(body.label or "").strip() or host, url=url[:800],
                              channel=(body.channel or "").strip().lower() or None,
                              variant=(body.variant or "").strip().upper() or None, paid=bool(body.paid),
                              region=(body.region or "").strip() or None)
    db.add(l)
    tracking.log(db, i, f"Now tracking {body.kind.replace('_', ' ')}: {l.label}" + (f" ({l.variant})" if l.variant else ""),
                 author(user), kind="system", link=url)
    db.commit()
    return {"id": l.id, "code": l.code, "tracked_url": f"{campaigns.backend_url()}/public/gtm/l/{l.code}"}


@router.patch("/{initiative_id}/links/{link_id}")
def patch_link(initiative_id: str, link_id: str, body: LinkBody, db: Session = Depends(get_db),
               user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    l = db.get(models.InitiativeLink, link_id)
    if not l or l.initiative_id != i.id:
        raise HTTPException(404, "Link not found.")
    data = body.model_dump(exclude_unset=True)
    if data.get("label"):
        l.label = data["label"].strip()
    if "variant" in data:
        l.variant = (data["variant"] or "").strip().upper() or None
    if "paid" in data:
        l.paid = bool(data["paid"])
    if "region" in data:
        l.region = (data["region"] or "").strip() or None
    if "channel" in data:
        l.channel = (data["channel"] or "").strip().lower() or None
    db.commit()
    return {"ok": True}


@router.delete("/{initiative_id}/links/{link_id}")
def delete_link(initiative_id: str, link_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    l = db.get(models.InitiativeLink, link_id)
    if not l or l.initiative_id != i.id:
        raise HTTPException(404, "Link not found.")
    db.delete(l)
    db.commit()
    return {"ok": True}


# ================================================================== people ==

@router.get("/{initiative_id}/people")
def people(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Everyone who registered, attended or walked in, with their account."""
    i = initiative_for(db, user, initiative_id)
    E = models.GtmEngagement
    rows = db.query(E).filter(E.initiative_id == i.id, E.kind.in_(("registered", "attended", "webinar_attended", "walk_in"))) \
        .order_by(E.occurred_at).all()
    by: dict[str, dict] = {}
    for e in rows:
        key = e.contact_id or (f"acc:{e.account_id}" if e.account_id else e.id)
        p = by.setdefault(key, {"contact_id": e.contact_id, "account_id": e.account_id, "registered_at": None,
                                "attended": False, "walk_in": False, "interests": [], "wants_meeting": False,
                                "note": None, "source": e.channel})
        if e.kind == "registered":
            p["registered_at"] = p["registered_at"] or _iso(e.occurred_at)
        if e.kind in ("attended", "webinar_attended"):
            p["attended"] = True
        if e.kind == "walk_in":
            p["walk_in"] = True
            d = e.detail or {}
            p["interests"] = d.get("interests") or p["interests"]
            p["wants_meeting"] = bool(d.get("wants_meeting")) or p["wants_meeting"]
            p["note"] = d.get("note") or p["note"]
    cids = [p["contact_id"] for p in by.values() if p["contact_id"]]
    aids = [p["account_id"] for p in by.values() if p["account_id"]]
    contacts = {c.id: c for c in db.query(models.GtmContact).filter(models.GtmContact.id.in_(cids or ["-"]))}
    accounts = {a.id: a for a in db.query(models.GtmAccount).filter(models.GtmAccount.id.in_(aids or ["-"]))}
    out = []
    for p in by.values():
        c = contacts.get(p["contact_id"])
        a = accounts.get(p["account_id"])
        out.append({**p, "name": c.name if c else None, "email": c.email if c else None, "title": c.title if c else None,
                    "company": a.name if a else None, "tier": a.icp_tier if a else None,
                    "subscribed": bool(c and c.subscribed and not c.unsubscribed)})
    return out


class PersonBody(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=200)
    company: str | None = Field(default=None, max_length=160)
    title: str | None = Field(default=None, max_length=120)
    kind: str = "registered"


@router.post("/{initiative_id}/people")
def add_person(initiative_id: str, body: PersonBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    if body.kind not in ("registered", "attended", "walk_in"):
        raise HTTPException(422, "Unknown kind.")
    if body.email and not gtm.valid_email(body.email):
        raise HTTPException(422, "That email doesn't look right.")
    c = gtm.upsert_contact(db, i.workspace_id, {"name": body.name, "email": body.email, "company": body.company,
                                                "title": body.title}, "manual")
    if not c:
        raise HTTPException(422, "Add at least a name or an email.")
    db.flush()
    gtm.record(db, i.workspace_id, body.kind, account_id=c.account_id, contact_id=c.id, initiative_id=i.id,
               channel="manual", detail={"added_by": author(user)})
    db.commit()
    return {"ok": True}


class AttendBody(BaseModel):
    attended: bool


@router.post("/{initiative_id}/people/{contact_id}/attended")
def mark_attended(initiative_id: str, contact_id: str, body: AttendBody, db: Session = Depends(get_db),
                  user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    c = db.get(models.GtmContact, contact_id)
    if not c or c.workspace_id != i.workspace_id:
        raise HTTPException(404, "Person not found.")
    E = models.GtmEngagement
    kind = "webinar_attended" if i.kind == "webinar" else "attended"
    existing = db.query(E).filter(E.initiative_id == i.id, E.contact_id == c.id, E.kind.in_(("attended", "webinar_attended"))).all()
    if body.attended and not existing:
        gtm.record(db, i.workspace_id, kind, account_id=c.account_id, contact_id=c.id, initiative_id=i.id,
                   channel="check-in", detail={"by": author(user)})
    elif not body.attended:
        for e in existing:
            db.delete(e)
        db.flush()
        if c.account_id:
            a = db.get(models.GtmAccount, c.account_id)
            if a:
                gtm.recompute_account(db, a)
    db.commit()
    return {"ok": True}


@router.get("/{initiative_id}/people.csv")
def export_people(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    rows = people(initiative_id, db, user)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["name", "email", "title", "company", "tier", "registered_at", "attended", "walk_in", "wants_meeting",
                "interests", "note", "email_opt_in"])
    for p in rows:
        w.writerow([p["name"] or "", p["email"] or "", p["title"] or "", p["company"] or "", p["tier"] or "",
                    p["registered_at"] or "", "yes" if p["attended"] else "", "yes" if p["walk_in"] else "",
                    "yes" if p["wants_meeting"] else "", "; ".join(p["interests"] or []), p["note"] or "",
                    "yes" if p["subscribed"] else ""])
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="people.csv"'})


@router.post("/{initiative_id}/import-people")
async def import_people(initiative_id: str, file: UploadFile = File(...), signal: str = Form("registered"),
                        source: str = Form("csv"), commit: bool = Form(False), db: Session = Depends(get_db),
                        user: models.User = Depends(get_current_user)):
    """An attendee or registrant list from Luma, Eventbrite, Zoom, Teams or a
    spreadsheet - matched to people and accounts, counted on this initiative."""
    i = initiative_for(db, user, initiative_id, edit=True)
    if signal not in ("registered", "attended", "webinar_attended", "walk_in", "social", "newsletter_signup"):
        raise HTTPException(422, "Unknown list type.")
    raw = await _read_upload(file)
    try:
        prev = gtm.preview(raw)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if not commit:
        return prev
    _, rows = gtm.read_csv(raw)
    stats = gtm.apply_import(db, i.workspace_id, rows, prev["mapping"], "signals", source=source[:30], signal=signal,
                             initiative_id=i.id)
    tracking.log(db, i, f"Imported {stats.get('signals', 0)} {signal.replace('_', ' ')} from {source}.", author(user), kind="system")
    log_audit_event(db, actor=user, action="initiative.people_import", workspace_id=i.workspace_id,
                    target_type="initiative", target_id=i.id, metadata={"source": source, **stats})
    db.commit()
    return {"ok": True, **stats}


# ================================================================= results ==

@router.get("/{initiative_id}/results")
def results(initiative_id: str, days: int = 60, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id)
    res = metrics.compute(db, i)
    since = datetime.utcnow() - timedelta(days=min(max(days, 7), 365))
    E = models.GtmEngagement
    series: dict[str, dict] = {}
    for kind, at in db.query(E.kind, E.occurred_at).filter(E.initiative_id == i.id, E.occurred_at >= since):
        if kind in ("email_sent", "note"):
            continue
        d = at.date().isoformat()
        row = series.setdefault(d, {"date": d})
        g = ("Registrations" if kind in ("registered",) else "Attendance" if kind in ("attended", "webinar_attended", "walk_in")
             else "Website" if kind in ("visit", "link_click", "form") else "Email" if kind.startswith("email")
             else "Meetings" if kind in ("meeting", "opportunity") else "Outreach" if kind in ("outreach", "reply") else "Other")
        row[g] = row.get(g, 0) + 1
    accs = {}
    for aid, n in db.query(E.account_id, func.count()).filter(E.initiative_id == i.id, E.account_id.isnot(None),
                                                             E.kind != "email_sent").group_by(E.account_id):
        accs[aid] = n
    top = []
    if accs:
        for a in db.query(models.GtmAccount).filter(models.GtmAccount.id.in_(list(accs))):
            top.append({**metrics.account_row(a), "signals": accs[a.id], "last_engaged_at": _iso(a.last_engaged_at)})
        top.sort(key=lambda x: -x["signals"])
    links = res.get("links") or []
    return {"targets": metrics.targets_with_actuals(i, res["values"]), "values": res["values"],
            "series": sorted(series.values(), key=lambda r: r["date"]), "accounts": top[:50],
            "breakdown": tracking.breakdown(links), "ab": tracking.ab_verdict(links),
            "update_totals": res.get("update_totals") or {}, "outcome": (i.plan_meta or {}).get("outcome")}


# =============================================================== assistant ==

class AskBody(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


@router.get("/{initiative_id}/assistant")
def assistant_history(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id)
    rows = db.query(models.InitiativeMessage).filter(models.InitiativeMessage.initiative_id == i.id) \
        .order_by(models.InitiativeMessage.created_at).limit(200).all()
    return [{"id": m.id, "role": m.role, "content": m.content, "actions": m.actions or [], "created_at": _iso(m.created_at)}
            for m in rows]


@router.post("/{initiative_id}/assistant")
def ask(initiative_id: str, body: AskBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _rate_limit(user.id)
    i = initiative_for(db, user, initiative_id)
    role = workspace_access.member_role(db, user.id, i.workspace_id)
    ws = db.get(models.Workspace, i.workspace_id)
    can_edit = role in ("owner", "member") or bool(ws and ws.owner_id == user.id)
    return assistant.chat(db, i, user, body.message.strip(), can_act=can_edit)


# =============================================================== reminders ==

class ReminderBody(BaseModel):
    note: str | None = Field(default=None, max_length=300)
    remind_at: str | None = None
    initiative_id: str | None = None
    task_id: str | None = None
    account_id: str | None = None
    workspace_id: str | None = None
    done: bool | None = None


def _rem(r: models.GtmReminder) -> dict:
    return {"id": r.id, "note": r.note, "remind_at": _iso(r.remind_at), "sent_at": _iso(r.sent_at), "done": bool(r.done),
            "initiative_id": r.initiative_id, "task_id": r.task_id, "account_id": r.account_id}


def _when(v: str | None) -> datetime:
    if not v:
        raise HTTPException(422, "Pick when to be reminded.")
    try:
        return datetime.fromisoformat(v.replace("Z", "")[:19])
    except ValueError:
        raise HTTPException(422, "Use a time like 2026-10-12T09:00.")


@router.get("/reminders/mine")
def my_reminders(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    rows = db.query(models.GtmReminder).filter(models.GtmReminder.owner_id == user.id, models.GtmReminder.done.is_(False)) \
        .order_by(models.GtmReminder.remind_at).limit(200).all()
    return [_rem(r) for r in rows]


@router.post("/reminders/new")
def add_reminder(body: ReminderBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    if not (body.note or "").strip():
        raise HTTPException(422, "Say what to remind you about.")
    ws = None
    if body.initiative_id:
        ws = initiative_for(db, user, body.initiative_id).workspace_id
    elif body.account_id:
        a = db.get(models.GtmAccount, body.account_id)
        if not a:
            raise HTTPException(404, "Account not found.")
        ws = workspace_for(db, user, a.workspace_id)
    else:
        ws = workspace_for(db, user, body.workspace_id)
    n = db.query(func.count(models.GtmReminder.id)).filter(models.GtmReminder.owner_id == user.id,
                                                          models.GtmReminder.done.is_(False)).scalar() or 0
    if n >= 500:
        raise HTTPException(409, "You have 500 open reminders - clear some first.")
    r = models.GtmReminder(workspace_id=ws, owner_id=user.id, initiative_id=body.initiative_id, task_id=body.task_id,
                           account_id=body.account_id, note=body.note.strip(), remind_at=_when(body.remind_at))
    db.add(r)
    db.commit()
    return {**_rem(r), "emails": email_configured()}


@router.patch("/reminders/{reminder_id}")
def patch_reminder(reminder_id: str, body: ReminderBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    r = db.get(models.GtmReminder, reminder_id)
    if not r or r.owner_id != user.id:
        raise HTTPException(404, "Reminder not found.")
    if body.done is not None:
        r.done = body.done
    if body.remind_at:
        r.remind_at, r.sent_at = _when(body.remind_at), None
    if body.note:
        r.note = body.note.strip()
    db.commit()
    return _rem(r)


@router.delete("/reminders/{reminder_id}")
def delete_reminder(reminder_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    r = db.get(models.GtmReminder, reminder_id)
    if not r or r.owner_id != user.id:
        raise HTTPException(404, "Reminder not found.")
    db.delete(r)
    db.commit()
    return {"ok": True}


# ==================================================================== team ==

class MemberBody(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=200)
    role: str | None = Field(default=None, max_length=60)
    team: str | None = Field(default=None, max_length=60)
    targets: dict | None = None


def _member_of(db: Session, i: models.Initiative, member_id: str) -> models.InitiativeMember:
    m = db.get(models.InitiativeMember, member_id)
    if not m or m.initiative_id != i.id:
        raise HTTPException(404, "Team member not found.")
    return m


def _member_links(i: models.Initiative, m: models.InitiativeMember) -> dict:
    base = app_url()
    return {"page": f"{base}/r/{m.token}", "invite": f"{base}/e/{i.public_token}?ref={m.ref}"}


def _clean_targets(t: dict | None) -> dict:
    out = {}
    for k, v in (t or {}).items():
        if k in ("invites", "registrations", "meetings", "walk_ins"):
            try:
                out[k] = max(0, int(v))
            except (TypeError, ValueError):
                pass
    return out


@router.get("/{initiative_id}/team")
def get_team(initiative_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id)
    st = team.stats(db, i)
    for m in st["members"]:
        m["last_update_at"] = _iso(m["last_update_at"])
        mm = db.get(models.InitiativeMember, m["id"])
        m["links"] = _member_links(i, mm)
    st["roles"] = (i.plan_meta or {}).get("roles") or st["roles"]
    st["statuses"] = [{"key": k, "label": v} for k, v in team.STATUS_LABELS.items()]
    st["channel_options"] = [{"key": k, "label": v} for k, v in team.CHANNELS.items()]
    return st


@router.post("/{initiative_id}/team")
def add_member(initiative_id: str, body: MemberBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    if not (body.name or "").strip():
        raise HTTPException(422, "Add the person's name.")
    if body.email and not gtm.valid_email(body.email):
        raise HTTPException(422, "That email doesn't look right.")
    n = db.query(func.count(models.InitiativeMember.id)).filter(models.InitiativeMember.initiative_id == i.id).scalar() or 0
    if n >= 200:
        raise HTTPException(409, "An initiative holds up to 200 team members.")
    u = db.query(models.User).filter(func.lower(models.User.email) == (body.email or "").lower()).first() if body.email else None
    m = models.InitiativeMember(initiative_id=i.id, name=body.name.strip(), email=(body.email or "").strip().lower() or None,
                                user_id=u.id if u else None, role=(body.role or "").strip() or None,
                                team=(body.team or "").strip() or None, targets=_clean_targets(body.targets))
    db.add(m)
    tracking.log(db, i, f"{m.name} joined as {m.role or 'team member'}" + (f" ({m.team})" if m.team else ""), author(user), kind="system")
    db.commit()
    return {**team.member_row(db, m), "last_update_at": None, "links": _member_links(i, m)}


@router.patch("/{initiative_id}/team/{member_id}")
def patch_member(initiative_id: str, member_id: str, body: MemberBody, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    m = _member_of(db, i, member_id)
    data = body.model_dump(exclude_unset=True)
    if data.get("name"):
        m.name = data["name"].strip()
    for f in ("role", "team"):
        if f in data:
            setattr(m, f, (data[f] or "").strip() or None)
    if "email" in data:
        if data["email"] and not gtm.valid_email(data["email"]):
            raise HTTPException(422, "That email doesn't look right.")
        m.email = (data["email"] or "").strip().lower() or None
    if "targets" in data:
        m.targets = _clean_targets(data["targets"])
    db.commit()
    return {"ok": True}


@router.delete("/{initiative_id}/team/{member_id}")
def delete_member(initiative_id: str, member_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    m = _member_of(db, i, member_id)
    # their list stays, unassigned, so nothing logged is lost
    db.query(models.InitiativeOutreach).filter(models.InitiativeOutreach.member_id == m.id).update(
        {models.InitiativeOutreach.member_id: None}, synchronize_session=False)
    db.delete(m)
    db.commit()
    return {"ok": True}


@router.post("/{initiative_id}/team/{member_id}/new-link")
def new_member_link(initiative_id: str, member_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Replaces the member's private page link (the old one stops working)."""
    import secrets
    i = initiative_for(db, user, initiative_id, edit=True)
    m = _member_of(db, i, member_id)
    m.token = secrets.token_urlsafe(18)
    log_audit_event(db, actor=user, action="initiative.member_link_reset", workspace_id=i.workspace_id, target_id=m.id)
    db.commit()
    return _member_links(i, m)


@router.post("/{initiative_id}/team/{member_id}/nudge")
def nudge(initiative_id: str, member_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    m = _member_of(db, i, member_id)
    links = _member_links(i, m)
    text = (f"Hi {m.name.split(' ')[0]}, quick nudge for {i.title}: please log your invites and replies here - "
            f"it takes a minute: {links['page']}  Your personal invite link: {links['invite']}")
    sent = False
    if m.email and email_configured():
        def go():
            try:
                send_email([m.email], f"{i.title}: update your invites",
                           f'<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1B2321;max-width:560px">'
                           f'<p>Hi {m.name.split(" ")[0]},</p><p>Please log your invites and replies for <b>{i.title}</b> - it takes a minute.</p>'
                           f'<p><a href="{links["page"]}" style="display:inline-block;background:#0E7C5A;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open my invites</a></p>'
                           f'<p style="color:#56605D;font-size:13px">Your personal invite link (registrations through it count for you): {links["invite"]}</p></div>', text)
            except Exception:  # noqa: BLE001
                pass
        threading.Thread(target=go, daemon=True).start()
        sent = True
    return {"emailed": sent, "message": text}


class AssignBody(BaseModel):
    member_ids: list[str] = Field(default_factory=list)
    account_ids: list[str] | None = None
    tiers: list[str] | None = None
    strategy: str = "round_robin"
    segment: str | None = None
    limit: int = 500


@router.post("/{initiative_id}/team/assign")
def assign_accounts(initiative_id: str, body: AssignBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    if body.segment not in (None, "target", "customer"):
        raise HTTPException(422, "Segment is target or customer.")
    out = team.assign(db, i, body.member_ids, body.account_ids, body.tiers, body.strategy, body.segment, body.limit)
    if out["assigned"]:
        tracking.log(db, i, f"Assigned {out['assigned']} accounts to the team.", author(user), kind="system")
    db.commit()
    return out


@router.get("/{initiative_id}/outreach")
def list_outreach(initiative_id: str, member_id: str | None = None, db: Session = Depends(get_db),
                  user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id)
    rows = team.rows_for(db, i.id, member_id)
    for r in rows:
        r["last_touch_at"] = _iso(r["last_touch_at"])
    return rows


class OutreachBody(BaseModel):
    member_id: str | None = None
    account_id: str | None = None
    contact_id: str | None = None
    name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=200)
    company: str | None = Field(default=None, max_length=160)
    title: str | None = Field(default=None, max_length=120)
    segment: str | None = None
    status: str | None = None
    channel: str | None = None
    note: str | None = Field(default=None, max_length=1000)
    next_step: str | None = Field(default=None, max_length=200)
    next_step_on: str | None = None


def add_outreach_row(db: Session, i: models.Initiative, body: OutreachBody, member_id: str | None, by: str) -> models.InitiativeOutreach:
    if body.email and not gtm.valid_email(body.email):
        raise HTTPException(422, "That email doesn't look right.")
    acc = db.get(models.GtmAccount, body.account_id) if body.account_id else None
    if acc and acc.workspace_id != i.workspace_id:
        raise HTTPException(404, "Account not found.")
    c = None
    if body.name or body.email:
        c = gtm.upsert_contact(db, i.workspace_id, {"name": body.name, "email": body.email, "company": body.company or (acc.name if acc else None),
                                                    "title": body.title}, "outreach", account=acc)
        db.flush()
        if c and not acc and c.account_id:
            acc = db.get(models.GtmAccount, c.account_id)
    elif body.company and not acc:
        acc = gtm.account_for_email(db, i.workspace_id, None, body.company, source="outreach")
        db.flush()
    if not acc and not c:
        raise HTTPException(422, "Add a person or a company.")
    O = models.InitiativeOutreach
    q = db.query(O).filter(O.initiative_id == i.id, O.member_id == member_id)
    o = q.filter(O.contact_id == c.id).first() if c else q.filter(O.account_id == acc.id, O.contact_id.is_(None)).first()
    if o is None:
        o = O(initiative_id=i.id, member_id=member_id, account_id=acc.id if acc else None, contact_id=c.id if c else None,
              person_name=body.name, segment=body.segment if body.segment in ("target", "customer") else team._segment_of(db, acc.id if acc else None),
              status="not_contacted")
        db.add(o)
        db.flush()
    if body.status or body.channel or body.note:
        _touch(db, o, body, by)
    return o


def _touch(db: Session, o: models.InitiativeOutreach, body: OutreachBody, by: str) -> None:
    if body.status and body.status not in team.STATUS_LABELS:
        raise HTTPException(422, "Unknown status.")
    if body.channel and body.channel not in team.CHANNELS:
        raise HTTPException(422, "Unknown channel.")
    team.log_touch(db, o, body.status, body.channel, body.note, by, body.next_step,
                   (_date(body.next_step_on) if body.next_step_on else ("" if body.next_step_on == "" else None)))
    if o.member_id:
        m = db.get(models.InitiativeMember, o.member_id)
        if m:
            m.last_update_at = datetime.utcnow()


@router.post("/{initiative_id}/outreach")
def add_outreach(initiative_id: str, body: OutreachBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    if body.member_id:
        _member_of(db, i, body.member_id)
    o = add_outreach_row(db, i, body, body.member_id, author(user))
    db.commit()
    return {"id": o.id}


@router.patch("/{initiative_id}/outreach/{outreach_id}")
def patch_outreach(initiative_id: str, outreach_id: str, body: OutreachBody, db: Session = Depends(get_db),
                   user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    o = db.get(models.InitiativeOutreach, outreach_id)
    if not o or o.initiative_id != i.id:
        raise HTTPException(404, "Not found.")
    if body.member_id is not None and body.member_id != o.member_id:
        if body.member_id:
            _member_of(db, i, body.member_id)
        o.member_id = body.member_id or None
    _touch(db, o, body, author(user))
    db.commit()
    return {"ok": True}


@router.delete("/{initiative_id}/outreach/{outreach_id}")
def delete_outreach(initiative_id: str, outreach_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, initiative_id, edit=True)
    o = db.get(models.InitiativeOutreach, outreach_id)
    if not o or o.initiative_id != i.id:
        raise HTTPException(404, "Not found.")
    db.delete(o)
    db.commit()
    return {"ok": True}
