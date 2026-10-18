"""2026-10-17 (R53): the tracking contract - written once when an initiative is created, so its evidence can be
found without typing anything:

  code          Q4LW26 - ads named INIT-Q4LW26-... count for it
  hashtag       #Q4LaunchWeek - posts that carry it count
  utm_campaign  gd-q4lw26 - website sessions from links tagged with it count (GA4)
  keywords      the words that, together, point at it in a caption
  bindings      every target -> where its number comes from, and how true that is:
                  counted  GD360 counted it itself (registrations, emails, visits, check-ins, tasks)
                  matched  read from a connected source and matched by the contract (reach, spend, sessions, deals)
                  typed    typed by a person - shown in amber
"""
from __future__ import annotations

import re
from datetime import date, datetime

from sqlalchemy.orm import Session

from ... import models

_STOP = {"the", "and", "for", "with", "our", "your", "a", "an", "of", "to", "in", "on", "at", "by", "from", "plan", "new", "2025", "2026", "2027"}

# target key -> (truth, where it comes from)
SOURCES = {
    "registrations": ("counted", "GD360 registration page and imports"), "attended": ("counted", "GD360 check-in and Zoom"),
    "attendance_rate": ("counted", "GD360 registrations and check-ins"), "walk_ins": ("counted", "GD360 walk-in capture"),
    "meetings": ("counted", "GD360 meetings logged and HubSpot meetings"), "accounts_engaged": ("counted", "GD360 account signals"),
    "tier_a_engaged": ("counted", "GD360 account signals"), "emails_sent": ("counted", "GD360 email"), "open_rate": ("counted", "GD360 email"),
    "click_rate": ("counted", "GD360 email"), "web_visits": ("counted", "GD360 website tracking"), "newsletter_signups": ("counted", "GD360 forms"),
    "opportunities": ("counted", "GD360 board and HubSpot deals"), "candidates": ("counted", "GD360 board"), "interviews": ("counted", "GD360 board"),
    "offers": ("counted", "GD360 board"), "hires": ("counted", "GD360 board"), "items_shipped": ("counted", "GD360 board"),
    "items_shipped_pct": ("counted", "GD360 board"), "tasks_done_pct": ("counted", "GD360 plan"), "landing_visits": ("counted", "GD360 landing pages"),
    "landing_conversions": ("counted", "GD360 landing pages"), "link_clicks": ("counted", "GD360 short links"),
    "approvals_done": ("counted", "GD360 approvals"), "invites_sent": ("counted", "GD360 invite emails and logged outreach"),
    "replies": ("counted", "logged outreach"), "reply_rate": ("counted", "logged outreach"),
    "social_reach": ("matched", "synced posts matched by the contract"), "social_engagements": ("matched", "synced posts matched by the contract"),
    "ad_spend": ("matched", "Meta / Google Ads campaigns named INIT-{code}"), "cost_per_lead": ("matched", "ad spend ÷ registrations or leads"),
    "utm_sessions": ("matched", "GA4 sessions with utm_campaign={utm}"), "pipeline_value": ("matched", "HubSpot deals at engaged companies"),
    "revenue": ("matched", "HubSpot deals won at engaged companies"), "nps": ("counted", "GD360 survey"),
}


def make_code(title: str, used: set[str]) -> str:
    words = [w for w in re.findall(r"[A-Za-z0-9]+", title or "") if w.lower() not in _STOP]
    base = "".join(w[0] if not w[:2].isdigit() else w[:2] for w in words[:4]).upper() or "INIT"
    if len(base) < 3:
        base = (re.sub(r"[^A-Z0-9]", "", (title or "INIT").upper()) + "XXX")[:4]
    base = base[:6] + date.today().strftime("%y")
    code, n = base, 2
    while code in used:
        code, n = f"{base}{n}", n + 1
    return code


def make_hashtag(title: str) -> str:
    words = [w for w in re.findall(r"[A-Za-z0-9]+", title or "") if w.lower() not in _STOP][:4]
    return "#" + "".join(w[:1].upper() + w[1:] for w in words)[:30] if words else ""


