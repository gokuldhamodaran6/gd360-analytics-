"""
Event OS public endpoints - no GD360 login (under /public/, so any origin
may call them). Each is guarded by an unguessable token or key.

  GET  /public/eventos/staff/{event}?k=          the staff phone app (k = the event's staff key, or a sponsor's)
  GET  /public/eventos/staff/{event}/search      find a person by name / email / company / code
  POST /public/eventos/staff/{event}/checkin     scan a ticket QR (or pick from search)
  POST /public/eventos/staff/{event}/walkin      a walk-in, with consent
  POST /public/eventos/staff/{event}/ocr         read a business card / badge photo
  POST /public/eventos/staff/{event}/lead        a sponsor's booth lead
  POST /public/eventos/staff/{event}/session     a session door scan
  POST /public/eventos/staff/{event}/count       a queue time or a room count
  POST /public/eventos/staff/{event}/sync        everything queued while offline, in one go
  GET  /public/eventos/ticket/{code}             a person's ticket (QR)
  GET  /public/eventos/c/{code}                  "yes, I'm coming"
  GET  /public/eventos/sp/{token}  POST .../renew a sponsor's live report
  GET  /public/eventos/f/{token}   POST          the survey (NPS + one line)
  GET  /public/eventos/x/{token}                 the read-only Event 360 share link
  GET  /public/eventos/goal/{token} POST .../sign one owner signs their goal
  GET  /public/eventos/asset/{id}                a brand image
  POST /public/eventos/hook/{event}/occupancy?k= people counters (sensors) post room counts
  POST /public/eventos/hook/{event}/zoom         Zoom webhooks: joins and leaves, live
"""
from __future__ import annotations

import hashlib
import hmac
import html
import json
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..services.eventos import core, views, vision
from ..services.eventos.ctx import Ctx
from ..services.initiatives import gtm, tracking

router = APIRouter(prefix="/public/eventos", tags=["eventos-public"])
NO_CACHE = {"Cache-Control": "no-store, max-age=0"}


def _ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() if fwd else "") or (request.client.host if request.client else "")


def _guard(request: Request, per_minute: int, scope: str) -> None:
    if not tracking.allow(f"ev:{scope}:{_ip(request)}", per_minute):
        raise HTTPException(429, "Too many requests - try again in a minute.")


def _event(db: Session, token: str) -> tuple[models.Initiative, models.EventConfig]:
    i = db.query(models.Initiative).filter(models.Initiative.public_token == token[:60]).first()
    if not i or i.status == "archived" or not core.is_event(i):
        raise HTTPException(404, "This event isn't available.")
    return i, core.ensure_config(db, i)


def _staff(db: Session, token: str, k: str | None) -> tuple[models.Initiative, models.EventConfig, models.EventSponsor | None]:
    i, cfg = _event(db, token)
    if not k:
        raise HTTPException(403, "This staff link is incomplete - ask the organiser for the full link.")
    if hmac.compare_digest(k, cfg.staff_key) or hmac.compare_digest(k, i.walkin_key):
        return i, cfg, None
    sp = db.query(models.EventSponsor).filter(models.EventSponsor.initiative_id == i.id, models.EventSponsor.staff_key == k[:40]).first()
    if sp:
        return i, cfg, sp
    raise HTTPException(403, "This staff link isn't valid any more - ask the organiser for a new one.")


def _seen(db: Session, i: models.Initiative, client_id: str | None, model) -> bool:
    if not client_id:
        return False
    return db.query(model.id).filter(model.initiative_id == i.id, model.client_id == client_id[:64]).first() is not None


def _when(at: str | None) -> datetime:
    if at:
        try:
            v = datetime.fromisoformat(at.replace("Z", "")[:19])
            if abs((v - datetime.utcnow()).total_seconds()) < 3 * 86400:
                return v
        except ValueError:
            pass
    return datetime.utcnow()


def _person(db: Session, t: models.EventTicket) -> dict:
    d = t.data or {}
    meeting = None
    if d.get("meeting_note"):
        meeting = d["meeting_note"]
    return {"id": t.id, "code": t.code, "name": t.name, "company": t.company, "title": t.title, "tier": t.tier, "icp": t.icp,
            "status": t.status, "walk_in": bool(t.walk_in), "checked_in_at": core.iso(t.checked_in_at), "meeting": meeting,
            "vip": t.tier in ("vip", "speaker", "sponsor", "press"), "repeat": bool(d.get("repeat"))}


# ============================================================ staff app ==

