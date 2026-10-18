"""2026-10-17 (R53): the other platforms.

  Luma            webhook: a guest registering or checking in counts as a registration / attendance for the
                  initiative (needs Luma Plus for webhooks; the URL carries a secret)
  Microsoft Teams attendance pulled from Microsoft Graph after the meeting (GET /users/{organizer}/onlineMeetings/
                  {meeting}/attendanceReports, then attendanceRecords) with an Azure app's client credentials
                  (application permission OnlineMeetingArtifact.Read.All plus an application access policy). A Teams
                  attendance CSV can be imported instead, with no app.
  LinkedIn        @mentions of your page (Community Management API: needs LinkedIn's app review; until then the call
                  is refused and the page says so)
  Conversions     each registration is sent back to the ad platforms that brought it:
                  Meta Conversions API (pixel + token), LinkedIn Conversions API (conversion rule + token),
                  Google Ads click conversions (needs a gclid on the registration, a developer token and basic access)
Secrets are stored encrypted in the business profile's integrations; the page never sees them again.
"""
from __future__ import annotations

import csv
import hashlib
import io
import secrets
from datetime import datetime

import requests
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ... import models
from ...security import decrypt_secret, encrypt_secret

TIMEOUT = 15
SECRET_FIELDS = {"slack_webhook", "teams_webhook", "meta_capi_token", "linkedin_capi_token", "google_ads_developer_token", "google_ads_refresh_token", "google_ads_client_secret",
                 "graph_client_secret", "luma_secret", "whatsapp_token", "linkedin_token"}
PLAIN_FIELDS = {"digest_email", "digest_hour", "digest_timezone", "digest_on", "meta_pixel_id", "linkedin_conversion_rule", "google_ads_customer_id",
                "google_ads_conversion_action", "google_ads_client_id", "graph_tenant_id", "graph_client_id", "linkedin_org_id",
                "whatsapp_phone_id", "whatsapp_to", "whatsapp_template", "digest_whatsapp", "digest_slack", "digest_teams"}


def integrations(bp: models.BusinessProfile) -> dict:
    return {k: v for k, v in (bp.integrations or {}).items() if not k.startswith("_")}


def secret(bp: models.BusinessProfile | None, key: str) -> str | None:
    if bp is None:
        return None
    v = (bp.integrations or {}).get(key)
    if not v:
        return None
    try:
        return decrypt_secret(v)
    except Exception:  # noqa: BLE001
        return None


def save(db: Session, bp: models.BusinessProfile, changes: dict) -> dict:
    cur = dict(bp.integrations or {})
    for k, v in changes.items():
        if k in SECRET_FIELDS:
            if v is None:
                continue
            cur[k] = encrypt_secret(str(v).strip()) if str(v).strip() else None
        elif k in PLAIN_FIELDS:
            cur[k] = v
    if not cur.get("luma_hook"):
        cur["luma_hook"] = secrets.token_urlsafe(18)
    bp.integrations = cur
    flag_modified(bp, "integrations")
    db.commit()
    return status(bp)


def status(bp: models.BusinessProfile) -> dict:
    """What is set up - never the secrets themselves."""
    cur = bp.integrations or {}
    has = lambda k: bool(cur.get(k))  # noqa: E731
    return {
        "digest": {"on": bool(cur.get("digest_on", True)), "hour": cur.get("digest_hour", 8), "timezone": cur.get("digest_timezone") or "Asia/Kolkata",
                   "email": cur.get("digest_email"), "slack": has("slack_webhook"), "teams": has("teams_webhook"),
                   "whatsapp": bool(has("whatsapp_token") and cur.get("whatsapp_phone_id") and cur.get("whatsapp_to") and cur.get("whatsapp_template"))},
        "meta_capi": bool(has("meta_capi_token") and cur.get("meta_pixel_id")),
        "linkedin_capi": bool(has("linkedin_capi_token") and cur.get("linkedin_conversion_rule")),
        "google_ads": bool(has("google_ads_developer_token") and has("google_ads_refresh_token") and cur.get("google_ads_customer_id") and cur.get("google_ads_conversion_action")),
        "teams_graph": bool(has("graph_client_secret") and cur.get("graph_tenant_id") and cur.get("graph_client_id")),
        "linkedin_mentions": bool(has("linkedin_token") and cur.get("linkedin_org_id")),
        "luma_hook": cur.get("luma_hook"),
        "plain": {k: cur.get(k) for k in PLAIN_FIELDS if cur.get(k) is not None},
        "last": {k: cur.get(k) for k in ("_last_capi", "_last_mentions", "_last_teams") if cur.get(k)},
    }


