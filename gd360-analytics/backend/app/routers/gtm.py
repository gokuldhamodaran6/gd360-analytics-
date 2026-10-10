"""
Accounts (2026-10-10) - the account-based marketing centre behind
Initiatives: the ideal customer profile, target accounts and their people,
every engagement signal, sources (CSV / Apollo / HubSpot / IPinfo / the
website snippet) and email campaigns. Workspace-scoped like Initiatives.

Privacy: a person's data can be exported (GET /gtm/contacts/{id}/export) or
erased with every signal tied to them (DELETE /gtm/contacts/{id}); both are
audited.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from .. import models
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..security import encrypt_secret
from ..services.audit import log_audit_event
from ..services.automations import NotConfigured, email_configured
from ..services.initiatives import campaigns, gtm, metrics, tracking
from .initiatives import _iso, _read_upload, author, initiative_for, workspace_for

router = APIRouter(prefix="/gtm", tags=["gtm"])
PROVIDERS = {"apollo": gtm.apollo_test, "hubspot": gtm.hubspot_test, "ipinfo": gtm.ipinfo_test}


def _account_of(db: Session, user: models.User, account_id: str, edit: bool = False) -> models.GtmAccount:
    a = db.get(models.GtmAccount, account_id)
    if not a:
        raise HTTPException(404, "Account not found.")
    workspace_for(db, user, a.workspace_id, edit=edit)
    return a


def _row(a: models.GtmAccount) -> dict:
    r = metrics.account_row(a)
    r["last_engaged_at"] = _iso(r["last_engaged_at"])
    return r


# ================================================================= profile ==

@router.get("/profile")
def get_profile(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, workspace_id)
    p = gtm.profile(db, ws)
    backend = campaigns.backend_url()
    last_visit = db.query(func.max(models.GtmEngagement.occurred_at)).filter(
        models.GtmEngagement.workspace_id == ws, models.GtmEngagement.kind == "visit").scalar()
    conns = []
    for c in db.query(models.GtmConnection).filter(models.GtmConnection.workspace_id == ws):
        conns.append({"provider": c.provider, "status": "syncing" if gtm.is_syncing(ws, c.provider) else c.status,
                      "masked": c.masked, "last_sync_at": _iso(c.last_sync_at), "last_error": c.last_error,
                      "last_result": (c.meta or {}).get("last_result")})
    s = get_settings()
    return {"workspace_id": ws, "icp": p.icp or {}, "icp_set": gtm.icp_is_set(p.icp),
            "snippet": tracking.snippet(p.site_key, backend), "site_key": p.site_key,
            "tracking": {"last_visit_at": _iso(last_visit), "live": bool(last_visit)},
            "connections": conns,
            "email": {"configured": email_configured(), "daily_cap": s.GTM_DAILY_EMAIL_CAP,
                      "sent_today": campaigns.sent_today(db, ws)}}


class ProfileBody(BaseModel):
    workspace_id: str | None = None
    icp: dict


@router.put("/profile")
def put_profile(body: ProfileBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, body.workspace_id, edit=True)
    p = gtm.profile(db, ws)
    p.icp = gtm.clean_icp(body.icp)
    p.updated_at = datetime.utcnow()
    db.commit()
    n = gtm.rescore_all(db, ws)
    log_audit_event(db, actor=user, action="gtm.icp_update", workspace_id=ws, target_type="gtm_profile", target_id=p.id)
    db.commit()
    return {"ok": True, "rescored": n, "icp": p.icp}


@router.post("/profile/suggest")
def suggest(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, workspace_id)
    return gtm.suggest_icp(db, ws)


@router.get("/overview")
def overview(workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, workspace_id)
    o = metrics.overview(db, ws)
    for r in o["surging"] + o["new_visitors"]:
        r["last_engaged_at"] = _iso(r["last_engaged_at"])
    for f in o["feed"]:
        f["occurred_at"] = _iso(f["occurred_at"])
    return o


# ================================================================ accounts ==

SORTS = {
    "icp": (models.GtmAccount.icp_score.desc().nullslast(), models.GtmAccount.engagement_score.desc()),
    "engagement": (models.GtmAccount.engagement_score.desc(), models.GtmAccount.icp_score.desc().nullslast()),
    "surging": (models.GtmAccount.engagement_7d.desc(), models.GtmAccount.engagement_score.desc()),
    "recent": (models.GtmAccount.last_engaged_at.desc().nullslast(),),
    "name": (models.GtmAccount.name.asc(),),
    "employees": (models.GtmAccount.employees.desc().nullslast(),),
}


def _filtered(db: Session, ws: str, q: str | None, tier: str | None, segment: str | None, list_name: str | None,
              heat: str | None, country: str | None, source: str | None):
    A = models.GtmAccount
    query = db.query(A).filter(A.workspace_id == ws)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(or_(A.name.ilike(like), A.domain.ilike(like), A.industry.ilike(like)))
    if tier:
        tiers = [t for t in tier.split(",") if t]
        query = query.filter(or_(A.icp_tier.in_([t for t in tiers if t != "none"]),
                                 *([A.icp_tier.is_(None)] if "none" in tiers else [])))
    if segment:
        query = query.filter(A.segment == segment)
    if list_name:
        query = query.filter(A.list_name == list_name)
    if country:
        query = query.filter(A.country == country)
    if source:
        query = query.filter(A.source == source)
    if heat == "hot":
        query = query.filter(A.engagement_score >= 20)
    elif heat == "warm":
        query = query.filter(A.engagement_score >= 6, A.engagement_score < 20)
    elif heat == "cold":
        query = query.filter(A.engagement_score < 6)
    return query


@router.get("/accounts")
def list_accounts(workspace_id: str | None = None, q: str | None = None, tier: str | None = None, segment: str | None = None,
                  list_name: str | None = None, heat: str | None = None, country: str | None = None,
                  source: str | None = None, sort: str = "icp", page: int = 1, size: int = 50,
                  db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, workspace_id)
    query = _filtered(db, ws, q, tier, segment, list_name, heat, country, source)
    total = query.count()
    size = min(max(size, 10), 200)
    page = max(page, 1)
    rows = query.order_by(*SORTS.get(sort, SORTS["icp"])).offset((page - 1) * size).limit(size).all()
    A = models.GtmAccount
    ids = [a.id for a in rows]
    people = dict(db.query(models.GtmContact.account_id, func.count()).filter(models.GtmContact.account_id.in_(ids or ["-"]))
                  .group_by(models.GtmContact.account_id).all())

    def facet(col):
        return [{"value": v, "n": n} for v, n in db.query(col, func.count()).filter(A.workspace_id == ws, col.isnot(None))
                .group_by(col).order_by(func.count().desc()).limit(40)]

    return {"total": total, "page": page, "size": size,
            "rows": [{**_row(a), "people": people.get(a.id, 0)} for a in rows],
            "facets": {"segments": facet(A.segment), "lists": facet(A.list_name), "countries": facet(A.country),
                       "sources": facet(A.source)}}


@router.get("/accounts.csv")
def export_accounts(workspace_id: str | None = None, q: str | None = None, tier: str | None = None, segment: str | None = None,
                    list_name: str | None = None, heat: str | None = None, country: str | None = None,
                    source: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, workspace_id)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["name", "domain", "industry", "employees", "revenue", "country", "city", "segment", "list", "icp_score",
                "icp_tier", "engagement_score", "engagement_7d", "last_engaged_at", "source", "owner"])
    for a in _filtered(db, ws, q, tier, segment, list_name, heat, country, source).order_by(*SORTS["icp"]).limit(50000):
        w.writerow([a.name, a.domain or "", a.industry or "", a.employees or "", a.revenue or "", a.country or "",
                    a.city or "", a.segment or "", a.list_name or "", a.icp_score if a.icp_score is not None else "",
                    a.icp_tier or "", a.engagement_score or 0, a.engagement_7d or 0, _iso(a.last_engaged_at) or "",
                    a.source or "", a.owner_name or ""])
    log_audit_event(db, actor=user, action="gtm.accounts_export", workspace_id=ws, target_type="gtm_accounts")
    db.commit()
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="accounts.csv"'})


@router.get("/accounts/{account_id}")
def get_account(account_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    a = _account_of(db, user, account_id)
    p = gtm.profile(db, a.workspace_id)
    E = models.GtmEngagement
    evs = db.query(E).filter(E.account_id == a.id).order_by(E.occurred_at.desc()).limit(150).all()
    contacts = {c.id: c for c in db.query(models.GtmContact).filter(models.GtmContact.account_id == a.id)}
    inits = {i.id: i for i in db.query(models.Initiative).filter(
        models.Initiative.id.in_({e.initiative_id for e in evs if e.initiative_id} or {"-"}))}
    timeline = []
    for e in evs:
        if e.kind == "email_sent":
            continue
        r = metrics.engagement_row(db, e, {a.id: a}, contacts)
        r["occurred_at"] = _iso(r["occurred_at"])
        r["initiative"] = inits[e.initiative_id].title if e.initiative_id in inits else None
        timeline.append(r)
    counts = dict(db.query(E.kind, func.count()).filter(E.account_id == a.id).group_by(E.kind).all())
    lp = gtm.likely_people(db, a, p.icp)
    rems = db.query(models.GtmReminder).filter(models.GtmReminder.account_id == a.id, models.GtmReminder.done.is_(False)).all()
    on_boards = db.query(models.InitiativeItem, models.Initiative).join(
        models.Initiative, models.Initiative.id == models.InitiativeItem.initiative_id).filter(
        models.InitiativeItem.account_id == a.id).all()
    return {**_row(a), "linkedin_url": a.linkedin_url, "notes": a.notes, "icp_reasons": a.icp_reasons or [],
            "region": a.region, "external_ids": a.external_ids or {},
            "people": lp["people"], "personas": lp["personas"], "timeline": timeline, "counts": counts,
            "initiatives": [{"id": i.id, "title": i.title} for i in inits.values()],
            "boards": [{"initiative_id": i.id, "initiative": i.title, "stage": it.stage, "item_id": it.id} for it, i in on_boards],
            "reminders": [{"id": r.id, "note": r.note, "remind_at": _iso(r.remind_at)} for r in rems],
            "apollo": bool(gtm.connection(db, a.workspace_id, "apollo"))}


class AccountBody(BaseModel):
    workspace_id: str | None = None
    name: str | None = Field(default=None, max_length=200)
    domain: str | None = Field(default=None, max_length=200)
    industry: str | None = Field(default=None, max_length=120)
    employees: int | None = None
    revenue: float | None = None
    country: str | None = Field(default=None, max_length=80)
    city: str | None = Field(default=None, max_length=80)
    segment: str | None = Field(default=None, max_length=80)
    list_name: str | None = Field(default=None, max_length=80)
    owner_name: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=4000)
    linkedin_url: str | None = Field(default=None, max_length=300)


@router.post("/accounts")
def add_account(body: AccountBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, body.workspace_id, edit=True)
    if not (body.name or body.domain):
        raise HTTPException(422, "Add a company name or website.")
    idx = gtm.AccountIndex(db, ws)
    a, created = idx.upsert(body.model_dump(exclude={"workspace_id"}), "manual")
    if not a:
        raise HTTPException(409, f"An account list holds up to {gtm.MAX_ACCOUNTS:,} accounts.")
    db.flush()
    a.icp_score, a.icp_tier, a.icp_reasons = gtm.score_icp(a, gtm.profile(db, ws).icp)
    db.commit()
    return {**_row(a), "created": created}


@router.patch("/accounts/{account_id}")
def patch_account(account_id: str, body: AccountBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    a = _account_of(db, user, account_id, edit=True)
    data = body.model_dump(exclude_unset=True, exclude={"workspace_id"})
    for k, v in data.items():
        if k == "domain":
            v = gtm.norm_domain(v)
        setattr(a, k, v.strip() if isinstance(v, str) else v)
    a.updated_at = datetime.utcnow()
    a.icp_score, a.icp_tier, a.icp_reasons = gtm.score_icp(a, gtm.profile(db, a.workspace_id).icp)
    db.commit()
    return _row(a)


class BulkBody(BaseModel):
    workspace_id: str | None = None
    ids: list[str] = Field(default_factory=list, max_length=5000)
    segment: str | None = None
    list_name: str | None = None
    owner_name: str | None = None
    delete: bool = False


@router.post("/accounts/bulk")
def bulk(body: BulkBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, body.workspace_id, edit=True)
    rows = db.query(models.GtmAccount).filter(models.GtmAccount.workspace_id == ws, models.GtmAccount.id.in_(body.ids or ["-"])).all()
    if body.delete:
        ids = [a.id for a in rows]
        db.query(models.GtmContact).filter(models.GtmContact.account_id.in_(ids or ["-"])).update(
            {models.GtmContact.account_id: None}, synchronize_session=False)
        db.query(models.GtmEngagement).filter(models.GtmEngagement.account_id.in_(ids or ["-"])).delete(synchronize_session=False)
        for a in rows:
            db.delete(a)
        log_audit_event(db, actor=user, action="gtm.accounts_delete", workspace_id=ws, metadata={"count": len(ids)})
    else:
        for a in rows:
            if body.segment is not None:
                a.segment = body.segment.strip() or None
            if body.list_name is not None:
                a.list_name = body.list_name.strip() or None
            if body.owner_name is not None:
                a.owner_name = body.owner_name.strip() or None
    db.commit()
    return {"ok": True, "count": len(rows)}


class ActivityBody(BaseModel):
    kind: str
    text: str | None = Field(default=None, max_length=2000)
    initiative_id: str | None = None
    contact_id: str | None = None
    occurred_at: str | None = None
    channel: str | None = Field(default=None, max_length=40)


@router.post("/accounts/{account_id}/activity")
def log_activity(account_id: str, body: ActivityBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    a = _account_of(db, user, account_id, edit=True)
    if body.kind not in ("meeting", "call", "note", "social", "opportunity", "email_reply", "event"):
        raise HTTPException(422, "Unknown activity.")
    kind = {"email_reply": "email_click", "event": "attended"}.get(body.kind, body.kind)
    if body.initiative_id:
        i = initiative_for(db, user, body.initiative_id)
        if i.workspace_id != a.workspace_id:
            raise HTTPException(422, "That initiative is in another workspace.")
    when = None
    if body.occurred_at:
        try:
            when = datetime.fromisoformat(body.occurred_at.replace("Z", "")[:19])
        except ValueError:
            raise HTTPException(422, "Use a date like 2026-10-10.")
    gtm.record(db, a.workspace_id, kind, account_id=a.id, contact_id=body.contact_id, initiative_id=body.initiative_id,
               channel=body.channel or "manual", detail={"text": body.text, "by": author(user)}, occurred_at=when)
    db.commit()
    return _row(a)


@router.post("/accounts/{account_id}/find-people")
def find_people(account_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    a = _account_of(db, user, account_id, edit=True)
    key = gtm.secret_of(gtm.connection(db, a.workspace_id, "apollo"))
    if not key:
        raise HTTPException(409, "Connect Apollo (Accounts → Sources) to find people automatically.")
    if not a.domain:
        raise HTTPException(422, "Add the company's website first - Apollo finds people by domain.")
    icp = gtm.profile(db, a.workspace_id).icp or {}
    try:
        found = gtm.apollo_people(key, a.domain, icp.get("titles"))
    except gtm.ConnectorError as e:
        raise HTTPException(502, str(e))
    added = 0
    for p in found:
        if gtm.upsert_contact(db, a.workspace_id, {**p, "company": a.name}, "apollo", account=a):
            added += 1
    db.commit()
    return {"found": len(found), "added": added}


# ================================================================ contacts ==

class ContactBody(BaseModel):
    workspace_id: str | None = None
    account_id: str | None = None
    name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=200)
    title: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=60)
    linkedin_url: str | None = Field(default=None, max_length=300)
    company: str | None = Field(default=None, max_length=160)
    subscribed: bool = False


@router.post("/contacts")
def add_contact(body: ContactBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    acc = _account_of(db, user, body.account_id, edit=True) if body.account_id else None
    ws = acc.workspace_id if acc else workspace_for(db, user, body.workspace_id, edit=True)
    if body.email and not gtm.valid_email(body.email):
        raise HTTPException(422, "That email doesn't look right.")
    c = gtm.upsert_contact(db, ws, body.model_dump(exclude={"workspace_id", "account_id"}), "manual", account=acc)
    if not c:
        raise HTTPException(422, "Add at least a name or an email.")
    db.commit()
    return {"id": c.id}


@router.get("/contacts")
def list_contacts(workspace_id: str | None = None, q: str | None = None, subscribed: bool | None = None,
                  page: int = 1, size: int = 50, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, workspace_id)
    C = models.GtmContact
    query = db.query(C).filter(C.workspace_id == ws)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(or_(C.name.ilike(like), C.email.ilike(like), C.title.ilike(like)))
    if subscribed is not None:
        query = query.filter(C.subscribed.is_(subscribed), C.unsubscribed.is_(False))
    total = query.count()
    size = min(max(size, 10), 200)
    rows = query.order_by(C.created_at.desc()).offset((max(page, 1) - 1) * size).limit(size).all()
    accs = {a.id: a for a in db.query(models.GtmAccount).filter(models.GtmAccount.id.in_({c.account_id for c in rows if c.account_id} or {"-"}))}
    return {"total": total, "rows": [{"id": c.id, "name": c.name, "email": c.email, "title": c.title, "seniority": c.seniority,
                                      "account_id": c.account_id, "company": accs[c.account_id].name if c.account_id in accs else None,
                                      "tier": accs[c.account_id].icp_tier if c.account_id in accs else None,
                                      "subscribed": bool(c.subscribed), "unsubscribed": bool(c.unsubscribed),
                                      "source": c.source, "linkedin_url": c.linkedin_url} for c in rows]}


def _contact_of(db: Session, user: models.User, contact_id: str, edit: bool = False) -> models.GtmContact:
    c = db.get(models.GtmContact, contact_id)
    if not c:
        raise HTTPException(404, "Person not found.")
    workspace_for(db, user, c.workspace_id, edit=edit)
    return c


@router.get("/contacts/{contact_id}/export")
def export_contact(contact_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Everything GD360 holds about one person (a data-subject access request)."""
    c = _contact_of(db, user, contact_id, edit=True)
    evs = db.query(models.GtmEngagement).filter(models.GtmEngagement.contact_id == c.id).all()
    sends = db.query(models.GtmCampaignSend).filter(models.GtmCampaignSend.contact_id == c.id).all()
    log_audit_event(db, actor=user, action="gtm.contact_export", workspace_id=c.workspace_id, target_type="gtm_contact", target_id=c.id)
    db.commit()
    return {"person": {k: getattr(c, k) for k in ("name", "email", "title", "seniority", "phone", "linkedin_url", "country",
                                                  "source", "subscribed", "unsubscribed", "lists")} | {"created_at": _iso(c.created_at)},
            "activity": [{"kind": e.kind, "channel": e.channel, "at": _iso(e.occurred_at), "detail": e.detail} for e in evs],
            "emails": [{"status": s.status, "sent_at": _iso(s.sent_at), "opened_at": _iso(s.opened_at), "clicked_at": _iso(s.clicked_at)} for s in sends]}


