"""
Everything that makes an initiative measurable, day by day:

  - website tracking (the snippet), tracked links and landing pages, with
    A/B comparison and a "tracking is live" check per page;
  - the update log ("design approved", "post live, reach 4,200") with the
    numbers read out of plain text;
  - approvals of deliverables, decided by anyone through a public link;
  - Today: what happened on a given day, across all of the above;
  - the tracking plan: for every target, whether GD360 counts it already,
    what to set up if not (with the exact step), or that it is logged by hand;
  - importing cards from any project tracker (Jira, Linear, Asana, ClickUp,
    Trello, monday.com, Notion) with statuses matched to board stages.
"""
from __future__ import annotations

import re
import threading
import time
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from urllib.parse import parse_qs, urlparse

from sqlalchemy import func
from sqlalchemy.orm import Session

from ... import models
from . import catalog, gtm

# ===================================================== website collect ==

_RATE: dict[str, list[float]] = defaultdict(list)
_RATE_LOCK = threading.Lock()


def allow(ip: str, per_minute: int = 120) -> bool:
    now = time.time()
    with _RATE_LOCK:
        w = _RATE[ip]
        while w and now - w[0] > 60:
            w.pop(0)
        if len(w) >= per_minute:
            return False
        w.append(now)
        if len(_RATE) > 50000:
            _RATE.clear()
        return True


