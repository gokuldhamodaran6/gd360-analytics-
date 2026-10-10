"""
Data the workspace has ALREADY connected to GD360 (GA4, Google Ads, Meta
Ads, LinkedIn Pages, Instagram, HubSpot, Klaviyo, Shopify, Stripe ...) is
used before asking anyone to set anything up: the tracking plan marks those
numbers as covered, and the initiative offers ready-made questions that open
in Ask anything against that exact source - no extra work, no new tools.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from ... import models

# kind -> (what it covers, metric keys it can answer, questions; {t} = the
# initiative's short name)
SOURCES = {
    "ga4": ("Website traffic", {"web_visits", "landing_visits", "landing_conversions"},
            ["Sessions, users and conversions by landing page for the last 30 days",
             "Sessions by source and medium for the last 30 days, with utm_campaign containing \"{t}\""]),
    "search_console": ("Search", set(), ["Clicks and impressions by page for the last 28 days"]),
    "google_ads": ("Paid search", {"cost_per_lead"},
                   ["Cost, clicks and conversions by campaign for the last 30 days, campaigns containing \"{t}\"",
                    "Cost per conversion by day for the last 30 days"]),
    "meta_ads": ("Paid social (Meta)", {"cost_per_lead"},
                 ["Spend, reach, clicks and results by campaign for the last 30 days, campaigns containing \"{t}\""]),
    "linkedin_pages": ("LinkedIn page", {"social_reach", "social_engagements"},
                       ["Impressions, clicks and engagement by post for the last 30 days",
                        "Which posts about \"{t}\" got the most engagement?"]),
    "instagram": ("Instagram", {"social_reach", "social_engagements"},
                  ["Reach and engagement by post for the last 30 days"]),
    "facebook_pages": ("Facebook page", {"social_reach", "social_engagements"},
                       ["Reach and engagement by post for the last 30 days"]),
    "youtube": ("YouTube", set(), ["Views and watch time by video for the last 30 days"]),
    "hubspot": ("CRM", {"pipeline_value", "revenue", "opportunities"},
                ["Deals created in the last 30 days by source and stage", "Pipeline value by deal stage"]),
    "klaviyo": ("Email", {"open_rate", "click_rate"}, ["Open and click rate by campaign for the last 30 days"]),
    "shopify": ("Sales", {"revenue"}, ["Revenue by day for the last 30 days"]),
    "woocommerce": ("Sales", {"revenue"}, ["Revenue by day for the last 30 days"]),
    "stripe": ("Revenue", {"revenue"}, ["New revenue by customer for the last 30 days"]),
}


RELEVANT = {
    "event": ("ga4", "linkedin_pages", "google_ads", "meta_ads", "hubspot", "instagram", "facebook_pages", "klaviyo"),
    "webinar": ("ga4", "linkedin_pages", "google_ads", "meta_ads", "hubspot", "youtube", "klaviyo"),
    "campaign": ("ga4", "google_ads", "meta_ads", "linkedin_pages", "klaviyo", "hubspot", "instagram", "facebook_pages", "search_console"),
    "abm": ("ga4", "hubspot", "linkedin_pages", "google_ads", "meta_ads", "search_console"),
    "product": ("ga4", "stripe", "shopify", "woocommerce", "search_console"),
    "hiring": ("linkedin_pages",),
    "custom": tuple(SOURCES),
}


def _short(title: str) -> str:
    words = [w for w in (title or "").split() if len(w) > 3]
    return " ".join(words[:2]) or title


def for_initiative(db: Session, user: models.User, i: models.Initiative) -> list[dict]:
    from ..project_engine.catalog import accessible_sources
    out = []
    t = _short(i.title)
    order = RELEVANT.get(i.kind) or RELEVANT["custom"]
    for ds in accessible_sources(db, user, i.workspace_id):
        meta = SOURCES.get(ds.kind)
        if not meta or ds.kind not in order:
            continue
        covers, keys, qs = meta
        out.append({"id": ds.id, "name": ds.name, "kind": ds.kind, "covers": covers, "metrics": sorted(keys),
                    "questions": [q.replace("{t}", t) for q in qs],
                    "last_synced_at": (ds.last_synced_at.isoformat() + "Z") if getattr(ds, "last_synced_at", None) else None})
    out.sort(key=lambda c: order.index(c["kind"]))
    return out


def apply_to_plan(plan: list[dict], connected: list[dict]) -> list[dict]:
    """A target the workspace's connected data already answers is covered:
    say so, and offer the question instead of a setup step."""
    by_metric: dict[str, dict] = {}
    for c in connected:
        for k in c["metrics"]:
            by_metric.setdefault(k, c)
    for row in plan:
        c = by_metric.get(row["key"])
        if c and row["state"] in ("setup", "manual"):
            row["state"] = "connected"
            row["how"] = f"Already connected in GD360: {c['name']} ({c['covers']}). Ask it directly - nothing to set up."
            row["action"] = f"ask:{c['id']}"
            row["question"] = c["questions"][0]
    used = {row.get("action") for row in plan}
    rest = [c for c in connected if f"ask:{c['id']}" not in used]
    if rest:
        plan.append({"key": "sources", "label": "Also connected in GD360", "state": "connected",
                     "how": ", ".join(f"{c['name']} ({c['covers']})" for c in rest[:6])
                            + " - ask any of them about this initiative from the Overview.",
                     "action": f"ask:{rest[0]['id']}", "question": rest[0]["questions"][0]})
    return plan
