"""
Email campaigns, sent by GD360 itself: an audience (ICP tiers, segments,
lists, chosen accounts, an initiative's registrants / attendees / no-shows /
walk-ins, the newsletter list, a job-title filter), a personalised message,
and tracking of every open, click and unsubscribe back onto the person and
their account.

Sending uses the server's email settings (RESEND_API_KEY or SMTP, plus
EMAIL_FROM - see automations.send_email). Without them a campaign can still
be exported as a CSV of personalised messages for any other email tool.
"""
from __future__ import annotations

import csv
import html
import io
import logging
import re
import threading
import time
from datetime import datetime, timedelta
from urllib.parse import quote

from sqlalchemy import func
from sqlalchemy.orm import Session

from ... import models
from ...config import get_settings
from ..automations import NotConfigured, app_url, email_configured, send_email
from . import gtm, metrics

logger = logging.getLogger(__name__)
URL_RE = re.compile(r"https?://[^\s<>()\"']+[^\s<>()\"'.,;:!?]")
_SENDING: set[str] = set()
_LOCK = threading.Lock()


def backend_url() -> str:
    return (get_settings().BACKEND_BASE_URL or "").rstrip("/")


def registration_url(i: models.Initiative) -> str:
    return f"{app_url()}/e/{i.public_token}"


# --------------------------------------------------------------- audience --

def recipients(db: Session, workspace_id: str, audience: dict | None, limit: int = 20000) -> list[models.GtmContact]:
    a = audience or {}
    C = models.GtmContact
    q = db.query(C).filter(C.workspace_id == workspace_id, C.email.isnot(None), C.unsubscribed.is_(False))
    if a.get("contact_ids"):
        q = q.filter(C.id.in_(list(a["contact_ids"])[:5000]))
    elif a.get("initiative_id") and a.get("people"):
        kinds = {"registered": ("registered", "attended", "webinar_attended"),
                 "attended": ("attended", "webinar_attended"), "walk_ins": ("walk_in",),
                 "no_shows": ("registered",)}.get(a["people"], ("registered",))
        E = models.GtmEngagement
        ids = {r[0] for r in db.query(E.contact_id).filter(E.initiative_id == a["initiative_id"], E.kind.in_(kinds),
                                                            E.contact_id.isnot(None))}
        if a["people"] == "no_shows":
            came = {r[0] for r in db.query(E.contact_id).filter(E.initiative_id == a["initiative_id"],
                                                                 E.kind.in_(("attended", "webinar_attended", "walk_in")))}
            ids -= came
        q = q.filter(C.id.in_(list(ids) or ["-"]))
    elif a.get("subscribers"):
        q = q.filter(C.subscribed.is_(True))
    elif metrics.has_audience(a):
        acc_ids = metrics.audience_query(db, workspace_id, a).with_entities(models.GtmAccount.id)
        q = q.filter(C.account_id.in_(acc_ids))
    if a.get("titles"):
        from sqlalchemy import or_
        q = q.filter(or_(*[C.title.ilike(f"%{t}%") for t in a["titles"][:10]]))
    seen, out = set(), []
    for c in q.limit(limit * 2):
        e = (c.email or "").lower()
        if e and e not in seen and gtm.valid_email(e):
            seen.add(e)
            out.append(c)
        if len(out) >= limit:
            break
    return out


def audience_count(db: Session, workspace_id: str, audience: dict | None) -> dict:
    rec = recipients(db, workspace_id, audience)
    accounts = {c.account_id for c in rec if c.account_id}
    return {"people": len(rec), "accounts": len(accounts),
            "sample": [{"name": c.name, "email": c.email, "title": c.title} for c in rec[:5]]}


# ---------------------------------------------------------------- render --

def _vars(c: models.GtmContact | None, a: models.GtmAccount | None, prof: models.GtmProfile,
          i: models.Initiative | None) -> dict:
    icp = prof.icp or {}
    name = (c.name if c else None) or ""
    first = name.split(" ")[0] if name else ""
    return {
        "first_name": first or "there", "name": name or "there", "company": (a.name if a else None) or "your team",
        "title": (c.title if c else None) or "", "sender": icp.get("sender_name") or icp.get("company_name") or "",
        "our_company": icp.get("company_name") or "", "booking_link": icp.get("booking_link") or "",
        "registration_link": registration_url(i) if i else "", "event_name": i.title if i else "",
        "event_date": (datetime.fromisoformat(i.key_date).strftime("%-d %B %Y") if i and i.key_date else ""),
        "location": (i.location if i else None) or "",
    }