@router.delete("/contacts/{contact_id}")
def erase_contact(contact_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Erases the person and every signal tied to them (right to erasure).
    Account-level counts are recomputed."""
    c = _contact_of(db, user, contact_id, edit=True)
    aid = c.account_id
    db.query(models.GtmEngagement).filter(models.GtmEngagement.contact_id == c.id).delete(synchronize_session=False)
    db.query(models.GtmCampaignSend).filter(models.GtmCampaignSend.contact_id == c.id).update(
        {models.GtmCampaignSend.email: "erased", models.GtmCampaignSend.contact_id: None}, synchronize_session=False)
    log_audit_event(db, actor=user, action="gtm.contact_erase", workspace_id=c.workspace_id, target_type="gtm_contact", target_id=c.id)
    db.delete(c)
    db.flush()
    if aid:
        a = db.get(models.GtmAccount, aid)
        if a:
            gtm.recompute_account(db, a)
    db.commit()
    return {"ok": True}


class SubBody(BaseModel):
    subscribed: bool


@router.post("/contacts/{contact_id}/subscription")
def set_subscription(contact_id: str, body: SubBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    c = _contact_of(db, user, contact_id, edit=True)
    if body.subscribed and c.unsubscribed:
        raise HTTPException(409, "This person unsubscribed - only they can opt back in (through a sign-up form).")
    c.subscribed = body.subscribed
    db.commit()
    return {"ok": True}


# ================================================================== import ==

@router.post("/import")
async def import_csv(file: UploadFile = File(...), workspace_id: str | None = Form(None), kind: str = Form("auto"),
                     source: str = Form("csv"), list_name: str | None = Form(None), segment: str | None = Form(None),
                     signal: str | None = Form(None), initiative_id: str | None = Form(None), subscribe: bool = Form(False),
                     commit: bool = Form(False), mapping: str | None = Form(None),
                     db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """commit=false: preview (columns matched, kind detected, sample).
    commit=true: import, with an optional corrected mapping (JSON)."""
    ws = workspace_for(db, user, workspace_id, edit=True)
    raw = await _read_upload(file)
    try:
        prev = gtm.preview(raw)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if not commit:
        return prev
    import json
    m = prev["mapping"]
    if mapping:
        try:
            m = {k: v for k, v in json.loads(mapping).items() if v}
        except ValueError:
            raise HTTPException(422, "The column mapping isn't valid.")
    k = prev["kind"] if kind == "auto" else kind
    if k not in ("accounts", "contacts", "signals"):
        raise HTTPException(422, "Import accounts, contacts or signals.")
    if k == "signals" and signal not in gtm.SIGNAL_KINDS:
        raise HTTPException(422, "Pick what each row is (registered, attended, social ...).")
    if initiative_id:
        i = initiative_for(db, user, initiative_id, edit=True)
        if i.workspace_id != ws:
            raise HTTPException(422, "That initiative is in another workspace.")
    _, rows = gtm.read_csv(raw)
    stats = gtm.apply_import(db, ws, rows, m, k, source=(source or "csv")[:30], list_name=(list_name or "").strip() or None,
                             segment=(segment or "").strip() or None, signal=signal, initiative_id=initiative_id,
                             subscribe=subscribe)
    log_audit_event(db, actor=user, action="gtm.import", workspace_id=ws, metadata={"kind": k, "source": source, **stats})
    db.commit()
    return {"ok": True, "kind": k, **stats}


# ============================================================= connections ==

class ConnectBody(BaseModel):
    workspace_id: str | None = None
    key: str = Field(min_length=6, max_length=400)


@router.put("/connections/{provider}")
def connect(provider: str, body: ConnectBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    if provider not in PROVIDERS:
        raise HTTPException(404, "Unknown provider.")
    ws = workspace_for(db, user, body.workspace_id, edit=True)
    key = body.key.strip()
    try:
        msg = PROVIDERS[provider](key)
    except gtm.ConnectorError as e:
        raise HTTPException(422, str(e))
    c = gtm.connection(db, ws, provider) or models.GtmConnection(workspace_id=ws, provider=provider, created_by=user.id)
    c.secret_enc, c.masked, c.status, c.last_error = encrypt_secret(key), f"••••{key[-4:]}", "connected", None
    db.add(c)
    log_audit_event(db, actor=user, action="gtm.connect", workspace_id=ws, target_type="gtm_connection", metadata={"provider": provider})
    db.commit()
    return {"ok": True, "message": msg}


@router.delete("/connections/{provider}")
def disconnect(provider: str, workspace_id: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, workspace_id, edit=True)
    c = gtm.connection(db, ws, provider)
    if c:
        db.delete(c)
        log_audit_event(db, actor=user, action="gtm.disconnect", workspace_id=ws, metadata={"provider": provider})
        db.commit()
    return {"ok": True}


class SyncBody(BaseModel):
    workspace_id: str | None = None
    limit: int = 500
    list_name: str | None = Field(default=None, max_length=80)
    keywords: list[str] | None = None


@router.post("/connections/{provider}/sync")
def sync(provider: str, body: SyncBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    if provider not in ("apollo", "hubspot"):
        raise HTTPException(422, "Only Apollo and HubSpot bring accounts in.")
    ws = workspace_for(db, user, body.workspace_id, edit=True)
    if not gtm.connection(db, ws, provider):
        raise HTTPException(409, "Connect it first.")
    if provider == "apollo" and not gtm.icp_is_set(gtm.profile(db, ws).icp) and not body.keywords:
        raise HTTPException(409, "Set your ideal customer profile first - Apollo pulls the companies that match it.")
    started = gtm.start_sync(ws, provider, body.model_dump())
    log_audit_event(db, actor=user, action="gtm.sync", workspace_id=ws, metadata={"provider": provider, "limit": body.limit})
    db.commit()
    return {"started": started}


# =============================================================== campaigns ==

class CampaignBody(BaseModel):
    workspace_id: str | None = None
    initiative_id: str | None = None
    name: str | None = Field(default=None, max_length=120)
    subject: str | None = Field(default=None, max_length=200)
    body: str | None = Field(default=None, max_length=20000)
    audience: dict | None = None


def _camp_of(db: Session, user: models.User, cid: str, edit: bool = False) -> models.GtmCampaign:
    c = db.get(models.GtmCampaign, cid)
    if not c:
        raise HTTPException(404, "Campaign not found.")
    workspace_for(db, user, c.workspace_id, edit=edit)
    return c


def _camp(db: Session, c: models.GtmCampaign, full: bool = False) -> dict:
    out = {"id": c.id, "name": c.name, "subject": c.subject, "status": "sending" if campaigns.is_sending(c.id) else c.status,
           "initiative_id": c.initiative_id, "audience": c.audience or {}, "audience_text": metrics.audience_text(c.audience),
           "scheduled_at": _iso(c.scheduled_at), "sent_at": _iso(c.sent_at), "error": c.error,
           "created_at": _iso(c.created_at), **campaigns.stats(db, c)}
    if full:
        out["body"] = c.body
    return out


def _clean_audience(a: dict | None) -> dict:
    a = a or {}
    out = {k: [str(x)[:80] for x in (a.get(k) or [])][:50] for k in ("tiers", "segments", "lists", "countries", "titles") if a.get(k)}
    if a.get("subscribers"):
        out["subscribers"] = True
    if a.get("initiative_id") and a.get("people") in ("registered", "attended", "no_shows", "walk_ins"):
        out["initiative_id"], out["people"] = a["initiative_id"], a["people"]
    if a.get("account_ids"):
        out["account_ids"] = [str(x) for x in a["account_ids"]][:5000]
    return out


@router.get("/campaigns")
def list_campaigns(workspace_id: str | None = None, initiative_id: str | None = None, db: Session = Depends(get_db),
                   user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, workspace_id)
    q = db.query(models.GtmCampaign).filter(models.GtmCampaign.workspace_id == ws)
    if initiative_id:
        q = q.filter(models.GtmCampaign.initiative_id == initiative_id)
    return [_camp(db, c) for c in q.order_by(models.GtmCampaign.created_at.desc()).limit(200)]


@router.post("/campaigns")
def create_campaign(body: CampaignBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    i = initiative_for(db, user, body.initiative_id, edit=True) if body.initiative_id else None
    ws = i.workspace_id if i else workspace_for(db, user, body.workspace_id, edit=True)
    c = models.GtmCampaign(workspace_id=ws, initiative_id=i.id if i else None, owner_id=user.id,
                           name=(body.name or body.subject or "New campaign").strip()[:120], subject=(body.subject or "").strip(),
                           body=body.body or "", audience=_clean_audience(body.audience) or (i.audience if i else {}) or {},
                           status="draft")
    db.add(c)
    db.commit()
    return _camp(db, c, full=True)


@router.get("/campaigns/{cid}")
def get_campaign(cid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    c = _camp_of(db, user, cid)
    return {**_camp(db, c, full=True), "preview": campaigns.preview(db, c), "count": campaigns.audience_count(db, c.workspace_id, c.audience)}


@router.patch("/campaigns/{cid}")
def patch_campaign(cid: str, body: CampaignBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    c = _camp_of(db, user, cid, edit=True)
    if c.status in ("sending", "sent") or campaigns.is_sending(c.id):
        raise HTTPException(409, "This campaign has gone out - duplicate it to change it.")
    data = body.model_dump(exclude_unset=True)
    for f in ("name", "subject", "body"):
        if f in data and data[f] is not None:
            setattr(c, f, data[f])
    if "audience" in data:
        c.audience = _clean_audience(data["audience"])
    if c.status == "scheduled":
        c.status = "draft"
    db.commit()
    return _camp(db, c, full=True)


@router.delete("/campaigns/{cid}")
def delete_campaign(cid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    c = _camp_of(db, user, cid, edit=True)
    if c.status == "sending" or campaigns.is_sending(c.id):
        raise HTTPException(409, "Wait until sending finishes.")
    if db.query(models.GtmCampaignSend.id).filter(models.GtmCampaignSend.campaign_id == c.id, models.GtmCampaignSend.status == "sent").first():
        raise HTTPException(409, "Sent campaigns are kept for their results.")
    db.query(models.GtmCampaignSend).filter(models.GtmCampaignSend.campaign_id == c.id).delete(synchronize_session=False)
    db.delete(c)
    db.commit()
    return {"ok": True}


class CountBody(BaseModel):
    workspace_id: str | None = None
    audience: dict | None = None


@router.post("/audience/count")
def count(body: CountBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = workspace_for(db, user, body.workspace_id)
    return campaigns.audience_count(db, ws, _clean_audience(body.audience))


class TestBody(BaseModel):
    to: str | None = None


@router.post("/campaigns/{cid}/test")
def test_send(cid: str, body: TestBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    c = _camp_of(db, user, cid, edit=True)
    to = (body.to or user.email).strip()
    if not gtm.valid_email(to):
        raise HTTPException(422, "That email doesn't look right.")
    try:
        campaigns.send_test(db, c, to)
    except NotConfigured as e:
        raise HTTPException(409, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"The email service refused it: {str(e)[:200]}")
    return {"ok": True, "to": to}


class SendBody(BaseModel):
    scheduled_at: str | None = None
    confirm_count: int | None = None


@router.post("/campaigns/{cid}/send")
def send(cid: str, body: SendBody, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    c = _camp_of(db, user, cid, edit=True)
    if not c.subject.strip() or not c.body.strip():
        raise HTTPException(422, "Write a subject and a message first.")
    if not email_configured():
        raise HTTPException(409, "Email sending isn't set up on the server yet. Export the campaign as a CSV for your email tool, or ask an admin to add the email settings.")
    if c.status == "sent":
        raise HTTPException(409, "Already sent.")
    n = campaigns.audience_count(db, c.workspace_id, c.audience)["people"]
    if not n:
        raise HTTPException(422, "Nobody in this audience has an email address (or everyone unsubscribed).")
    if body.confirm_count is not None and body.confirm_count != n:
        raise HTTPException(409, f"The audience changed to {n} people - check it and confirm again.")
    if body.scheduled_at:
        try:
            c.scheduled_at = datetime.fromisoformat(body.scheduled_at.replace("Z", "")[:19])
        except ValueError:
            raise HTTPException(422, "Use a time like 2026-10-12T09:00.")
        c.status = "scheduled"
    else:
        c.status = "queued"
    log_audit_event(db, actor=user, action="gtm.campaign_send", workspace_id=c.workspace_id, target_type="gtm_campaign",
                    target_id=c.id, metadata={"people": n, "scheduled": body.scheduled_at})
    if c.initiative_id:
        i = db.get(models.Initiative, c.initiative_id)
        if i:
            tracking.log(db, i, f"Email “{c.name}” {'scheduled' if body.scheduled_at else 'sending'} to {n:,} people.",
                         author(user), kind="milestone", channel="email")
    db.commit()
    if not body.scheduled_at:
        campaigns.start(c.id)
    return _camp(db, c)


@router.get("/campaigns/{cid}/export")
def export_campaign(cid: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    c = _camp_of(db, user, cid, edit=True)
    log_audit_event(db, actor=user, action="gtm.campaign_export", workspace_id=c.workspace_id, target_id=c.id)
    db.commit()
    return Response(campaigns.export_csv(db, c), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="campaign.csv"'})
