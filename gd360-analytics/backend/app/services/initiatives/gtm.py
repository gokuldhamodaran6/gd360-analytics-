"""
The go-to-market layer: target accounts, their people, the ideal customer
profile they are scored on, and every engagement signal - wherever the data
comes from.

Data in, four ways (any time - first, midway, or never):
  - CSV import with automatic column matching for ZoomInfo, Apollo,
    Salesforce, HubSpot, LinkedIn, Luma, Eventbrite, Zoom and Mailchimp
    exports (accounts, contacts, or signals such as attendee lists);
  - Apollo (the person's own API key): companies matching the ICP, and the
    likely people at each account;
  - HubSpot (a private-app token): companies and contacts;
  - GD360 itself: registration and walk-in pages, website tracking, email
    campaigns - so none of the above is required.

Scoring:
  - ICP fit 0-100 (industry 35, size 25, region 20, revenue 10, keywords 10)
    with the reasons kept; Tier A >= 75, B >= 50, else C.
  - Engagement: weighted signals halving every 30 days, recomputed for an
    account whenever a signal lands on it.
"""
from __future__ import annotations

import csv
import io
import logging
import math
import re
import threading
import time
from collections import Counter
from datetime import datetime, timedelta

import requests
from sqlalchemy import func
from sqlalchemy.orm import Session

from ... import models

logger = logging.getLogger(__name__)

MAX_ACCOUNTS = 25000
MAX_IMPORT_ROWS = 25000
HALF_LIFE_DAYS = 30.0

WEIGHTS = {
    "visit": 2, "email_open": 1, "email_click": 3, "registered": 5, "attended": 8, "walk_in": 8,
    "webinar_attended": 6, "meeting": 15, "newsletter_signup": 3, "social": 2, "form": 5, "note": 0,
    "email_sent": 0, "call": 6, "opportunity": 20, "link_click": 1,
    "reply": 6, "outreach": 0,
}
KIND_LABELS = {
    "visit": "Visited the website", "email_open": "Opened an email", "email_click": "Clicked an email",
    "email_sent": "Was sent an email", "registered": "Registered", "attended": "Attended",
    "walk_in": "Walked in", "webinar_attended": "Attended the webinar", "meeting": "Meeting",
    "newsletter_signup": "Joined the newsletter", "social": "Engaged on social", "form": "Filled a form",
    "note": "Note", "call": "Call", "opportunity": "Opportunity opened", "link_click": "Clicked a tracked link",
    "reply": "Replied", "outreach": "Personal outreach",
}
SIGNAL_KINDS = set(WEIGHTS)

FREE_EMAIL = {
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk", "hotmail.com", "outlook.com",
    "live.com", "msn.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com",
    "gmx.de", "mail.com", "yandex.com", "zoho.com", "rediffmail.com", "qq.com", "163.com", "web.de",
}
SOCIAL_HOSTS = ("linkedin.", "lnkd.in", "twitter.", "x.com", "t.co", "facebook.", "fb.", "instagram.",
                "youtube.", "reddit.", "threads.")


# ================================================================ helpers ==

def norm_domain(value: str | None) -> str | None:
    if not value:
        return None
    v = str(value).strip().lower()
    if "@" in v:
        v = v.split("@", 1)[1]
    v = re.sub(r"^[a-z]+://", "", v)
    v = v.split("/")[0].split("?")[0].split(":")[0]
    if v.startswith("www."):
        v = v[4:]
    return v if re.match(r"^[a-z0-9.-]+\.[a-z]{2,}$", v) else None


def norm_name(value: str | None) -> str:
    v = re.sub(r"[^a-z0-9 ]+", " ", str(value or "").lower())
    v = re.sub(r"\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|pvt|private|the|sa|ag|bv)\b", " ", v)
    return re.sub(r"\s+", " ", v).strip()


def email_domain(email: str | None) -> str | None:
    if not email or "@" not in email:
        return None
    d = norm_domain(email)
    return None if not d or d in FREE_EMAIL else d