@router.get("/staff/{token}")
def staff_info(token: str, k: str, db: Session = Depends(get_db)):
    i, cfg, sp = _staff(db, token, k)
    T = models.EventTicket
    came = db.query(func.count(T.id)).filter(T.initiative_id == i.id, T.status == "checked_in").scalar() or 0
    reg = db.query(func.count(T.id)).filter(T.initiative_id == i.id, T.walk_in.is_(False), T.status != "cancelled").scalar() or 0
    walk = db.query(func.count(T.id)).filter(T.initiative_id == i.id, T.walk_in.is_(True)).scalar() or 0
    if not sp:
        cfg.data = {**(cfg.data or {}), "staff_opened": datetime.utcnow().isoformat()}
    sessions = db.query(models.EventSession).filter(models.EventSession.initiative_id == i.id).order_by(models.EventSession.starts_at).all()
    leads = None
    if sp:
        leads = db.query(func.count(models.EventLead.id)).filter(models.EventLead.sponsor_id == sp.id).scalar() or 0
    d = i.details or {}
    interests = d.get("interests")
    if isinstance(interests, str):
        interests = [x.strip() for x in interests.split(",") if x.strip()]
    db.commit()
    w = core.Windows(i, cfg)
    return {"title": i.title, "format": cfg.format, "location": i.location, "start_local": w.as_dict()["start_local"],
            "counts": {"checked_in": came, "registered": reg, "walk_ins": walk}, "mode": "sponsor" if sp else "staff",
            "sponsor": {"id": sp.id, "name": sp.name, "booth": sp.booth, "leads": leads, "goal": sp.goal_leads} if sp else None,
            "gates": [z["name"] for z in (cfg.zones or []) if z.get("outside")] or ["Main entrance"],
            "zones": [{"id": z["id"], "name": z["name"]} for z in (cfg.zones or []) if not z.get("outside")],
            "sessions": [{"id": s.id, "title": s.title, "room": s.room, "starts_at": s.starts_at.isoformat() if s.starts_at else None} for s in sessions],
            "interests": (interests or ["Demo", "Pricing", "Partnership", "Hiring", "Integration"])[:12],
            "vision": vision.available(), "sample": bool((cfg.data or {}).get("sample"))}


@router.get("/staff/{token}/search")
def staff_search(token: str, k: str, q: str, request: Request, db: Session = Depends(get_db)):
    _guard(request, 240, "search")
    i, cfg, sp = _staff(db, token, k)
    q = (q or "").strip()
    if len(q) < 2:
        return {"people": []}
    T = models.EventTicket
    like = f"%{q.lower()}%"
    rows = db.query(T).filter(T.initiative_id == i.id, T.status != "cancelled",
                              or_(func.lower(T.name).like(like), func.lower(T.email).like(like), func.lower(T.company).like(like),
                                  func.upper(T.code) == q.upper())).limit(8).all()
    return {"people": [_person(db, t) for t in rows]}


class CheckinBody(BaseModel):
    k: str
    code: str | None = Field(default=None, max_length=200)
    ticket_id: str | None = None
    gate: str | None = Field(default=None, max_length=60)
    by: str | None = Field(default=None, max_length=80)
    client_id: str | None = Field(default=None, max_length=64)
    at: str | None = None


def _do_checkin(db: Session, i: models.Initiative, body: CheckinBody) -> dict:
    T = models.EventTicket
    t = None
    if body.ticket_id:
        t = db.get(T, body.ticket_id)
    elif body.code:
        code = body.code.strip()
        if "/" in code:  # a full ticket link scanned
            code = code.rstrip("/").split("/")[-1].split("?")[0]
        t = db.query(T).filter(T.initiative_id == i.id, T.code == code.upper()[:20]).first()
    if not t or t.initiative_id != i.id:
        return {"ok": False, "error": "No ticket with that code for this event."}
    if t.status == "cancelled":
        return {"ok": False, "error": "This ticket was cancelled.", "person": _person(db, t)}
    first = core.check_in(db, i, t, body.by or "staff", body.gate, when=_when(body.at))
    return {"ok": True, "already": not first, "person": _person(db, t)}


@router.post("/staff/{token}/checkin")
def staff_checkin(token: str, body: CheckinBody, request: Request, db: Session = Depends(get_db)):
    _guard(request, 600, "checkin")
    i, cfg, sp = _staff(db, token, body.k)
    if sp:
        raise HTTPException(403, "Sponsor links scan leads, not check-ins.")
    out = _do_checkin(db, i, body)
    db.commit()
    out["checked_in"] = db.query(func.count(models.EventTicket.id)).filter(models.EventTicket.initiative_id == i.id,
                                                                            models.EventTicket.status == "checked_in").scalar() or 0
    return out