def _sha(s: str | None) -> str | None:
    s = (s or "").strip().lower()
    return hashlib.sha256(s.encode()).hexdigest() if s else None


# ---- conversions back to the ad platforms --------------------------------------------------------------------

def send_conversion(db: Session, i: models.Initiative, email: str | None, at: datetime | None = None, gclid: str | None = None,
                    source: str | None = None, post=requests.post) -> list[dict]:
    """Sends one registration to every configured platform. Returns [{platform, ok, status}] (also kept on the profile)."""
    bp = db.get(models.BusinessProfile, i.workspace_id) if i.workspace_id else None
    if bp is None or not email:
        return []
    cur = bp.integrations or {}
    when = int((at or datetime.utcnow()).timestamp())
    out = []
    em = _sha(email)
    tok = secret(bp, "meta_capi_token")
    if tok and cur.get("meta_pixel_id"):
        try:
            r = post(f"https://graph.facebook.com/v19.0/{cur['meta_pixel_id']}/events", params={"access_token": tok}, timeout=TIMEOUT,
                     json={"data": [{"event_name": "CompleteRegistration", "event_time": when, "action_source": "website",
                                     "user_data": {"em": [em]}, "custom_data": {"content_name": i.title, "content_category": i.kind}}]})
            out.append({"platform": "Meta", "ok": r.status_code < 300, "status": r.status_code})
        except Exception as e:  # noqa: BLE001
            out.append({"platform": "Meta", "ok": False, "status": str(e)[:80]})
    tok = secret(bp, "linkedin_capi_token")
    if tok and cur.get("linkedin_conversion_rule"):
        try:
            r = post("https://api.linkedin.com/rest/conversionEvents", timeout=TIMEOUT,
                     headers={"Authorization": f"Bearer {tok}", "LinkedIn-Version": "202409", "X-Restli-Protocol-Version": "2.0.0"},
                     json={"conversion": cur["linkedin_conversion_rule"], "conversionHappenedAt": when * 1000,
                           "user": {"userIds": [{"idType": "SHA256_EMAIL", "idValue": em}]}})
            out.append({"platform": "LinkedIn", "ok": r.status_code < 300, "status": r.status_code})
        except Exception as e:  # noqa: BLE001
            out.append({"platform": "LinkedIn", "ok": False, "status": str(e)[:80]})
    dev = secret(bp, "google_ads_developer_token")
    if dev and gclid and cur.get("google_ads_customer_id") and cur.get("google_ads_conversion_action"):
        try:
            token = _google_token(bp, post)
            cid = str(cur["google_ads_customer_id"]).replace("-", "")
            r = post(f"https://googleads.googleapis.com/v17/customers/{cid}:uploadClickConversions", timeout=TIMEOUT,
                     headers={"Authorization": f"Bearer {token}", "developer-token": dev},
                     json={"conversions": [{"gclid": gclid, "conversionAction": cur["google_ads_conversion_action"],
                                            "conversionDateTime": datetime.utcfromtimestamp(when).strftime("%Y-%m-%d %H:%M:%S+00:00")}], "partialFailure": True})
            out.append({"platform": "Google Ads", "ok": r.status_code < 300, "status": r.status_code})
        except Exception as e:  # noqa: BLE001
            out.append({"platform": "Google Ads", "ok": False, "status": str(e)[:80]})
    elif dev and not gclid:
        out.append({"platform": "Google Ads", "ok": False, "status": "no gclid on this registration"})
    if out:
        bp.integrations = {**cur, "_last_capi": {"at": datetime.utcnow().isoformat() + "Z", "results": out}}
        flag_modified(bp, "integrations")
        db.commit()
    return out


def _google_token(bp: models.BusinessProfile, post) -> str:
    cur = bp.integrations or {}
    r = post("https://oauth2.googleapis.com/token", timeout=TIMEOUT, data={"grant_type": "refresh_token", "refresh_token": secret(bp, "google_ads_refresh_token"),
                                                                           "client_id": cur.get("google_ads_client_id") or "",
                                                                           "client_secret": secret(bp, "google_ads_client_secret") or ""})
    return r.json().get("access_token") or ""


def on_registration(initiative_id: str, email: str | None, gclid: str | None, source: str | None) -> None:
    """Called in the background after a registration (gtm_public.register)."""
    from ...database import SessionLocal
    db = SessionLocal()
    try:
        i = db.get(models.Initiative, initiative_id)
        if i is not None:
            send_conversion(db, i, email, datetime.utcnow(), gclid, source)
    except Exception as e:  # noqa: BLE001
        print(f"[autopilot.capi] skipped: {e}")
    finally:
        db.close()