def valid_email(email: str | None) -> bool:
    return bool(email) and bool(re.match(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$", str(email).strip()))


def _num(v) -> float | None:
    if v is None:
        return None
    s = str(v).strip().lower().replace(",", "").replace("$", "").replace("€", "").replace("£", "")
    if not s or s in ("nan", "none", "-", "n/a"):
        return None
    m = re.match(r"^(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*([kmb])?", s)  # ranges: midpoint
    mult = {"k": 1e3, "m": 1e6, "b": 1e9}
    if m:
        a, b, u = float(m.group(1)), float(m.group(2)), m.group(3)
        return (a + b) / 2 * mult.get(u or "", 1)
    m = re.match(r"^(\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion|mil|bn)?\+?", s)
    if not m:
        return None
    u = (m.group(2) or "")[:1]
    return float(m.group(1)) * mult.get(u, 1)


def seniority_of(title: str | None) -> str | None:
    t = (title or "").lower()
    if not t:
        return None
    if re.search(r"\b(ceo|cfo|cto|coo|cmo|cro|cio|chief|founder|owner|president)\b", t):
        return "C-level"
    if re.search(r"\b(vp|vice president|svp|evp)\b", t):
        return "VP"
    if re.search(r"\b(head|director)\b", t):
        return "Director"
    if re.search(r"\b(manager|lead|principal)\b", t):
        return "Manager"
    return "Individual contributor"


SENIORITY_RANK = {"C-level": 5, "VP": 4, "Director": 3, "Manager": 2, "Individual contributor": 1}


# =============================================================== profile ==

def profile(db: Session, workspace_id: str) -> models.GtmProfile:
    p = db.query(models.GtmProfile).filter(models.GtmProfile.workspace_id == workspace_id).first()
    if not p:
        p = models.GtmProfile(workspace_id=workspace_id, icp={})
        db.add(p)
        db.commit()
        db.refresh(p)
    return p


def clean_icp(raw: dict) -> dict:
    def lst(key, n=30):
        v = raw.get(key) or []
        if isinstance(v, str):
            v = [x for x in re.split(r"[,\n;]", v)]
        return [str(x).strip()[:80] for x in v if str(x).strip()][:n]

    def num(key):
        v = raw.get(key)
        try:
            return float(v) if v not in (None, "") else None
        except (TypeError, ValueError):
            return None

    return {
        "industries": lst("industries"), "countries": lst("countries"), "titles": lst("titles"),
        "keywords": lst("keywords"), "exclude": lst("exclude"),
        "min_employees": num("min_employees"), "max_employees": num("max_employees"),
        "min_revenue": num("min_revenue"),
        "company_name": str(raw.get("company_name") or "")[:120],
        "sender_name": str(raw.get("sender_name") or "")[:120],
        "postal_address": str(raw.get("postal_address") or "")[:300],
        "booking_link": str(raw.get("booking_link") or "")[:300],
    }


def icp_is_set(icp: dict | None) -> bool:
    icp = icp or {}
    return bool(icp.get("industries") or icp.get("countries") or icp.get("min_employees") or icp.get("max_employees")
                or icp.get("keywords") or icp.get("min_revenue"))


def _match_any(value: str | None, options: list[str]) -> str | None:
    v = (value or "").lower()
    if not v:
        return None
    for o in options:
        ol = o.lower().strip()
        if ol and (ol in v or v in ol):
            return o
        # word overlap ("software" ~ "computer software")
        ow = set(re.findall(r"[a-z]{4,}", ol))
        if ow and ow & set(re.findall(r"[a-z]{4,}", v)):
            return o
    return None


def score_icp(a: models.GtmAccount, icp: dict | None) -> tuple[int | None, str | None, list[str]]:
    icp = icp or {}
    if not icp_is_set(icp):
        return None, None, []
    reasons: list[str] = []
    score = 0.0
    weight = 0.0
    if icp.get("industries"):
        weight += 35
        hit = _match_any(a.industry, icp["industries"])
        if hit:
            score += 35
            reasons.append(f"Industry: {a.industry}")
        elif not a.industry:
            score += 10
    emin, emax = icp.get("min_employees"), icp.get("max_employees")
    if emin or emax:
        weight += 25
        e = a.employees
        if e is None:
            score += 8
        elif (not emin or e >= emin) and (not emax or e <= emax):
            score += 25
            reasons.append(f"Size: {e:,} people")
        elif (emin and e >= emin * 0.5) or (emax and e <= emax * 2):
            score += 10
    if icp.get("countries"):
        weight += 20
        hit = _match_any(" ".join(x for x in (a.country, a.region, a.city) if x), icp["countries"])
        if hit:
            score += 20
            reasons.append(f"Region: {a.country or a.region}")
        elif not (a.country or a.region):
            score += 6
    if icp.get("min_revenue"):
        weight += 10
        if a.revenue is not None and a.revenue >= icp["min_revenue"]:
            score += 10
            reasons.append("Revenue above your floor")
        elif a.revenue is None:
            score += 3
    if icp.get("keywords"):
        weight += 10
        hay = " ".join(x for x in (a.name, a.industry, a.segment, a.list_name, a.notes) if x)
        hit = _match_any(hay, icp["keywords"])
        if hit:
            score += 10
            reasons.append(f"Matches “{hit}”")
    if icp.get("exclude") and _match_any(" ".join(x for x in (a.name, a.industry) if x), icp["exclude"]):
        return 0, "C", ["Excluded by your ICP"]
    pct = int(round(100 * score / weight)) if weight else None
    if pct is None:
        return None, None, []
    tier = "A" if pct >= 75 else "B" if pct >= 50 else "C"
    return pct, tier, reasons


def rescore_all(db: Session, workspace_id: str) -> int:
    icp = profile(db, workspace_id).icp or {}
    n = 0
    for a in db.query(models.GtmAccount).filter(models.GtmAccount.workspace_id == workspace_id).yield_per(500):
        a.icp_score, a.icp_tier, a.icp_reasons = score_icp(a, icp)
        n += 1
    db.commit()
    return n


def suggest_icp(db: Session, workspace_id: str) -> dict:
    """An ICP drawn from the accounts that engage most (or all accounts when
    nothing has engaged yet)."""
    q = db.query(models.GtmAccount).filter(models.GtmAccount.workspace_id == workspace_id)
    rows = q.filter(models.GtmAccount.engagement_score > 0).order_by(models.GtmAccount.engagement_score.desc()).limit(100).all()
    basis = "your most engaged accounts"
    if len(rows) < 10:
        rows = q.limit(2000).all()
        basis = "your account list"
    if not rows:
        return {"icp": {}, "basis": None}
    ind = Counter(a.industry for a in rows if a.industry).most_common(4)
    cty = Counter(a.country for a in rows if a.country).most_common(4)
    emps = sorted(a.employees for a in rows if a.employees)
    icp = {"industries": [i for i, _ in ind], "countries": [c for c, _ in cty]}
    if len(emps) >= 5:
        lo, hi = emps[len(emps) // 5], emps[(len(emps) * 4) // 5]
        icp["min_employees"] = float(max(1, int(lo)))
        icp["max_employees"] = float(int(hi))
    return {"icp": icp, "basis": basis}


# ============================================================ accounts ==

ACCOUNT_FIELDS = ("name", "domain", "industry", "employees", "revenue", "country", "region", "city", "segment",
                  "list_name", "linkedin_url", "owner_name", "notes")


def account_key(domain: str | None, name: str | None) -> str | None:
    d = norm_domain(domain)
    if d:
        return d
    n = norm_name(name)
    return f"name:{n}" if n else None


class AccountIndex:
    """Existing accounts of a workspace, found by domain or by name - built
    once per import so 25,000 rows never mean 25,000 queries."""

    def __init__(self, db: Session, workspace_id: str):
        self.db, self.ws = db, workspace_id
        self.by_key: dict[str, models.GtmAccount] = {}
        self.by_name: dict[str, models.GtmAccount] = {}
        for a in db.query(models.GtmAccount).filter(models.GtmAccount.workspace_id == workspace_id):
            self._add(a)

    def _add(self, a: models.GtmAccount) -> None:
        self.by_key[a.key] = a
        if a.domain:
            self.by_key[a.domain] = a
        n = norm_name(a.name)
        if n:
            self.by_name.setdefault(n, a)

    def find(self, domain: str | None = None, name: str | None = None) -> models.GtmAccount | None:
        d = norm_domain(domain)
        if d and d in self.by_key:
            return self.by_key[d]
        n = norm_name(name)
        if n and n in self.by_name:
            return self.by_name[n]
        if n and f"name:{n}" in self.by_key:
            return self.by_key[f"name:{n}"]
        return None

    def count(self) -> int:
        return len({id(a) for a in self.by_key.values()})

    def upsert(self, fields: dict, source: str, overwrite: bool = False) -> tuple[models.GtmAccount | None, bool]:
        name = str(fields.get("name") or "").strip()
        domain = norm_domain(fields.get("domain"))
        if not name and domain:
            name = domain.split(".")[0].replace("-", " ").title()
        key = account_key(domain, name)
        if not key:
            return None, False
        a = self.find(domain, name)
        created = False
        if a is None:
            if self.count() >= MAX_ACCOUNTS:
                return None, False
            a = models.GtmAccount(workspace_id=self.ws, key=key, name=name[:200], domain=domain, source=source,
                                  engagement_score=0, engagement_7d=0)
            self.db.add(a)
            created = True
        for f in ACCOUNT_FIELDS:
            v = fields.get(f)
            if f == "domain":
                v = domain
            if v in (None, "") or (isinstance(v, float) and math.isnan(v)):
                continue
            if f in ("employees",):
                v = _num(v)
                v = int(v) if v is not None else None
            elif f == "revenue":
                v = _num(v)
            else:
                v = str(v).strip()[:300]
            if v in (None, ""):
                continue
            if overwrite or created or getattr(a, f) in (None, ""):
                setattr(a, f, v)
        if a.domain and a.key.startswith("name:") and a.domain not in self.by_key:
            a.key = a.domain
        if fields.get("external_id"):
            ids = dict(a.external_ids or {})
            ids[source] = str(fields["external_id"])[:80]
            a.external_ids = ids
        a.updated_at = datetime.utcnow()
        self._add(a)
        return a, created


def account_for_email(db: Session, workspace_id: str, email: str | None, company: str | None = None,
                      source: str = "registration", index: AccountIndex | None = None) -> models.GtmAccount | None:
    dom = email_domain(email)
    idx = index or AccountIndex(db, workspace_id)
    if dom:
        a = idx.find(dom, None)
        if a:
            return a
        a = idx.find(None, company) if company else None
        if a:
            if not a.domain:
                a.domain = dom
            return a
        acc, _ = idx.upsert({"domain": dom, "name": company or None}, source)
        if acc:
            acc.icp_score, acc.icp_tier, acc.icp_reasons = score_icp(acc, profile(db, workspace_id).icp)
        return acc
    if company:
        a = idx.find(None, company)
        if a:
            return a
        acc, _ = idx.upsert({"name": company}, source)
        if acc:
            acc.icp_score, acc.icp_tier, acc.icp_reasons = score_icp(acc, profile(db, workspace_id).icp)
        return acc
    return None


def upsert_contact(db: Session, workspace_id: str, fields: dict, source: str,
                   account: models.GtmAccount | None = None, index: AccountIndex | None = None) -> models.GtmContact | None:
    email = str(fields.get("email") or "").strip().lower() or None
    if email and not valid_email(email):
        email = None
    name = str(fields.get("name") or "").strip() or " ".join(
        x for x in (str(fields.get("first_name") or "").strip(), str(fields.get("last_name") or "").strip()) if x)
    if not email and not name:
        return None
    c = None
    if email:
        c = db.query(models.GtmContact).filter(models.GtmContact.workspace_id == workspace_id,
                                               models.GtmContact.email == email).first()
    if c is None and not email and account is not None and name:
        c = db.query(models.GtmContact).filter(models.GtmContact.workspace_id == workspace_id,
                                               models.GtmContact.account_id == account.id,
                                               func.lower(models.GtmContact.name) == name.lower()).first()
    if account is None:
        account = account_for_email(db, workspace_id, email, fields.get("company"), source=source, index=index)
    if c is None:
        c = models.GtmContact(workspace_id=workspace_id, email=email, source=source, subscribed=False,
                              unsubscribed=False)
        db.add(c)
    if account is not None:
        if account.id is None:
            db.flush()
        c.account_id = c.account_id or account.id
    for f in ("name", "title", "phone", "linkedin_url", "country"):
        v = name if f == "name" else fields.get(f)
        if v not in (None, "") and not getattr(c, f):
            setattr(c, f, str(v).strip()[:200])
    if c.title and not c.seniority:
        c.seniority = fields.get("seniority") or seniority_of(c.title)
    if fields.get("subscribed") and not c.unsubscribed:
        c.subscribed = True
    if fields.get("list"):
        lists = list(c.lists or [])
        if fields["list"] not in lists:
            lists.append(str(fields["list"])[:60])
            c.lists = lists
    return c


# ========================================================== engagement ==

def record(db: Session, workspace_id: str, kind: str, *, account_id: str | None = None,
           contact_id: str | None = None, initiative_id: str | None = None, campaign_id: str | None = None,
           channel: str | None = None, detail: dict | None = None, visitor_id: str | None = None,
           occurred_at: datetime | None = None, rescore: bool = True) -> models.GtmEngagement:
    e = models.GtmEngagement(workspace_id=workspace_id, kind=kind, account_id=account_id, contact_id=contact_id,
                             initiative_id=initiative_id, campaign_id=campaign_id, channel=channel,
                             detail=detail or None, visitor_id=visitor_id,
                             occurred_at=occurred_at or datetime.utcnow())
    db.add(e)
    if initiative_id and kind in ("registered", "attended", "webinar_attended", "walk_in", "meeting", "opportunity"):
        db.flush()
        from .team import sync_signal
        sync_signal(db, initiative_id, kind, contact_id, account_id, (detail or {}).get("ref"))
    if account_id and rescore:
        db.flush()
        a = db.get(models.GtmAccount, account_id)
        if a:
            recompute_account(db, a)
    return e


def recompute_account(db: Session, a: models.GtmAccount) -> None:
    now = datetime.utcnow()
    since = now - timedelta(days=180)
    rows = (db.query(models.GtmEngagement.kind, models.GtmEngagement.occurred_at)
            .filter(models.GtmEngagement.account_id == a.id, models.GtmEngagement.occurred_at >= since).all())
    total = recent = 0.0
    last = None
    for kind, at in rows:
        w = WEIGHTS.get(kind, 1)
        if not w:
            continue
        age = max((now - at).total_seconds() / 86400.0, 0.0)
        total += w * (0.5 ** (age / HALF_LIFE_DAYS))
        if age <= 7:
            recent += w
        last = at if last is None or at > last else last
    a.engagement_score = round(total, 1)
    a.engagement_7d = round(recent, 1)
    if last:
        a.last_engaged_at = last


def recompute_workspace(db: Session, workspace_id: str) -> None:
    ids = [r[0] for r in db.query(models.GtmEngagement.account_id).filter(
        models.GtmEngagement.workspace_id == workspace_id, models.GtmEngagement.account_id.isnot(None)).distinct()]
    for aid in ids:
        a = db.get(models.GtmAccount, aid)
        if a:
            recompute_account(db, a)
    db.commit()


def heat(score: float | None) -> str:
    s = score or 0
    return "hot" if s >= 20 else "warm" if s >= 6 else "cold"


# ============================================================ CSV import ==

# header synonyms, matched after lower-casing and stripping punctuation;
# covers ZoomInfo, Apollo, Salesforce, HubSpot, LinkedIn, Luma, Eventbrite,
# Zoom and Mailchimp exports.
SYNONYMS = {
    "name": ["company name", "company", "account name", "organization name", "organisation name", "organization",
             "company name for emails", "account"],
    "domain": ["website", "domain", "company website", "website url", "company domain", "web address",
               "company domain name", "url", "primary domain"],
    "industry": ["industry", "primary industry", "industry hub", "sector", "company industry", "vertical"],
    "employees": ["employees", "employee count", "number of employees", "company size", "headcount", "employee range",
                  "# employees", "num employees", "company employee count"],
    "revenue": ["revenue", "annual revenue", "revenue in 000s usd", "revenue range", "company revenue",
                "revenue (in 000s usd)"],
    "country": ["country", "company country", "hq country", "billing country", "country region"],
    "region": ["state", "company state", "region", "hq state", "billing state province", "state region"],
    "city": ["city", "company city", "hq city", "billing city"],
    "segment": ["segment", "icp segment", "tier", "account tier", "type", "account type"],
    "list_name": ["list", "list name", "lists", "campaign"],
    "linkedin_url": ["company linkedin url", "linkedin company url", "company linkedin", "linkedin url",
                     "company linkedin profile"],
    "owner_name": ["account owner", "owner", "company owner", "contact owner"],
    "external_id": ["zoominfo company id", "apollo account id", "account id", "record id", "company id", "id"],
    # contacts
    "email": ["email", "email address", "work email", "business email", "contact email", "e mail", "email id"],
    "first_name": ["first name", "firstname", "given name"],
    "last_name": ["last name", "lastname", "surname", "family name"],
    "full_name": ["full name", "contact name", "name", "attendee name", "guest name", "person name"],
    "title": ["title", "job title", "position", "role", "designation"],
    "phone": ["phone", "direct phone number", "mobile phone", "phone number", "work phone", "corporate phone"],
    "person_linkedin": ["person linkedin url", "linkedin profile url", "contact linkedin url", "linkedin profile"],
    "seniority": ["seniority", "management level"],
    # signals
    "date": ["date", "registration time", "join time", "attended at", "created at", "registered at", "date time",
             "checked in at", "subscribed at", "timestamp", "optin time", "approved at", "event date"],
    "attended": ["attended", "checked in", "check in", "attendance", "status"],
    "duration": ["time in session (minutes)", "duration (minutes)", "duration", "time in session"],
    "engagement": ["engagement", "engagements", "clicks", "impressions", "engagement rate", "score"],
}


def _norm_header(h: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9#() ]+", " ", str(h or "").lower())).strip()


def read_csv(raw: bytes) -> tuple[list[str], list[dict]]:
    for enc in ("utf-8-sig", "utf-16", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ValueError("That file isn't readable text - export it as CSV and try again.")
    sample = text[:5000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    headers = [h for h in (reader.fieldnames or []) if h is not None]
    rows = []
    for i, r in enumerate(reader):
        if i >= MAX_IMPORT_ROWS:
            break
        rows.append({k: (v.strip() if isinstance(v, str) else v) for k, v in r.items() if k is not None})
    if not headers:
        raise ValueError("The file has no header row.")
    return headers, rows


def map_columns(headers: list[str]) -> dict[str, str]:
    """field -> header. Exact synonym first, then 'contains'."""
    normed = {h: _norm_header(h) for h in headers}
    out: dict[str, str] = {}
    used: set[str] = set()
    for field, syns in SYNONYMS.items():
        for s in syns:
            hit = next((h for h, n in normed.items() if n == s and h not in used), None)
            if hit:
                out[field] = hit
                used.add(hit)
                break
    for field, syns in SYNONYMS.items():
        if field in out or field in ("full_name", "external_id", "date", "attended", "engagement", "list_name",
                                     "segment"):
            continue
        for s in syns:
            hit = next((h for h, n in normed.items() if s in n and h not in used and len(s) > 4), None)
            if hit:
                out[field] = hit
                used.add(hit)
                break
    # "Checked in at" / "Join time" (Luma, Zoom): filled = attended, empty = no-show
    if "attended" not in out:
        hit = next((h for h, n in normed.items() if h not in used and any(w in n for w in ("checked in", "join time", "attended"))), None)
        if hit:
            out["attended_at"] = hit
            used.add(hit)
            if out.get("date") == hit:
                out.pop("date")
    # "Name" alone in a company file means the company
    if "full_name" in out and "name" not in out and "email" not in out:
        out["name"] = out.pop("full_name")
    if "person_linkedin" not in out and "linkedin_url" in out and "email" in out:
        out["person_linkedin"] = out.pop("linkedin_url")
    return out


def detect_kind(mapping: dict[str, str]) -> str:
    if "email" in mapping or "first_name" in mapping or "full_name" in mapping:
        return "contacts"
    return "accounts"


def preview(raw: bytes) -> dict:
    headers, rows = read_csv(raw)
    mapping = map_columns(headers)
    return {"headers": headers, "rows": len(rows), "sample": rows[:5], "mapping": mapping,
            "kind": detect_kind(mapping), "capped": len(rows) >= MAX_IMPORT_ROWS}


def _get(row: dict, mapping: dict, field: str):
    h = mapping.get(field)
    return row.get(h) if h else None


def _parse_dt(v) -> datetime | None:
    if not v:
        return None
    s = re.sub(r"\s+", " ", str(v).strip())
    s = re.sub(r"\s*\(?(UTC|GMT|IST|PST|EST|CET)\)?$", "", s)
    for cand in (s, s[:19], s[:16], s[:10]):
        for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S",
                    "%Y-%m-%d %H:%M", "%Y-%m-%d", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %I:%M %p",
                    "%m/%d/%Y %H:%M", "%m/%d/%Y", "%d/%m/%Y", "%b %d, %Y %I:%M:%S %p", "%b %d, %Y %I:%M %p",
                    "%b %d, %Y %H:%M:%S", "%b %d, %Y"):
            try:
                return datetime.strptime(cand, fmt)
            except ValueError:
                continue
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def _truthy(v) -> bool | None:
    s = str(v or "").strip().lower()
    if s in ("yes", "y", "true", "1", "attended", "checked in", "checked_in", "present", "approved"):
        return True
    if s in ("no", "n", "false", "0", "absent", "not attended", "no show", "declined"):
        return False
    return None


def apply_import(db: Session, workspace_id: str, rows: list[dict], mapping: dict, kind: str, *,
                 source: str = "csv", list_name: str | None = None, segment: str | None = None,
                 signal: str | None = None, initiative_id: str | None = None, subscribe: bool = False) -> dict:
    """kind: accounts | contacts | signals. `signal` is the engagement each
    row records (registered, attended, webinar_attended, social, ...)."""
    idx = AccountIndex(db, workspace_id)
    icp = profile(db, workspace_id).icp or {}
    stats = Counter()
    touched: set[str] = set()
    for row in rows:
        fields = {f: _get(row, mapping, f) for f in SYNONYMS}
        if list_name:
            fields["list_name"] = fields.get("list_name") or list_name
        if segment:
            fields["segment"] = segment
        acc = None
        if kind == "accounts":
            acc, created = idx.upsert(fields, source)
            if not acc:
                stats["skipped"] += 1
                continue
            stats["created" if created else "updated"] += 1
            acc.icp_score, acc.icp_tier, acc.icp_reasons = score_icp(acc, icp)
            continue
        # contacts and signals both start from a person (or at least a company)
        email = (fields.get("email") or "").strip().lower() or None
        company_fields = {"name": fields.get("name"), "domain": fields.get("domain") or email_domain(email),
                          "industry": fields.get("industry"), "employees": fields.get("employees"),
                          "country": fields.get("country"), "city": fields.get("city"),
                          "revenue": fields.get("revenue"), "linkedin_url": None,
                          "list_name": fields.get("list_name") if kind == "contacts" else None,
                          "segment": fields.get("segment")}
        if company_fields["name"] or company_fields["domain"]:
            acc, created = idx.upsert(company_fields, source)
            if acc and created:
                stats["accounts_created"] += 1
                acc.icp_score, acc.icp_tier, acc.icp_reasons = score_icp(acc, icp)
        if acc is not None and acc.id is None:
            db.flush()
        person = {"email": email, "name": fields.get("full_name"), "first_name": fields.get("first_name"),
                  "last_name": fields.get("last_name"), "title": fields.get("title"), "phone": fields.get("phone"),
                  "linkedin_url": fields.get("person_linkedin"), "seniority": fields.get("seniority"),
                  "company": fields.get("name"), "subscribed": subscribe or signal == "newsletter_signup",
                  "list": list_name}
        c = upsert_contact(db, workspace_id, person, source, account=acc, index=idx)
        if c is None and acc is None:
            stats["skipped"] += 1
            continue
        if c is not None:
            if c.id is None:
                db.flush()
            stats["people"] += 1
        if kind == "signals" and signal:
            k = signal
            att = _truthy(_get(row, mapping, "attended")) if mapping.get("attended") else None
            if att is None and mapping.get("attended_at"):
                att = bool(str(_get(row, mapping, "attended_at") or "").strip())
            if signal in ("attended", "webinar_attended") and att is False:
                k = "registered"
            detail = {"source": source}
            dur = _num(_get(row, mapping, "duration"))
            if dur:
                detail["minutes"] = dur
            eng = _get(row, mapping, "engagement")
            if eng:
                detail["engagement"] = str(eng)[:40]
            when = _parse_dt(_get(row, mapping, "date")) or (_parse_dt(_get(row, mapping, "attended_at")) if k != "registered" else None)
            record(db, workspace_id, k, account_id=acc.id if acc else (c.account_id if c else None),
                   contact_id=c.id if c else None, initiative_id=initiative_id, channel=source, detail=detail,
                   occurred_at=when, rescore=False)
            if k != signal and signal in ("attended", "webinar_attended"):
                stats["no_shows"] += 1
            else:
                stats["signals"] += 1
            aid = acc.id if acc else (c.account_id if c else None)
            if aid:
                touched.add(aid)
        if len(stats) and sum(stats.values()) % 500 == 0:
            db.flush()
    db.commit()
    for aid in touched:
        a = db.get(models.GtmAccount, aid)
        if a:
            recompute_account(db, a)
    db.commit()
    return dict(stats)


# ============================================================ people ==

def likely_people(db: Session, a: models.GtmAccount, icp: dict | None) -> dict:
    titles = [t.lower() for t in ((icp or {}).get("titles") or [])]
    people = db.query(models.GtmContact).filter(models.GtmContact.account_id == a.id).all()
    eng = Counter(r[0] for r in db.query(models.GtmEngagement.contact_id).filter(
        models.GtmEngagement.account_id == a.id, models.GtmEngagement.contact_id.isnot(None)))

    def fit(c):
        t = (c.title or "").lower()
        persona = 1 if titles and any(x in t for x in titles) else 0
        return (persona, eng.get(c.id, 0), SENIORITY_RANK.get(c.seniority or "", 0))

    people.sort(key=fit, reverse=True)
    out = []
    for c in people[:40]:
        f = fit(c)
        out.append({"id": c.id, "name": c.name, "email": c.email, "title": c.title, "seniority": c.seniority,
                    "linkedin_url": c.linkedin_url, "phone": c.phone, "source": c.source,
                    "subscribed": bool(c.subscribed), "unsubscribed": bool(c.unsubscribed),
                    "persona_match": bool(f[0]), "signals": f[1]})
    # who to look for, even with no data at all
    want = (icp or {}).get("titles") or ["Head of Marketing", "VP Sales", "Head of Operations"]
    have = " ".join((c.title or "").lower() for c in people)
    q = re.sub(r"\s+", "%20", a.name or "")
    personas = [{"title": t, "covered": t.lower() in have,
                 "search": f"https://www.linkedin.com/search/results/people/?keywords={re.sub(r' +', '%20', t)}%20{q}"}
                for t in want[:6]]
    return {"people": out, "personas": personas}


# ============================================================ connectors ==

class ConnectorError(RuntimeError):
    pass


def _http(method: str, url: str, **kw) -> dict:
    try:
        r = requests.request(method, url, timeout=30, **kw)
    except requests.RequestException as e:
        raise ConnectorError(f"Couldn't reach the service ({type(e).__name__}).") from e
    if r.status_code in (401, 403):
        raise ConnectorError("The key was refused - check it is correct and has API access.")
    if r.status_code == 429:
        raise ConnectorError("The service is rate-limiting us - try again in a minute.")
    if r.status_code >= 300:
        raise ConnectorError(f"The service answered {r.status_code}: {r.text[:160]}")
    try:
        return r.json()
    except ValueError:
        raise ConnectorError("The service answered with something that isn't JSON.")


# ---- Apollo ------------------------------------------------------------
APOLLO = "https://api.apollo.io/api/v1"


def _apollo_headers(key: str) -> dict:
    return {"X-Api-Key": key, "Content-Type": "application/json", "Cache-Control": "no-cache"}


def apollo_test(key: str) -> str:
    data = _http("POST", f"{APOLLO}/mixed_companies/search", headers=_apollo_headers(key),
                 json={"page": 1, "per_page": 1})
    n = (data.get("pagination") or {}).get("total_entries")
    return f"Connected - Apollo can see {n:,} companies." if isinstance(n, int) else "Connected."


def _employee_ranges(icp: dict) -> list[str]:
    lo, hi = icp.get("min_employees"), icp.get("max_employees")
    if not lo and not hi:
        return []
    return [f"{int(lo or 1)},{int(hi or 1000000)}"]


def apollo_companies(key: str, icp: dict, limit: int = 500, keywords: list[str] | None = None) -> list[dict]:
    body = {"per_page": 100, "page": 1}
    ranges = _employee_ranges(icp)
    if ranges:
        body["organization_num_employees_ranges"] = ranges
    if icp.get("countries"):
        body["organization_locations"] = icp["countries"][:10]
    tags = (keywords or []) + (icp.get("industries") or []) + (icp.get("keywords") or [])
    if tags:
        body["q_organization_keyword_tags"] = tags[:10]
    out: list[dict] = []
    while len(out) < limit:
        data = _http("POST", f"{APOLLO}/mixed_companies/search", headers=_apollo_headers(key), json=body)
        orgs = (data.get("organizations") or []) + (data.get("accounts") or [])
        if not orgs:
            break
        for o in orgs:
            out.append({
                "name": o.get("name"), "domain": o.get("primary_domain") or o.get("website_url") or o.get("domain"),
                "industry": o.get("industry"), "employees": o.get("estimated_num_employees"),
                "revenue": o.get("annual_revenue") or o.get("organization_revenue"),
                "country": o.get("country"), "region": o.get("state"), "city": o.get("city"),
                "linkedin_url": o.get("linkedin_url"), "external_id": o.get("id"),
            })
        pages = (data.get("pagination") or {}).get("total_pages") or 1
        if body["page"] >= pages:
            break
        body["page"] += 1
        time.sleep(0.4)
    return out[:limit]


def apollo_people(key: str, domain: str, titles: list[str] | None = None, limit: int = 10) -> list[dict]:
    body = {"q_organization_domains_list": [domain], "per_page": min(limit, 25), "page": 1}
    if titles:
        body["person_titles"] = titles[:10]
    else:
        body["person_seniorities"] = ["c_suite", "vp", "head", "director"]
    data = None
    for path in ("mixed_people/api_search", "mixed_people/search"):
        try:
            data = _http("POST", f"{APOLLO}/{path}", headers=_apollo_headers(key), json=body)
            break
        except ConnectorError as e:
            if "answered 404" in str(e) or "answered 422" in str(e):
                continue
            raise
    out = []
    for p in (data or {}).get("people") or []:
        email = p.get("email")
        if email and ("not_unlocked" in email or "@domain.com" in email):
            email = None
        out.append({"name": p.get("name") or " ".join(x for x in (p.get("first_name"), p.get("last_name")) if x),
                    "title": p.get("title"), "linkedin_url": p.get("linkedin_url"), "email": email,
                    "seniority": (p.get("seniority") or "").replace("_", " ").title() or None,
                    "country": p.get("country")})
    return out


# ---- HubSpot -------------------------------------------------------------
HUBSPOT = "https://api.hubapi.com"


def hubspot_test(token: str) -> str:
    data = _http("GET", f"{HUBSPOT}/crm/v3/objects/companies", headers={"Authorization": f"Bearer {token}"},
                 params={"limit": 1})
    return "Connected - HubSpot answered." if "results" in data else "Connected."


def hubspot_pull(token: str, limit: int = 10000) -> tuple[list[dict], list[dict]]:
    h = {"Authorization": f"Bearer {token}"}
    companies: list[dict] = []
    after = None
    while len(companies) < limit:
        params = {"limit": 100, "properties": "name,domain,industry,numberofemployees,annualrevenue,country,state,city,linkedin_company_page,hubspot_owner_id"}
        if after:
            params["after"] = after
        data = _http("GET", f"{HUBSPOT}/crm/v3/objects/companies", headers=h, params=params)
        for r in data.get("results") or []:
            p = r.get("properties") or {}
            companies.append({"name": p.get("name"), "domain": p.get("domain"), "industry": p.get("industry"),
                              "employees": p.get("numberofemployees"), "revenue": p.get("annualrevenue"),
                              "country": p.get("country"), "region": p.get("state"), "city": p.get("city"),
                              "linkedin_url": p.get("linkedin_company_page"), "external_id": r.get("id")})
        after = ((data.get("paging") or {}).get("next") or {}).get("after")
        if not after:
            break
    contacts: list[dict] = []
    after = None
    while len(contacts) < limit:
        params = {"limit": 100, "properties": "email,firstname,lastname,jobtitle,company,phone,hs_linkedin_url"}
        if after:
            params["after"] = after
        data = _http("GET", f"{HUBSPOT}/crm/v3/objects/contacts", headers=h, params=params)
        for r in data.get("results") or []:
            p = r.get("properties") or {}
            contacts.append({"email": p.get("email"), "first_name": p.get("firstname"), "last_name": p.get("lastname"),
                             "title": p.get("jobtitle"), "company": p.get("company"), "phone": p.get("phone"),
                             "linkedin_url": p.get("hs_linkedin_url")})
        after = ((data.get("paging") or {}).get("next") or {}).get("after")
        if not after:
            break
    return companies, contacts


# ---- IPinfo ----------------------------------------------------------------
_IP_CACHE: dict[str, tuple[float, dict | None]] = {}
_IP_LOCK = threading.Lock()
ISP_WORDS = ("telecom", "communications", "broadband", "mobile", "wireless", "internet", "cable", "comcast",
             "verizon", "at&t", "vodafone", "airtel", "jio", "reliance", "t-mobile", "sprint", "charter", "cox",
             "bt ", "orange", "telefonica", "deutsche telekom", "amazon", "google", "microsoft", "cloudflare",
             "digitalocean", "ovh", "hetzner", "akamai", "fastly", "linode", "starlink", "spectrum", "bsnl", "act fibernet")


def ipinfo_test(token: str) -> str:
    data = _http("GET", "https://ipinfo.io/8.8.8.8/json", params={"token": token})
    return "Connected - company lookups are on." if data.get("ip") else "Connected."


def company_for_ip(token: str, ip: str) -> dict | None:
    if not ip or ip.startswith(("10.", "192.168.", "127.", "172.16.", "::1")):
        return None
    now = time.time()
    with _IP_LOCK:
        hit = _IP_CACHE.get(ip)
        if hit and now - hit[0] < 86400:
            return hit[1]
    out = None
    try:
        data = _http("GET", f"https://ipinfo.io/{ip}/json", params={"token": token})
        comp = data.get("company") or {}
        name, domain, ctype = comp.get("name"), comp.get("domain"), comp.get("type")
        if not name:
            org = re.sub(r"^AS\d+\s+", "", data.get("org") or "")
            name, ctype = org or None, None
        low = (name or "").lower()
        if name and ctype not in ("isp", "hosting") and not any(w in low for w in ISP_WORDS):
            out = {"name": name, "domain": norm_domain(domain), "country": data.get("country"),
                   "city": data.get("city")}
    except ConnectorError as e:
        logger.info("[gtm] ipinfo lookup failed: %s", e)
    with _IP_LOCK:
        if len(_IP_CACHE) > 20000:
            _IP_CACHE.clear()
        _IP_CACHE[ip] = (now, out)
    return out


def connection(db: Session, workspace_id: str, provider: str) -> models.GtmConnection | None:
    return db.query(models.GtmConnection).filter(models.GtmConnection.workspace_id == workspace_id,
                                                 models.GtmConnection.provider == provider).first()


def secret_of(conn: models.GtmConnection | None) -> str | None:
    if not conn or not conn.secret_enc:
        return None
    from ...security import decrypt_secret
    try:
        return decrypt_secret(conn.secret_enc)
    except Exception:  # noqa: BLE001
        return None


# ---- background sync jobs ------------------------------------------------------
_SYNCING: set[str] = set()
_SYNC_LOCK = threading.Lock()


def is_syncing(workspace_id: str, provider: str) -> bool:
    return f"{workspace_id}:{provider}" in _SYNCING


def start_sync(workspace_id: str, provider: str, opts: dict | None = None) -> bool:
    key = f"{workspace_id}:{provider}"
    with _SYNC_LOCK:
        if key in _SYNCING:
            return False
        _SYNCING.add(key)

    def target():
        from ...database import SessionLocal
        db = SessionLocal()
        try:
            _sync(db, workspace_id, provider, opts or {})
        except Exception as e:  # noqa: BLE001
            logger.warning("[gtm] %s sync failed: %s", provider, e)
            db.rollback()
            c = connection(db, workspace_id, provider)
            if c:
                c.status, c.last_error = "error", str(e)[:400]
                db.commit()
        finally:
            db.close()
            with _SYNC_LOCK:
                _SYNCING.discard(key)

    threading.Thread(target=target, daemon=True, name=f"gtm-{provider}").start()
    return True


def _sync(db: Session, workspace_id: str, provider: str, opts: dict) -> None:
    c = connection(db, workspace_id, provider)
    key = secret_of(c)
    if not c or not key:
        raise ConnectorError("Not connected.")
    c.status, c.last_error = "syncing", None
    db.commit()
    icp = profile(db, workspace_id).icp or {}
    idx = AccountIndex(db, workspace_id)
    stats = Counter()
    if provider == "apollo":
        limit = max(1, min(int(opts.get("limit") or 500), 2000))
        rows = apollo_companies(key, icp, limit=limit, keywords=opts.get("keywords") or None)
        for r in rows:
            r["list_name"] = opts.get("list_name") or "Apollo ICP pull"
            acc, created = idx.upsert(r, "apollo")
            if acc:
                acc.icp_score, acc.icp_tier, acc.icp_reasons = score_icp(acc, icp)
                stats["created" if created else "updated"] += 1
    elif provider == "hubspot":
        companies, contacts = hubspot_pull(key)
        for r in companies:
            acc, created = idx.upsert(r, "hubspot")
            if acc:
                acc.icp_score, acc.icp_tier, acc.icp_reasons = score_icp(acc, icp)
                stats["created" if created else "updated"] += 1
        db.flush()
        for p in contacts:
            if upsert_contact(db, workspace_id, p, "hubspot", index=idx):
                stats["people"] += 1
            if stats["people"] % 300 == 0:
                db.flush()
    db.commit()
    c.status, c.last_sync_at = "connected", datetime.utcnow()
    c.meta = {**(c.meta or {}), "last_result": dict(stats)}
    db.commit()
