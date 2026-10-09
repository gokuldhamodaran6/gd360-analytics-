"""
Mission Control, part 2 (2026-10-10): CRM (leads, deals, product-qualified
leads), support ticketing with SLAs, system health and incidents, and
security & privacy (posture, customer roles, privacy requests, abuse).
"""
from __future__ import annotations

import json
import re
import statistics
from collections import defaultdict
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..services import admin_metrics as M
from ..services.admin_access import Staff, current_staff, log_admin, mask_email, require

router = APIRouter(prefix="/admin/v2", tags=["mission-control"])

STAGES = [("new", "New lead", 0.05), ("qualified", "Qualified", 0.15), ("demo", "Demo done", 0.30),
          ("proposal", "Proposal", 0.60), ("won", "Won", 1.0), ("lost", "Lost", 0.0)]
PROB = {k: p for k, _, p in STAGES}
SLA_FIRST = {"P1": 1, "P2": 4, "P3": 8, "P4": 24}         # hours to first response
SLA_RESOLVE = {"P1": 8, "P2": 24, "P3": 72, "P4": 120}    # hours to resolution


def _iso(dt):
    return dt.isoformat() + "Z" if isinstance(dt, datetime) else dt


# ======================================================================== CRM
_KEYWORDS = re.compile(r"\b(sso|saml|okta|security|soc ?2|gdpr|hipaa|residency|procurement|warehouse|snowflake|bigquery|redshift|databricks)\b", re.I)


def lead_score(r: models.DemoRequest, signups_by_domain: dict) -> tuple[int, list[str]]:
    why, s = [], 0
    dom = M.domain_of(r.email)
    if dom in M.DISPOSABLE:
        s -= 50; why.append("−50 disposable email")
    elif dom in M.FREEMAIL:
        s -= 30; why.append("−30 freemail")
    else:
        s += 25; why.append("+25 company email")
    size = (r.team_size or "").replace(",", "")
    if any(x in size for x in ("200–1000", "1000–5000", "5000+", "200-1000", "1000-5000")):
        s += 20; why.append("+20 large team")
    elif "50" in size:
        s += 15; why.append("+15 team of 50+")
    if r.question and _KEYWORDS.search(r.question):
        s += 15; why.append("+15 asked about security or warehouses")
    n = signups_by_domain.get(dom, 0) if dom not in M.FREEMAIL else 0
    if n:
        bonus = min(20, 10 * n)
        s += bonus; why.append(f"+{bonus} {n} sign-up(s) from {dom}")
    if r.question and len(r.question) > 40:
        s += 5; why.append("+5 specific question")
    return max(0, min(100, s + 30)), ["base 30"] + why


def _deal_out(d: models.CrmDeal, staff: Staff) -> dict:
    return {"id": d.id, "name": d.name, "company": d.company, "domain": d.domain, "contact_name": d.contact_name,
            "contact_email": mask_email(d.contact_email, staff), "stage": d.stage, "amount": d.amount, "seats": d.seats,
            "probability": PROB.get(d.stage, 0), "owner_email": d.owner_email, "close_date": _iso(d.close_date),
            "next_step": d.next_step, "source": d.source, "lost_reason": d.lost_reason,
            "created_at": _iso(d.created_at), "updated_at": _iso(d.updated_at)}


