"""2026-10-17 (R53): the business brain - what GD360 knows about the business, so a plan starts from the business
and not from a blank template.

  website     the home page (title, description, headings), read when the workspace has one
  about       the model's short reading of the website (or what the person wrote; theirs is never overwritten)
  brand       the workspace brand kit
  audiences   customers by ICP tier, and investors / partners / candidates when the account lists say so
  sources     every connected source with its last-90-days numbers (posts and reach, ad spend and cost per result,
              sessions, deals and pipeline, orders and revenue)
  history     what earlier initiatives of each kind achieved
  facts       all of the above as [{key, label, value, unit, source}] - the planner must cite one of these for a
              number, or mark the number as an assumption
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from ... import models
from . import packs

AUD_WORDS = {
    "investors": ("investor", "vc", "venture", "angel", "lp", "fund", "demo day", "pitch"),
    "partners": ("partner", "reseller", "distributor", "channel", "alliance", "broker", "agent"),
    "candidates": ("candidate", "hiring", "recruit", "talent", "job", "intern", "campus"),
    "students": ("student", "admission", "parents", "enrol"),
    "donors": ("donor", "fundrais", "gala", "volunteer"),
    "press": ("press", "media", "journalist"),
}


def audience_type(text: str | None) -> str:
    t = (text or "").lower()
    for k, words in AUD_WORDS.items():
        if any(re.search(r"\b" + re.escape(w), t) for w in words):
            return k
    return "customers"


def _num(v) -> float | None:
    try:
        f = float(v)
        return None if f != f else f
    except (TypeError, ValueError):
        return None


def _col(df, *names):
    for n in names:
        if n in df.columns:
            return n
    return None


def _recent(df, days: int = 90):
    import pandas as pd
    dc = _col(df, "date", "posted_at", "post_date", "created_at", "createdate", "closedate", "order_date")
    if not dc:
        return df, None
    d = pd.to_datetime(df[dc], errors="coerce", utc=True).dt.tz_localize(None)
    cut = datetime.utcnow() - timedelta(days=days)
    return df[d >= cut], dc


def source_numbers(db: Session, workspace_id: str) -> list[dict]:
    """Every connected source with the numbers a planner can use, last 90 days."""
    from ..synced_sources import load_table
    out = []
    for ds in db.query(models.DataSource).filter(models.DataSource.workspace_id == workspace_id).all():
        row = {"id": ds.id, "kind": ds.kind, "name": ds.name, "numbers": []}
        try:
            if ds.kind in ("instagram", "facebook_pages", "linkedin_pages", "youtube"):
                df = load_table(db, ds.id, "posts")
                r, _ = _recent(df)
                reach = r[_col(r, "reach", "impressions", "views")] if _col(r, "reach", "impressions", "views") else None
                row["numbers"] += [("posts_90d", "Posts in the last 90 days", float(len(r)), "count")]
                if reach is not None and len(r):
                    row["numbers"].append(("avg_reach", "Average reach per post", round(float(reach.fillna(0).mean()), 1), "count"))
            elif ds.kind in ("meta_ads", "google_ads"):
                df = load_table(db, ds.id, "campaign_daily")
                r, _ = _recent(df)
                sc = _col(r, "spend", "cost")
                cc = _col(r, "conversions", "purchases", "leads")
                spend = float(r[sc].fillna(0).sum()) if sc else 0.0
                conv = float(r[cc].fillna(0).sum()) if cc else 0.0
                row["numbers"] += [("ad_spend_90d", "Ad spend, last 90 days", round(spend, 2), "money")]
                if conv:
                    row["numbers"] += [("conversions_90d", "Ad conversions, last 90 days", conv, "count"),
                                       ("cost_per_result", "Cost per result", round(spend / conv, 2), "money")]
            elif ds.kind == "ga4":
                df = load_table(db, ds.id, "traffic_daily")
                r, _ = _recent(df)
                if _col(r, "sessions"):
                    row["numbers"].append(("sessions_90d", "Website sessions, last 90 days", float(r["sessions"].fillna(0).sum()), "count"))
                if _col(r, "key_events"):
                    row["numbers"].append(("key_events_90d", "Key events (conversions), last 90 days", float(r["key_events"].fillna(0).sum()), "count"))
            elif ds.kind == "hubspot":
                df = load_table(db, ds.id, "deals")
                r, _ = _recent(df, 365)
                ac = _col(r, "amount")
                row["numbers"].append(("deals_12m", "Deals created, last 12 months", float(len(r)), "count"))
                if ac:
                    row["numbers"].append(("pipeline_12m", "Pipeline created, last 12 months", round(float(r[ac].apply(_num).fillna(0).sum()), 2), "money"))
            elif ds.kind in ("shopify", "woocommerce", "stripe"):
                tbl = "orders" if ds.kind != "stripe" else None
                df = load_table(db, ds.id, tbl)
                r, _ = _recent(df)
                vc = _col(r, "total_price", "total", "amount", "revenue", "net")
                row["numbers"].append(("orders_90d", "Orders, last 90 days", float(len(r)), "count"))
                if vc:
                    row["numbers"].append(("revenue_90d", "Revenue, last 90 days", round(float(r[vc].apply(_num).fillna(0).sum()), 2), "money"))
            else:
                continue
        except Exception:  # noqa: BLE001 - not synced yet, or a table without those columns
            if not row["numbers"]:
                row["numbers"].append(("not_synced", "Connected, not synced yet", None, "note"))
        out.append(row)
    return out


def _website_text(url: str) -> dict:
    from ..eventos.net import page_preview, safe_get
    if not re.match(r"^https?://", url):
        url = "https://" + url
    out = {"url": url}
    try:
        pv = page_preview(url)
        out.update({"title": pv.get("title"), "description": pv.get("description"), "site": pv.get("site")})
        body, _ct, _f = safe_get(url, max_bytes=800_000, accept="text/html,*/*")
        html = body.decode("utf-8", errors="ignore")
        heads = [re.sub(r"<[^>]+>", " ", h) for h in re.findall(r"<h[1-3][^>]*>(.*?)</h[1-3]>", html, re.I | re.S)]
        out["headings"] = [re.sub(r"\s+", " ", h).strip()[:140] for h in heads if h.strip()][:16]
    except Exception as e:  # noqa: BLE001 - an unreachable site leaves the brain without it, said plainly
        out["error"] = str(e)[:160]
    return out


def _read_site(site: dict) -> dict:
    """The model's reading of the website: about, products, voice. Empty when the model is unavailable."""
    if not (site.get("title") or site.get("description") or site.get("headings")):
        return {}
    from .. import ai_engine
    try:
        raw = ai_engine._call_llm_resilient([
            {"role": "system", "content": "GD360 BUSINESS BRAIN. From the website text, reply with JSON only: "
                                          '{"about": "2 sentences on what the business does and for whom", "products": ["up to 6"], '
                                          '"voice": "how it writes, in a few words", "industry": "one of: ' + ", ".join(packs.PACKS) + '"}. '
                                          "Use only what the text says."},
            {"role": "user", "content": json.dumps(site)[:6000]}], max_tokens=500)
        m = re.search(r"\{.*\}", raw or "", re.S)
        d = json.loads(m.group(0)) if m else {}
        return d if isinstance(d, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _audiences(db: Session, workspace_id: str) -> dict:
    A = models.GtmAccount
    tiers = dict(db.query(A.icp_tier, func.count()).filter(A.workspace_id == workspace_id).group_by(A.icp_tier).all())
    out = {"customers": {"accounts": int(sum(tiers.values())), "tiers": {k or "unscored": v for k, v in tiers.items()}}}
    for k, words in AUD_WORDS.items():
        if k in ("students", "donors", "press"):
            continue
        n = 0
        for w in words[:3]:
            n += db.query(func.count(A.id)).filter(A.workspace_id == workspace_id,
                                                    (A.segment.ilike(f"%{w}%")) | (A.list_name.ilike(f"%{w}%"))).scalar() or 0
        if n:
            out[k] = {"accounts": int(n), "from": "account lists and segments"}
    contacts = db.query(func.count(models.GtmContact.id)).filter(models.GtmContact.workspace_id == workspace_id).scalar() or 0
    out["customers"]["contacts"] = int(contacts)
    return out


def _history(db: Session, workspace_id: str) -> dict:
    from ..initiatives import metrics
    kinds = [k for (k,) in db.query(models.Initiative.kind).filter(models.Initiative.workspace_id == workspace_id).distinct()]
    out = {}
    for k in kinds:
        h = metrics.history(db, workspace_id, k)
        if h.get("count"):
            out[k] = {"count": h["count"], "averages": h["averages"]}
    return out


def refresh(db: Session, workspace_id: str, website: str | None = None) -> models.BusinessProfile:
    bp = db.get(models.BusinessProfile, workspace_id)
    if bp is None:
        bp = models.BusinessProfile(workspace_id=workspace_id, edited={})
        db.add(bp)
    edited = dict(bp.edited or {})
    if website:
        bp.website, edited["website"] = website.strip()[:300], True
    if not bp.website:
        prof = db.query(models.GtmProfile).filter(models.GtmProfile.workspace_id == workspace_id).first()
        doms = (prof.site_domains if prof else None) or []
        bp.website = doms[0] if doms else None
    facts: list[dict] = []
    today = date.today().isoformat()
    if bp.website:
        site = _website_text(bp.website)
        read = _read_site(site)
        if read.get("about") and not edited.get("about"):
            bp.about = str(read["about"])[:800]
        if read.get("products") and not edited.get("products"):
            bp.products = [str(p)[:80] for p in read["products"]][:8]
        if read.get("voice") and not edited.get("voice"):
            bp.voice = str(read["voice"])[:200]
        if read.get("industry") in packs.PACKS and not edited.get("industry"):
            bp.industry = read["industry"]
        if not bp.about and not edited.get("about") and site.get("description"):
            bp.about = site["description"][:800]
        data = {"site": {k: site.get(k) for k in ("title", "description", "headings", "error")}}
    else:
        data = {"site": None}
    if not bp.industry and not edited.get("industry"):
        bp.industry = packs.guess(" ".join(filter(None, [bp.about, " ".join(bp.products or [])])))
    bp.audiences = _audiences(db, workspace_id)
    srcs = source_numbers(db, workspace_id)
    bp.sources = [{"id": s["id"], "kind": s["kind"], "name": s["name"],
                   "numbers": [{"key": k, "label": l, "value": v, "unit": u} for k, l, v, u in s["numbers"]]} for s in srcs]
    for s in srcs:
        for k, l, v, u in s["numbers"]:
            if v is not None:
                facts.append({"key": f"{s['kind']}.{k}", "label": f"{l} ({s['name']})", "value": v, "unit": u,
                              "source": s["name"], "as_of": today})
    cust = bp.audiences.get("customers") or {}
    if cust.get("accounts"):
        facts.append({"key": "gtm.accounts", "label": "Accounts in GD360", "value": cust["accounts"], "unit": "count", "source": "GD360 accounts", "as_of": today})
    for kind, h in _history(db, workspace_id).items():
        for k, v in (h.get("averages") or {}).items():
            facts.append({"key": f"history.{kind}.{k}", "label": f"Average {k.replace('_', ' ')} of your past {kind}s ({h['count']})", "value": v,
                          "unit": "pct" if k.endswith("rate") else "count", "source": f"{h['count']} past {kind}{'s' if h['count'] != 1 else ''} in GD360", "as_of": today})
    bp.facts = facts
    ws = db.get(models.Workspace, workspace_id)
    kit = (ws.brand_kit if ws is not None else None) or {}
    bp.edited = edited
    bp.refreshed_at = datetime.utcnow()
    bp.updated_at = datetime.utcnow()
    bp.integrations = bp.integrations or {}
    bp.integrations = {**bp.integrations, "_brand": {"palette": kit.get("palette"), "font": kit.get("font")} if kit else None, "_site": data["site"]}
    db.commit()
    return bp


def get(db: Session, workspace_id: str, refresh_if_older_h: float | None = 24) -> models.BusinessProfile:
    bp = db.get(models.BusinessProfile, workspace_id)
    if bp is None or (refresh_if_older_h is not None and (bp.refreshed_at is None or bp.refreshed_at < datetime.utcnow() - timedelta(hours=refresh_if_older_h))):
        try:
            bp = refresh(db, workspace_id)
        except Exception as e:  # noqa: BLE001 - a plan must still come back
            db.rollback()
            print(f"[autopilot.brain] refresh skipped: {e}")
            bp = db.get(models.BusinessProfile, workspace_id) or models.BusinessProfile(workspace_id=workspace_id, facts=[], sources=[], audiences={})
    return bp


def edit(db: Session, workspace_id: str, changes: dict) -> models.BusinessProfile:
    bp = get(db, workspace_id, refresh_if_older_h=None)
    if bp not in db:
        db.add(bp)
    edited = dict(bp.edited or {})
    for k in ("website", "about", "voice", "industry"):
        if k in changes and changes[k] is not None:
            v = str(changes[k]).strip()
            if k == "industry" and v and v not in packs.PACKS:
                continue
            setattr(bp, k, v[:800] or None)
            edited[k] = True
    if isinstance(changes.get("products"), list):
        bp.products, edited["products"] = [str(p).strip()[:80] for p in changes["products"] if str(p).strip()][:12], True
    bp.edited = edited
    bp.updated_at = datetime.utcnow()
    db.commit()
    return bp


def out(bp: models.BusinessProfile) -> dict:
    integ = bp.integrations or {}
    return {"workspace_id": bp.workspace_id, "website": bp.website, "about": bp.about, "products": bp.products or [], "voice": bp.voice,
            "industry": bp.industry, "industry_label": (packs.PACKS.get(bp.industry or "") or {}).get("label"),
            "audiences": bp.audiences or {}, "sources": bp.sources or [], "facts": bp.facts or [], "edited": bp.edited or {},
            "brand": integ.get("_brand"), "site": integ.get("_site"),
            "benchmarks": packs.benchmarks_for(bp.industry),
            "refreshed_at": bp.refreshed_at.isoformat() + "Z" if bp.refreshed_at else None}


def for_planner(bp: models.BusinessProfile, kind: str | None) -> dict:
    """What the planner sees: the business, its audiences, every fact with its source, the industry benchmarks."""
    return {"about": bp.about, "products": bp.products or [], "voice": bp.voice, "industry": (packs.PACKS.get(bp.industry or "") or {}).get("label"),
            "audiences": bp.audiences or {}, "facts": [{k: f.get(k) for k in ("key", "label", "value", "unit", "source")} for f in (bp.facts or [])][:60],
            "benchmarks": packs.benchmarks_for(bp.industry)}


# target key -> the brain facts that can stand behind it
_FACT_FOR = {
    "social_reach": ("avg_reach", "posts_90d"), "social_engagements": ("avg_reach",), "cost_per_lead": ("cost_per_result",),
    "pipeline_value": ("pipeline_12m",), "revenue": ("revenue_90d",), "landing_visits": ("sessions_90d",), "web_visits": ("sessions_90d",),
    "landing_conversions": ("key_events_90d", "conversions_90d"), "opportunities": ("deals_12m",),
}
_BENCH_FOR = {"attendance_rate": "webinar_attendance_pct", "open_rate": "email_open_pct", "click_rate": "email_click_pct",
              "reply_rate": "warm_reply_pct", "cost_per_lead": "linkedin_cpl_usd"}


def cite(targets: list[dict], kind: str, bp: models.BusinessProfile | None, history: dict | None) -> list[dict]:
    """Every target gets a source: your history, a brain fact, an industry benchmark - or it says "assumption"."""
    facts = (bp.facts if bp is not None else None) or []
    avgs = (history or {}).get("averages") or {}
    n_hist = (history or {}).get("count") or 0
    pack = bp.industry if bp is not None else None
    out = []
    for t in targets:
        key = t.get("key")
        src = None
        if key in avgs:
            src = {"kind": "history", "label": f"Your {n_hist} past {kind}{'s' if n_hist != 1 else ''} averaged {avgs[key]:g}", "value": avgs[key]}
        if src is None:
            for f in facts:
                if any(f["key"].endswith("." + fk) for fk in _FACT_FOR.get(key, ())):
                    src = {"kind": "brain", "label": f"{f['label']}: {f['value']:g}" if isinstance(f.get("value"), (int, float)) else f["label"], "value": f.get("value"), "source": f.get("source")}
                    break
        if src is None and key in _BENCH_FOR and _BENCH_FOR[key] in packs.BENCHMARKS:
            b = packs.BENCHMARKS[_BENCH_FOR[key]]
            src = {"kind": "benchmark", "label": f"Industry range {b['range'][0]:g}-{b['range'][2]:g} ({b['source']})", "value": b["range"][1]}
        if src is None:
            src = {"kind": "assumption", "label": "Assumption: no history, fact or benchmark behind this number yet"}
        out.append({**t, "source": src})
    return out