def make_keywords(title: str, brief: str | None) -> list[str]:
    seen, out = set(), []
    for w in re.findall(r"[A-Za-z][A-Za-z0-9\-]{3,}", f"{title} {brief or ''}".lower()):
        if w not in _STOP and w not in seen:
            seen.add(w)
            out.append(w)
    return out[:10]


def ensure(db: Session, i: models.Initiative) -> models.InitiativeContract:
    c = db.get(models.InitiativeContract, i.id)
    if c is not None:
        return c
    used = {x for (x,) in db.query(models.InitiativeContract.code).join(models.Initiative, models.Initiative.id == models.InitiativeContract.initiative_id)
            .filter(models.Initiative.workspace_id == i.workspace_id)}
    code, tag = None, None
    cfg = db.get(models.EventConfig, i.id) if i.kind in ("event", "webinar") else None
    if cfg is not None and cfg.code:
        code = cfg.code.upper()
        tag = "#" + str((cfg.hashtags or [""])[0]).lstrip("#") if cfg.hashtags else None
    code = code or make_code(i.title, used)
    c = models.InitiativeContract(initiative_id=i.id, code=code, hashtag=tag or make_hashtag(i.title), utm_campaign=f"gd-{code.lower()}",
                                  keywords=make_keywords(i.title, i.brief), mapped={"ads": [], "posts": []}, bindings=bind(i, code), data={})
    db.add(c)
    db.flush()
    return c


def bind(i: models.Initiative, code: str) -> dict:
    out = {}
    for t in i.targets or []:
        k = t.get("key")
        truth, where = SOURCES.get(k, ("typed", "typed by you"))
        if t.get("auto") is False and truth != "typed":
            truth, where = "typed", "typed by you (you switched counting off)"
        out[k] = {"truth": truth, "source": where.replace("{code}", code).replace("{utm}", f"gd-{code.lower()}")}
    return out


def update(db: Session, i: models.Initiative, changes: dict) -> models.InitiativeContract:
    c = ensure(db, i)
    if changes.get("code"):
        c.code = re.sub(r"[^A-Z0-9]", "", str(changes["code"]).upper())[:12] or c.code
        c.utm_campaign = f"gd-{c.code.lower()}"
    if changes.get("hashtag") is not None:
        h = str(changes["hashtag"]).strip().lstrip("#")
        c.hashtag = "#" + re.sub(r"[^A-Za-z0-9_]", "", h)[:40] if h else None
    if isinstance(changes.get("keywords"), list):
        c.keywords = [str(k).lower().strip()[:40] for k in changes["keywords"] if str(k).strip()][:20]
    if isinstance(changes.get("mapped_ads"), list):
        c.mapped = {**(c.mapped or {}), "ads": [str(x).strip()[:120] for x in changes["mapped_ads"] if str(x).strip()][:50]}
    c.bindings = bind(i, c.code)
    c.updated_at = datetime.utcnow()
    db.commit()
    return c


def out(c: models.InitiativeContract) -> dict:
    return {"code": c.code, "ad_rule": f"INIT-{c.code}", "hashtag": c.hashtag, "utm_campaign": c.utm_campaign,
            "utm_example": f"?utm_source=linkedin&utm_medium=social&utm_campaign={c.utm_campaign}",
            "keywords": c.keywords or [], "mapped": c.mapped or {}, "bindings": c.bindings or {}}


def rules(db: Session, i: models.Initiative, c: models.InitiativeContract) -> dict:
    """The text-matching rules evidence.py uses (same shape as Event OS social rules)."""
    links = []
    for l in db.query(models.InitiativeLink).filter(models.InitiativeLink.initiative_id == i.id):
        links.append(l.code.lower())
        u = re.sub(r"^https?://(www\.)?", "", (l.url or "").lower()).rstrip("/")
        if len(u) > 8:
            links.append(u)
    links.append((i.public_token or "").lower())
    title = (i.title or "").lower().strip()
    return {"tags": [c.hashtag.lower().lstrip("#")] if c.hashtag else [], "codes": [c.code.lower(), c.utm_campaign.lower()],
            "links": [x for x in links if x], "title": title, "keywords": [k for k in (c.keywords or []) if k != title]}
