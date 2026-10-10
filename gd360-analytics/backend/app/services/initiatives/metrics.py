"""
Results: every number an initiative is measured on, counted from what GD360
tracks (engagements, campaign sends, the board, the plan), plus the hub
summary, "needs you today", the account-based overview and the history the
planner learns from.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ... import models
from . import catalog, gtm

ENGAGED_KINDS = tuple(k for k in gtm.WEIGHTS if k not in ("email_sent", "note"))


def _d(s: str | None) -> date | None:
    try:
        return date.fromisoformat(s) if s else None
    except ValueError:
        return None


def start_of(i: models.Initiative) -> datetime:
    d = _d(i.starts_on)
    return datetime(d.year, d.month, d.day) if d else (i.created_at or datetime.utcnow())


# ------------------------------------------------------------ audience ---

def audience_query(db: Session, workspace_id: str, audience: dict | None):
    q = db.query(models.GtmAccount).filter(models.GtmAccount.workspace_id == workspace_id)
    a = audience or {}
    if a.get("account_ids"):
        return q.filter(models.GtmAccount.id.in_(list(a["account_ids"])[:5000]))
    if a.get("tiers"):
        q = q.filter(models.GtmAccount.icp_tier.in_(a["tiers"]))
    if a.get("segments"):
        q = q.filter(models.GtmAccount.segment.in_(a["segments"]))
    if a.get("lists"):
        q = q.filter(models.GtmAccount.list_name.in_(a["lists"]))
    if a.get("countries"):
        from sqlalchemy import or_
        q = q.filter(or_(*[models.GtmAccount.country.ilike(f"%{c}%") for c in a["countries"][:20]],
                         *[models.GtmAccount.region.ilike(f"%{c}%") for c in a["countries"][:20]]))
    return q


def has_audience(audience: dict | None) -> bool:
    a = audience or {}
    return bool(a.get("tiers") or a.get("segments") or a.get("lists") or a.get("account_ids") or a.get("all")
                or a.get("countries"))


def audience_text(audience: dict | None) -> str:
    a = audience or {}
    parts = []
    if a.get("account_ids"):
        parts.append(f"{len(a['account_ids'])} chosen accounts")
    if a.get("tiers"):
        parts.append("Tier " + " + ".join(a["tiers"]))
    if a.get("segments"):
        parts.append(", ".join(a["segments"]))
    if a.get("lists"):
        parts.append("list " + ", ".join(a["lists"]))
    if a.get("countries"):
        parts.append("in " + ", ".join(a["countries"]))
    return " · ".join(parts) or "All accounts"


# ------------------------------------------------------------- results ---

def compute(db: Session, i: models.Initiative) -> dict:
    """Every metric value for this initiative (auto ones counted, manual
    ones from the targets), plus the evidence behind them."""
    ws = i.workspace_id
    since = start_of(i) - timedelta(days=1)
    tagged = db.query(models.GtmEngagement).filter(models.GtmEngagement.initiative_id == i.id).all()
    by_kind: dict[str, list] = defaultdict(list)
    for e in tagged:
        by_kind[e.kind].append(e)

    def people(*kinds):
        s = set()
        for k in kinds:
            for e in by_kind.get(k, []):
                s.add(e.contact_id or (f"acc:{e.account_id}" if e.account_id else e.id))
        return s

    reg = people("registered", "attended", "webinar_attended")
    att = people("attended", "webinar_attended")
    values: dict[str, float | None] = {
        "registrations": len(reg), "attended": len(att),
        "attendance_rate": round(100 * len(att) / len(reg), 1) if reg else None,
        "walk_ins": len(by_kind.get("walk_in", [])),
        "meetings": len(by_kind.get("meeting", [])),
    }
    # accounts engaged: initiative-tagged signals, plus - for account-based
    # work with an audience - any signal from an audience account since start
    eng_accounts = {e.account_id for e in tagged if e.account_id and e.kind in ENGAGED_KINDS}
    scoped = i.kind in ("abm", "campaign") and has_audience(i.audience)
    visits = len(by_kind.get("visit", []))
    if scoped and ws:
        ids = [r[0] for r in audience_query(db, ws, i.audience).with_entities(models.GtmAccount.id)]
        if ids:
            rows = (db.query(models.GtmEngagement.account_id, models.GtmEngagement.kind, func.count())
                    .filter(models.GtmEngagement.workspace_id == ws, models.GtmEngagement.account_id.in_(ids),
                            models.GtmEngagement.occurred_at >= since,
                            or_(models.GtmEngagement.initiative_id.is_(None), models.GtmEngagement.initiative_id == i.id))
                    .group_by(models.GtmEngagement.account_id, models.GtmEngagement.kind).all())
            for aid, kind, n in rows:
                if kind in ENGAGED_KINDS:
                    eng_accounts.add(aid)
                if kind == "visit" and not any(e.account_id == aid for e in by_kind.get("visit", [])):
                    visits += n
        values["audience_size"] = len(ids)
    values["accounts_engaged"] = len(eng_accounts)
    tier_a = 0
    if eng_accounts:
        tier_a = db.query(func.count(models.GtmAccount.id)).filter(
            models.GtmAccount.id.in_(list(eng_accounts)), models.GtmAccount.icp_tier == "A").scalar() or 0
    values["tier_a_engaged"] = tier_a
    values["web_visits"] = visits
    values["newsletter_signups"] = len(by_kind.get("newsletter_signup", []))

    # email
    camp_ids = [c.id for c in db.query(models.GtmCampaign.id).filter(models.GtmCampaign.initiative_id == i.id)]
    sent = opened = clicked = 0
    if camp_ids:
        sent, opened, clicked = db.query(
            func.count(models.GtmCampaignSend.id),
            func.count(models.GtmCampaignSend.opened_at),
            func.count(models.GtmCampaignSend.clicked_at),
        ).filter(models.GtmCampaignSend.campaign_id.in_(camp_ids), models.GtmCampaignSend.status == "sent").one()
    values["emails_sent"] = sent
    values["open_rate"] = round(100 * opened / sent, 1) if sent else None
    values["click_rate"] = round(100 * clicked / sent, 1) if sent else None

    # board
    items = db.query(models.InitiativeItem).filter(models.InitiativeItem.initiative_id == i.id).all()
    stages = (catalog.KINDS.get(i.kind) or catalog.KINDS["custom"])["stages"]
    rank = {s: n for n, s in enumerate(stages)}
    live = [it for it in items if it.stage not in catalog.CLOSED_STAGES]

    def reached(stage):
        r = rank.get(stage)
        return sum(1 for it in items if r is not None and rank.get(it.stage, -1) >= r) if r is not None else 0

    values["candidates"] = len(live) if i.kind == "hiring" else None
    values["interviews"] = reached("Interview") if i.kind == "hiring" else None
    values["offers"] = reached("Offer") if i.kind == "hiring" else None
    values["hires"] = reached("Hired") if i.kind == "hiring" else None
    if i.kind == "product":
        values["items_shipped"] = reached("Shipped")
        values["items_shipped_pct"] = round(100 * reached("Shipped") / len(live), 1) if live else None
    opp = reached("Opportunity") if "Opportunity" in rank else 0
    values["opportunities"] = max(opp, len(by_kind.get("opportunity", [])))
    tasks = db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id == i.id).all()
    done = sum(1 for t in tasks if t.status == "done")
    values["tasks_done_pct"] = round(100 * done / len(tasks), 1) if tasks else None
    values["approvals_done"] = sum(1 for t in tasks if (t.approval or {}).get("state") == "approved")
    # tracked links, landing pages and the numbers logged in updates
    from . import tracking
    links = tracking.link_stats(db, i)
    pages = [l for l in links if l["kind"] == "landing_page"]
    values["landing_visits"] = sum(l["visits"] for l in pages)
    values["landing_conversions"] = sum(l["conversions"] for l in pages)
    values["link_clicks"] = sum(l["clicks"] for l in links)
    from . import team
    tt = team.stats(db, i)["total"]
    values["invites_sent"] = tt.get("invited", 0)
    values["replies"] = tt.get("replied", 0)
    values["reply_rate"] = tt.get("reply_rate")
    totals = tracking.update_totals(db, i.id)
    values["social_reach"] = totals.get("reach") or None
    values["social_engagements"] = (totals.get("engagements", 0) + totals.get("comments", 0) + totals.get("shares", 0)) or None
    return {"links": links, "update_totals": totals, "values": values, "tasks_total": len(tasks), "tasks_done": done, "board": Counter(it.stage for it in items)}


def targets_with_actuals(i: models.Initiative, values: dict) -> list[dict]:
    out = []
    for t in i.targets or []:
        key = t.get("key")
        meta = catalog.METRICS.get(key) or {}
        auto = bool(meta.get("auto")) and t.get("auto", True) is not False
        actual = values.get(key) if auto else t.get("actual")
        target = t.get("target")
        pct = None
        try:
            if actual is not None and target:
                pct = round(100 * float(actual) / float(target), 1)
        except (TypeError, ValueError):
            pct = None
        out.append({"key": key, "label": t.get("label") or catalog.metric_label(key), "target": target,
                    "unit": t.get("unit") or meta.get("unit") or "count", "actual": actual, "auto": auto,
                    "why": t.get("why"), "pct": pct})
    return out


def pacing(i: models.Initiative) -> float | None:
    """How far through its time the initiative is, 0-1 (None when undated)."""
    start = start_of(i)
    end = _d(i.key_date)
    if not end:
        return None
    endt = datetime(end.year, end.month, end.day)
    total = (endt - start).total_seconds()
    if total <= 0:
        return 1.0
    return max(0.0, min(1.0, (datetime.utcnow() - start).total_seconds() / total))


def health(i: models.Initiative, targets: list[dict], overdue: int, risk: str | None = None) -> dict:
    if i.status in ("done", "archived"):
        return {"state": "done", "label": "Finished"}
    p = pacing(i)
    lead = next((t for t in targets if t.get("pct") is not None), None)
    if overdue >= 3:
        return {"state": "risk", "label": f"{overdue} tasks overdue"}
    if p is not None and lead and p > 0.35 and lead["pct"] < 100 * p * 0.55:
        return {"state": "risk", "label": f"{lead['label']} behind pace"}
    if overdue:
        return {"state": "watch", "label": f"{overdue} task{'s' if overdue > 1 else ''} overdue"}
    if risk:
        return {"state": "watch", "label": risk[:80]}
    return {"state": "ok", "label": "On track"}


def overdue_count(tasks: list[models.InitiativeTask]) -> int:
    today = date.today().isoformat()
    return sum(1 for t in tasks if t.status != "done" and t.due_on and t.due_on < today)


def summary(db: Session, i: models.Initiative, with_values: dict | None = None) -> dict:
    res = with_values or compute(db, i)
    targets = targets_with_actuals(i, res["values"])
    tasks = db.query(models.InitiativeTask).filter(models.InitiativeTask.initiative_id == i.id).all()
    od = overdue_count(tasks)
    risk = (db.query(models.InitiativeUpdate.text).filter(
        models.InitiativeUpdate.initiative_id == i.id, models.InitiativeUpdate.kind == "risk",
        models.InitiativeUpdate.occurred_at >= datetime.utcnow() - timedelta(hours=48))
        .order_by(models.InitiativeUpdate.occurred_at.desc()).first())
    blocked = sum(1 for t in tasks if t.status == "blocked")
    nxt = sorted((t for t in tasks if t.status != "done"), key=lambda t: (t.due_on or "9999", t.position or 0))
    kd = _d(i.key_date)
    return {
        "id": i.id, "title": i.title, "kind": i.kind, "kind_label": catalog.KINDS.get(i.kind, {}).get("label", "Custom"),
        "department": i.department, "status": i.status, "key_date": i.key_date, "starts_on": i.starts_on,
        "location": i.location, "days_to_go": (kd - date.today()).days if kd else None,
        "targets": targets, "tasks_total": res["tasks_total"], "tasks_done": res["tasks_done"],
        "overdue": od, "blocked": blocked,
        "health": health(i, targets, od, (f"Blocked: {blocked} task{'s' if blocked > 1 else ''}" if blocked else (risk[0] if risk else None))),
        "next_task": ({"id": nxt[0].id, "title": nxt[0].title, "due_on": nxt[0].due_on} if nxt else None),
        "updated_at": i.updated_at, "created_at": i.created_at,
    }


# ------------------------------------------------------------ history ---

def history(db: Session, workspace_id: str, kind: str, exclude: str | None = None) -> dict:
    """What earlier initiatives of this kind achieved - the planner sets
    targets from it and says so."""
    rows = (db.query(models.Initiative).filter(models.Initiative.workspace_id == workspace_id,
                                               models.Initiative.kind == kind)
            .order_by(models.Initiative.created_at.desc()).limit(8).all())
    past = []
    agg: dict[str, list[float]] = defaultdict(list)
    for i in rows:
        if i.id == exclude:
            continue
        kd = _d(i.key_date)
        finished = i.status == "done" or (kd is not None and kd < date.today())
        if not finished:
            continue
        vals = compute(db, i)["values"]
        t = targets_with_actuals(i, vals)
        for x in t:
            if x["actual"] is not None:
                try:
                    agg[x["key"]].append(float(x["actual"]))
                except (TypeError, ValueError):
                    pass
        for k in ("registrations", "attended", "attendance_rate", "walk_ins", "meetings", "open_rate", "click_rate",
                  "hires", "accounts_engaged"):
            v = vals.get(k)
            if v and k not in {x["key"] for x in t}:
                agg[k].append(float(v))
        past.append({"title": i.title, "date": i.key_date, "results": {x["label"]: x["actual"] for x in t},
                     "learned": (i.plan_meta or {}).get("outcome") or (i.plan_meta or {}).get("learned_note")})
    averages = {k: round(sum(v) / len(v), 1) for k, v in agg.items() if v}
    return {"count": len(past), "past": past[:5], "averages": averages}


# --------------------------------------------------------------- hub ---

def needs_you(db: Session, user: models.User, workspace_id: str) -> list[dict]:
    today = date.today().isoformat()
    out: list[dict] = []
    inits = {i.id: i for i in db.query(models.Initiative).filter(
        models.Initiative.workspace_id == workspace_id, models.Initiative.status.in_(("active", "planning")))}
    if inits:
        tasks = (db.query(models.InitiativeTask)
                 .filter(models.InitiativeTask.initiative_id.in_(list(inits)), models.InitiativeTask.status != "done",
                         models.InitiativeTask.due_on.isnot(None), models.InitiativeTask.due_on <= today)
                 .order_by(models.InitiativeTask.due_on).limit(12).all())
        for t in tasks:
            out.append({"type": "task", "id": t.id, "initiative_id": t.initiative_id,
                        "initiative": inits[t.initiative_id].title, "title": t.title, "due_on": t.due_on,
                        "overdue": t.due_on < today})
    end = datetime.utcnow().replace(hour=23, minute=59)
    for r in (db.query(models.GtmReminder).filter(models.GtmReminder.owner_id == user.id,
                                                  models.GtmReminder.done.is_(False),
                                                  models.GtmReminder.remind_at <= end)
              .order_by(models.GtmReminder.remind_at).limit(10)):
        acc = db.get(models.GtmAccount, r.account_id) if r.account_id else None
        out.append({"type": "reminder", "id": r.id, "title": r.note, "remind_at": r.remind_at,
                    "initiative_id": r.initiative_id, "account_id": r.account_id,
                    "account": acc.name if acc else None})
    for a in (db.query(models.GtmAccount).filter(models.GtmAccount.workspace_id == workspace_id,
                                                 models.GtmAccount.engagement_7d >= 8)
              .order_by(models.GtmAccount.engagement_7d.desc()).limit(4)):
        out.append({"type": "surge", "id": a.id, "account_id": a.id, "title": f"{a.name} is surging",
                    "detail": f"{a.engagement_7d:g} signal points this week" + (f" · Tier {a.icp_tier}" if a.icp_tier else ""),
                    "tier": a.icp_tier})
    return out


def hub(db: Session, user: models.User, workspace_id: str) -> dict:
    rows = (db.query(models.Initiative).filter(models.Initiative.workspace_id == workspace_id,
                                               models.Initiative.status != "archived")
            .order_by(models.Initiative.updated_at.desc()).limit(100).all())
    items = [summary(db, i) for i in rows]
    counts = Counter(x["status"] for x in items)
    acc_n = db.query(func.count(models.GtmAccount.id)).filter(models.GtmAccount.workspace_id == workspace_id).scalar() or 0
    return {"initiatives": items, "needs_you": needs_you(db, user, workspace_id),
            "counts": {"active": counts.get("active", 0) + counts.get("planning", 0), "done": counts.get("done", 0),
                       "at_risk": sum(1 for x in items if x["health"]["state"] == "risk"), "accounts": acc_n}}


# ------------------------------------------------------- ABM overview ---

def overview(db: Session, workspace_id: str) -> dict:
    now = datetime.utcnow()
    d30 = now - timedelta(days=30)
    A = models.GtmAccount
    base = db.query(A).filter(A.workspace_id == workspace_id)
    total = base.count()
    tiers = dict(db.query(A.icp_tier, func.count()).filter(A.workspace_id == workspace_id).group_by(A.icp_tier).all())
    E = models.GtmEngagement
    eng30 = db.query(E).filter(E.workspace_id == workspace_id, E.occurred_at >= d30)
    kinds30 = dict(eng30.with_entities(E.kind, func.count()).group_by(E.kind).all())
    engaged_ids = {r[0] for r in eng30.filter(E.account_id.isnot(None), E.kind.in_(ENGAGED_KINDS))
                   .with_entities(E.account_id).distinct()}
    engaged_tier = Counter()
    if engaged_ids:
        for t, n in db.query(A.icp_tier, func.count()).filter(A.id.in_(list(engaged_ids))).group_by(A.icp_tier):
            engaged_tier[t or "—"] = n
    meeting_ids = {r[0] for r in db.query(E.account_id).filter(E.workspace_id == workspace_id, E.kind == "meeting",
                                                                E.account_id.isnot(None)).distinct()}
    opp_ids = {r[0] for r in db.query(E.account_id).filter(E.workspace_id == workspace_id, E.kind == "opportunity",
                                                            E.account_id.isnot(None)).distinct()}
    # weekly signals for 12 weeks, by kind group
    weeks = []
    start = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(weeks=11)
    rows = (db.query(E.kind, E.occurred_at).filter(E.workspace_id == workspace_id, E.occurred_at >= start).all())
    buckets: dict[int, Counter] = defaultdict(Counter)
    for kind, at in rows:
        w = int((at - start).days // 7)
        g = ("Website" if kind == "visit" else "Email" if kind.startswith("email") else
             "Events" if kind in ("registered", "attended", "walk_in", "webinar_attended") else
             "Meetings" if kind in ("meeting", "call", "opportunity") else "Other")
        if kind in ("email_sent", "note"):
            continue
        buckets[w][g] += 1
    for w in range(12):
        ws_ = start + timedelta(weeks=w)
        weeks.append({"week": ws_.date().isoformat(), **{g: buckets[w].get(g, 0) for g in
                                                         ("Website", "Email", "Events", "Meetings", "Other")}})
    surging = [account_row(a) for a in base.filter(A.engagement_7d > 0).order_by(A.engagement_7d.desc()).limit(8)]
    new_visitors = [account_row(a) for a in base.filter(A.source == "website", A.created_at >= d30)
                    .order_by(A.icp_score.desc().nullslast(), A.engagement_score.desc()).limit(6)]
    feed = []
    for e in (db.query(E).filter(E.workspace_id == workspace_id, E.kind != "email_sent")
              .order_by(E.occurred_at.desc()).limit(12)):
        feed.append(engagement_row(db, e))
    C = models.GtmContact
    subs = db.query(func.count(C.id)).filter(C.workspace_id == workspace_id, C.subscribed.is_(True),
                                             C.unsubscribed.is_(False)).scalar() or 0
    people = db.query(func.count(C.id)).filter(C.workspace_id == workspace_id).scalar() or 0
    S = models.GtmCampaignSend
    sent, opened, clicked = (db.query(func.count(S.id), func.count(S.opened_at), func.count(S.clicked_at))
                             .join(models.GtmCampaign, models.GtmCampaign.id == S.campaign_id)
                             .filter(models.GtmCampaign.workspace_id == workspace_id, S.status == "sent",
                                     S.sent_at >= d30).one())
    return {
        "accounts": total, "people": people, "subscribers": subs,
        "tiers": {k or "—": v for k, v in tiers.items()},
        "engaged_30d": len(engaged_ids), "engaged_by_tier": dict(engaged_tier),
        "visits_30d": kinds30.get("visit", 0),
        "meetings_30d": kinds30.get("meeting", 0),
        "emails_30d": {"sent": sent, "open_rate": round(100 * opened / sent, 1) if sent else None,
                       "click_rate": round(100 * clicked / sent, 1) if sent else None},
        "funnel": [
            {"stage": "Target accounts", "n": total},
            {"stage": "Engaged (30 days)", "n": len(engaged_ids)},
            {"stage": "Had a meeting", "n": len(meeting_ids)},
            {"stage": "Opportunity", "n": len(opp_ids)},
        ],
        "weeks": weeks, "surging": surging, "new_visitors": new_visitors, "feed": feed,
    }


def account_row(a: models.GtmAccount) -> dict:
    return {"id": a.id, "name": a.name, "domain": a.domain, "industry": a.industry, "employees": a.employees,
            "revenue": a.revenue, "country": a.country, "city": a.city, "segment": a.segment, "list_name": a.list_name,
            "icp_score": a.icp_score, "icp_tier": a.icp_tier, "engagement_score": a.engagement_score or 0,
            "engagement_7d": a.engagement_7d or 0, "heat": gtm.heat(a.engagement_score),
            "last_engaged_at": a.last_engaged_at, "source": a.source, "owner_name": a.owner_name}


def engagement_row(db: Session, e: models.GtmEngagement, accounts: dict | None = None,
                   contacts: dict | None = None) -> dict:
    a = (accounts or {}).get(e.account_id) if accounts is not None else (db.get(models.GtmAccount, e.account_id) if e.account_id else None)
    c = (contacts or {}).get(e.contact_id) if contacts is not None else (db.get(models.GtmContact, e.contact_id) if e.contact_id else None)
    return {"id": e.id, "kind": e.kind, "label": gtm.KIND_LABELS.get(e.kind, e.kind), "channel": e.channel,
            "detail": e.detail, "occurred_at": e.occurred_at, "initiative_id": e.initiative_id,
            "account_id": e.account_id, "account": a.name if a else None, "tier": a.icp_tier if a else None,
            "contact_id": e.contact_id, "contact": (c.name or c.email) if c else None}