class WalkinBody(BaseModel):
    k: str
    name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=200)
    company: str | None = Field(default=None, max_length=160)
    title: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=60)
    linkedin: str | None = Field(default=None, max_length=300)
    interests: list[str] = Field(default_factory=list, max_length=12)
    note: str | None = Field(default=None, max_length=1000)
    wants_meeting: bool = False
    consent: bool = False
    by: str | None = Field(default=None, max_length=80)
    gate: str | None = Field(default=None, max_length=60)
    client_id: str | None = Field(default=None, max_length=64)
    at: str | None = None
    seconds: float | None = None


def _do_walkin(db: Session, i: models.Initiative, cfg: models.EventConfig, body: WalkinBody) -> dict:
    if body.email and not gtm.valid_email(body.email):
        return {"ok": False, "error": "Check the email address."}
    if not (body.name or body.email or body.company):
        return {"ok": False, "error": "Add at least a name, email or company."}
    if _seen(db, i, body.client_id, models.EventTouch):
        return {"ok": True, "already": True}
    sample = bool((cfg.data or {}).get("sample"))
    c = None
    if i.workspace_id and not sample and (body.email or body.name):
        c = gtm.upsert_contact(db, i.workspace_id, {"name": body.name, "email": body.email, "company": body.company, "title": body.title,
                                                    "phone": body.phone, "linkedin_url": body.linkedin, "subscribed": body.consent}, "walk-in")
        db.flush()
    T = models.EventTicket
    if c:
        t = db.query(T).filter(T.initiative_id == i.id, T.contact_id == c.id).first()
        if t:  # they had registered after all: check them in
            first = core.check_in(db, i, t, body.by or "walk-in desk", body.gate, when=_when(body.at))
            return {"ok": True, "registered": True, "already": not first, "person": _person(db, t)}
    when = _when(body.at)
    t = core.ticket_from_contact(db, i, c, source="Walk-in", when=when, walk_in=True, consent=body.consent,
                                 extra={"name": body.name, "email": body.email, "company": body.company, "title": body.title})
    t.data = {"interests": [x[:40] for x in body.interests], "note": body.note, "wants_meeting": body.wants_meeting,
              "client_id": body.client_id, "seconds": body.seconds, "consent_at": when.isoformat() if body.consent else None,
              "consent_text": "Shared details with the organiser for this event and follow-up" if body.consent else None}
    db.flush()
    t.status = "registered"
    core.check_in(db, i, t, body.by or "walk-in desk", body.gate, when=when, client_id=body.client_id)
    if c and i.workspace_id:
        E = models.GtmEngagement
        db.query(E).filter(E.initiative_id == i.id, E.contact_id == c.id, E.kind.in_(("attended", "webinar_attended"))).delete(synchronize_session=False)
        gtm.record(db, i.workspace_id, "walk_in", account_id=c.account_id, contact_id=c.id, initiative_id=i.id, channel="walk-in",
                   detail={"interests": body.interests, "wants_meeting": body.wants_meeting, "note": body.note, "captured_by": body.by,
                           "consent": body.consent, "ticket": t.code})
    if body.wants_meeting:
        n = db.query(func.count(models.InitiativeTask.id)).filter(models.InitiativeTask.initiative_id == i.id).scalar() or 0
        who = (body.name or body.email or body.company or "visitor").strip()
        db.add(models.InitiativeTask(initiative_id=i.id, title=f"Book a meeting with {who}" + (f" ({body.company})" if body.company else ""),
                                     detail="; ".join(x for x in [", ".join(body.interests) if body.interests else None, body.note, body.email, body.phone] if x) or None,
                                     owner_name=body.by, status="todo", origin="walk-in", position=n + 1, phase_id=(i.phases or [{}])[-1].get("id")))
    return {"ok": True, "registered": False, "person": _person(db, t)}


@router.post("/staff/{token}/walkin")
def staff_walkin(token: str, body: WalkinBody, request: Request, db: Session = Depends(get_db)):
    _guard(request, 120, "walkin")
    i, cfg, sp = _staff(db, token, body.k)
    if sp:
        raise HTTPException(403, "Sponsor links scan leads, not walk-ins.")
    out = _do_walkin(db, i, cfg, body)
    db.commit()
    return out