def page_key(url: str | None) -> str | None:
    """host + path, lower-cased, no trailing slash - how a landing page is
    matched to the visits on it."""
    if not url:
        return None
    try:
        u = urlparse(url if "://" in url else f"https://{url}")
    except ValueError:
        return None
    host = (u.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if not host:
        return None
    return host + (u.path.rstrip("/") or "")


def _social(referrer: str | None, utm_source: str | None) -> str | None:
    s = (utm_source or "").lower()
    for name in ("linkedin", "twitter", "facebook", "instagram", "youtube", "reddit", "threads"):
        if name in s:
            return name
    if s in ("x", "x.com"):
        return "x"
    host = (urlparse(referrer).hostname or "").lower() if referrer else ""
    for h in gtm.SOCIAL_HOSTS:
        if h in host:
            return h.strip(".")
    return None


def collect(db: Session, site_key: str, payload: dict, ip: str | None) -> dict:
    prof = db.query(models.GtmProfile).filter(models.GtmProfile.site_key == site_key).first()
    if not prof:
        return {"ok": False}
    ws = prof.workspace_id
    kind = payload.get("e") or "page"
    vid = str(payload.get("v") or "")[:64] or None
    url = str(payload.get("u") or "")[:800]
    ref = str(payload.get("r") or "")[:500] or None
    qs = parse_qs(urlparse(url).query) if url else {}
    utm = {k: v[0][:120] for k, v in qs.items() if k.startswith("utm_") and v}
    gd_t = (qs.get("gd_t") or [payload.get("gd_t")])[0]
    gd_l = (qs.get("gd_l") or [payload.get("gd_l")])[0]

    contact = None
    account = None
    # 1. a person who clicked one of our emails
    if gd_t:
        s = db.query(models.GtmCampaignSend).filter(models.GtmCampaignSend.token == str(gd_t)[:60]).first()
        if s and s.contact_id:
            contact = db.get(models.GtmContact, s.contact_id)
    # 2. a visitor seen before
    if contact is None and vid:
        prev = (db.query(models.GtmEngagement).filter(models.GtmEngagement.workspace_id == ws,
                                                      models.GtmEngagement.visitor_id == vid,
                                                      models.GtmEngagement.contact_id.isnot(None))
                .order_by(models.GtmEngagement.occurred_at.desc()).first())
        if prev:
            contact = db.get(models.GtmContact, prev.contact_id)
        else:
            prev = (db.query(models.GtmEngagement).filter(models.GtmEngagement.workspace_id == ws,
                                                          models.GtmEngagement.visitor_id == vid,
                                                          models.GtmEngagement.account_id.isnot(None))
                    .order_by(models.GtmEngagement.occurred_at.desc()).first())
            if prev:
                account = db.get(models.GtmAccount, prev.account_id)
    # 3. identify / subscribe from the page itself
    if kind in ("identify", "subscribe") and gtm.valid_email(payload.get("email")):
        contact = gtm.upsert_contact(db, ws, {"email": payload["email"], "name": payload.get("name"),
                                              "company": payload.get("company"),
                                              "subscribed": kind == "subscribe" and bool(payload.get("consent", True))},
                                     "website")
        db.flush()
    if contact is not None:
        account = db.get(models.GtmAccount, contact.account_id) if contact.account_id else account
        if vid:
            ids = list(contact.visitor_ids or [])
            if vid not in ids:
                contact.visitor_ids = (ids + [vid])[-20:]
    # 4. the company behind the IP address (IPinfo, when connected)
    if account is None and ip:
        token = gtm.secret_of(gtm.connection(db, ws, "ipinfo"))
        if token:
            comp = gtm.company_for_ip(token, ip)
            if comp:
                idx = gtm.AccountIndex(db, ws)
                account = idx.find(comp.get("domain"), comp.get("name"))
                if account is None and comp.get("domain"):
                    account, _ = idx.upsert({"name": comp["name"], "domain": comp["domain"],
                                             "country": comp.get("country"), "city": comp.get("city")}, "website")
                    if account:
                        db.flush()
                        account.icp_score, account.icp_tier, account.icp_reasons = gtm.score_icp(account, prof.icp)
    # the initiative this visit belongs to: a tracked link, else a landing page
    initiative_id = None
    link = None
    if gd_l:
        link = db.query(models.InitiativeLink).filter(models.InitiativeLink.code == str(gd_l)[:20]).first()
    pk = page_key(url)
    if link is None and pk:
        for l in db.query(models.InitiativeLink).filter(models.InitiativeLink.workspace_id == ws,
                                                        models.InitiativeLink.kind == "landing_page"):
            if page_key(l.url) == pk:
                link = l
                break
    if link is not None and link.workspace_id == ws:
        initiative_id = link.initiative_id
    elif utm.get("utm_campaign", "").startswith("gd-"):
        i = db.query(models.Initiative).filter(models.Initiative.public_token == utm["utm_campaign"][3:]).first()
        if i and i.workspace_id == ws:
            initiative_id = i.id

    if kind == "page":
        # one visit per visitor per page per 30 minutes
        if vid:
            recent = (db.query(models.GtmEngagement.id).filter(
                models.GtmEngagement.workspace_id == ws, models.GtmEngagement.visitor_id == vid,
                models.GtmEngagement.kind == "visit", models.GtmEngagement.occurred_at >= datetime.utcnow() - timedelta(minutes=30))
                .all())
            # same page within 30 minutes: skip
            for (eid,) in recent:
                e = db.get(models.GtmEngagement, eid)
                if e and (e.detail or {}).get("page") == pk:
                    db.commit()
                    return {"ok": True, "dup": True}
        social = _social(ref, utm.get("utm_source"))
        gtm.record(db, ws, "visit", account_id=account.id if account else None,
                   contact_id=contact.id if contact else None, initiative_id=initiative_id,
                   channel="social" if social else ("email" if gd_t else "web"),
                   detail={"page": pk, "url": url[:300], "title": str(payload.get("t") or "")[:160],
                           "referrer": ref, "social": social, "link": link.id if link else None,
                           "variant": link.variant if link else None, **({"utm": utm} if utm else {})},
                   visitor_id=vid)
        if social and account:
            gtm.record(db, ws, "social", account_id=account.id, contact_id=contact.id if contact else None,
                       initiative_id=initiative_id, channel=social, detail={"via": "visit", "page": pk},
                       visitor_id=vid)
    elif kind in ("identify", "subscribe", "form"):
        k = "newsletter_signup" if kind == "subscribe" else "form"
        gtm.record(db, ws, k, account_id=account.id if account else None, contact_id=contact.id if contact else None,
                   initiative_id=initiative_id, channel="web",
                   detail={"page": pk, "link": link.id if link else None, "variant": link.variant if link else None,
                           "form": str(payload.get("f") or "")[:80] or None}, visitor_id=vid)
    db.commit()
    return {"ok": True}


def snippet(site_key: str, backend: str) -> str:
    return f'<script async src="{backend}/public/gtm/t/{site_key}.js"></script>'


def script(site_key: str, backend: str) -> str:
    """The tracking script itself - small, no cookies, a random visitor id
    in localStorage; never collects form contents unless the site calls
    gd360.identify / gd360.subscribe itself."""
    return ("(function(){var B=%r,K=%r;var V;try{V=localStorage.getItem('gd360_vid');if(!V){V=Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem('gd360_vid',V)}}catch(e){V=''}"
            "var q=new URLSearchParams(location.search);var T=q.get('gd_t'),L=q.get('gd_l');try{if(T)sessionStorage.setItem('gd360_t',T);else T=sessionStorage.getItem('gd360_t');if(L)sessionStorage.setItem('gd360_l',L);else L=sessionStorage.getItem('gd360_l')}catch(e){}"
            "function s(o){o.k=K;o.v=V;o.u=location.href;o.r=document.referrer;o.t=document.title;o.gd_t=T;o.gd_l=L;var b=JSON.stringify(o);"
            "if(navigator.sendBeacon){navigator.sendBeacon(B+'/public/gtm/collect',b)}else{var x=new XMLHttpRequest();x.open('POST',B+'/public/gtm/collect');x.setRequestHeader('Content-Type','text/plain');x.send(b)}}"
            "s({e:'page'});var P=location.pathname;setInterval(function(){if(location.pathname!==P){P=location.pathname;s({e:'page'})}},1000);"
            "window.gd360={identify:function(email,name,company){s({e:'identify',email:email,name:name,company:company})},"
            "subscribe:function(email,name,consent){s({e:'subscribe',email:email,name:name,consent:consent!==false})},"
            "conversion:function(name){s({e:'form',f:name||'conversion'})}};})();") % (backend, site_key)


# ======================================================= links & pages ==

def tracked_url(link: models.InitiativeLink, backend: str) -> str:
    return f"{backend}/public/gtm/l/{link.code}"


def destination(link: models.InitiativeLink, initiative: models.Initiative | None) -> str:
    url = link.url
    sep = "&" if "?" in url else "?"
    params = [f"gd_l={link.code}"]
    if "utm_source=" not in url:
        params.append(f"utm_source={link.channel or link.kind}")
        params.append("utm_medium=" + {"social_post": "social", "ad": "paid", "email": "email"}.get(link.kind, "referral"))
        if initiative:
            params.append(f"utm_campaign=gd-{initiative.public_token}")
    return url + sep + "&".join(params)


def link_stats(db: Session, i: models.Initiative) -> list[dict]:
    links = db.query(models.InitiativeLink).filter(models.InitiativeLink.initiative_id == i.id) \
        .order_by(models.InitiativeLink.created_at).all()
    if not links:
        return []
    visits = (db.query(models.GtmEngagement).filter(models.GtmEngagement.workspace_id == i.workspace_id,
                                                    models.GtmEngagement.kind.in_(("visit", "form", "newsletter_signup")),
                                                    models.GtmEngagement.occurred_at >= datetime.utcnow() - timedelta(days=180))
              .all())
    regs = db.query(models.GtmEngagement).filter(models.GtmEngagement.initiative_id == i.id,
                                                 models.GtmEngagement.kind == "registered").all()
    reg_visitors = {e.visitor_id for e in regs if e.visitor_id}
    from .metrics import start_of
    since = start_of(i) - timedelta(days=1)
    logged: dict[str, Counter] = defaultdict(Counter)
    for lid, nums in db.query(models.InitiativeUpdate.link_id, models.InitiativeUpdate.numbers).filter(
            models.InitiativeUpdate.initiative_id == i.id, models.InitiativeUpdate.link_id.isnot(None)):
        for k, v in (nums or {}).items():
            if _isnum(v):
                logged[lid][k] += float(v)
    host_seen: dict[str, datetime] = {}
    for e in visits:
        pk = (e.detail or {}).get("page") or ""
        host = pk.split("/")[0]
        if host and (host not in host_seen or e.occurred_at > host_seen[host]):
            host_seen[host] = e.occurred_at
    out = []
    for l in links:
        pk = page_key(l.url)
        mine = [e for e in visits if e.occurred_at >= since and ((e.detail or {}).get("link") == l.id or
                (l.kind == "landing_page" and pk and (e.detail or {}).get("page") == pk))]
        v = [e for e in mine if e.kind == "visit"]
        vis_ids = {e.visitor_id for e in v if e.visitor_id}
        conv = [e for e in mine if e.kind in ("form", "newsletter_signup")]
        conv_vis = {e.visitor_id for e in conv if e.visitor_id} | (vis_ids & reg_visitors)
        conv_n = len(conv_vis) + sum(1 for e in conv if not e.visitor_id)
        host = (pk or "").split("/")[0]
        live = None
        if l.kind == "landing_page":
            seen = host_seen.get(host)
            live = {"state": "live" if seen and seen > datetime.utcnow() - timedelta(days=14) else ("stale" if seen else "missing"),
                    "last_seen": seen}
        out.append({
            "id": l.id, "kind": l.kind, "label": l.label, "url": l.url, "channel": l.channel, "variant": l.variant,
            "paid": bool(l.paid), "region": l.region, "logged": dict(logged.get(l.id) or {}),
            "code": l.code, "clicks": l.clicks or 0, "last_click_at": l.last_click_at,
            "visits": len(v), "visitors": len(vis_ids), "accounts": len({e.account_id for e in v if e.account_id}),
            "conversions": conv_n, "conversion_rate": round(100 * conv_n / len(vis_ids), 1) if vis_ids else None,
            "tracking": live, "created_at": l.created_at,
        })
    return out


def breakdown(rows: list[dict]) -> list[dict]:
    """Results by channel and organic vs paid - only this initiative's own
    posts, ads and pages, never the rest of the company's activity."""
    groups: dict[tuple, Counter] = defaultdict(Counter)
    for r in rows:
        ch = r.get("channel") or ("website" if r["kind"] == "landing_page" else r["kind"])
        key = (ch, "Paid" if r.get("paid") else "Organic", r.get("region") or "")
        g = groups[key]
        g["items"] += 1
        g["clicks"] += r.get("clicks") or 0
        g["visits"] += r.get("visits") or 0
        g["conversions"] += r.get("conversions") or 0
        for k in ("reach", "impressions", "engagements", "spend"):
            g[k] += (r.get("logged") or {}).get(k, 0)
    out = []
    for (ch, mode, region), g in sorted(groups.items(), key=lambda kv: -kv[1]["visits"] - kv[1]["clicks"]):
        row = {"channel": ch, "mode": mode, "region": region or None, **{k: g[k] for k in
               ("items", "clicks", "visits", "conversions", "reach", "impressions", "engagements", "spend")}}
        row["cost_per_conversion"] = round(g["spend"] / g["conversions"], 2) if g["spend"] and g["conversions"] else None
        out.append(row)
    return out


def ab_verdict(rows: list[dict]) -> dict | None:
    """Compare two landing-page variants on conversion rate (two-proportion
    z-test); says plainly when there isn't enough traffic yet."""
    pages = [r for r in rows if r["kind"] == "landing_page" and r.get("variant")]
    if len(pages) < 2:
        return None
    a, b = sorted(pages, key=lambda r: r["variant"])[:2]
    na, nb = a["visitors"], b["visitors"]
    ca, cb = a["conversions"], b["conversions"]
    if na < 30 or nb < 30:
        return {"a": a["label"], "b": b["label"], "state": "collecting",
                "text": f"Collecting data: {na} and {nb} visitors so far. Each page needs about 30 visitors before the comparison means anything."}
    pa, pb = ca / na, cb / nb
    p = (ca + cb) / (na + nb)
    se = (p * (1 - p) * (1 / na + 1 / nb)) ** 0.5
    z = (pb - pa) / se if se else 0.0
    lead = b if pb > pa else a
    lag = a if lead is b else b
    if abs(z) >= 1.96:
        return {"a": a["label"], "b": b["label"], "state": "winner", "winner": lead["label"],
                "text": f"{lead['label']} converts better: {max(pa, pb) * 100:.1f}% against {min(pa, pb) * 100:.1f}% "
                        f"(confident at 95%). Send more traffic to it."}
    return {"a": a["label"], "b": b["label"], "state": "close",
            "text": f"No clear winner yet: {lead['label']} {max(pa, pb) * 100:.1f}% vs {lag['label']} "
                    f"{min(pa, pb) * 100:.1f}%. Keep both running."}


# ============================================================= updates ==

_NUM = r"(\d+(?:[.,]\d+)?)\s*(k|m|thousand|million)?"
NUMBER_WORDS = {
    "reach": ("reach", "reached", "people reached"),
    "impressions": ("impressions", "views", "view"),
    "clicks": ("clicks", "click"),
    "engagements": ("engagements", "engagement", "reactions", "likes", "like"),
    "comments": ("comments", "comment"),
    "shares": ("shares", "reposts", "share"),
    "followers": ("followers", "new followers"),
    "signups": ("signups", "sign-ups", "sign ups", "registrations", "registered"),
    "leads": ("leads", "lead"),
    "visits": ("visits", "sessions", "visitors", "traffic"),
    "spend": ("spend", "spent", "cost"),
}


def _val(n: str, unit: str | None) -> float:
    v = float(n.replace(",", "")) if n.count(",") and len(n.split(",")[-1]) == 3 else float(n.replace(",", "."))
    u = (unit or "").lower()
    return v * (1000 if u in ("k", "thousand") else 1_000_000 if u in ("m", "million") else 1)


def parse_numbers(text: str) -> dict:
    t = (text or "").lower()
    out: dict[str, float] = {}
    for key, words in NUMBER_WORDS.items():
        for w in words:
            w_re = re.escape(w)
            m = re.search(rf"(?:\$|₹|€|£)?{_NUM}\s*{w_re}\b", t) or re.search(rf"\b{w_re}\s*(?:of|:|=|is|was|at)?\s*(?:\$|₹|€|£)?{_NUM}", t)
            if m:
                out[key] = _val(m.group(1), m.group(2))
                break
    return out


def classify(text: str) -> tuple[str, str | None]:
    t = (text or "").lower()
    channel = None
    for name in ("linkedin", "instagram", "facebook", "twitter", "youtube", "tiktok", "newsletter", "google ads", "meta ads"):
        if name in t:
            channel = name
            break
    if re.search(r"\b(x\.com|on x)\b", t):
        channel = channel or "x"
    if re.search(r"\b(approved|signed off|sign-off|final copy|final version)\b", t):
        return "approval", channel
    if re.search(r"\b(blocked|delay|delayed|risk|issue|problem|slipped|late)\b", t):
        return "risk", channel
    if channel and re.search(r"\b(post|posted|published|went live|live|ran|launched|shared|ad)\b", t):
        return "post", channel
    if re.search(r"\b(launched|live|published|shipped|released|done|completed|signed|booked|confirmed)\b", t):
        return "milestone", channel
    if parse_numbers(t):
        return "metric", channel
    return "update", channel


def update_row(u: models.InitiativeUpdate) -> dict:
    return {"id": u.id, "kind": u.kind, "text": u.text, "channel": u.channel, "link": u.link, "numbers": u.numbers or {},
            "link_id": u.link_id, "paid": u.paid, "region": u.region,
            "task_id": u.task_id, "author": u.author, "occurred_at": u.occurred_at}


def log(db: Session, i: models.Initiative, text: str, author: str | None, *, kind: str | None = None,
        channel: str | None = None, link: str | None = None, numbers: dict | None = None,
        task_id: str | None = None, occurred_at: datetime | None = None, link_id: str | None = None,
        paid: bool | None = None, region: str | None = None) -> models.InitiativeUpdate:
    k, ch = classify(text)
    tl = db.get(models.InitiativeLink, link_id) if link_id else None
    if tl and tl.initiative_id != i.id:
        tl = None
    if tl:
        channel = channel or tl.channel
        paid = tl.paid if paid is None else paid
        region = region or tl.region
        k = "post" if k in ("update", "metric") else k
    nums = {**parse_numbers(text), **{kk: float(v) for kk, v in (numbers or {}).items() if _isnum(v)}}
    if not link:
        m = re.search(r"https?://\S+", text or "")
        link = m.group(0).rstrip(".,)") if m else None
    u = models.InitiativeUpdate(initiative_id=i.id, kind=kind or k, text=text.strip()[:2000], channel=channel or ch,
                                link=(link or None) and link[:600], numbers=nums or None, task_id=task_id,
                                author=author, occurred_at=occurred_at or datetime.utcnow(),
                                link_id=tl.id if tl else None, paid=paid, region=(region or None) and region[:40])
    db.add(u)
    i.updated_at = datetime.utcnow()
    return u


def _isnum(v) -> bool:
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


def update_totals(db: Session, initiative_id: str) -> dict:
    tot: Counter = Counter()
    for (nums,) in db.query(models.InitiativeUpdate.numbers).filter(models.InitiativeUpdate.initiative_id == initiative_id):
        for k, v in (nums or {}).items():
            if _isnum(v):
                tot[k] += float(v)
    return dict(tot)


# =========================================================== approvals ==

def evidence_clean(items) -> list[dict]:
    out = []
    for e in (items or [])[:20]:
        if not isinstance(e, dict):
            continue
        url = str(e.get("url") or "").strip()[:600]
        label = str(e.get("label") or "").strip()[:120]
        if not url and not label:
            continue
        if url and not re.match(r"^https?://", url):
            url = "https://" + url
        host = (urlparse(url).hostname or "") if url else ""
        kind = ("figma" if "figma.com" in host else "doc" if any(h in host for h in ("docs.google", "notion", "dropbox", "sharepoint", "onedrive", "confluence"))
                else "code" if any(h in host for h in ("github", "gitlab", "bitbucket")) else
                "ticket" if any(h in host for h in ("atlassian", "linear.app", "asana", "clickup", "trello", "monday.com")) else
                "video" if any(h in host for h in ("loom", "youtube", "vimeo")) else "link")
        out.append({"label": label or host or "Deliverable", "url": url or None, "version": str(e.get("version") or "").strip()[:40] or None,
                    "kind": e.get("kind") or kind, "added_at": e.get("added_at") or datetime.utcnow().isoformat()})
    return out


def approval_state(t: models.InitiativeTask) -> dict:
    a = dict(t.approval or {})
    a.setdefault("state", "none")
    a.setdefault("history", [])
    return a


def request_approval(t: models.InitiativeTask, approver: str, approver_email: str | None, note: str | None,
                     by: str) -> dict:
    import secrets
    a = approval_state(t)
    token = t.approval_token or secrets.token_urlsafe(18)
    ev = (t.evidence or [])
    version = (ev[-1].get("version") if ev else None)
    a.update({"state": "submitted", "approver": approver[:120], "approver_email": (approver_email or "")[:200] or None,
              "note": (note or "")[:600] or None, "requested_by": by, "requested_at": datetime.utcnow().isoformat(),
              "version": version})
    a["history"] = (a["history"] + [{"at": datetime.utcnow().isoformat(), "by": by, "action": "submitted",
                                     "note": note, "version": version}])[-30:]
    t.approval, t.approval_token = a, token
    t.status = "review"
    return a


def decide(t: models.InitiativeTask, decision: str, by: str, note: str | None) -> dict:
    a = approval_state(t)
    now = datetime.utcnow().isoformat()
    a["state"] = "approved" if decision == "approve" else "changes"
    a["decided_by"], a["decided_at"], a["decision_note"] = by[:120], now, (note or "")[:1000] or None
    a["history"] = (a["history"] + [{"at": now, "by": by, "action": a["state"], "note": note,
                                     "version": a.get("version")}])[-30:]
    t.approval = a
    if a["state"] == "approved":
        t.status, t.done_at = "done", datetime.utcnow()
    else:
        t.status = "doing"
    return a


# =============================================================== today ==

def today(db: Session, i: models.Initiative, day: date | None = None) -> dict:
    d = day or date.today()
    start = datetime(d.year, d.month, d.day)
    end = start + timedelta(days=1)
    ups = (db.query(models.InitiativeUpdate).filter(models.InitiativeUpdate.initiative_id == i.id,
                                                    models.InitiativeUpdate.occurred_at >= start,
                                                    models.InitiativeUpdate.occurred_at < end)
           .order_by(models.InitiativeUpdate.occurred_at.desc()).all())
    done = (db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id == i.id,
                                                   models.InitiativeTask.done_at >= start,
                                                   models.InitiativeTask.done_at < end).all())
    due = (db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id == i.id,
                                                  models.InitiativeTask.status != "done",
                                                  models.InitiativeTask.due_on == d.isoformat()).all())
    kinds = dict(db.query(models.GtmEngagement.kind, func.count()).filter(
        models.GtmEngagement.initiative_id == i.id, models.GtmEngagement.occurred_at >= start,
        models.GtmEngagement.occurred_at < end).group_by(models.GtmEngagement.kind).all())
    numbers: Counter = Counter()
    for u in ups:
        for k, v in (u.numbers or {}).items():
            if _isnum(v):
                numbers[k] += float(v)
    tiles = []
    for key, label in (("registered", "Registrations"), ("attended", "Attended"), ("walk_in", "Walk-ins"),
                       ("visit", "Tracked visits"), ("link_click", "Link clicks"), ("email_open", "Email opens"),
                       ("email_click", "Email clicks"), ("outreach", "Personal invites"), ("reply", "Replies"), ("meeting", "Meetings"), ("form", "Form fills"),
                       ("newsletter_signup", "Newsletter sign-ups")):
        if kinds.get(key):
            tiles.append({"label": label, "value": kinds[key], "source": "tracked"})
    for key, label in (("reach", "Social reach"), ("impressions", "Impressions"), ("engagements", "Engagements"),
                       ("clicks", "Reported clicks"), ("signups", "Reported sign-ups"), ("spend", "Spend")):
        if numbers.get(key):
            tiles.append({"label": label, "value": numbers[key], "source": "logged"})
    approvals = []
    for t in db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id == i.id,
                                                    models.InitiativeTask.approval.isnot(None)).all():
        a = t.approval or {}
        for h in a.get("history") or []:
            try:
                at = datetime.fromisoformat(h["at"])
            except (KeyError, ValueError):
                continue
            if start <= at < end:
                approvals.append({"task": t.title, "action": h.get("action"), "by": h.get("by"),
                                  "version": h.get("version"), "at": at})
    return {"date": d.isoformat(), "tiles": tiles, "updates": [update_row(u) for u in ups],
            "completed": [{"id": t.id, "title": t.title, "owner": t.owner_name} for t in done],
            "due": [{"id": t.id, "title": t.title, "owner": t.owner_name} for t in due],
            "approvals": approvals}


