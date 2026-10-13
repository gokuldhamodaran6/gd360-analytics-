"""Pipeline from the event: HubSpot deals (synced) matched to the
companies of the people who came.

  sourced     a deal created after doors opened (up to 180 days) at a
              company that came
  influenced  a deal already open when the event started, at a company
              that came
  won         sourced deals marked won

Matching is by company name inside the deal name - the way most teams
name deals ("Larkspur Bank - data platform"). Deals can also be tagged to
the event by id. Truth label: matched."""
from __future__ import annotations

import re
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ... import models

_GENERIC = {"inc", "ltd", "llc", "pvt", "private", "limited", "technologies", "tech", "solutions", "group", "the", "co",
            "corp", "corporation", "india", "global", "labs", "services"}


def _key(name: str) -> str:
    words = [w for w in re.findall(r"[a-z0-9]+", (name or "").lower()) if w not in _GENERIC]
    return " ".join(words)


def _ts(v) -> datetime | None:
    if v is None:
        return None
    try:
        import pandas as pd
        t = pd.to_datetime(v, errors="coerce", utc=True)
        if pd.isna(t):
            return None
        return t.tz_convert(None).to_pydatetime()
    except Exception:  # noqa: BLE001
        return None


def deals_for(db: Session, i: models.Initiative, cfg: models.EventConfig, companies: set[str], start: datetime | None) -> dict:
    data = cfg.data or {}
    if data.get("sample"):
        return _summ(data.get("sample_deals") or [], [{"name": "Sample data"}])
    rows = []
    sources = []
    if not i.workspace_id:
        return _summ([], [])
    from ..synced_sources import load_table
    keys = {k for k in (_key(c) for c in companies) if len(k) >= 4}
    tagged = {str(x) for x in (data.get("deal_ids") or [])}
    for ds in db.query(models.DataSource).filter(models.DataSource.workspace_id == i.workspace_id,
                                                 models.DataSource.kind == "hubspot").all():
        try:
            df = load_table(db, ds.id, "deals")
        except Exception:  # noqa: BLE001
            continue
        if df is None or not len(df):
            continue
        sources.append({"name": ds.name})
        for r in df.to_dict("records"):
            name = str(r.get("name") or "")
            did = str(r.get("deal_id") or "")
            nk = _key(name)
            company = next((k for k in keys if k and (f" {k} " in f" {nk} ")), None)
            if did not in tagged and not company:
                continue
            created = _ts(r.get("created_at"))
            amount = float(r.get("amount") or 0)
            if start is None or created is None:
                kind = "sourced" if did in tagged else "influenced"
            elif created >= start - timedelta(days=1):
                if created > start + timedelta(days=180):
                    continue
                kind = "sourced"
            else:
                if r.get("is_closed") and not r.get("is_won"):
                    continue
                kind = "influenced"
            rows.append({"deal_id": did, "name": name, "amount": amount, "stage": r.get("stage"), "kind": kind,
                         "won": bool(r.get("is_won")), "created_at": created.isoformat() + "Z" if created else None,
                         "company": company, "how": "tagged" if did in tagged else "company in deal name"})
    return _summ(rows, sources)


def _summ(rows: list[dict], sources: list[dict]) -> dict:
    src = [r for r in rows if r.get("kind") == "sourced"]
    inf = [r for r in rows if r.get("kind") == "influenced"]
    won = [r for r in src if r.get("won")]
    return {"deals": sorted(rows, key=lambda r: -(r.get("amount") or 0)), "sources": sources,
            "sourced": round(sum(r.get("amount") or 0 for r in src), 2), "sourced_n": len(src),
            "influenced": round(sum(r.get("amount") or 0 for r in inf), 2), "influenced_n": len(inf),
            "won": round(sum(r.get("amount") or 0 for r in won), 2), "won_n": len(won)}