@router.post("/staff/{token}/ocr")
async def staff_ocr(token: str, request: Request, k: str = Form(...), file: UploadFile = File(...), db: Session = Depends(get_db)):
    _guard(request, 30, "ocr")
    _staff(db, token, k)
    raw = await file.read()
    if not raw or len(raw) > 6 * 1024 * 1024:
        raise HTTPException(413, "Take the photo again - images up to 6 MB.")
    if not vision.available():
        raise HTTPException(503, "Card reading isn't set up on this Euliv - type the details instead.")
    try:
        return {"fields": vision.read_card(raw)}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Couldn't read the card: {str(e)[:120]}")


class LeadBody(BaseModel):
    k: str
    sponsor_id: str | None = None
    code: str | None = Field(default=None, max_length=200)
    name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=200)
    company: str | None = Field(default=None, max_length=160)
    title: str | None = Field(default=None, max_length=120)
    rating: int | None = None
    interests: list[str] = Field(default_factory=list, max_length=12)
    note: str | None = Field(default=None, max_length=2000)
    by: str | None = Field(default=None, max_length=80)
    client_id: str | None = Field(default=None, max_length=64)
    at: str | None = None


def _do_lead(db: Session, i: models.Initiative, sp: models.EventSponsor | None, body: LeadBody) -> dict:
    if sp is None:
        if not body.sponsor_id:
            return {"ok": False, "error": "Pick the sponsor."}
        sp = db.get(models.EventSponsor, body.sponsor_id)
        if not sp or sp.initiative_id != i.id:
            return {"ok": False, "error": "Unknown sponsor."}
    if _seen(db, i, body.client_id, models.EventLead):
        return {"ok": True, "already": True}
    t = None
    if body.code:
        code = body.code.strip().rstrip("/").split("/")[-1].split("?")[0].upper()
        t = db.query(models.EventTicket).filter(models.EventTicket.initiative_id == i.id, models.EventTicket.code == code[:20]).first()
    if not t and not (body.name or body.email):
        return {"ok": False, "error": "Scan the badge or type a name."}
    when = _when(body.at)
    l = models.EventLead(initiative_id=i.id, sponsor_id=sp.id, ticket_id=t.id if t else None, name=(t.name if t else body.name),
                         email=(t.email if t else body.email), company=(t.company if t else body.company), title=(t.title if t else body.title),
                         rating=max(1, min(5, body.rating)) if body.rating else None, interests=[x[:40] for x in body.interests],
                         note=body.note, scanned_by=body.by, client_id=body.client_id, created_at=when)
    db.add(l)
    db.add(models.EventTouch(initiative_id=i.id, kind="booth_visit", ticket_id=t.id if t else None, sponsor_id=sp.id, occurred_at=when,
                             source="lead scan", client_id=(body.client_id + "v") if body.client_id else None))
    n = db.query(func.count(models.EventLead.id)).filter(models.EventLead.sponsor_id == sp.id).scalar() or 0
    return {"ok": True, "leads": n + 1, "person": {"name": l.name, "company": l.company, "title": l.title}}


@router.post("/staff/{token}/lead")
def staff_lead(token: str, body: LeadBody, request: Request, db: Session = Depends(get_db)):
    _guard(request, 240, "lead")
    i, cfg, sp = _staff(db, token, body.k)
    out = _do_lead(db, i, sp, body)
    db.commit()
    return out


class SessionScanBody(BaseModel):
    k: str
    session_id: str
    code: str | None = Field(default=None, max_length=200)
    rating: int | None = None
    client_id: str | None = Field(default=None, max_length=64)
    at: str | None = None


def _do_session(db: Session, i: models.Initiative, body: SessionScanBody) -> dict:
    s = db.get(models.EventSession, body.session_id)
    if not s or s.initiative_id != i.id:
        return {"ok": False, "error": "Unknown session."}
    if _seen(db, i, body.client_id, models.EventTouch):
        return {"ok": True, "already": True}
    t = None
    if body.code:
        code = body.code.strip().rstrip("/").split("/")[-1].split("?")[0].upper()
        t = db.query(models.EventTicket).filter(models.EventTicket.initiative_id == i.id, models.EventTicket.code == code[:20]).first()
        if not t:
            return {"ok": False, "error": "No ticket with that code."}
        if t.status != "checked_in":
            core.check_in(db, i, t, "session door", s.room, when=_when(body.at))
    db.add(models.EventTouch(initiative_id=i.id, kind="session_scan", ticket_id=t.id if t else None, session_id=s.id, zone=s.room,
                             occurred_at=_when(body.at), source="staff app", client_id=body.client_id))
    n = db.query(func.count(models.EventTouch.id)).filter(models.EventTouch.initiative_id == i.id, models.EventTouch.kind == "session_scan",
                                                          models.EventTouch.session_id == s.id).scalar() or 0
    return {"ok": True, "in_room": n + 1, "capacity": s.capacity, "person": _person(db, t) if t else None}