def fill(text: str, values: dict) -> str:
    def rep(m):
        key = m.group(1).strip().lower()
        return str(values.get(key, m.group(0)))
    return re.sub(r"\{\{\s*([a-zA-Z_]+)\s*\}\}", rep, text or "")


def allowed_links(c: models.GtmCampaign, prof: models.GtmProfile, i: models.Initiative | None) -> set[str]:
    body = fill(c.body, _vars(None, None, prof, i))
    return set(URL_RE.findall(body))


def render(c: models.GtmCampaign, contact: models.GtmContact | None, account: models.GtmAccount | None,
           prof: models.GtmProfile, i: models.Initiative | None, token: str | None) -> tuple[str, str, str]:
    values = _vars(contact, account, prof, i)
    subject = fill(c.subject, values)
    body = fill(c.body, values)
    text = body
    base = backend_url()

    def link(url: str) -> str:
        if not token:
            return url
        return f"{base}/public/gtm/c/{token}?u={quote(url, safe='')}"

    paras = []
    for block in re.split(r"\n\s*\n", body.strip()):
        esc = html.escape(block)
        esc = URL_RE.sub(lambda m: f'<a href="{html.escape(link(html.unescape(m.group(0))))}" style="color:#0E7C5A">{m.group(0)}</a>', esc)
        paras.append(f'<p style="margin:0 0 14px;line-height:1.55">{esc.replace(chr(10), "<br>")}</p>')
    icp = prof.icp or {}
    footer = []
    if token:
        footer.append(f'<a href="{base}/public/gtm/u/{token}" style="color:#7A8582">Unsubscribe</a>')
    if icp.get("postal_address"):
        footer.append(html.escape(icp["postal_address"]))
    pixel = f'<img src="{base}/public/gtm/o/{token}.gif" width="1" height="1" alt="" style="display:block;border:0">' if token else ""
    html_body = (
        '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1B2321;'
        'max-width:600px;margin:0 auto;padding:24px 20px">' + "".join(paras) +
        (f'<p style="margin:28px 0 0;font-size:12px;color:#7A8582">{" · ".join(footer)}</p>' if footer else "") +
        pixel + "</div>")
    if token:
        text += f"\n\n--\nUnsubscribe: {base}/public/gtm/u/{token}"
        if icp.get("postal_address"):
            text += f"\n{icp['postal_address']}"
    return subject, html_body, text


# ------------------------------------------------------------------ send --

def is_sending(campaign_id: str) -> bool:
    return campaign_id in _SENDING


def sent_today(db: Session, workspace_id: str) -> int:
    S, C = models.GtmCampaignSend, models.GtmCampaign
    return (db.query(func.count(S.id)).join(C, C.id == S.campaign_id)
            .filter(C.workspace_id == workspace_id, S.status == "sent",
                    S.sent_at >= datetime.utcnow() - timedelta(days=1)).scalar() or 0)


def start(campaign_id: str) -> bool:
    with _LOCK:
        if campaign_id in _SENDING:
            return False
        _SENDING.add(campaign_id)

    def target():
        from ...database import SessionLocal
        db = SessionLocal()
        try:
            _send(db, campaign_id)
        except Exception as e:  # noqa: BLE001
            logger.exception("[gtm] campaign %s failed", campaign_id)
            db.rollback()
            c = db.get(models.GtmCampaign, campaign_id)
            if c:
                c.status, c.error = "failed", str(e)[:400]
                db.commit()
        finally:
            db.close()
            with _LOCK:
                _SENDING.discard(campaign_id)

    threading.Thread(target=target, daemon=True, name=f"gtm-send-{campaign_id[:8]}").start()
    return True