# ======================================================= tracking plan ==

def tracking_plan(db: Session, i: models.Initiative, values: dict, links: list[dict]) -> list[dict]:
    """For every target and tracked asset: is GD360 already counting it, what
    exactly to set up if not, or is it logged by hand. state: live | setup |
    manual | waiting."""
    from ..automations import email_configured
    ws = i.workspace_id
    out: list[dict] = []
    prof = gtm.profile(db, ws) if ws else None
    site_live = bool(ws and db.query(models.GtmEngagement.id).filter(
        models.GtmEngagement.workspace_id == ws, models.GtmEngagement.kind == "visit",
        models.GtmEngagement.occurred_at >= datetime.utcnow() - timedelta(days=14)).first())
    acc_n = db.query(func.count(models.GtmAccount.id)).filter(models.GtmAccount.workspace_id == ws).scalar() if ws else 0
    camp_n = db.query(func.count(models.GtmCampaign.id)).filter(models.GtmCampaign.initiative_id == i.id).scalar()
    items_n = db.query(func.count(models.InitiativeItem.id)).filter(models.InitiativeItem.initiative_id == i.id).scalar()

    def add(key, label, state, how, action=None):
        out.append({"key": key, "label": label, "state": state, "how": how, "action": action})

    for t in i.targets or []:
        k = t.get("key")
        label = t.get("label") or catalog.metric_label(k)
        meta = catalog.METRICS.get(k) or {}
        if not meta.get("auto") or t.get("auto") is False:
            add(k, label, "manual", "Typed in by the owner - update it on the Results tab or log it as an update.", "log")
        elif k in ("registrations", "attended", "attendance_rate"):
            if values.get("registrations"):
                add(k, label, "live", "Counted from the GD360 registration page and imported attendee lists.")
            else:
                add(k, label, "setup", "Share the registration page link (Audience tab). Using Luma, Eventbrite or Zoom instead? Import their attendee CSV after the event.", "audience")
        elif k == "walk_ins":
            add(k, label, "live" if values.get("walk_ins") else "waiting",
                "Your booth team opens the walk-in link on their phones on the day.", "audience")
        elif k in ("emails_sent", "open_rate", "click_rate"):
            if not email_configured():
                add(k, label, "setup", "Email sending isn't switched on for this server yet (an admin adds RESEND_API_KEY or SMTP and EMAIL_FROM). Until then, export campaigns as CSV for your email tool.", "campaigns")
            elif not camp_n:
                add(k, label, "setup", "Create the first campaign on the Campaigns tab - opens and clicks are tracked automatically.", "campaigns")
            else:
                add(k, label, "live", "Counted from GD360 campaigns: every send, open and click.")
        elif k in ("web_visits", "landing_visits", "landing_conversions"):
            if site_live:
                add(k, label, "live", "The GD360 snippet is reporting visits from your site.")
            else:
                add(k, label, "setup", "Paste the one-line GD360 snippet into your site's <head> (Tracking tab), then open the page once to confirm.", "tracking")
        elif k in ("accounts_engaged", "tier_a_engaged", "opportunities"):
            if not acc_n:
                add(k, label, "setup", "Bring your target accounts in (Accounts → Sources: Apollo, HubSpot, or a ZoomInfo / Salesforce CSV).", "accounts")
            else:
                add(k, label, "live", f"Counted across your {acc_n:,} accounts from every visit, email, registration and meeting.")
        elif k in ("candidates", "interviews", "offers", "hires", "items_shipped", "items_shipped_pct"):
            add(k, label, "live" if items_n else "setup",
                "Counted from the board. Using Jira, Linear, Asana, ClickUp, Trello or Notion? Import their CSV export and statuses become stages." if not items_n
                else "Counted from the board stages.", "board")
        elif k in ("social_reach", "social_engagements"):
            add(k, label, "manual", "LinkedIn and Instagram don't share reach with other apps without a business integration - log it in one line after each post (\"LinkedIn post reach 4.2k, 63 clicks\") and GD360 adds it up.", "log")
        elif k == "link_clicks":
            add(k, label, "live" if links else "setup", "Add each post or ad as a tracked link and share the GD360 link instead of the raw one.", "tracking")
        elif k == "approvals_done":
            add(k, label, "live", "Counted when a deliverable is approved.")
        elif k == "meetings":
            add(k, label, "live" if values.get("meetings") else "waiting",
                "Logged on the account (Log activity → Meeting) or by moving a card to Meeting on the board.", "board")
        elif k == "tasks_done_pct":
            add(k, label, "live", "Counted from the plan.")
        else:
            add(k, label, "live", "Counted automatically.")
    for l in links:
        if l["kind"] == "landing_page":
            st = (l.get("tracking") or {}).get("state")
            add(f"page:{l['id']}", f"Landing page · {l['label']}", "live" if st == "live" else "setup",
                "Tracking is live on this page." if st == "live" else
                "No visits seen from this page yet - paste the snippet into its <head>, publish, and open it once.", "tracking")
        elif l["kind"] in ("social_post", "ad"):
            add(f"link:{l['id']}", f"{l['label']}", "live", "Clicks are counted through the GD360 link; log reach from the platform after 24 hours.", "log")
    if i.kind in ("event", "webinar", "abm", "campaign") and ws and not gtm.connection(db, ws, "ipinfo"):
        add("ipinfo", "Company names for anonymous visitors", "setup",
            "Optional: connect IPinfo (Accounts → Sources) so visits from target accounts show up even before anyone fills a form.", "accounts")
    pend = db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id == i.id,
                                                  models.InitiativeTask.status == "review").count()
    if pend:
        add("approvals", f"{pend} deliverable{'s' if pend > 1 else ''} waiting for approval", "waiting",
            "The approver can decide from the link they were sent - no GD360 account needed.", "plan")
    return out


