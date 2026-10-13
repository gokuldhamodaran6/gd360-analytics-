"""Ad spend for one event, read from the synced Meta Ads and Google Ads
tables (campaign_daily). A campaign counts for the event when its name
carries the event's naming rule (INIT-{code}, e.g. INIT-AIS26-LI-cxo), or
when it was mapped to the event by hand. Nothing is typed."""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy.orm import Session

from ... import models

AD_KINDS = {"meta_ads": "Meta ads", "google_ads": "Google ads"}


def _datasources(db: Session, workspace_id: str | None, kinds) -> list[models.DataSource]:
    if not workspace_id:
        return []
    return db.query(models.DataSource).filter(models.DataSource.workspace_id == workspace_id,
                                              models.DataSource.kind.in_(tuple(kinds))).all()


def naming_rule(cfg: models.EventConfig) -> str:
    return f"INIT-{(cfg.code or 'EVT').upper()}"


def _matches(name: str, cid: str, rule: str, mapped: set[str]) -> str | None:
    n = (name or "").upper()
    if cid and cid in mapped:
        return "mapped"
    if name and name.strip().lower() in mapped:
        return "mapped"
    if rule and rule in n:
        return "naming rule"
    return None


def campaigns_for(db: Session, i: models.Initiative, cfg: models.EventConfig, lo: date | None = None,
                  hi: date | None = None) -> dict:
    """{rows: [{date, platform, campaign, campaign_id, spend, clicks, impressions, conversions}],
        campaigns: [{platform, campaign, id, spend, how}], unmatched: [recent campaigns not mapped],
        sources: [{platform, name, synced_at}]}"""
    data = cfg.data or {}
    if data.get("sample"):
        rows = [r for r in data.get("sample_ads") or []]
        return _summarise(rows, [], [{"platform": "Sample data", "name": "sample", "synced_at": None}])
    from ..synced_sources import load_table
    rule = naming_rule(cfg)
    mapped = {str(x).strip().lower() if not str(x).isdigit() else str(x) for x in (cfg.ad_campaigns or [])}
    rows: list[dict] = []
    seen_unmatched: dict[tuple, float] = {}
    sources = []
    for ds in _datasources(db, i.workspace_id, AD_KINDS):
        try:
            df = load_table(db, ds.id, "campaign_daily")
        except Exception:  # noqa: BLE001 - not synced yet
            continue
        if df is None or not len(df):
            continue
        platform = AD_KINDS[ds.kind]
        sources.append({"platform": platform, "name": ds.name, "synced_at": None})
        spend_col = "spend" if "spend" in df.columns else "cost"
        conv_col = "purchases" if "purchases" in df.columns else ("conversions" if "conversions" in df.columns else None)
        for r in df.to_dict("records"):
            d = r.get("date")
            if isinstance(d, datetime):
                d = d.date()
            if isinstance(d, str):
                try:
                    d = date.fromisoformat(d[:10])
                except ValueError:
                    continue
            if d is None or (lo and d < lo) or (hi and d > hi):
                continue
            name, cid = str(r.get("campaign") or ""), str(r.get("campaign_id") or "")
            how = _matches(name, cid, rule, mapped)
            spend = float(r.get(spend_col) or 0)
            if not how:
                k = (platform, name, cid)
                seen_unmatched[k] = seen_unmatched.get(k, 0) + spend
                continue
            rows.append({"date": d.isoformat(), "platform": platform, "campaign": name, "campaign_id": cid, "how": how,
                         "spend": spend, "clicks": float(r.get("clicks") or 0), "impressions": float(r.get("impressions") or 0),
                         "conversions": float(r.get(conv_col) or 0) if conv_col else 0.0})
    unmatched = [{"platform": p, "campaign": n, "id": c, "spend": round(s, 2)}
                 for (p, n, c), s in sorted(seen_unmatched.items(), key=lambda x: -x[1])[:12] if s > 0]
    return _summarise(rows, unmatched, sources)


def _summarise(rows: list[dict], unmatched: list[dict], sources: list[dict]) -> dict:
    camps: dict[tuple, dict] = {}
    for r in rows:
        k = (r["platform"], r["campaign"])
        c = camps.setdefault(k, {"platform": r["platform"], "campaign": r["campaign"], "id": r.get("campaign_id"),
                                 "how": r.get("how", "naming rule"), "spend": 0.0, "clicks": 0.0, "impressions": 0.0,
                                 "conversions": 0.0})
        for f in ("spend", "clicks", "impressions", "conversions"):
            c[f] += float(r.get(f) or 0)
    return {"rows": rows, "campaigns": sorted(camps.values(), key=lambda c: -c["spend"]), "unmatched": unmatched,
            "sources": sources, "total": round(sum(r["spend"] for r in rows), 2)}