def _send(db: Session, campaign_id: str) -> None:
    c = db.get(models.GtmCampaign, campaign_id)
    if not c:
        return
    if not email_configured():
        c.status, c.error = "failed", ("Email sending isn't set up on the server yet (RESEND_API_KEY or SMTP, plus "
                                       "EMAIL_FROM). Export the campaign as a CSV to send it from another tool.")
        db.commit()
        return
    prof = gtm.profile(db, c.workspace_id)
    i = db.get(models.Initiative, c.initiative_id) if c.initiative_id else None
    c.status, c.error = "sending", None
    db.commit()
    # queue once: a resumed send skips people already queued
    existing = {s.email for s in db.query(models.GtmCampaignSend.email).filter(models.GtmCampaignSend.campaign_id == c.id)}
    for p in recipients(db, c.workspace_id, c.audience):
        if p.email.lower() not in existing:
            db.add(models.GtmCampaignSend(campaign_id=c.id, contact_id=p.id, email=p.email.lower()))
    db.commit()
    cap = get_settings().GTM_DAILY_EMAIL_CAP
    used = sent_today(db, c.workspace_id)
    queue = db.query(models.GtmCampaignSend).filter(models.GtmCampaignSend.campaign_id == c.id,
                                                    models.GtmCampaignSend.status == "queued").all()
    failed = 0
    for s in queue:
        if used >= cap:
            c.error = f"Paused at the daily limit of {cap} emails; the rest go out tomorrow when you press Send again."
            break
        contact = db.get(models.GtmContact, s.contact_id) if s.contact_id else None
        if contact and contact.unsubscribed:
            s.status = "skipped"
            continue
        acc = db.get(models.GtmAccount, contact.account_id) if contact and contact.account_id else None
        subject, html_body, text = render(c, contact, acc, prof, i, s.token)
        try:
            send_email([s.email], subject, html_body, text)
            s.status, s.sent_at = "sent", datetime.utcnow()
            used += 1
            gtm.record(db, c.workspace_id, "email_sent", account_id=acc.id if acc else None,
                       contact_id=contact.id if contact else None, initiative_id=c.initiative_id, campaign_id=c.id,
                       channel="email", rescore=False)
        except NotConfigured as e:
            c.status, c.error = "failed", str(e)
            db.commit()
            return
        except Exception as e:  # noqa: BLE001 - one bad address never stops the rest
            s.status, s.error = "failed", str(e)[:200]
            failed += 1
            if failed >= 10 and failed > len(queue) // 2:
                c.status, c.error = "failed", f"The email service keeps refusing: {str(e)[:200]}"
                db.commit()
                return
        db.commit()
        time.sleep(0.12)
    left = db.query(func.count(models.GtmCampaignSend.id)).filter(models.GtmCampaignSend.campaign_id == c.id,
                                                                  models.GtmCampaignSend.status == "queued").scalar()
    c.status = "sending" if left else "sent"
    if not left:
        c.sent_at = datetime.utcnow()
        if failed and not c.error:
            c.error = f"{failed} address{'es' if failed > 1 else ''} could not be delivered."
    if left:
        c.status = "paused"
    db.commit()


def send_test(db: Session, c: models.GtmCampaign, to: str) -> str:
    prof = gtm.profile(db, c.workspace_id)
    i = db.get(models.Initiative, c.initiative_id) if c.initiative_id else None
    sample = recipients(db, c.workspace_id, c.audience, limit=1)
    contact = sample[0] if sample else None
    acc = db.get(models.GtmAccount, contact.account_id) if contact and contact.account_id else None
    subject, html_body, text = render(c, contact, acc, prof, i, None)
    return send_email([to], f"[Test] {subject}", html_body, text)


def preview(db: Session, c: models.GtmCampaign) -> dict:
    prof = gtm.profile(db, c.workspace_id)
    i = db.get(models.Initiative, c.initiative_id) if c.initiative_id else None
    sample = recipients(db, c.workspace_id, c.audience, limit=1)
    contact = sample[0] if sample else None
    acc = db.get(models.GtmAccount, contact.account_id) if contact and contact.account_id else None
    subject, html_body, text = render(c, contact, acc, prof, i, None)
    return {"subject": subject, "text": text, "to": (contact.name or contact.email) if contact else None}