# ======================================================== board import ==

STATUS_MAP = {
    "product": [("Shipped", ("done", "closed", "resolved", "complete", "completed", "shipped", "released", "deployed", "live")),
                ("Review", ("review", "qa", "testing", "test", "code review", "in review", "verify", "uat")),
                ("Building", ("in progress", "doing", "development", "in development", "started", "active", "building", "wip", "dev")),
                ("Design", ("design", "in design", "designing", "spec", "discovery", "research")),
                ("Backlog", ("backlog", "to do", "todo", "open", "new", "planned", "ready", "not started", "selected"))],
    "hiring": [("Hired", ("hired", "accepted", "joined", "started")), ("Offer", ("offer", "offered")),
               ("Interview", ("interview", "onsite", "technical", "final")), ("Screen", ("screen", "phone", "review")),
               ("Applied", ("applied", "new", "application")), ("Sourced", ("sourced", "prospect", "lead"))],
}


def stage_for(kind: str, status: str | None) -> str:
    stages = (catalog.KINDS.get(kind) or catalog.KINDS["custom"])["stages"]
    s = (status or "").strip().lower()
    if not s:
        return stages[0]
    for st in stages:
        if s == st.lower():
            return st
    if s in ("rejected", "declined", "withdrawn", "lost", "won't do", "wont do", "cancelled", "canceled", "dropped"):
        return "Rejected" if kind == "hiring" else "Dropped"
    for st, words in STATUS_MAP.get(kind, []):
        if any(w == s or w in s for w in words):
            return st
    generic = [(stages[-1], ("done", "closed", "complete", "completed", "resolved", "shipped", "hired", "won")),
               (stages[min(1, len(stages) - 1)], ("in progress", "doing", "active", "started", "review"))]
    for st, words in generic:
        if any(w in s for w in words):
            return st
    return stages[0]


