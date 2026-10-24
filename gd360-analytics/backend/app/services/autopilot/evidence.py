"""2026-10-17 (R53): the evidence engine. One scan reads every connected source and keeps what belongs to an
initiative, with how it was matched and how sure:

  posts   synced Instagram / Facebook / LinkedIn / YouTube posts, matched by the contract's hashtag, tracked link,
          code or name (rules, free and exact); a post with a picture and no words that match can be checked against
          the initiative's banner (vision) when the workspace has the key
  ads     Meta / Google Ads campaign_daily rows whose campaign is named INIT-{code}, or mapped by hand
  web     GA4 sessions whose utm_campaign is the contract's (gd-{code})
  deals   HubSpot deals at the companies this initiative engaged (created after it started = sourced)
  pages   a tracked landing page that has had its first visit (= live)
  emails  GD360 emails sent for it

Matches at 0.90 or more attach by themselves (the Autopilot policy can raise that bar); the rest wait in the review
queue. A person's decision (confirmed / rejected) is never undone by a later scan.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from types import SimpleNamespace

from sqlalchemy.orm import Session

from ... import models
from . import contract as contract_mod

AD_KINDS = {"meta_ads": "Meta ads", "google_ads": "Google ads"}


def _window(i: models.Initiative) -> tuple[datetime, datetime]:
    from ..initiatives.metrics import _d, start_of
    lo = start_of(i) - timedelta(days=7)
    kd = _d(i.key_date)
    hi = datetime.utcnow() + timedelta(days=1)
    if kd is not None:
        hi = min(hi, datetime(kd.year, kd.month, kd.day) + timedelta(days=45))
    return lo, max(hi, lo + timedelta(days=1))


def _threshold(i: models.Initiative) -> float:
    from . import policy
    return policy.get(i)["auto_attach_at"]


def _upsert(db: Session, i: models.Initiative, existing: dict, kind: str, source: str, external_id: str, conf: float, **f) -> tuple[models.InitiativeEvidence, bool]:
    key = (source, str(external_id))
    e = existing.get(key)
    new = e is None
    if new:
        e = models.InitiativeEvidence(initiative_id=i.id, kind=kind, source=source, external_id=str(external_id)[:240])
        db.add(e)
        existing[key] = e
    for k, v in f.items():
        if v is not None and k in ("title", "text", "url", "media_url", "numbers", "occurred_at"):
            setattr(e, k, v)
    if new or e.state in ("auto", "review"):
        e.matched_by, e.confidence, e.why = f.get("matched_by"), round(conf, 2), (f.get("why") or "")[:240]
        e.state = "auto" if conf >= _threshold(i) else "review"
    return e, new


def scan(db: Session, i: models.Initiative, vision_budget: int = 6) -> dict:
    """Reads every source once; returns {found, new, review, by_kind, sources}."""
    c = contract_mod.ensure(db, i)
    rules = contract_mod.rules(db, i, c)
    lo, hi = _window(i)
    existing = {(e.source, e.external_id): e for e in db.query(models.InitiativeEvidence).filter(models.InitiativeEvidence.initiative_id == i.id)}
    new_items: list[models.InitiativeEvidence] = []
    sources: list[dict] = []
    by_kind: dict[str, int] = {}

    def keep(e, is_new):
        by_kind[e.kind] = by_kind.get(e.kind, 0) + 1
        if is_new:
            new_items.append(e)

    # posts
    from ..eventos import social
    posts, srcs = social.own_posts(db, i, lo, hi)
    sources += [{"kind": "posts", **s} for s in srcs]
    mapped_posts = {str(u).lower().rstrip("/") for u in ((c.mapped or {}).get("posts") or [])}
    refs = None
    for p in posts:
        how, conf, why = social.match_text(p.get("text"), rules)
        if (p.get("url") or "").lower().rstrip("/") in mapped_posts:
            how, conf, why = "mapped", 1.0, "added by you"
        if not how and p.get("media_url") and vision_budget > 0:
            if refs is None:
                refs = _refs(db, i)
            if refs:
                vision_budget -= 1
                how, conf, why = _vision(p, refs, i, c)
        if not how:
            continue
        e, n = _upsert(db, i, existing, "post", p["platform"].title(), p["external_id"], conf, title=(p.get("text") or "")[:120] or "Post",
                       text=(p.get("text") or "")[:4000], url=p.get("url"), media_url=p.get("media_url"), occurred_at=p.get("posted_at"),
                       numbers={"reach": p.get("reach"), "engagements": p.get("engagements")}, matched_by=how, why=why)
        keep(e, n)

    # ads
    for row in _ads(db, i, c, lo.date(), hi.date(), sources):
        e, n = _upsert(db, i, existing, "ad", row["platform"], f"{row['campaign_id'] or row['campaign']}", row["conf"], title=row["campaign"],
                       numbers={k: round(row[k], 2) for k in ("spend", "clicks", "impressions", "conversions")},
                       occurred_at=row["last"], matched_by=row["how"], why=row["why"])
        keep(e, n)

    # web sessions by UTM
    for row in _web(db, i, c, lo.date(), hi.date(), sources):
        e, n = _upsert(db, i, existing, "web", "GA4", f"utm:{row['campaign']}", 0.99, title=f"Sessions from utm_campaign={row['campaign']}",
                       numbers={"sessions": row["sessions"], "conversions": row["conversions"]}, occurred_at=row["last"],
                       matched_by="utm", why=f"utm_campaign is {row['campaign']}")
        keep(e, n)

    # deals
    pipe = deals(db, i)
    if pipe["sources"]:
        sources.append({"kind": "deals", "platform": "HubSpot", "name": ", ".join(s["name"] for s in pipe["sources"])})
    for d in pipe["deals"]:
        e, n = _upsert(db, i, existing, "deal", "HubSpot", d["deal_id"] or d["name"], 0.92 if d["how"] != "tagged" else 1.0, title=d["name"],
                       numbers={"amount": d["amount"], "won": 1 if d.get("won") else 0, "sourced": 1 if d["kind"] == "sourced" else 0},
                       occurred_at=_dt(d.get("created_at")), matched_by="company" if d["how"] != "tagged" else "mapped",
                       why=f"{d['kind']}: {d['how']}" + (f" ({d['company']})" if d.get("company") else ""))
        keep(e, n)

    # pages live and emails sent (GD360 counted these itself)
    from ..initiatives import tracking
    for l in tracking.link_stats(db, i):
        if l.get("kind") == "landing_page" and (l.get("visits") or 0) > 0:
            first = (l.get("tracking") or {}).get("first_seen") or (l.get("tracking") or {}).get("last_seen")
            e, n = _upsert(db, i, existing, "page", "Euliv", f"page:{l['id']}", 1.0, title=f"{l['label']} is live", url=l.get("url"),
                           numbers={"visits": l.get("visits"), "conversions": l.get("conversions")}, occurred_at=first if isinstance(first, datetime) else None,
                           matched_by="counted", why="first visit recorded by the Euliv snippet")
            keep(e, n)
    for camp in db.query(models.GtmCampaign).filter(models.GtmCampaign.initiative_id == i.id, models.GtmCampaign.status == "sent"):
        e, n = _upsert(db, i, existing, "email", "Euliv", f"email:{camp.id}", 1.0, title=f"Email sent: {camp.name}", occurred_at=camp.sent_at,
                       matched_by="counted", why="sent from Euliv")
        keep(e, n)
    db.commit()
    review = db.query(models.InitiativeEvidence).filter(models.InitiativeEvidence.initiative_id == i.id, models.InitiativeEvidence.state == "review").count()
    c.data = {**(c.data or {}), "last_scan": datetime.utcnow().isoformat() + "Z", "sources": sources}
    db.commit()
    return {"found": sum(by_kind.values()), "new": len(new_items), "review": review, "by_kind": by_kind, "sources": sources,
            "new_ids": [e.id for e in new_items]}


def _dt(s) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).rstrip("Z"))
    except ValueError:
        return None


def _refs(db: Session, i: models.Initiative) -> list[bytes]:
    rows = db.query(models.EventAsset).filter(models.EventAsset.initiative_id == i.id,
                                              models.EventAsset.kind.in_(("banner", "logo", "backdrop", "badge"))).limit(3).all()
    return [r.data for r in rows if r.data]


def _vision(p: dict, refs: list[bytes], i: models.Initiative, c: models.InitiativeContract) -> tuple[str | None, float, str]:
    from ..eventos import net, vision
    if not vision.available():
        return None, 0.0, ""
    try:
        img, _ct, _u = net.safe_get(p["media_url"], max_bytes=4_000_000, accept="image/*")
        m = vision.match_brand(img, refs, i.title, [c.hashtag or ""])
    except Exception:  # noqa: BLE001 - an image that won't load is simply not matched
        return None, 0.0, ""
    if not m.get("match") or m["confidence"] < 0.5:
        return None, 0.0, ""
    return "vision", m["confidence"], (m.get("why") or f"{m.get('seen')} in the picture")


def _ads(db: Session, i: models.Initiative, c: models.InitiativeContract, lo: date, hi: date, sources: list) -> list[dict]:
    from ..synced_sources import load_table
    rule = f"INIT-{c.code}".upper()
    mapped = {str(x).strip().lower() for x in ((c.mapped or {}).get("ads") or [])}
    camps: dict[tuple, dict] = {}
    if not i.workspace_id:
        return []
    for ds in db.query(models.DataSource).filter(models.DataSource.workspace_id == i.workspace_id, models.DataSource.kind.in_(tuple(AD_KINDS))).all():
        try:
            df = load_table(db, ds.id, "campaign_daily")
        except Exception:  # noqa: BLE001
            continue
        if df is None or not len(df):
            continue
        platform = AD_KINDS[ds.kind]
        sources.append({"kind": "ads", "platform": platform, "name": ds.name})
        spend_col = "spend" if "spend" in df.columns else "cost"
        conv_col = next((x for x in ("conversions", "purchases", "leads") if x in df.columns), None)
        for r in df.to_dict("records"):
            d = _day(r.get("date"))
            if d is None or d < lo or d > hi:
                continue
            name, cid = str(r.get("campaign") or ""), str(r.get("campaign_id") or "")
            how = "mapped" if (cid and cid.lower() in mapped) or name.strip().lower() in mapped else ("naming rule" if rule in name.upper() else None)
            if not how:
                continue
            k = (platform, cid or name)
            row = camps.setdefault(k, {"platform": platform, "campaign": name, "campaign_id": cid, "how": how, "conf": 1.0 if how == "mapped" else 0.99,
                                       "why": "mapped by you" if how == "mapped" else f"name carries {rule}", "spend": 0.0, "clicks": 0.0,
                                       "impressions": 0.0, "conversions": 0.0, "last": None, "daily": {}})
            sp = float(r.get(spend_col) or 0)
            row["spend"] += sp
            row["clicks"] += float(r.get("clicks") or 0)
            row["impressions"] += float(r.get("impressions") or 0)
            cv = float(r.get(conv_col) or 0) if conv_col else 0.0
            row["conversions"] += cv
            day = d.isoformat()
            dd = row["daily"].setdefault(day, {"spend": 0.0, "conversions": 0.0})
            dd["spend"] += sp
            dd["conversions"] += cv
            dt = datetime(d.year, d.month, d.day)
            row["last"] = dt if row["last"] is None or dt > row["last"] else row["last"]
    return list(camps.values())


def ad_days(db: Session, i: models.Initiative) -> list[dict]:
    """[{platform, campaign, day, spend, conversions}] for the mix model."""
    c = contract_mod.ensure(db, i)
    lo, hi = _window(i)
    out = []
    for row in _ads(db, i, c, (lo - timedelta(days=120)).date(), hi.date(), []):
        for day, v in row["daily"].items():
            out.append({"platform": row["platform"], "campaign": row["campaign"], "day": day, **v})
    return out


def _web(db: Session, i: models.Initiative, c: models.InitiativeContract, lo: date, hi: date, sources: list) -> list[dict]:
    from ..synced_sources import load_table
    want = {c.utm_campaign.lower(), c.code.lower()}
    out = {}
    if not i.workspace_id:
        return []
    for ds in db.query(models.DataSource).filter(models.DataSource.workspace_id == i.workspace_id, models.DataSource.kind == "ga4").all():
        try:
            df = load_table(db, ds.id, "traffic_daily")
        except Exception:  # noqa: BLE001
            continue
        if df is None or not len(df) or "campaign" not in df.columns:
            continue
        sources.append({"kind": "web", "platform": "GA4", "name": ds.name})
        for r in df.to_dict("records"):
            camp = str(r.get("campaign") or "").strip().lower()
            if not camp or not any(w == camp or w in camp for w in want):
                continue
            d = _day(r.get("date"))
            if d is None or d < lo or d > hi:
                continue
            row = out.setdefault(camp, {"campaign": camp, "sessions": 0.0, "conversions": 0.0, "last": None})
            row["sessions"] += float(r.get("sessions") or 0)
            row["conversions"] += float(r.get("key_events") or r.get("conversions") or 0)
            dt = datetime(d.year, d.month, d.day)
            row["last"] = dt if row["last"] is None or dt > row["last"] else row["last"]
    return list(out.values())


def _day(v) -> date | None:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except (TypeError, ValueError):
        return None


def companies(db: Session, i: models.Initiative) -> set[str]:
    ids = {a for (a,) in db.query(models.GtmEngagement.account_id).filter(models.GtmEngagement.initiative_id == i.id,
                                                                          models.GtmEngagement.account_id.isnot(None),
                                                                          models.GtmEngagement.kind.notin_(("email_sent", "note"))).distinct()}
    if not ids:
        return set()
    return {a.name for a in db.query(models.GtmAccount).filter(models.GtmAccount.id.in_(list(ids))) if a.name}


def deals(db: Session, i: models.Initiative) -> dict:
    from ..eventos import pipeline
    from ..initiatives.metrics import start_of
    cfg = SimpleNamespace(data={"deal_ids": ((db.get(models.InitiativeContract, i.id).data or {}).get("deal_ids") if db.get(models.InitiativeContract, i.id) else [])})
    return pipeline.deals_for(db, i, cfg, companies(db, i), start_of(i))


def accepted(db: Session, i: models.Initiative):
    return db.query(models.InitiativeEvidence).filter(models.InitiativeEvidence.initiative_id == i.id,
                                                      models.InitiativeEvidence.state.in_(("auto", "confirmed")))


def values(db: Session, i: models.Initiative) -> dict:
    """The numbers evidence stands behind (None when there is no evidence of that kind)."""
    rows = accepted(db, i).all()
    if not rows:
        return {}
    v: dict = {}
    posts = [e for e in rows if e.kind == "post"]
    if posts:
        v["social_reach"] = sum(float((e.numbers or {}).get("reach") or 0) for e in posts)
        v["social_engagements"] = sum(float((e.numbers or {}).get("engagements") or 0) for e in posts)
        v["posts_matched"] = len(posts)
    ads = [e for e in rows if e.kind == "ad"]
    if ads:
        v["ad_spend"] = round(sum(float((e.numbers or {}).get("spend") or 0) for e in ads), 2)
        v["ad_conversions"] = sum(float((e.numbers or {}).get("conversions") or 0) for e in ads)
        v["ad_clicks"] = sum(float((e.numbers or {}).get("clicks") or 0) for e in ads)
    web = [e for e in rows if e.kind == "web"]
    if web:
        v["utm_sessions"] = sum(float((e.numbers or {}).get("sessions") or 0) for e in web)
    dl = [e for e in rows if e.kind == "deal"]
    if dl:
        v["pipeline_value"] = round(sum(float((e.numbers or {}).get("amount") or 0) for e in dl if (e.numbers or {}).get("sourced")), 2)
        v["revenue"] = round(sum(float((e.numbers or {}).get("amount") or 0) for e in dl if (e.numbers or {}).get("won") and (e.numbers or {}).get("sourced")), 2)
        v["deals_sourced"] = sum(1 for e in dl if (e.numbers or {}).get("sourced"))
    return v


def row(e: models.InitiativeEvidence) -> dict:
    return {"id": e.id, "kind": e.kind, "source": e.source, "external_id": e.external_id, "title": e.title, "text": (e.text or "")[:400],
            "url": e.url, "media_url": e.media_url, "numbers": e.numbers or {}, "matched_by": e.matched_by, "confidence": e.confidence,
            "why": e.why, "state": e.state, "occurred_at": e.occurred_at.isoformat() + "Z" if e.occurred_at else None,
            "decided_by": e.decided_by}