@router.get("/crm")
def crm_overview(staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    deals = db.query(models.CrmDeal).order_by(models.CrmDeal.updated_at.desc()).all()
    cols = []
    for key, label, p in STAGES:
        ds = [d for d in deals if d.stage == key]
        total = sum(d.amount or 0 for d in ds)
        cols.append({"key": key, "label": label, "probability": p, "count": len(ds), "total": total,
                     "weighted": round(total * p), "deals": [_deal_out(d, staff) for d in ds]})
    closed90 = [d for d in deals if d.stage in ("won", "lost") and d.updated_at >= now - timedelta(days=90)]
    won90 = sum(1 for d in closed90 if d.stage == "won")
    cycles = [(d.updated_at - d.created_at).days for d in deals if d.stage == "won"]

    reqs = db.query(models.DemoRequest).order_by(models.DemoRequest.created_at.desc()).all()
    signups = defaultdict(int)
    for (email,) in db.query(models.User.email).all():
        signups[M.domain_of(email)] += 1
    first_touch = dict(
        db.query(models.CrmActivity.demo_request_id, func.min(models.CrmActivity.created_at))
        .filter(models.CrmActivity.demo_request_id.isnot(None)).group_by(models.CrmActivity.demo_request_id).all()
    )
    touch_hours = [(first_touch[r.id] - r.created_at).total_seconds() / 3600 for r in reqs if r.id in first_touch]
    leads = []
    for r in reqs:
        score, why = lead_score(r, signups)
        leads.append({"id": r.id, "name": r.name, "email": mask_email(r.email, staff), "company": r.company, "team_size": r.team_size,
                      "question": r.question, "status": r.status, "owner_email": r.owner_email, "notes": r.notes,
                      "deal_id": r.deal_id, "score": score, "why": why, "created_at": _iso(r.created_at)})

    reps = defaultdict(lambda: {"commit": 0.0, "best": 0.0, "won": 0.0})
    for d in deals:
        o = d.owner_email or "Unassigned"
        if d.stage in ("proposal",):
            reps[o]["commit"] += d.amount or 0
        if d.stage in ("qualified", "demo", "proposal"):
            reps[o]["best"] += d.amount or 0
        if d.stage == "won":
            reps[o]["won"] += d.amount or 0
    open_deals = [d for d in deals if d.stage not in ("won", "lost")]
    stats = {
        "weighted": round(sum((d.amount or 0) * PROB[d.stage] for d in open_deals)),
        "open_deals": len(open_deals), "won_total": round(sum(d.amount or 0 for d in deals if d.stage == "won")),
        "won_count": sum(1 for d in deals if d.stage == "won"),
        "win_rate_90d": round(won90 / len(closed90) * 100, 1) if closed90 else None,
        "speed_to_lead_hours": round(statistics.median(touch_hours), 1) if touch_hours else None,
        "sales_cycle_days": round(statistics.median(cycles)) if cycles else None,
        "new_leads_7d": sum(1 for r in reqs if r.created_at >= now - timedelta(days=7)),
        "leads_new": sum(1 for r in reqs if r.status == "new"),
    }
    # product-qualified: early-access workspaces whose usage fits a paid team plan
    pql = []
    for w in M.workspace_rows(db):
        if w["fit"] == "Plus" or (w["chats_30d"] == 0 and w["active_30d"] == 0):
            continue
        reasons = []
        if w["members"] >= 3: reasons.append(f"{w['members']} members")
        if w["warehouse"]: reasons.append("warehouse source")
        if w["chats_per_user"] > 200: reasons.append(f"{w['chats_per_user']:.0f} chats per person")
        if w["published"]: reasons.append(f"{w['published']} published dashboard(s)")
        if w["sources"] > 5: reasons.append(f"{w['sources']} sources")
        pql.append({"workspace_id": w["id"], "name": w["name"], "owner_email": mask_email(w["owner_email"], staff),
                    "fit": w["fit"], "members": w["members"], "chats_30d": w["chats_30d"], "reasons": reasons or ["usage fits a team plan"],
                    "domain": M.domain_of(w["owner_email"]) if M.is_corporate(w["owner_email"]) else None})
    pql.sort(key=lambda x: (-["Plus", "Team", "Business", "Enterprise"].index(x["fit"]), -x["chats_30d"]))
    return {"stages": [{"key": k, "label": l, "probability": p} for k, l, p in STAGES], "columns": cols, "stats": stats,
            "leads": leads, "pql": pql[:60],
            "reps": [{"owner": k, **{kk: round(vv) for kk, vv in v.items()}} for k, v in sorted(reps.items(), key=lambda kv: -kv[1]["best"])]}


class DealIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    company: str | None = None
    domain: str | None = None
    contact_name: str | None = None
    contact_email: str | None = None
    stage: str = "new"
    amount: float | None = Field(default=None, ge=0)
    seats: int | None = Field(default=None, ge=0)
    owner_email: str | None = None
    close_date: datetime | None = None
    next_step: str | None = None
    source: str | None = "manual"


@router.post("/crm/deals")
def create_deal(body: DealIn, request: Request, staff: Staff = Depends(require("crm.write")), db: Session = Depends(get_db)):
    if body.stage not in PROB:
        raise HTTPException(400, "Unknown stage.")
    data = body.model_dump()
    data["owner_email"] = body.owner_email or staff.email
    d = models.CrmDeal(**data)
    if not d.domain and d.contact_email and M.is_corporate(d.contact_email):
        d.domain = M.domain_of(d.contact_email)
    db.add(d)
    db.flush()
    db.add(models.CrmActivity(deal_id=d.id, kind="stage", body=f"Deal created in {d.stage}", staff_email=staff.email))
    log_admin(db, staff, "crm.deal_create", target_type="deal", target_id=d.id, summary=f"Created deal {d.name}", request=request)
    db.commit()
    return _deal_out(d, staff)


class DealPatch(BaseModel):
    name: str | None = None
    stage: str | None = None
    amount: float | None = Field(default=None, ge=0)
    seats: int | None = Field(default=None, ge=0)
    owner_email: str | None = None
    close_date: datetime | None = None
    next_step: str | None = None
    lost_reason: str | None = None


@router.patch("/crm/deals/{deal_id}")
def update_deal(deal_id: str, body: DealPatch, request: Request, staff: Staff = Depends(require("crm.write")), db: Session = Depends(get_db)):
    d = db.get(models.CrmDeal, deal_id)
    if not d:
        raise HTTPException(404, "Deal not found.")
    data = body.model_dump(exclude_unset=True)
    if "stage" in data and data["stage"] not in PROB:
        raise HTTPException(400, "Unknown stage.")
    if data.get("stage") == "lost" and not (data.get("lost_reason") or d.lost_reason):
        raise HTTPException(400, "Say why it was lost.")
    old_stage = d.stage
    for k, v in data.items():
        setattr(d, k, v)
    d.updated_at = datetime.utcnow()
    if "stage" in data and data["stage"] != old_stage:
        db.add(models.CrmActivity(deal_id=d.id, kind="stage", body=f"{old_stage} → {d.stage}" + (f" ({d.lost_reason})" if d.stage == "lost" else ""), staff_email=staff.email))
    log_admin(db, staff, "crm.deal_update", target_type="deal", target_id=d.id, summary=f"Updated {d.name}: {', '.join(data)}", request=request)
    db.commit()
    return _deal_out(d, staff)


@router.get("/crm/deals/{deal_id}")
def deal_detail(deal_id: str, staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    d = db.get(models.CrmDeal, deal_id)
    if not d:
        raise HTTPException(404, "Deal not found.")
    acts = db.query(models.CrmActivity).filter(models.CrmActivity.deal_id == deal_id).order_by(models.CrmActivity.created_at.desc()).all()
    return {"deal": _deal_out(d, staff), "activities": [{"id": a.id, "kind": a.kind, "body": a.body, "by": a.staff_email, "t": _iso(a.created_at)} for a in acts]}


class ActivityIn(BaseModel):
    kind: str = Field(default="note", pattern="^(note|call|email|meeting)$")
    body: str = Field(min_length=1, max_length=4000)


@router.post("/crm/deals/{deal_id}/activities")
def add_activity(deal_id: str, body: ActivityIn, request: Request, staff: Staff = Depends(require("crm.write")), db: Session = Depends(get_db)):
    d = db.get(models.CrmDeal, deal_id)
    if not d:
        raise HTTPException(404, "Deal not found.")
    db.add(models.CrmActivity(deal_id=deal_id, kind=body.kind, body=body.body, staff_email=staff.email))
    d.updated_at = datetime.utcnow()
    log_admin(db, staff, "crm.activity", target_type="deal", target_id=deal_id, summary=f"Logged a {body.kind} on {d.name}", request=request)
    db.commit()
    return {"ok": True}


class LeadPatch(BaseModel):
    status: str | None = Field(default=None, pattern="^(new|contacted|qualified|closed)$")
    owner_email: str | None = None
    notes: str | None = Field(default=None, max_length=4000)


@router.patch("/crm/leads/{lead_id}")
def update_lead(lead_id: str, body: LeadPatch, request: Request, staff: Staff = Depends(require("crm.write")), db: Session = Depends(get_db)):
    r = db.get(models.DemoRequest, lead_id)
    if not r:
        raise HTTPException(404, "Lead not found.")
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(r, k, v)
    if data.get("status") and data["status"] != "new":
        db.add(models.CrmActivity(demo_request_id=r.id, kind="note", body=f"Status → {data['status']}", staff_email=staff.email))
    if data.get("notes"):
        db.add(models.CrmActivity(demo_request_id=r.id, kind="note", body=data["notes"], staff_email=staff.email))
    log_admin(db, staff, "crm.lead_update", target_type="lead", target_id=r.id, summary=f"Updated lead {r.company or r.name}: {', '.join(data)}", request=request)
    db.commit()
    return {"ok": True}


class ConvertIn(BaseModel):
    amount: float | None = Field(default=None, ge=0)
    seats: int | None = Field(default=None, ge=0)


@router.post("/crm/leads/{lead_id}/convert")
def convert_lead(lead_id: str, body: ConvertIn, request: Request, staff: Staff = Depends(require("crm.write")), db: Session = Depends(get_db)):
    r = db.get(models.DemoRequest, lead_id)
    if not r:
        raise HTTPException(404, "Lead not found.")
    if r.deal_id and db.get(models.CrmDeal, r.deal_id):
        return {"deal_id": r.deal_id}
    d = models.CrmDeal(name=f"{r.company or r.name} — Enterprise", company=r.company, contact_name=r.name, contact_email=r.email,
                       domain=M.domain_of(r.email) if M.is_corporate(r.email) else None, stage="qualified",
                       amount=body.amount, seats=body.seats, owner_email=r.owner_email or staff.email, source="demo_request",
                       demo_request_id=r.id, next_step="Book the demo")
    db.add(d)
    db.flush()
    r.deal_id, r.status = d.id, "qualified"
    db.add(models.CrmActivity(deal_id=d.id, kind="stage", body="Created from a demo request", staff_email=staff.email))
    db.add(models.CrmActivity(demo_request_id=r.id, kind="note", body="Converted to a deal", staff_email=staff.email))
    log_admin(db, staff, "crm.lead_convert", target_type="lead", target_id=r.id, summary=f"Converted {r.company or r.name} to a deal", request=request)
    db.commit()
    return {"deal_id": d.id}


# ==================================================================== support
def _next_number(db: Session) -> int:
    return (db.query(func.max(models.SupportTicket.number)).scalar() or 1000) + 1


def _ticket_out(t: models.SupportTicket, staff: Staff, now: datetime) -> dict:
    due = t.first_response_due_at if not t.first_responded_at else t.resolution_due_at
    mins = int((due - now).total_seconds() // 60) if (due and t.status in ("open", "pending")) else None
    return {"id": t.id, "number": t.number, "subject": t.subject, "requester_email": mask_email(t.requester_email, staff),
            "channel": t.channel, "priority": t.priority, "status": t.status, "assignee_email": t.assignee_email,
            "tags": t.tags or [], "related_type": t.related_type, "created_at": _iso(t.created_at), "updated_at": _iso(t.updated_at),
            "first_responded_at": _iso(t.first_responded_at), "solved_at": _iso(t.solved_at), "csat": t.csat,
            "sla_minutes_left": mins, "sla_kind": "first response" if not t.first_responded_at else "resolution"}


def create_ticket(db: Session, *, subject: str, body: str, requester_email: str | None, priority: str = "P3",
                  channel: str = "email", author_kind: str = "customer", related=(None, None), tags=None,
                  requester_user_id: str | None = None) -> models.SupportTicket:
    now = datetime.utcnow()
    t = models.SupportTicket(number=_next_number(db), subject=subject[:200], requester_email=(requester_email or "").lower() or None,
                             requester_user_id=requester_user_id, channel=channel, priority=priority, tags=tags or [],
                             related_type=related[0], related_id=related[1],
                             first_response_due_at=now + timedelta(hours=SLA_FIRST[priority]),
                             resolution_due_at=now + timedelta(hours=SLA_RESOLVE[priority]))
    db.add(t)
    db.flush()
    db.add(models.SupportMessage(ticket_id=t.id, author_kind=author_kind, author_email=requester_email, body=body))
    return t


@router.get("/support")
def support_list(view: str = Query("open", pattern="^(open|mine|unassigned|breaching|auto|solved|all)$"), q: str = "",
                 staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    allt = db.query(models.SupportTicket).order_by(models.SupportTicket.created_at.desc()).all()
    open_t = [t for t in allt if t.status in ("open", "pending")]

    def breaching(t):
        due = t.first_response_due_at if not t.first_responded_at else t.resolution_due_at
        return t.status in ("open", "pending") and due is not None and due <= now + timedelta(hours=1)

    pick = {
        "open": open_t, "mine": [t for t in open_t if t.assignee_email == staff.email],
        "unassigned": [t for t in open_t if not t.assignee_email], "breaching": [t for t in open_t if breaching(t)],
        "auto": [t for t in open_t if t.channel == "auto"], "solved": [t for t in allt if t.status in ("solved", "closed")], "all": allt,
    }[view]
    ql = q.lower().strip()
    if ql:
        pick = [t for t in pick if ql in (t.subject or "").lower() or ql in (t.requester_email or "").lower() or ql == str(t.number)]
    order = {"P1": 0, "P2": 1, "P3": 2, "P4": 3}
    pick.sort(key=lambda t: (order.get(t.priority, 9), t.created_at))
    solved30 = [t for t in allt if t.solved_at and t.solved_at >= now - timedelta(days=30)]
    frt = [(t.first_responded_at - t.created_at).total_seconds() / 60 for t in allt if t.first_responded_at and t.created_at >= now - timedelta(days=30)]
    res = [(t.solved_at - t.created_at).total_seconds() / 60 for t in solved30]
    due_30 = [t for t in allt if t.created_at >= now - timedelta(days=30) and t.first_response_due_at]
    met = [t for t in due_30 if t.first_responded_at and t.first_responded_at <= t.first_response_due_at]
    csats = [t.csat for t in solved30 if t.csat]
    stats = {
        "open": len(open_t), "by_priority": {p: sum(1 for t in open_t if t.priority == p) for p in order},
        "first_response_median_min": round(statistics.median(frt)) if frt else None,
        "resolution_median_min": round(statistics.median(res)) if res else None,
        "sla_pct": round(len(met) / len(due_30) * 100, 1) if due_30 else None,
        "csat": round(sum(csats) / len(csats), 2) if csats else None, "csat_n": len(csats),
        "counts": {k: len(v) for k, v in {"open": open_t, "mine": [t for t in open_t if t.assignee_email == staff.email],
                                            "unassigned": [t for t in open_t if not t.assignee_email],
                                            "breaching": [t for t in open_t if breaching(t)],
                                            "auto": [t for t in open_t if t.channel == "auto"]}.items()},
    }
    return {"stats": stats, "tickets": [_ticket_out(t, staff, now) for t in pick[:300]]}


class TicketIn(BaseModel):
    subject: str = Field(min_length=3, max_length=200)
    requester_email: str = Field(min_length=3, max_length=200)
    body: str = Field(min_length=1, max_length=8000)
    priority: str = Field(default="P3", pattern="^P[1-4]$")
    channel: str = Field(default="email", pattern="^(email|phone|in_app|chat)$")


@router.post("/support/tickets")
def new_ticket(body: TicketIn, request: Request, staff: Staff = Depends(require("tickets.write")), db: Session = Depends(get_db)):
    u = db.query(models.User).filter(func.lower(models.User.email) == body.requester_email.lower()).first()
    t = create_ticket(db, subject=body.subject, body=body.body, requester_email=body.requester_email, priority=body.priority,
                      channel=body.channel, requester_user_id=u.id if u else None)
    t.assignee_email = staff.email
    log_admin(db, staff, "ticket.create", target_type="ticket", target_id=t.id, summary=f"Opened #{t.number} for {body.requester_email}", request=request)
    db.commit()
    return {"id": t.id, "number": t.number}


def _context_for(db: Session, t: models.SupportTicket, staff: Staff) -> dict:
    u = None
    if t.requester_user_id:
        u = db.get(models.User, t.requester_user_id)
    if not u and t.requester_email:
        u = db.query(models.User).filter(func.lower(models.User.email) == t.requester_email.lower()).first()
    if not u:
        return {"user": None, "signals": []}
    rows = M.user_rows(db)
    r = next((x for x in rows if x["id"] == u.id), None)
    acct = next((a for a in M.account_rows(db, rows) if a["key"] == M.account_key_for(u)), None)
    signals = []
    for s in db.query(models.DataSource).filter(models.DataSource.owner_id == u.id, models.DataSource.sync_error.isnot(None)).all():
        signals.append(f"Source “{s.name}” ({s.kind}) failing: {s.sync_error[:160]}")
    for j in (db.query(models.JobRun).filter(models.JobRun.owner_id == u.id, models.JobRun.status.in_(("failed", "error")))
              .order_by(models.JobRun.started_at.desc()).limit(3).all()):
        signals.append(f"Refresh “{j.target_label or 'dashboard'}” failed {j.started_at:%d %b %H:%M}: {(j.error_message or '')[:140]}")
    for a in (db.query(models.AutomationRun).filter(models.AutomationRun.owner_id == u.id, models.AutomationRun.status.in_(("failed", "error")))
              .order_by(models.AutomationRun.started_at.desc()).limit(3).all()):
        signals.append(f"Automation “{a.automation_name}” failed {a.started_at:%d %b %H:%M}: {(a.error_message or '')[:140]}")
    for p in (db.query(models.PipelineRun).filter(models.PipelineRun.owner_id == u.id, models.PipelineRun.status.in_(("failed", "error")))
              .order_by(models.PipelineRun.started_at.desc()).limit(2).all()):
        signals.append(f"Pipeline “{p.pipeline_name}” failed {p.started_at:%d %b %H:%M}: {(p.error_message or '')[:140]}")
    return {
        "user": {"id": u.id, "email": mask_email(u.email, staff), "name": u.full_name, "status": r["status"] if r else None,
                 "chats_30d": r["chats_30d"] if r else 0, "sources": r["sources"] if r else 0, "lifecycle": r["lifecycle"] if r else None},
        "account": {"key": acct["key"], "name": acct["name"], "users": acct["users"], "health": acct["health"],
                    "band": acct["health_band"], "plan": acct["plan"], "fit": acct["fit"]} if acct else None,
        "signals": signals,
    }


@router.get("/support/tickets/{ticket_id}")
def ticket_detail(ticket_id: str, staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    t = db.get(models.SupportTicket, ticket_id)
    if not t:
        raise HTTPException(404, "Ticket not found.")
    msgs = db.query(models.SupportMessage).filter(models.SupportMessage.ticket_id == t.id).order_by(models.SupportMessage.created_at).all()
    return {"ticket": _ticket_out(t, staff, datetime.utcnow()),
            "messages": [{"id": m.id, "kind": m.author_kind, "author": mask_email(m.author_email, staff), "body": m.body, "t": _iso(m.created_at)} for m in msgs],
            "context": _context_for(db, t, staff)}


class TicketPatch(BaseModel):
    status: str | None = Field(default=None, pattern="^(open|pending|solved|closed)$")
    priority: str | None = Field(default=None, pattern="^P[1-4]$")
    assignee_email: str | None = None
    csat: int | None = Field(default=None, ge=1, le=5)


@router.patch("/support/tickets/{ticket_id}")
def update_ticket(ticket_id: str, body: TicketPatch, request: Request, staff: Staff = Depends(require("tickets.write")), db: Session = Depends(get_db)):
    t = db.get(models.SupportTicket, ticket_id)
    if not t:
        raise HTTPException(404, "Ticket not found.")
    data = body.model_dump(exclude_unset=True)
    now = datetime.utcnow()
    if "priority" in data and data["priority"] != t.priority:
        t.first_response_due_at = t.created_at + timedelta(hours=SLA_FIRST[data["priority"]])
        t.resolution_due_at = t.created_at + timedelta(hours=SLA_RESOLVE[data["priority"]])
    for k, v in data.items():
        setattr(t, k, v)
    if data.get("status") in ("solved", "closed") and not t.solved_at:
        t.solved_at = now
    if data.get("status") in ("open", "pending"):
        t.solved_at = None
    t.updated_at = now
    db.add(models.SupportMessage(ticket_id=t.id, author_kind="system", author_email=staff.email,
                                 body="; ".join(f"{k} → {v}" for k, v in data.items())))
    log_admin(db, staff, "ticket.update", target_type="ticket", target_id=t.id, summary=f"#{t.number}: {', '.join(f'{k}={v}' for k, v in data.items())}", request=request)
    db.commit()
    return _ticket_out(t, staff, now)


class ReplyIn(BaseModel):
    body: str = Field(min_length=1, max_length=8000)
    internal: bool = False


@router.post("/support/tickets/{ticket_id}/messages")
def reply(ticket_id: str, body: ReplyIn, request: Request, staff: Staff = Depends(require("tickets.write")), db: Session = Depends(get_db)):
    t = db.get(models.SupportTicket, ticket_id)
    if not t:
        raise HTTPException(404, "Ticket not found.")
    now = datetime.utcnow()
    db.add(models.SupportMessage(ticket_id=t.id, author_kind="internal" if body.internal else "staff", author_email=staff.email, body=body.body))
    if not body.internal:
        if not t.first_responded_at:
            t.first_responded_at = now
        if t.status == "open":
            t.status = "pending"
    if not t.assignee_email:
        t.assignee_email = staff.email
    t.updated_at = now
    log_admin(db, staff, "ticket.reply" if not body.internal else "ticket.note", target_type="ticket", target_id=t.id,
              summary=f"{'Replied on' if not body.internal else 'Internal note on'} #{t.number}", request=request)
    db.commit()
    return {"ok": True}


@router.post("/support/tickets/{ticket_id}/draft")
def draft_reply(ticket_id: str, staff: Staff = Depends(require("tickets.write")), db: Session = Depends(get_db)):
    from ..services import ai_engine
    t = db.get(models.SupportTicket, ticket_id)
    if not t:
        raise HTTPException(404, "Ticket not found.")
    msgs = db.query(models.SupportMessage).filter(models.SupportMessage.ticket_id == t.id).order_by(models.SupportMessage.created_at).all()
    ctx = _context_for(db, t, staff)
    thread = "\n".join(f"[{m.author_kind}] {m.body}" for m in msgs if m.author_kind != "system")
    messages = [
        {"role": "system", "content": (
            "You write support replies for GD360, an AI data analytics product. Write the reply the support agent will send: "
            "warm, short (under 120 words), specific. Use the workspace signals to explain the likely cause and the exact fix. "
            "Never invent facts, refunds, dates or promises. No sign-off name. Plain text.")},
        {"role": "user", "content": f"Ticket #{t.number}: {t.subject}\nThread:\n{thread}\n\nSignals from their workspace:\n" +
            ("\n".join(ctx["signals"]) or "none") + "\n\nWrite the reply."},
    ]
    try:
        text = ai_engine._call_llm(messages, max_tokens=500)
    except Exception as exc:
        raise HTTPException(503, f"Couldn't draft a reply right now ({str(exc)[:100]}).")
    return {"draft": text.strip()}


@router.post("/support/scan")
def scan_for_auto_tickets(request: Request, staff: Staff = Depends(require("tickets.write")), db: Session = Depends(get_db)):
    """Open a ticket for each failing connector or automation that doesn't have one yet."""
    existing = {(t.related_type, t.related_id) for t in db.query(models.SupportTicket).filter(
        models.SupportTicket.channel == "auto", models.SupportTicket.status.in_(("open", "pending"))).all()}
    users = {u.id: u for u in db.query(models.User).all()}
    created = 0
    for s in db.query(models.DataSource).filter(models.DataSource.sync_error.isnot(None)).all():
        if ("datasource", s.id) in existing:
            continue
        u = users.get(s.owner_id)
        pr = "P2" if (u and M.is_corporate(u.email)) else "P3"
        create_ticket(db, subject=f"{s.kind} source “{s.name}” is failing to sync", body=f"Auto-ticket from system health.\nError: {s.sync_error}",
                      requester_email=u.email if u else None, requester_user_id=u.id if u else None, priority=pr, channel="auto",
                      author_kind="system", related=("datasource", s.id), tags=["connector"])
        created += 1
    for a in db.query(models.Automation).filter(models.Automation.enabled.is_(True), models.Automation.last_status.in_(("failed", "error"))).all():
        if ("automation", a.id) in existing:
            continue
        u = users.get(a.owner_id)
        create_ticket(db, subject=f"Automation “{a.name}” failed on its last run", body="Auto-ticket from system health.",
                      requester_email=u.email if u else None, requester_user_id=u.id if u else None, priority="P3", channel="auto",
                      author_kind="system", related=("automation", a.id), tags=["automation"])
        created += 1
    log_admin(db, staff, "ticket.scan", summary=f"Scanned for problems: {created} auto-ticket(s) opened", request=request)
    db.commit()
    return {"created": created}


# ===================================================================== health
_FAILED = ("failed", "error")


@router.get("/health")
def system_health(staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    day = now - timedelta(days=1)
    runs = []
    for key, label, model, name_col in (("dashboard", "Dashboard refreshes", models.JobRun, "target_label"),
                                        ("pipeline", "Pipelines", models.PipelineRun, "pipeline_name"),
                                        ("automation", "Automations", models.AutomationRun, "automation_name"),
                                        ("project", "Project runs", models.ProjectRun, "question")):
        rs = db.query(model).filter(model.started_at >= day).all()
        hours = []
        for h in range(23, -1, -1):
            lo, hi = now - timedelta(hours=h + 1), now - timedelta(hours=h)
            inb = [r for r in rs if r.started_at and lo <= r.started_at < hi]
            hours.append({"total": len(inb), "failed": sum(1 for r in inb if r.status in _FAILED)})
        failed = sum(1 for r in rs if r.status in _FAILED)
        runs.append({"key": key, "label": label, "total": len(rs), "failed": failed,
                     "success": round((1 - failed / len(rs)) * 100, 1) if rs else None, "hours": hours})

    users = {u.id: u for u in db.query(models.User).all()}
    failing = db.query(models.DataSource).filter(models.DataSource.sync_error.isnot(None)).all()
    by_kind = defaultdict(int)
    for s in failing:
        by_kind[s.kind] += 1

    failures = []
    for s in failing:
        u = users.get(s.owner_id)
        failures.append({"kind": "source", "id": s.id, "what": f"{s.kind} sync · {s.name}", "who": mask_email(u.email if u else None, staff),
                         "error": (s.sync_error or "")[:240], "since": _iso(s.last_synced_at or s.created_at), "retry": True})
    for j in db.query(models.JobRun).filter(models.JobRun.status.in_(_FAILED), models.JobRun.started_at >= now - timedelta(days=3)).order_by(models.JobRun.started_at.desc()).limit(15).all():
        u = users.get(j.owner_id)
        failures.append({"kind": "dashboard", "id": j.dashboard_id, "what": f"Refresh · {j.target_label or 'dashboard'}", "who": mask_email(u.email if u else None, staff),
                         "error": (j.error_message or "")[:240], "since": _iso(j.started_at), "retry": bool(j.dashboard_id)})
    for a in db.query(models.AutomationRun).filter(models.AutomationRun.status.in_(_FAILED), models.AutomationRun.started_at >= now - timedelta(days=3)).order_by(models.AutomationRun.started_at.desc()).limit(15).all():
        u = users.get(a.owner_id)
        failures.append({"kind": "automation", "id": a.automation_id, "what": f"Automation · {a.automation_name}", "who": mask_email(u.email if u else None, staff),
                         "error": (a.error_message or "")[:240], "since": _iso(a.started_at), "retry": bool(a.automation_id)})
    for p in db.query(models.PipelineRun).filter(models.PipelineRun.status.in_(_FAILED), models.PipelineRun.started_at >= now - timedelta(days=3)).order_by(models.PipelineRun.started_at.desc()).limit(10).all():
        u = users.get(p.owner_id)
        failures.append({"kind": "pipeline", "id": p.pipeline_id, "what": f"Pipeline · {p.pipeline_name}", "who": mask_email(u.email if u else None, staff),
                         "error": (p.error_message or "")[:240], "since": _iso(p.started_at), "retry": bool(p.pipeline_id)})
    for m in db.query(models.MLModel).filter(models.MLModel.status == "failed").order_by(models.MLModel.created_at.desc()).limit(10).all():
        u = users.get(m.owner_id)
        failures.append({"kind": "ml", "id": m.id, "what": f"ML training · {m.name}", "who": mask_email(u.email if u else None, staff),
                         "error": (m.error_message or "")[:240], "since": _iso(m.trained_at or m.created_at), "retry": False})
    failures.sort(key=lambda f: f["since"] or "", reverse=True)

    wh = []
    for prov, n, err, by in (db.query(models.PushdownQueryLog.provider, func.count(models.PushdownQueryLog.id),
                                      func.sum(case((models.PushdownQueryLog.status != "ok", 1), else_=0)),
                                      func.coalesce(func.sum(models.PushdownQueryLog.bytes_scanned), 0))
                             .filter(models.PushdownQueryLog.created_at >= day).group_by(models.PushdownQueryLog.provider).all()):
        wh.append({"provider": prov, "queries": n, "errors": int(err or 0), "bytes": int(by or 0)})

    def size(col, model):
        try:
            return int(db.query(func.coalesce(func.sum(func.length(col)), 0)).select_from(model).scalar() or 0)
        except Exception:
            db.rollback()
            return None

    storage = [
        {"k": "Dataset versions", "bytes": size(models.DatasetVersion.data, models.DatasetVersion)},
        {"k": "Uploaded files", "bytes": size(models.DataSource.file_data, models.DataSource)},
        {"k": "Synced app tables", "bytes": size(models.SyncedTable.parquet_data, models.SyncedTable)},
        {"k": "ML artifacts", "bytes": size(models.MLModel.model_artifact, models.MLModel)},
    ]
    quality_failing = db.query(func.count(models.DataQualityRule.id)).filter(models.DataQualityRule.last_status == "fail").scalar() or 0
    domains_pending = db.query(func.count(models.DashboardShare.id)).filter(models.DashboardShare.custom_domain.isnot(None),
                                                                           models.DashboardShare.custom_domain_status != "active").scalar() or 0
    incidents = db.query(models.Incident).order_by(models.Incident.started_at.desc()).limit(10).all()
    return {
        "runs": runs, "failing_by_kind": [{"kind": k, "n": n} for k, n in sorted(by_kind.items(), key=lambda kv: -kv[1])],
        "failing_sources": len(failing), "failures": failures[:40], "warehouse": wh, "storage": storage,
        "quality_failing": quality_failing, "domains_pending": domains_pending,
        "ml_failed": db.query(func.count(models.MLModel.id)).filter(models.MLModel.status == "failed").scalar() or 0,
        "incidents": [{"id": i.id, "title": i.title, "severity": i.severity, "status": i.status, "owner_email": i.owner_email,
                       "updates": i.updates or [], "started_at": _iso(i.started_at), "resolved_at": _iso(i.resolved_at)} for i in incidents],
        "generated_at": _iso(now),
    }


class RetryIn(BaseModel):
    kind: str = Field(pattern="^(source|dashboard|automation|pipeline)$")
    id: str


@router.post("/health/retry")
def retry(body: RetryIn, request: Request, staff: Staff = Depends(require("health.write")), db: Session = Depends(get_db)):
    """Queue a re-run now: the in-process scheduler picks it up within a minute."""
    now = datetime.utcnow()
    if body.kind == "source":
        o = db.get(models.DataSource, body.id)
        if o:
            o.next_sync_at = now
    elif body.kind == "dashboard":
        o = db.get(models.Dashboard, body.id)
        if o:
            o.next_refresh_at = now
    elif body.kind == "automation":
        o = db.get(models.Automation, body.id)
        if o:
            o.next_run_at = now
    else:
        o = db.get(models.Pipeline, body.id)
        if o:
            o.next_run_at = now
    if not o:
        raise HTTPException(404, "Nothing to retry with that id.")
    log_admin(db, staff, "health.retry", target_type=body.kind, target_id=body.id, summary=f"Queued a re-run of {body.kind} {getattr(o, 'name', body.id)}", request=request)
    db.commit()
    return {"queued": True}


class IncidentIn(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    severity: str = Field(default="SEV-3", pattern="^SEV-[1-4]$")
    update: str | None = None


@router.post("/incidents")
def open_incident(body: IncidentIn, request: Request, staff: Staff = Depends(require("health.write")), db: Session = Depends(get_db)):
    i = models.Incident(title=body.title, severity=body.severity, owner_email=staff.email,
                        updates=[{"t": _iso(datetime.utcnow()), "by": staff.email, "text": body.update or "Incident opened."}])
    db.add(i)
    log_admin(db, staff, "incident.open", target_type="incident", summary=f"{body.severity}: {body.title}", request=request)
    db.commit()
    return {"id": i.id}


class IncidentPatch(BaseModel):
    status: str | None = Field(default=None, pattern="^(open|resolved)$")
    update: str | None = Field(default=None, max_length=2000)


@router.patch("/incidents/{incident_id}")
def update_incident(incident_id: str, body: IncidentPatch, request: Request, staff: Staff = Depends(require("health.write")), db: Session = Depends(get_db)):
    i = db.get(models.Incident, incident_id)
    if not i:
        raise HTTPException(404, "Incident not found.")
    ups = list(i.updates or [])
    if body.update:
        ups.append({"t": _iso(datetime.utcnow()), "by": staff.email, "text": body.update})
    if body.status:
        i.status = body.status
        i.resolved_at = datetime.utcnow() if body.status == "resolved" else None
        ups.append({"t": _iso(datetime.utcnow()), "by": staff.email, "text": f"Marked {body.status}."})
    i.updates = ups
    log_admin(db, staff, "incident.update", target_type="incident", target_id=i.id, summary=f"{i.title}: {body.status or 'update'}", request=request)
    db.commit()
    return {"ok": True}


# ================================================================ trust
@router.get("/trust")
def trust(staff: Staff = Depends(require("metrics.read")), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    users = db.query(models.User).all()
    locked = [u for u in users if u.locked_until and u.locked_until > now]
    suspended = [u for u in users if getattr(u, "disabled_at", None)]
    failed = sum(u.failed_login_attempts or 0 for u in users)
    logins_24h = db.query(func.count(models.AuditEvent.id)).filter(models.AuditEvent.action == "login", models.AuditEvent.created_at >= now - timedelta(days=1)).scalar() or 0

    roles = defaultdict(int)
    for (r,) in db.query(models.WorkspaceMember.role).all():
        roles[r] += 1
    team_ws = db.query(models.Workspace).filter(models.Workspace.is_personal.is_(False)).all()
    members_by_ws = defaultdict(list)
    for m in db.query(models.WorkspaceMember).all():
        members_by_ws[m.workspace_id].append(m)
    by_id = {u.id: u for u in users}
    single_owner = sum(1 for w in team_ws if len(members_by_ws[w.id]) > 1 and sum(1 for m in members_by_ws[w.id] if m.role == "owner") <= 1)
    outside = 0
    for w in team_ws:
        owner = by_id.get(w.owner_id)
        od = M.domain_of(owner.email) if owner and M.is_corporate(owner.email) else None
        if not od:
            continue
        outside += sum(1 for m in members_by_ws[w.id] if by_id.get(m.user_id) and M.domain_of(by_id[m.user_id].email) != od)
    publics = db.query(func.count(models.DashboardShare.id)).filter(models.DashboardShare.mode == "public",
                                                                    models.DashboardShare.published_at.isnot(None)).scalar() or 0

    disposable = [u for u in users if M.domain_of(u.email) in M.DISPOSABLE]
    per_day = defaultdict(int)
    for u in users:
        if u.created_at and u.created_at >= now - timedelta(days=30):
            per_day[u.created_at.date()] += 1
    med = statistics.median(per_day.values()) if per_day else 0
    bursts = sorted([(d, n) for d, n in per_day.items() if med and n >= 3 * med and n >= 5], reverse=True)
    month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    heavy = (db.query(models.AICall.user_id, func.sum(models.AICall.cost_usd)).filter(models.AICall.created_at >= month)
             .group_by(models.AICall.user_id).having(func.sum(models.AICall.cost_usd) > 5).all())
    reqs = db.query(models.PrivacyRequest).order_by(models.PrivacyRequest.received_at.desc()).limit(50).all()
    return {
        "posture": {"locked": len(locked), "suspended": len(suspended), "failed_logins_pending": failed, "logins_24h": logins_24h,
                    "public_dashboards": publics, "staff": db.query(func.count(models.StaffMember.id)).scalar() or 0},
        "roles": [{"role": k, "n": v} for k, v in sorted(roles.items(), key=lambda kv: -kv[1])],
        "risks": [
            {"k": "Team workspaces with only one owner", "n": single_owner},
            {"k": "Members from outside the workspace owner's company", "n": outside},
            {"k": "Dashboards shared publicly (anyone with the link)", "n": publics},
            {"k": "Accounts suspended", "n": len(suspended)},
        ],
        "abuse": [
            {"key": "disposable", "k": "Sign-ups from disposable email domains", "n": len(disposable),
             "sample": [mask_email(u.email, staff) for u in disposable[:5]]},
            {"key": "bursts", "k": "Days with a sign-up burst (3× the 30-day median)", "n": len(bursts),
             "sample": [f"{d:%d %b}: {n} sign-ups" for d, n in bursts[:5]]},
            {"key": "heavy_ai", "k": "People over $5 of AI this month", "n": len(heavy),
             "sample": [f"{mask_email(by_id[u].email if u in by_id else u, staff)}: ${c:,.2f}" for u, c in heavy[:5]]},
        ],
        "privacy": [{"id": r.id, "email": mask_email(r.email, staff), "kind": r.kind, "status": r.status, "notes": r.notes,
                     "handled_by": r.handled_by, "received_at": _iso(r.received_at), "due_at": _iso(r.due_at),
                     "completed_at": _iso(r.completed_at), "user_found": bool(r.user_id),
                     "days_left": (r.due_at - now).days if r.due_at and r.status not in ("completed", "rejected") else None} for r in reqs],
        "locked_people": [{"id": u.id, "email": mask_email(u.email, staff), "until": _iso(u.locked_until)} for u in locked[:20]],
    }


class PrivacyIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    kind: str = Field(pattern="^(export|delete|correct)$")
    notes: str | None = Field(default=None, max_length=2000)


@router.post("/privacy-requests")
def log_privacy(body: PrivacyIn, request: Request, staff: Staff = Depends(require("privacy.write")), db: Session = Depends(get_db)):
    u = db.query(models.User).filter(func.lower(models.User.email) == body.email.lower().strip()).first()
    now = datetime.utcnow()
    r = models.PrivacyRequest(email=body.email.lower().strip(), user_id=u.id if u else None, kind=body.kind, notes=body.notes,
                              received_at=now, due_at=now + timedelta(days=30))
    db.add(r)
    log_admin(db, staff, "privacy.log", target_type="privacy", summary=f"Logged a {body.kind} request for {body.email}", request=request)
    db.commit()
    return {"id": r.id}


class PrivacyPatch(BaseModel):
    status: str = Field(pattern="^(received|in_review|completed|rejected)$")
    notes: str | None = Field(default=None, max_length=2000)


@router.patch("/privacy-requests/{req_id}")
def update_privacy(req_id: str, body: PrivacyPatch, request: Request, staff: Staff = Depends(current_staff), db: Session = Depends(get_db)):
    need = "privacy.execute" if body.status in ("completed", "rejected") else "privacy.write"
    if not staff.can(need):
        raise HTTPException(403, "Only the Security officer or an Owner can complete or reject a privacy request.")
    r = db.get(models.PrivacyRequest, req_id)
    if not r:
        raise HTTPException(404, "Request not found.")
    r.status = body.status
    if body.notes:
        r.notes = ((r.notes or "") + f"\n[{datetime.utcnow():%d %b} {staff.email}] {body.notes}").strip()
    r.handled_by = staff.email
    r.completed_at = datetime.utcnow() if body.status in ("completed", "rejected") else None
    log_admin(db, staff, "privacy.update", target_type="privacy", target_id=r.id, summary=f"{r.kind} request for {r.email} → {body.status}", request=request)
    db.commit()
    return {"ok": True}


@router.get("/privacy-requests/{req_id}/export")
def export_user_data(req_id: str, request: Request, staff: Staff = Depends(require("privacy.execute")), db: Session = Depends(get_db)):
    """Everything GD360 holds about the person, as JSON (no secrets or credentials)."""
    r = db.get(models.PrivacyRequest, req_id)
    if not r or not r.user_id:
        raise HTTPException(404, "No account matches this request's email.")
    u = db.get(models.User, r.user_id)
    convs = db.query(models.Conversation).filter(models.Conversation.owner_id == u.id).all()
    data = {
        "exported_at": _iso(datetime.utcnow()),
        "profile": {"email": u.email, "name": u.full_name, "company": u.company, "created_at": _iso(u.created_at)},
        "workspaces": [{"name": w.name, "role": m.role} for m, w in db.query(models.WorkspaceMember, models.Workspace)
                       .join(models.Workspace, models.Workspace.id == models.WorkspaceMember.workspace_id)
                       .filter(models.WorkspaceMember.user_id == u.id).all()],
        "data_sources": [{"name": s.name, "kind": s.kind, "created_at": _iso(s.created_at)} for s in
                         db.query(models.DataSource).filter(models.DataSource.owner_id == u.id).all()],
        "dashboards": [{"name": d.name, "created_at": _iso(d.created_at)} for d in db.query(models.Dashboard).filter(models.Dashboard.owner_id == u.id).all()],
        "conversations": [{"title": c.title, "created_at": _iso(c.created_at),
                           "messages": [{"role": m.role, "content": m.content, "created_at": _iso(m.created_at)}
                                        for m in db.query(models.Message).filter(models.Message.conversation_id == c.id).order_by(models.Message.created_at).all()]}
                          for c in convs],
        "activity": [{"action": e.action, "at": _iso(e.created_at)} for e in db.query(models.AuditEvent).filter(models.AuditEvent.actor_user_id == u.id).all()],
    }
    log_admin(db, staff, "privacy.export", target_type="privacy", target_id=r.id, summary=f"Exported data for {u.email}", request=request)
    db.commit()
    return Response(content=json.dumps(data, indent=2, default=str), media_type="application/json",
                    headers={"Content-Disposition": f"attachment; filename=gd360-data-{u.id[:8]}.json"})