@router.post("/staff/{token}/session")
def staff_session(token: str, body: SessionScanBody, request: Request, db: Session = Depends(get_db)):
    _guard(request, 600, "session")
    i, cfg, sp = _staff(db, token, body.k)
    out = _do_session(db, i, body)
    db.commit()
    return out


class CountBody(BaseModel):
    k: str
    kind: str  # queue | occupancy
    zone: str | None = Field(default=None, max_length=60)
    value: float
    client_id: str | None = Field(default=None, max_length=64)
    at: str | None = None


@router.post("/staff/{token}/count")
def staff_count(token: str, body: CountBody, request: Request, db: Session = Depends(get_db)):
    _guard(request, 240, "count")
    i, cfg, sp = _staff(db, token, body.k)
    if body.kind not in ("queue", "occupancy"):
        raise HTTPException(422, "Count a queue (minutes) or a room (people).")
    if not _seen(db, i, body.client_id, models.EventTouch):
        db.add(models.EventTouch(initiative_id=i.id, kind=body.kind, zone=body.zone, value=max(0.0, min(body.value, 1_000_000)),
                                 occurred_at=_when(body.at), source="staff app", truth="counted", client_id=body.client_id))
    db.commit()
    return {"ok": True}


class SyncBody(BaseModel):
    k: str
    items: list[dict] = Field(default_factory=list, max_length=500)


@router.post("/staff/{token}/sync")
def staff_sync(token: str, body: SyncBody, request: Request, db: Session = Depends(get_db)):
    """Everything a phone queued while it had no signal. Each item carries a
    client id, so a retry never counts anything twice."""
    _guard(request, 60, "sync")
    i, cfg, sp = _staff(db, token, body.k)
    results = []
    for it in body.items:
        typ = it.get("type")
        nested = db.begin_nested()  # a bad item rolls back alone, never the ones before it
        try:
            if typ == "checkin" and not sp:
                b = CheckinBody(k=body.k, **{x: it.get(x) for x in ("code", "ticket_id", "gate", "by", "client_id", "at")})
                r = _do_checkin(db, i, b)
            elif typ == "walkin" and not sp:
                b = WalkinBody(k=body.k, **{x: it.get(x) for x in WalkinBody.model_fields if x != "k" and it.get(x) is not None})
                r = _do_walkin(db, i, cfg, b)
            elif typ == "lead":
                b = LeadBody(k=body.k, **{x: it.get(x) for x in LeadBody.model_fields if x != "k" and it.get(x) is not None})
                r = _do_lead(db, i, sp, b)
            elif typ == "session":
                b = SessionScanBody(k=body.k, **{x: it.get(x) for x in SessionScanBody.model_fields if x != "k" and it.get(x) is not None})
                r = _do_session(db, i, b)
            elif typ == "count" and it.get("kind") in ("queue", "occupancy"):
                if not _seen(db, i, it.get("client_id"), models.EventTouch):
                    db.add(models.EventTouch(initiative_id=i.id, kind=it["kind"], zone=(it.get("zone") or "")[:60] or None,
                                             value=max(0.0, min(float(it.get("value") or 0), 1_000_000)), occurred_at=_when(it.get("at")),
                                             source="staff app", truth="counted", client_id=(it.get("client_id") or "")[:64] or None))
                r = {"ok": True}
            else:
                r = {"ok": False, "error": "Unknown item."}
            db.flush()
            nested.commit()
        except Exception as e:  # noqa: BLE001 - one bad item never loses the rest
            nested.rollback()
            r = {"ok": False, "error": str(e)[:160]}
        results.append({"client_id": it.get("client_id"), **{k: v for k, v in r.items() if k in ("ok", "error", "already")}})
    db.commit()
    return {"results": results}


# ================================================================ ticket ==