# ---- Luma -------------------------------------------------------------------------------------------------------

def luma_event(db: Session, i: models.Initiative, payload: dict) -> dict:
    """guest.created / guest.updated: registered, and attended once checked in."""
    from ..initiatives import gtm
    data = payload.get("data") or payload
    guest = data.get("guest") or data
    email = (guest.get("email") or guest.get("user_email") or "").strip().lower()
    name = guest.get("name") or guest.get("user_name") or ""
    if not email:
        return {"ok": False, "why": "no email"}
    c = gtm.upsert_contact(db, i.workspace_id, {"name": name, "email": email}, "luma")
    db.flush()
    E = models.GtmEngagement
    done = []
    if not db.query(E.id).filter(E.initiative_id == i.id, E.contact_id == c.id, E.kind == "registered").first():
        gtm.record(db, i.workspace_id, "registered", account_id=c.account_id, contact_id=c.id, initiative_id=i.id, channel="Luma", detail={"source": "Luma"})
        done.append("registered")
    if (guest.get("checked_in_at") or data.get("checked_in_at")) and not db.query(E.id).filter(E.initiative_id == i.id, E.contact_id == c.id, E.kind == "attended").first():
        gtm.record(db, i.workspace_id, "attended", account_id=c.account_id, contact_id=c.id, initiative_id=i.id, channel="Luma", detail={"source": "Luma"})
        done.append("attended")
    db.commit()
    return {"ok": True, "did": done}


# ---- Microsoft Teams --------------------------------------------------------------------------------------------

def teams_csv(db: Session, i: models.Initiative, raw: bytes) -> dict:
    """A Teams attendance report (CSV): Name, Email / Participant ID, Join time, Leave time, Duration."""
    from ..initiatives import gtm
    text = raw.decode("utf-8-sig", errors="ignore").replace("\t", ",")
    lines = text.splitlines()
    start = next((n for n, l in enumerate(lines) if "email" in l.lower() and ("name" in l.lower() or "participant" in l.lower())), None)
    if start is None:
        return {"ok": False, "why": "No header row with Name and Email (or Participant ID) found."}
    reader = csv.DictReader(io.StringIO("\n".join(lines[start:])))
    seen, n = set(), 0
    E = models.GtmEngagement
    for r in reader:
        low = {str(k).strip().lower(): v for k, v in r.items() if k}
        email = (low.get("email") or low.get("participant id (upn)") or low.get("participant id") or "").strip().lower()
        if not email or "@" not in email or email in seen:
            continue
        seen.add(email)
        c = gtm.upsert_contact(db, i.workspace_id, {"name": low.get("name") or low.get("full name") or "", "email": email}, "teams")
        db.flush()
        if not db.query(E.id).filter(E.initiative_id == i.id, E.contact_id == c.id, E.kind == "webinar_attended").first():
            gtm.record(db, i.workspace_id, "webinar_attended", account_id=c.account_id, contact_id=c.id, initiative_id=i.id, channel="Microsoft Teams",
                       detail={"source": "Teams attendance report", "duration": low.get("duration") or low.get("in-meeting duration")}, rescore=False)
            n += 1
    db.commit()
    return {"ok": True, "attended": n, "rows": len(seen)}


