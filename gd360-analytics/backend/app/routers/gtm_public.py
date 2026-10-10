"""
Public endpoints for Initiatives - no GD360 login. Under /public/ so any
origin may call them (see main.py's public_cors_reflection).

  GET  /public/gtm/t/{site_key}.js     the website tracking script
  POST /public/gtm/collect             page views / identify / subscribe (sendBeacon, text/plain)
  GET  /public/gtm/o/{token}.gif       email open pixel
  GET  /public/gtm/c/{token}?u=        email click (only the campaign's own links)
  GET  /public/gtm/u/{token}           unsubscribe (also POST, for one-click)
  GET  /public/gtm/l/{code}            tracked link: count the click, go to the page
  GET  /public/gtm/e/{token}           event / webinar registration page data
  POST /public/gtm/e/{token}           register
  GET  /public/gtm/w/{token}?k=        walk-in capture page data (needs the staff key)
  POST /public/gtm/w/{token}           capture a walk-in
  GET  /public/gtm/a/{token}           an approval request
  POST /public/gtm/a/{token}           approve / request changes
"""
from __future__ import annotations

import base64
import html
import json
import threading
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..services.automations import email_configured, send_email
from ..services.initiatives import campaigns, catalog, gtm, tracking

router = APIRouter(prefix="/public/gtm", tags=["gtm-public"])
PIXEL = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
NO_CACHE = {"Cache-Control": "no-store, max-age=0"}


def _ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() if fwd else "") or (request.client.host if request.client else "")


def _guard(request: Request, per_minute: int = 120, scope: str = "form") -> None:
    if not tracking.allow(f"{scope}:{_ip(request)}", per_minute):
        raise HTTPException(429, "Too many requests - try again in a minute.")


# ================================================================ website ==

@router.get("/t/{site_key}.js")
def script(site_key: str, db: Session = Depends(get_db)):
    prof = db.query(models.GtmProfile).filter(models.GtmProfile.site_key == site_key).first()
    if not prof:
        return Response("/* GD360: unknown site key */", media_type="application/javascript")
    return Response(tracking.script(site_key, campaigns.backend_url()), media_type="application/javascript",
                    headers={"Cache-Control": "public, max-age=300"})