@router.get("/ticket/{code}")
def ticket(code: str, request: Request, db: Session = Depends(get_db)):
    _guard(request, 120, "ticket")
    t = db.query(models.EventTicket).filter(models.EventTicket.code == code.upper()[:20]).first()
    if not t:
        raise HTTPException(404, "Ticket not found.")
    i = db.get(models.Initiative, t.initiative_id)
    cfg = core.ensure_config(db, i)
    w = core.Windows(i, cfg)
    return {"code": t.code, "name": t.name, "company": t.company, "tier": t.tier, "status": t.status, "qr_svg": core.ticket_qr_svg(t.code),
            "event": {"title": i.title, "location": i.location, "start_local": w.as_dict()["start_local"], "end_local": w.as_dict()["end_local"],
                      "format": cfg.format, "join_url": (cfg.data or {}).get("join_url") if cfg.format in ("webinar", "online", "hybrid", "launch") else None},
            "confirmed": bool(t.confirmed_at)}


@router.get("/ticket/{code}/qr.svg")
def ticket_qr(code: str, request: Request, db: Session = Depends(get_db)):
    _guard(request, 240, "ticket_qr")
    t = db.query(models.EventTicket.code).filter(models.EventTicket.code == code.upper()[:20]).first()
    if not t:
        raise HTTPException(404, "Ticket not found.")
    return Response(core.ticket_qr_svg(t[0]), media_type="image/svg+xml", headers={"Cache-Control": "private, max-age=3600"})


def _page(title: str, body: str) -> HTMLResponse:
    return HTMLResponse(
        f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{html.escape(title)}</title></head><body style="margin:0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;'
        f'background:#0B0F0E;color:#E8EDEA;display:grid;place-items:center;min-height:100vh"><div style="max-width:420px;padding:32px;text-align:center">'
        f'{body}</div></body></html>', headers=NO_CACHE)


@router.get("/c/{code}")
def confirm(code: str, request: Request, db: Session = Depends(get_db)):
    _guard(request, 60, "confirm")
    t = db.query(models.EventTicket).filter(models.EventTicket.code == code.upper()[:20]).first()
    if not t:
        return _page("Not found", "<h2>We couldn't find that ticket.</h2>")
    i = db.get(models.Initiative, t.initiative_id)
    if not t.confirmed_at:
        t.confirmed_at = datetime.utcnow()
        db.commit()
    return _page("Confirmed", f'<div style="font-size:44px">✓</div><h2 style="margin:8px 0">You\'re confirmed</h2>'
                              f'<p style="color:#A6B0AB">See you at {html.escape(i.title if i else "the event")}. Your ticket code is '
                              f'<b style="font-family:monospace;color:#4BE3A3">{html.escape(t.code)}</b>.</p>')


# ============================================================== sponsors ==

def _sponsor(db: Session, token: str) -> tuple[models.EventSponsor, models.Initiative]:
    s = db.query(models.EventSponsor).filter(models.EventSponsor.token == token[:60]).first()
    if not s:
        raise HTTPException(404, "This report link isn't valid.")
    i = db.get(models.Initiative, s.initiative_id)
    if not i or i.status == "archived":
        raise HTTPException(404, "This report isn't available.")
    return s, i


@router.get("/sp/{token}")
def sponsor_page(token: str, request: Request, db: Session = Depends(get_db)):
    _guard(request, 120, "sponsor")
    s, i = _sponsor(db, token)
    ctx = Ctx(db, i)
    out = views.sponsor_report(ctx, s)
    db.commit()
    return out


class RenewBody(BaseModel):
    decision: str
    name: str | None = Field(default=None, max_length=80)


@router.post("/sp/{token}/renew")
def sponsor_renew(token: str, body: RenewBody, request: Request, db: Session = Depends(get_db)):
    _guard(request, 20, "renew")
    s, i = _sponsor(db, token)
    if body.decision not in ("signed", "verbal", "declined"):
        raise HTTPException(422, "Choose renew, maybe or not this time.")
    s.renewal, s.renewal_at = body.decision, datetime.utcnow()
    s.data = {**(s.data or {}), "renewal_by": (body.name or "")[:80] or None}
    tracking.log(db, i, f"Sponsor {s.name}: {'renews' if body.decision == 'signed' else 'interested in renewing' if body.decision == 'verbal' else 'not renewing'}"
                 + (f" ({body.name})" if body.name else ""), "Sponsor report", kind="update")
    db.commit()
    return {"ok": True, "renewal": s.renewal}


# ================================================================ survey ==

def _survey_event(db: Session, token: str) -> tuple[models.Initiative, models.EventConfig]:
    cfg = db.query(models.EventConfig).filter(models.EventConfig.survey_token == token[:60]).first()
    if not cfg:
        raise HTTPException(404, "This survey link isn't valid.")
    i = db.get(models.Initiative, cfg.initiative_id)
    if not i or i.status == "archived":
        raise HTTPException(404, "This survey is closed.")
    return i, cfg