BOARD_SYNONYMS = {
    "title": ["summary", "title", "name", "task name", "issue", "card name", "item", "task"],
    "status": ["status", "state", "stage", "list", "column", "section/column", "section", "progress"],
    "group": ["sprint", "epic", "milestone", "cycle", "project", "parent", "epic link", "group", "role"],
    "owner": ["assignee", "owner", "assigned to", "assigned", "members", "person", "people"],
    "link": ["url", "link", "issue url", "card url", "permalink"],
    "key": ["issue key", "key", "id", "identifier", "task id", "card id"],
    "email": ["email", "email address"],
    "due": ["due date", "due", "due on", "target date", "end date"],
}


def map_board(headers: list[str]) -> dict:
    normed = {h: re.sub(r"\s+", " ", re.sub(r"[^a-z0-9/ ]+", " ", h.lower())).strip() for h in headers}
    out = {}
    used = set()
    for f, syns in BOARD_SYNONYMS.items():
        for s in syns:
            hit = next((h for h, n in normed.items() if n == s and h not in used), None)
            if hit:
                out[f] = hit
                used.add(hit)
                break
    return out


def import_board(db: Session, i: models.Initiative, rows: list[dict], mapping: dict, source: str) -> dict:
    stats = Counter()
    existing = {(it.title or "").lower(): it for it in
                db.query(models.InitiativeItem).filter(models.InitiativeItem.initiative_id == i.id)}
    pos = len(existing)
    for r in rows[:2000]:
        title = str(r.get(mapping.get("title", ""), "") or "").strip()
        if not title:
            stats["skipped"] += 1
            continue
        key = str(r.get(mapping.get("key", ""), "") or "").strip()
        full = f"{key} {title}".strip() if key and key not in title else title
        stage = stage_for(i.kind, r.get(mapping.get("status", "")))
        link = str(r.get(mapping.get("link", ""), "") or "").strip() or None
        it = existing.get(full.lower())
        if it:
            if it.stage != stage:
                it.stage, it.stage_changed_at = stage, datetime.utcnow()
                stats["moved"] += 1
            else:
                stats["unchanged"] += 1
            continue
        pos += 1
        data = {"source": source}
        due = r.get(mapping.get("due", "")) if mapping.get("due") else None
        if due:
            data["due"] = str(due)[:30]
        db.add(models.InitiativeItem(initiative_id=i.id, title=full[:200], stage=stage,
                                     group_name=(str(r.get(mapping.get("group", ""), "") or "").strip() or None),
                                     owner_name=(str(r.get(mapping.get("owner", ""), "") or "").strip()[:120] or None),
                                     email=(str(r.get(mapping.get("email", ""), "") or "").strip() or None),
                                     link=link, position=pos, data=data))
        stats["created"] += 1
    return dict(stats)