@router.post("/collect")
async def collect(request: Request, db: Session = Depends(get_db)):
    if not tracking.allow(f"collect:{_ip(request)}", 240):
        return Response(status_code=204)
    raw = await request.body()
    if len(raw) > 8000:
        return Response(status_code=204)
    try:
        payload = json.loads(raw.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        return Response(status_code=204)
    if not isinstance(payload, dict) or not payload.get("k"):
        return Response(status_code=204)
    try:
        tracking.collect(db, str(payload["k"])[:60], payload, _ip(request))
    except Exception:  # noqa: BLE001 - tracking must never break a customer's site
        db.rollback()
    return Response(status_code=204)


# ================================================================== email ==

@router.get("/o/{token}.gif")
def open_pixel(token: str, db: Session = Depends(get_db)):
    try:
        campaigns.on_open(db, token[:60])
    except Exception:  # noqa: BLE001
        db.rollback()
    return Response(PIXEL, media_type="image/gif", headers=NO_CACHE)


@router.get("/c/{token}")
def click(token: str, u: str, db: Session = Depends(get_db)):
    dest = campaigns.on_click(db, token[:60], u)
    if not dest:
        raise HTTPException(404, "This link is no longer available.")
    return RedirectResponse(dest, status_code=302)


def _page(title: str, body: str) -> HTMLResponse:
    return HTMLResponse(
        f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)}</title><style>body{{margin:0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#F4F6F5;color:#1B2321;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}}
main{{max-width:440px;background:#fff;border:1px solid #E1E6E4;border-radius:16px;padding:32px}}h1{{font-size:20px;margin:0 0 8px}}p{{margin:0;color:#56605D;line-height:1.55}}</style></head>
<body><main>{body}</main></body></html>""")


@router.get("/u/{token}")
def unsubscribe_page(token: str, db: Session = Depends(get_db)):
    ok = campaigns.on_unsubscribe(db, token[:60])
    if not ok:
        return _page("Unsubscribe", "<h1>Link not recognised</h1><p>This unsubscribe link has expired or was copied incorrectly.</p>")
    return _page("Unsubscribed", "<h1>You're unsubscribed</h1><p>You won't receive marketing emails from this sender through GD360 again.</p>")


@router.post("/u/{token}")
def unsubscribe_one_click(token: str, db: Session = Depends(get_db)):
    campaigns.on_unsubscribe(db, token[:60])
    return {"ok": True}


# ========================================================== tracked links ==

@router.get("/l/{code}")
def tracked_link(code: str, request: Request, db: Session = Depends(get_db)):
    l = db.query(models.InitiativeLink).filter(models.InitiativeLink.code == code[:20]).first()
    if not l:
        raise HTTPException(404, "This link is no longer available.")
    i = db.get(models.Initiative, l.initiative_id)
    if tracking.allow("l:" + _ip(request), 30):
        l.clicks = (l.clicks or 0) + 1
        l.last_click_at = datetime.utcnow()
        gtm.record(db, l.workspace_id, "link_click", initiative_id=l.initiative_id, channel=l.channel or l.kind,
                   detail={"link": l.id, "label": l.label, "variant": l.variant, "paid": bool(l.paid), "region": l.region},
                   rescore=False)
        db.commit()
    return RedirectResponse(tracking.destination(l, i), status_code=302)


# ============================================================ registration ==

def _initiative(db: Session, token: str) -> models.Initiative:
    i = db.query(models.Initiative).filter(models.Initiative.public_token == token[:60]).first()
    if not i or i.status == "archived":
        raise HTTPException(404, "This page isn't available.")
    return i


def _brand(db: Session, i: models.Initiative) -> dict:
    icp = (gtm.profile(db, i.workspace_id).icp or {}) if i.workspace_id else {}
    return {"company": icp.get("company_name") or None, "privacy_note": (
        f"{icp.get('company_name') or 'The organiser'} uses your details to manage this "
        f"{'webinar' if i.kind == 'webinar' else 'event'}. Marketing emails only if you tick the box; unsubscribe any time.")}


@router.get("/e/{token}")
def event_info(token: str, db: Session = Depends(get_db)):
    i = _initiative(db, token)
    d = i.details or {}
    return {"title": i.title, "kind": i.kind, "kind_label": catalog.KINDS.get(i.kind, {}).get("label"),
            "key_date": i.key_date, "time": d.get("time"), "location": i.location,
            "description": d.get("public_description") or i.summary, "open": bool(i.registration_open) and i.status != "done",
            "online": i.kind == "webinar", **_brand(db, i)}


class RegisterBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=5, max_length=200)
    company: str | None = Field(default=None, max_length=160)
    title: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=60)
    consent: bool = False
    visitor_id: str | None = Field(default=None, max_length=64)
    ref: str | None = Field(default=None, max_length=20)  # a team member's personal invite link
    hp: str | None = None  # honeypot: real people never fill it


def _confirmation(i: models.Initiative, to: str, name: str) -> None:
    d = i.details or {}
    when = ""
    if i.key_date:
        when = datetime.fromisoformat(i.key_date).strftime("%A %-d %B %Y") + (f", {d['time']}" if d.get("time") else "")
    join = d.get("join_url")

    def go():
        try:
            lines = [f"You're registered for {i.title}."] + ([when] if when else []) + ([i.location] if i.location else []) + \
                    ([f"Join link: {join}"] if join else [])
            body = "".join(f'<p style="margin:0 0 10px">{html.escape(x)}</p>' for x in lines)
            send_email([to], f"You're registered: {i.title}",
                       f'<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1B2321;max-width:560px">'
                       f'<p style="margin:0 0 14px">Hi {html.escape(name.split(" ")[0])},</p>{body}</div>',
                       f"Hi {name.split(' ')[0]},\n\n" + "\n".join(lines))
        except Exception:  # noqa: BLE001
            pass
    threading.Thread(target=go, daemon=True).start()


@router.post("/e/{token}")
def register(token: str, body: RegisterBody, request: Request, db: Session = Depends(get_db)):
    _guard(request, 20, "register")
    i = _initiative(db, token)
    if body.hp:
        return {"ok": True}
    if not i.registration_open or i.status == "done":
        raise HTTPException(409, "Registration is closed.")
    if not gtm.valid_email(body.email):
        raise HTTPException(422, "Please check your email address.")
    c = gtm.upsert_contact(db, i.workspace_id, {"name": body.name, "email": body.email, "company": body.company,
                                                "title": body.title, "phone": body.phone, "subscribed": body.consent},
                           "registration")
    db.flush()
    E = models.GtmEngagement
    already = db.query(E.id).filter(E.initiative_id == i.id, E.contact_id == c.id, E.kind == "registered").first()
    if not already:
        gtm.record(db, i.workspace_id, "registered", account_id=c.account_id, contact_id=c.id, initiative_id=i.id,
                   channel="registration page",
                   detail={"consent": body.consent, "consent_at": datetime.utcnow().isoformat() if body.consent else None,
                           "consent_source": "registration page", "ref": body.ref}, visitor_id=body.visitor_id)
        if body.consent:
            gtm.record(db, i.workspace_id, "newsletter_signup", account_id=c.account_id, contact_id=c.id,
                       initiative_id=i.id, channel="registration page", rescore=False)
    db.commit()
    if not already and email_configured():
        _confirmation(i, c.email, body.name)
    return {"ok": True, "already": bool(already), "join_url": (i.details or {}).get("join_url") if i.kind == "webinar" else None}


# ================================================================ walk-ins ==

@router.get("/w/{token}")
def walkin_info(token: str, k: str, db: Session = Depends(get_db)):
    i = _initiative(db, token)
    if k != i.walkin_key:
        raise HTTPException(403, "This capture link is incomplete - ask the organiser for the full link.")
    n = db.query(func.count(models.GtmEngagement.id)).filter(models.GtmEngagement.initiative_id == i.id,
                                                             models.GtmEngagement.kind.in_(("walk_in", "attended"))).scalar() or 0
    d = i.details or {}
    interests = d.get("interests")
    if isinstance(interests, str):
        interests = [x.strip() for x in interests.split(",") if x.strip()]
    return {"title": i.title, "captured": n, "interests": (interests or [])[:12], **_brand(db, i)}


class WalkinBody(BaseModel):
    k: str
    name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=200)
    company: str | None = Field(default=None, max_length=160)
    title: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=60)
    interests: list[str] = Field(default_factory=list, max_length=12)
    wants_meeting: bool = False
    consent: bool = False
    note: str | None = Field(default=None, max_length=1000)
    captured_by: str | None = Field(default=None, max_length=80)


@router.post("/w/{token}")
def walkin(token: str, body: WalkinBody, request: Request, db: Session = Depends(get_db)):
    _guard(request, 60, "walkin")
    i = _initiative(db, token)
    if body.k != i.walkin_key:
        raise HTTPException(403, "This capture link is incomplete.")
    if body.email and not gtm.valid_email(body.email):
        raise HTTPException(422, "Check the email address.")
    if not (body.name or body.email or body.company):
        raise HTTPException(422, "Add at least a name, email or company.")
    c = gtm.upsert_contact(db, i.workspace_id, {"name": body.name, "email": body.email, "company": body.company,
                                                "title": body.title, "phone": body.phone, "subscribed": body.consent},
                           "walk-in")
    acc = None
    if c is None and body.company:
        acc = gtm.account_for_email(db, i.workspace_id, None, body.company, source="walk_in")
    db.flush()
    E = models.GtmEngagement
    registered = bool(c and db.query(E.id).filter(E.initiative_id == i.id, E.contact_id == c.id, E.kind == "registered").first())
    kind = ("webinar_attended" if i.kind == "webinar" else "attended") if registered else "walk_in"
    detail = {"interests": [x[:40] for x in body.interests], "wants_meeting": body.wants_meeting, "note": body.note,
              "captured_by": body.captured_by, "consent": body.consent,
              "consent_at": datetime.utcnow().isoformat() if body.consent else None, "consent_source": "walk-in capture"}
    gtm.record(db, i.workspace_id, kind, account_id=(c.account_id if c else (acc.id if acc else None)),
               contact_id=c.id if c else None, initiative_id=i.id, channel="walk-in", detail=detail)
    who = (body.name or body.email or body.company or "visitor").strip()
    company = body.company or (db.get(models.GtmAccount, c.account_id).name if c and c.account_id else None)
    if body.wants_meeting:
        n = db.query(func.count(models.InitiativeTask.id)).filter(models.InitiativeTask.initiative_id == i.id).scalar() or 0
        db.add(models.InitiativeTask(
            initiative_id=i.id, title=f"Book a meeting with {who}" + (f" ({company})" if company else ""),
            detail="; ".join(x for x in [", ".join(body.interests) if body.interests else None, body.note,
                                          body.email, body.phone] if x) or None,
            owner_name=body.captured_by, due_on=(datetime.utcnow() + timedelta(days=2)).date().isoformat(),
            status="todo", origin="walk-in", position=n + 1, tool_key="calendly",
            phase_id=(i.phases or [{}])[-1].get("id")))
    tracking.log(db, i, f"{'Checked in' if registered else 'Walk-in'}: {who}" + (f" ({company})" if company else "")
                 + (" - wants a meeting" if body.wants_meeting else ""), body.captured_by or "Booth", kind="update")
    db.commit()
    n = db.query(func.count(E.id)).filter(E.initiative_id == i.id, E.kind.in_(("walk_in", "attended", "webinar_attended"))).scalar() or 0
    return {"ok": True, "checked_in": registered, "captured": n}


# =============================================================== approvals ==

def _approval_task(db: Session, token: str) -> tuple[models.InitiativeTask, models.Initiative]:
    t = db.query(models.InitiativeTask).filter(models.InitiativeTask.approval_token == token[:60]).first()
    if not t:
        raise HTTPException(404, "This approval link isn't valid.")
    return t, db.get(models.Initiative, t.initiative_id)


@router.get("/a/{token}")
def approval_info(token: str, db: Session = Depends(get_db)):
    t, i = _approval_task(db, token)
    a = tracking.approval_state(t)
    return {"initiative": i.title if i else None, "task": t.title, "detail": t.detail, "evidence": t.evidence or [],
            "state": a.get("state"), "approver": a.get("approver"), "note": a.get("note"),
            "requested_by": a.get("requested_by"), "requested_at": a.get("requested_at"), "version": a.get("version"),
            "decided_by": a.get("decided_by"), "decided_at": a.get("decided_at"), "decision_note": a.get("decision_note"),
            "history": [{k: h.get(k) for k in ("at", "by", "action", "note", "version")} for h in a.get("history") or []]}


class PublicDecision(BaseModel):
    decision: str
    name: str = Field(min_length=1, max_length=120)
    note: str | None = Field(default=None, max_length=1000)


@router.post("/a/{token}")
def approval_decide(token: str, body: PublicDecision, request: Request, db: Session = Depends(get_db)):
    _guard(request, 20, "approve")
    t, i = _approval_task(db, token)
    if body.decision not in ("approve", "changes"):
        raise HTTPException(422, "Approve or request changes.")
    a = tracking.approval_state(t)
    if a.get("state") != "submitted":
        raise HTTPException(409, "This has already been decided. Ask for a new review if something changed.")
    if body.decision == "changes" and not (body.note or "").strip():
        raise HTTPException(422, "Say what needs to change.")
    a = tracking.decide(t, body.decision, body.name.strip(), body.note)
    v = f" (v{a['version']})" if a.get("version") else ""
    if i:
        tracking.log(db, i, (f"Approved{v} by {body.name.strip()}: {t.title}" if body.decision == "approve"
                             else f"Changes requested{v} by {body.name.strip()}: {t.title}")
                     + (f" - {body.note.strip()}" if body.note and body.note.strip() else ""),
                     body.name.strip(), kind="approval", task_id=t.id)
    db.commit()
    return {"ok": True, "state": a["state"]}


# ========================================================= my invites (rep) ==

def _member(db: Session, token: str) -> tuple[models.InitiativeMember, models.Initiative]:
    m = db.query(models.InitiativeMember).filter(models.InitiativeMember.token == token[:60]).first()
    if not m:
        raise HTTPException(404, "This link isn't valid any more - ask the organiser for a new one.")
    i = db.get(models.Initiative, m.initiative_id)
    if not i or i.status == "archived":
        raise HTTPException(404, "This initiative has been archived.")
    return m, i


@router.get("/r/{token}")
def rep_page(token: str, db: Session = Depends(get_db)):
    from ..services.automations import app_url
    from ..services.initiatives import team
    m, i = _member(db, token)
    rows = team.rows_for(db, i.id, m.id)
    for r in rows:
        r["last_touch_at"] = r["last_touch_at"].isoformat() + "Z" if r["last_touch_at"] else None
        r.pop("history", None)
    st = next((x for x in team.stats(db, i)["members"] if x["id"] == m.id), None)
    return {"member": {"name": m.name, "role": m.role, "team": m.team, "targets": m.targets or {}},
            "initiative": {"title": i.title, "key_date": i.key_date, "location": i.location, "kind": i.kind},
            "invite_link": f"{app_url()}/e/{i.public_token}?ref={m.ref}",
            "stats": (st or {}).get("stats") or {}, "rows": rows,
            "statuses": [{"key": k, "label": v} for k, v in team.STATUS_LABELS.items()],
            "channels": [{"key": k, "label": v} for k, v in team.CHANNELS.items()]}


class RepLog(BaseModel):
    outreach_id: str | None = None
    status: str | None = None
    channel: str | None = None
    note: str | None = Field(default=None, max_length=1000)
    next_step: str | None = Field(default=None, max_length=200)
    next_step_on: str | None = None
    # adding someone new to my list
    name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=200)
    company: str | None = Field(default=None, max_length=160)
    title: str | None = Field(default=None, max_length=120)
    segment: str | None = None


@router.post("/r/{token}")
def rep_log(token: str, body: RepLog, request: Request, db: Session = Depends(get_db)):
    from .initiatives import OutreachBody, _touch, add_outreach_row
    _guard(request, 120, "rep")
    m, i = _member(db, token)
    ob = OutreachBody(**body.model_dump(exclude={"outreach_id"}))
    if body.outreach_id:
        o = db.get(models.InitiativeOutreach, body.outreach_id)
        if not o or o.initiative_id != i.id or o.member_id != m.id:
            raise HTTPException(404, "That isn't on your list.")
        _touch(db, o, ob, m.name)
    else:
        o = add_outreach_row(db, i, ob, m.id, m.name)
    m.last_update_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "id": o.id, "status": o.status}