@router.get("/f/{token}")
def survey_info(token: str, t: str | None = None, db: Session = Depends(get_db)):
    i, cfg = _survey_event(db, token)
    name = None
    if t:
        tk = db.query(models.EventTicket).filter(models.EventTicket.initiative_id == i.id, models.EventTicket.code == t.upper()[:20]).first()
        name = tk.name.split(" ")[0] if tk and tk.name else None
    sessions = db.query(models.EventSession).filter(models.EventSession.initiative_id == i.id).order_by(models.EventSession.starts_at).limit(30).all()
    return {"title": i.title, "name": name, "sessions": [{"id": s.id, "title": s.title} for s in sessions]}


class SurveyBody(BaseModel):
    t: str | None = Field(default=None, max_length=20)
    score: int = Field(ge=0, le=10)
    comment: str | None = Field(default=None, max_length=1000)
    ratings: dict | None = None


@router.post("/f/{token}")
def survey_answer(token: str, body: SurveyBody, request: Request, db: Session = Depends(get_db)):
    _guard(request, 20, "survey")
    i, cfg = _survey_event(db, token)
    tk = None
    if body.t:
        tk = db.query(models.EventTicket).filter(models.EventTicket.initiative_id == i.id, models.EventTicket.code == body.t.upper()[:20]).first()
        if tk and db.query(models.EventTouch.id).filter(models.EventTouch.initiative_id == i.id, models.EventTouch.kind == "survey",
                                                        models.EventTouch.ticket_id == tk.id).first():
            return {"ok": True, "already": True}
    db.add(models.EventTouch(initiative_id=i.id, kind="survey", ticket_id=tk.id if tk else None, value=body.score, text=body.comment,
                             source="survey", truth="reported"))
    for sid, val in (body.ratings or {}).items():
        try:
            v = int(val)
        except (TypeError, ValueError):
            continue
        if 1 <= v <= 5 and db.get(models.EventSession, sid):
            db.add(models.EventTouch(initiative_id=i.id, kind="rating", ticket_id=tk.id if tk else None, session_id=sid, value=v,
                                     source="survey", truth="reported"))
    db.commit()
    return {"ok": True}


# ============================================================ share link ==

@router.get("/x/{token}")
def shared(token: str, request: Request, db: Session = Depends(get_db)):
    _guard(request, 60, "share")
    cfg = db.query(models.EventConfig).filter(models.EventConfig.share_token == token[:60]).first()
    if not cfg or not cfg.share_enabled:
        raise HTTPException(404, "This link isn't shared (any more).")
    i = db.get(models.Initiative, cfg.initiative_id)
    if not i or i.status == "archived":
        raise HTTPException(404, "This event isn't available.")
    ctx = Ctx(db, i)
    ov = views.overview(ctx)
    ov.pop("actions", None)
    ov.pop("setup", None)
    for g in ov["score"]["goals"]:
        g.pop("sign_token", None)
        g.pop("owner_email", None)
    db.rollback()  # read-only: nothing a viewer opens is written
    return ov


# ================================================================== sign ==

@router.get("/goal/{token}")
def goal_info(token: str, db: Session = Depends(get_db)):
    g = db.query(models.EventGoal).filter(models.EventGoal.sign_token == token[:60]).first()
    if not g:
        raise HTTPException(404, "This sign link isn't valid.")
    i = db.get(models.Initiative, g.initiative_id)
    from ..services.eventos.score import metric_meta
    return {"event": i.title if i else None, "owner_name": g.owner_name, "label": g.label, "metric": metric_meta(g.metric)["label"],
            "target": g.target, "low": g.low, "high": g.high, "lower_is_better": bool(g.lower_is_better), "unit": g.unit or metric_meta(g.metric)["unit"],
            "signed": bool(g.signed_at), "signed_by": g.signed_by, "version": g.version or 1,
            "how": "0 points at the low end, 70 on target, 100 at the good end."}


class SignBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)


@router.post("/goal/{token}/sign")
def goal_sign(token: str, body: SignBody, request: Request, db: Session = Depends(get_db)):
    _guard(request, 20, "sign")
    g = db.query(models.EventGoal).filter(models.EventGoal.sign_token == token[:60]).first()
    if not g:
        raise HTTPException(404, "This sign link isn't valid.")
    g.signed_at, g.signed_by = datetime.utcnow(), body.name.strip()
    g.history = (g.history or []) + [{"at": g.signed_at.isoformat(), "by": g.signed_by, "change": f"signed v{g.version or 1} by link"}]
    db.commit()
    return {"ok": True}