def teams_pull(db: Session, i: models.Initiative, organizer: str, meeting_id: str, get=requests.get, post=requests.post) -> dict:
    """Attendance from Microsoft Graph (app credentials). Returns {ok, attended} or {ok: False, why}."""
    from ..initiatives import gtm
    bp = db.get(models.BusinessProfile, i.workspace_id)
    cur = (bp.integrations if bp else None) or {}
    sec = secret(bp, "graph_client_secret")
    if not (sec and cur.get("graph_tenant_id") and cur.get("graph_client_id")):
        return {"ok": False, "why": "Add the Azure app (tenant, client id, secret) in Autopilot setup, or import the attendance CSV."}
    try:
        tr = post(f"https://login.microsoftonline.com/{cur['graph_tenant_id']}/oauth2/v2.0/token", timeout=TIMEOUT,
                  data={"grant_type": "client_credentials", "client_id": cur["graph_client_id"], "client_secret": sec, "scope": "https://graph.microsoft.com/.default"})
        token = (tr.json() or {}).get("access_token")
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "why": f"Microsoft could not be reached ({str(e)[:80]})."}
    if not token:
        return {"ok": False, "why": "Microsoft refused the app credentials."}
    h = {"Authorization": f"Bearer {token}"}
    base = f"https://graph.microsoft.com/v1.0/users/{organizer}/onlineMeetings/{meeting_id}"
    try:
        reps = get(f"{base}/attendanceReports", headers=h, timeout=TIMEOUT)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "why": f"Microsoft Graph could not be reached ({str(e)[:80]})."}
    if reps.status_code >= 300:
        return {"ok": False, "why": f"Graph said {reps.status_code}: the app needs OnlineMeetingArtifact.Read.All and an application access policy."}
    E = models.GtmEngagement
    n = 0
    for rep in (reps.json() or {}).get("value") or []:
        recs = get(f"{base}/attendanceReports/{rep.get('id')}/attendanceRecords", headers=h, timeout=TIMEOUT)
        for r in (recs.json() or {}).get("value") or []:
            email = ((r.get("emailAddress") or "") or ((r.get("identity") or {}).get("email") or "")).strip().lower()
            if not email:
                continue
            c = gtm.upsert_contact(db, i.workspace_id, {"name": (r.get("identity") or {}).get("displayName") or "", "email": email}, "teams")
            db.flush()
            if not db.query(E.id).filter(E.initiative_id == i.id, E.contact_id == c.id, E.kind == "webinar_attended").first():
                gtm.record(db, i.workspace_id, "webinar_attended", account_id=c.account_id, contact_id=c.id, initiative_id=i.id, channel="Microsoft Teams",
                           detail={"source": "Microsoft Graph", "seconds": r.get("totalAttendanceInSeconds")}, rescore=False)
                n += 1
    bp.integrations = {**cur, "_last_teams": {"at": datetime.utcnow().isoformat() + "Z", "attended": n}}
    flag_modified(bp, "integrations")
    db.commit()
    return {"ok": True, "attended": n}


# ---- LinkedIn @mentions --------------------------------------------------------------------------------------------

def linkedin_mentions(db: Session, i: models.Initiative, get=requests.get) -> dict:
    """Posts that @mention your page, as evidence (Community Management API)."""
    from . import contract as contract_mod, evidence
    from ..eventos import social
    bp = db.get(models.BusinessProfile, i.workspace_id)
    cur = (bp.integrations if bp else None) or {}
    tok = secret(bp, "linkedin_token")
    if not (tok and cur.get("linkedin_org_id")):
        return {"ok": False, "why": "Add your LinkedIn page id and a token with Community Management access in Autopilot setup."}
    org = f"urn:li:organization:{cur['linkedin_org_id']}"
    try:
        r = get("https://api.linkedin.com/rest/organizationalEntityNotifications", timeout=TIMEOUT,
                headers={"Authorization": f"Bearer {tok}", "LinkedIn-Version": "202409", "X-Restli-Protocol-Version": "2.0.0"},
                params={"q": "criteria", "actions": "List(SHARE_MENTION,COMMENT)", "organizationalEntity": org})
    except Exception as e:  # noqa: BLE001 - unreachable: said plainly
        return {"ok": False, "why": f"LinkedIn could not be reached ({str(e)[:80]})."}
    if r.status_code in (401, 403):
        return {"ok": False, "why": "LinkedIn refused: the app needs Community Management API approval (app review)."}
    if r.status_code >= 300:
        return {"ok": False, "why": f"LinkedIn said {r.status_code}."}
    c = contract_mod.ensure(db, i)
    rules = contract_mod.rules(db, i, c)
    existing = {(e.source, e.external_id): e for e in db.query(models.InitiativeEvidence).filter(models.InitiativeEvidence.initiative_id == i.id)}
    n = 0
    for el in (r.json() or {}).get("elements") or []:
        text = ((el.get("sourcePost") or {}).get("commentary") or el.get("text") or "")
        how, conf, why = social.match_text(text, rules)
        if not how:
            continue
        ext = str(el.get("id") or el.get("sourcePost", {}).get("id") or hashlib.md5(text.encode()).hexdigest())
        evidence._upsert(db, i, existing, "mention", "LinkedIn", ext, conf, title=text[:120] or "Mention", text=text[:4000],
                         occurred_at=datetime.utcfromtimestamp((el.get("lastModifiedAt") or el.get("createdAt") or 0) / 1000) if (el.get("lastModifiedAt") or el.get("createdAt")) else None,
                         numbers={}, matched_by=how, why=f"@mention of your page; {why}")
        n += 1
    bp.integrations = {**cur, "_last_mentions": {"at": datetime.utcnow().isoformat() + "Z", "found": n}}
    flag_modified(bp, "integrations")
    db.commit()
    return {"ok": True, "found": n}