def export_csv(db: Session, c: models.GtmCampaign) -> str:
    prof = gtm.profile(db, c.workspace_id)
    i = db.get(models.Initiative, c.initiative_id) if c.initiative_id else None
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["email", "name", "title", "company", "tier", "subject", "body"])
    for p in recipients(db, c.workspace_id, c.audience):
        acc = db.get(models.GtmAccount, p.account_id) if p.account_id else None
        subject, _, text = render(c, p, acc, prof, i, None)
        w.writerow([p.email, p.name or "", p.title or "", acc.name if acc else "", (acc.icp_tier if acc else "") or "",
                    subject, text])
    return buf.getvalue()


def stats(db: Session, c: models.GtmCampaign) -> dict:
    S = models.GtmCampaignSend
    rows = dict(db.query(S.status, func.count()).filter(S.campaign_id == c.id).group_by(S.status).all())
    sent = rows.get("sent", 0)
    opened, clicked = db.query(func.count(S.opened_at), func.count(S.clicked_at)).filter(
        S.campaign_id == c.id, S.status == "sent").one()
    unsub = db.query(func.count(models.GtmEngagement.id)).filter(
        models.GtmEngagement.campaign_id == c.id, models.GtmEngagement.kind == "note",
        models.GtmEngagement.channel == "unsubscribe").scalar() or 0
    return {"queued": rows.get("queued", 0), "sent": sent, "failed": rows.get("failed", 0),
            "skipped": rows.get("skipped", 0), "opened": opened, "clicked": clicked, "unsubscribed": unsub,
            "open_rate": round(100 * opened / sent, 1) if sent else None,
            "click_rate": round(100 * clicked / sent, 1) if sent else None}


# --------------------------------------------------------------- tracking --

def on_open(db: Session, token: str) -> None:
    s = db.query(models.GtmCampaignSend).filter(models.GtmCampaignSend.token == token).first()
    if not s or s.opened_at:
        return
    s.opened_at = datetime.utcnow()
    _signal(db, s, "email_open")
    db.commit()


def on_click(db: Session, token: str, url: str) -> str | None:
    """The URL to send the reader on to, or None when it isn't one of the
    campaign's own links (never an open redirect)."""
    s = db.query(models.GtmCampaignSend).filter(models.GtmCampaignSend.token == token).first()
    if not s:
        return None
    c = db.get(models.GtmCampaign, s.campaign_id)
    if not c:
        return None
    i = db.get(models.Initiative, c.initiative_id) if c.initiative_id else None
    if url not in allowed_links(c, gtm.profile(db, c.workspace_id), i):
        return None
    if not s.opened_at:
        s.opened_at = datetime.utcnow()
    if not s.clicked_at:
        s.clicked_at = datetime.utcnow()
        _signal(db, s, "email_click", {"url": url[:300]})
    db.commit()
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}gd_t={token}"


def on_unsubscribe(db: Session, token: str) -> bool:
    s = db.query(models.GtmCampaignSend).filter(models.GtmCampaignSend.token == token).first()
    if not s:
        return False
    c = db.get(models.GtmContact, s.contact_id) if s.contact_id else None
    if c and not c.unsubscribed:
        c.unsubscribed, c.subscribed = True, False
        camp = db.get(models.GtmCampaign, s.campaign_id)
        gtm.record(db, camp.workspace_id if camp else c.workspace_id, "note", account_id=c.account_id,
                   contact_id=c.id, campaign_id=s.campaign_id, channel="unsubscribe",
                   detail={"text": "Unsubscribed from emails"}, rescore=False)
    db.commit()
    return True


def _signal(db: Session, s: models.GtmCampaignSend, kind: str, detail: dict | None = None) -> None:
    c = db.get(models.GtmCampaign, s.campaign_id)
    contact = db.get(models.GtmContact, s.contact_id) if s.contact_id else None
    if not c:
        return
    gtm.record(db, c.workspace_id, kind, account_id=contact.account_id if contact else None,
               contact_id=contact.id if contact else None, initiative_id=c.initiative_id, campaign_id=c.id,
               channel="email", detail={"campaign": c.name, **(detail or {})})


def due_scheduled(db: Session, now: datetime) -> list[str]:
    rows = db.query(models.GtmCampaign.id).filter(models.GtmCampaign.status == "scheduled",
                                                  models.GtmCampaign.scheduled_at <= now).limit(5).all()
    return [r[0] for r in rows]