# ================================================================= asset ==

@router.get("/asset/{asset_id}")
def asset(asset_id: str, db: Session = Depends(get_db)):
    a = db.get(models.EventAsset, asset_id[:60])
    if not a:
        raise HTTPException(404, "Not found.")
    return Response(a.data, media_type=a.mime, headers={"Cache-Control": "public, max-age=86400"})


# ================================================================= hooks ==

class OccupancyBody(BaseModel):
    zone: str = Field(max_length=60)
    count: float
    at: str | None = None


@router.post("/hook/{token}/occupancy")
def hook_occupancy(token: str, k: str, body: OccupancyBody, request: Request, db: Session = Depends(get_db)):
    """People counters (no images) post a zone's count every few minutes."""
    _guard(request, 600, "occupancy")
    i, cfg, sp = _staff(db, token, k)
    db.add(models.EventTouch(initiative_id=i.id, kind="occupancy", zone=body.zone, value=max(0.0, body.count), occurred_at=_when(body.at),
                             source="sensor", truth="counted"))
    db.commit()
    return {"ok": True}


@router.post("/hook/{token}/zoom")
async def hook_zoom(token: str, request: Request, db: Session = Depends(get_db)):
    """Zoom webhooks (Webinar participant joined / left). The event's Zoom
    secret token verifies every call."""
    _guard(request, 1200, "zoom")
    i, cfg = _event(db, token)
    secret = (cfg.data or {}).get("zoom_secret")
    raw = await request.body()
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        raise HTTPException(400, "Not JSON.")
    if not secret:
        raise HTTPException(403, "Add the Zoom secret token in the event setup first.")
    if body.get("event") == "endpoint.url_validation":
        plain = (body.get("payload") or {}).get("plainToken", "")
        return {"plainToken": plain, "encryptedToken": hmac.new(secret.encode(), plain.encode(), hashlib.sha256).hexdigest()}
    ts = request.headers.get("x-zm-request-timestamp", "")
    sig = request.headers.get("x-zm-signature", "")
    expect = "v0=" + hmac.new(secret.encode(), f"v0:{ts}:{raw.decode()}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expect):
        raise HTTPException(401, "Signature doesn't match.")
    ev = body.get("event", "")
    p = ((body.get("payload") or {}).get("object") or {}).get("participant") or {}
    email = (p.get("email") or "").strip().lower()
    if ev.endswith("participant_joined") or ev.endswith("participant_left"):
        T = models.EventTicket
        t = db.query(T).filter(T.initiative_id == i.id, func.lower(T.email) == email).first() if email else None
        if ev.endswith("participant_joined"):
            if t is None and email:
                c = gtm.upsert_contact(db, i.workspace_id, {"name": p.get("user_name"), "email": email}, "webinar") if i.workspace_id else None
                db.flush()
                t = core.ticket_from_contact(db, i, c, source="Joined without registering", when=datetime.utcnow(), walk_in=True,
                                             extra={"name": p.get("user_name"), "email": email})
                db.flush()
            if t:
                core.check_in(db, i, t, "Zoom", "online")
                t.data = {**(t.data or {}), "joined_at": datetime.utcnow().isoformat()}
            db.add(models.EventTouch(initiative_id=i.id, kind="stream_join", ticket_id=t.id if t else None, source="zoom"))
        else:
            if t and (t.data or {}).get("joined_at"):
                try:
                    j = datetime.fromisoformat(t.data["joined_at"])
                    t.online_minutes = round((t.online_minutes or 0) + (datetime.utcnow() - j).total_seconds() / 60, 1)
                except ValueError:
                    pass
            db.add(models.EventTouch(initiative_id=i.id, kind="stream_leave", ticket_id=t.id if t else None, source="zoom"))
        # viewers now = joins - leaves (counted)
        K = models.EventTouch
        j = db.query(func.count(K.id)).filter(K.initiative_id == i.id, K.kind == "stream_join").scalar() or 0
        lv = db.query(func.count(K.id)).filter(K.initiative_id == i.id, K.kind == "stream_leave").scalar() or 0
        db.add(models.EventTouch(initiative_id=i.id, kind="stream_viewers", value=max(0, j - lv), source="zoom"))
    db.commit()
    return {"ok": True}
