"""
2026-10-09 (round 15): Spaces - named groups of data sources for one team or
subject ("Marketing & Brand", "Sales", "Finance", "HR & People").

Rules (models.Space):
  - who sees a Space: its owner; every member of its workspace when
    access == "workspace"; the people in member_ids when access == "members".
  - a Space never grants access to data: every list of its sources is
    filtered by workspace_access.can_access_datasource for the viewer.
  - who changes a Space: its owner, or the owner of its workspace.

Also here: the Space a newly connected app belongs in (suggest_space), the
freshness line every Space card shows, and the Space overview - the
"Marketing & Brand hub" computed straight from the synced tables of the
Space's sources (overview()).
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta

import pandas as pd
from sqlalchemy.orm import Session

from .. import models
from . import workspace_access
from .project_engine.catalog import KIND_LABELS, LIVE_DIALECTS
from .project_engine.numbers import fmt, pct_change

ACCESS_LEVELS = ("private", "workspace", "members")
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_SOURCES_PER_SPACE = 60

# ---- kinds -------------------------------------------------------------------

SOCIAL_KINDS = ("instagram", "facebook_pages", "linkedin_pages", "youtube")
PAID_KINDS = ("meta_ads", "google_ads")
STORE_KINDS = ("shopify", "woocommerce", "stripe")

# Labels for the kinds the connectors builder adds this round, used until
# services.synced_sources.APPS carries them.
_EXTRA_LABELS = {
    "instagram": "Instagram", "facebook_pages": "Facebook Pages", "linkedin_pages": "LinkedIn Pages",
    "youtube": "YouTube", "search_console": "Search Console", "woocommerce": "WooCommerce",
    "stripe": "Stripe", "hubspot": "HubSpot", "klaviyo": "Klaviyo",
}

_SUGGEST = {
    "Marketing & Brand": ("instagram", "facebook_pages", "linkedin_pages", "youtube", "tiktok", "pinterest",
                          "meta_ads", "google_ads", "linkedin_ads", "tiktok_ads", "ga4", "search_console", "klaviyo",
                          "mailchimp"),
    "Sales": ("shopify", "woocommerce", "stripe", "hubspot", "amazon", "amazon_seller", "salesforce", "etsy", "ebay"),
    "Finance": ("quickbooks", "xero", "netsuite"),
    "HR & People": ("bamboohr", "workday", "greenhouse", "gusto", "deel"),
}

SPACE_TEMPLATES = {
    "Marketing & Brand": {"color": "#C9A7FF", "description": "Social pages, ads, web and search"},
    "Sales": {"color": "#43E5A0", "description": "Store, marketplaces, payments, CRM"},
    "Finance": {"color": "#F2B84B", "description": "Books, payouts and revenue"},
    "HR & People": {"color": "#FF8FA3", "description": "Headcount, hiring, payroll"},
    "Product & Testing": {"color": "#7AA7FF", "description": "App data, experiments, tickets"},
}


def _apps() -> dict:
    try:
        from . import synced_sources
        return dict(synced_sources.APPS)
    except Exception:  # noqa: BLE001
        return {}


def kind_label(kind: str) -> str:
    app = _apps().get(kind)
    if app and app.get("label"):
        return app["label"]
    return KIND_LABELS.get(kind) or _EXTRA_LABELS.get(kind) or kind


def source_mode(kind: str) -> str:
    """"synced" for apps GD360 copies on a schedule, "live" for databases and
    warehouses queried in place, "file" for uploads, sheets, APIs, streams."""
    if kind in _apps():
        return "synced"
    if kind in LIVE_DIALECTS or kind == "mongodb":
        return "live"
    return "file"


def suggest_space(kind: str) -> str | None:
    for name, kinds in _SUGGEST.items():
        if kind in kinds:
            return name
    return None


# ---- visibility --------------------------------------------------------------

def can_view(db: Session, space: models.Space, user: models.User) -> bool:
    if space.owner_id == user.id:
        return True
    if space.access == "workspace" and space.workspace_id:
        return workspace_access.member_role(db, user.id, space.workspace_id) is not None
    if space.access == "members":
        return user.id in (space.member_ids or [])
    return False


def can_edit(db: Session, space: models.Space, user: models.User) -> bool:
    if space.owner_id == user.id:
        return True
    if space.workspace_id:
        return workspace_access.member_role(db, user.id, space.workspace_id) == "owner"
    return False


def list_spaces(db: Session, user: models.User, workspace_id: str | None = None) -> list[models.Space]:
    q = db.query(models.Space)
    if workspace_id:
        ws = db.get(models.Workspace, workspace_id)
        if ws and ws.is_personal and ws.owner_id == user.id:
            q = q.filter((models.Space.workspace_id == workspace_id) | (models.Space.workspace_id.is_(None)))
        else:
            q = q.filter(models.Space.workspace_id == workspace_id)
    rows = q.order_by(models.Space.created_at.asc()).all()
    return [s for s in rows if can_view(db, s, user)]


def get_space(db: Session, user: models.User, space_id: str) -> models.Space | None:
    s = db.get(models.Space, space_id) if space_id else None
    return s if s and can_view(db, s, user) else None


def space_sources(db: Session, user: models.User, space: models.Space) -> list[models.DataSource]:
    """The Space's sources this person may use, in the Space's order."""
    out = []
    for sid in space.source_ids or []:
        ds = db.get(models.DataSource, sid)
        if ds and workspace_access.can_access_datasource(db, ds, user):
            out.append(ds)
    return out


def space_source_ids(db: Session, user: models.User, space_id: str) -> list[str]:
    """Accessible source ids of a Space the person can see ([] otherwise).
    Used by Projects and ML Studio to scope work to a Space."""
    space = get_space(db, user, space_id)
    if not space:
        return []
    return [ds.id for ds in space_sources(db, user, space)]


# ---- freshness ---------------------------------------------------------------

def _ago(ts: datetime | None) -> str:
    if not ts:
        return "never"
    secs = max(0, int((datetime.utcnow() - ts).total_seconds()))
    if secs < 90:
        return "just now"
    if secs < 3600:
        return f"{secs // 60} min ago"
    if secs < 86400:
        return f"{secs // 3600} h ago"
    return f"{secs // 86400} d ago"


def freshness(sources: list[models.DataSource]) -> dict:
    synced = [ds for ds in sources if source_mode(ds.kind) == "synced"]
    live = [ds for ds in sources if source_mode(ds.kind) == "live"]
    errors = [ds for ds in synced if ds.sync_error]
    waiting = [ds for ds in synced if not ds.last_synced_at and not ds.sync_error]
    times = [ds.last_synced_at for ds in synced if ds.last_synced_at]
    last = max(times) if times else None
    base = {"sources": len(sources), "synced": len(synced), "live": len(live),
            "errors": [{"id": ds.id, "name": ds.name, "error": ds.sync_error} for ds in errors],
            "last_synced_at": last}
    if not sources:
        return {**base, "status": "warning", "text": "No sources yet. Add some to this Space."}
    if errors:
        first = errors[0]
        more = f" (and {len(errors) - 1} more)" if len(errors) > 1 else ""
        return {**base, "status": "warning", "text": f"{first.name} needs attention: its last sync failed{more}."}
    if waiting:
        return {**base, "status": "syncing", "text": "First sync running" if len(waiting) == len(synced)
                else f"{len(waiting)} source{'s' if len(waiting) > 1 else ''} still on the first sync"}
    if synced:
        return {**base, "status": "ok", "text": f"All fresh · synced {_ago(last)}"}
    return {**base, "status": "ok", "text": "All fresh · live" if live else "All fresh"}


# ---- output ------------------------------------------------------------------

def source_out(ds: models.DataSource) -> dict:
    return {"id": ds.id, "name": ds.name, "kind": ds.kind, "label": kind_label(ds.kind),
            "last_synced_at": ds.last_synced_at, "sync_error": ds.sync_error, "mode": source_mode(ds.kind)}


def space_out(db: Session, space: models.Space, user: models.User) -> dict:
    sources = space_sources(db, user, space)
    convs = [c for c in db.query(models.Conversation).filter(models.Conversation.space_id == space.id).all()
             if workspace_access.can_access_conversation(db, c, user)]
    conv_ids = [c.id for c in convs]
    dashboards = 0
    if conv_ids:
        dashboards = (db.query(models.Dashboard.id)
                      .filter(models.Dashboard.source_conversation_id.in_(conv_ids)).count())
    fresh = freshness(sources)
    return {
        "id": space.id, "name": space.name, "color": space.color, "description": space.description,
        "icon": space.icon, "access": space.access, "member_ids": list(space.member_ids or []),
        "workspace_id": space.workspace_id, "owner_id": space.owner_id, "can_edit": can_edit(db, space, user),
        "source_ids": [ds.id for ds in sources], "sources": [source_out(ds) for ds in sources],
        "stats": {"sources": len(sources), "dashboards": dashboards,
                  "projects": len([c for c in convs if c.kind == "project"])},
        "fresh": {"status": fresh["status"], "text": fresh["text"], "last_synced_at": fresh["last_synced_at"]},
        "created_at": space.created_at, "updated_at": space.updated_at,
    }


# ---- the overview ("Marketing & Brand hub") ------------------------------------

_SOCIAL_SESSION_CHANNELS = ("organic social", "paid social")
_WOO_NOT_SALES = {"cancelled", "failed", "pending", "checkout-draft", "trash"}


def _num(df: pd.DataFrame, col: str) -> pd.Series:
    if col not in df.columns:
        return pd.Series([float("nan")] * len(df), index=df.index, dtype="float64")
    return pd.to_numeric(df[col], errors="coerce")


def _sum(df: pd.DataFrame | None, col: str) -> float | None:
    """Sum of a column, or None when the column is missing or entirely empty
    (a number GD360 does not have is never shown as 0)."""
    if df is None or col not in df.columns:
        return None
    s = _num(df, col)
    if s.notna().sum() == 0:
        return None if len(df) else 0.0
    return float(s.sum())


def _dates(df: pd.DataFrame, cols: tuple[str, ...]) -> pd.Series | None:
    for c in cols:
        if c in df.columns:
            return pd.to_datetime(df[c], errors="coerce", utc=True).dt.tz_localize(None).dt.normalize()
    return None


def _window(df: pd.DataFrame | None, cols: tuple[str, ...], start: date, end: date) -> pd.DataFrame | None:
    if df is None:
        return None
    d = _dates(df, cols)
    if d is None:
        return None
    mask = (d >= pd.Timestamp(start)) & (d <= pd.Timestamp(end))
    return df[mask.fillna(False)]


def _ratio(a: float | None, b: float | None, scale: float = 1.0) -> float | None:
    if a is None or not b:
        return None
    return a / b * scale


def _add(*vals: float | None) -> float | None:
    got = [v for v in vals if v is not None]
    return float(sum(got)) if got else None


def _r(v: float | None, n: int = 2) -> float | None:
    return None if v is None else round(float(v), n)


def _compact(v: float | None) -> str:
    return fmt(v) if v is not None else "—"


def _money(v: float | None, currency: str = "USD") -> str:
    return fmt(v, "currency", currency) if v is not None else "—"


def _pct_text(v: float | None) -> str:
    return "—" if v is None else f"{v:.1f}%"


def overview(db: Session, user: models.User, space: models.Space, days: int = 28,
             end: date | None = None) -> dict:
    from . import synced_sources

    days = max(1, min(int(days or 28), 366))
    end = end or datetime.utcnow().date()
    start = end - timedelta(days=days - 1)
    p_end = start - timedelta(days=1)
    p_start = p_end - timedelta(days=days - 1)
    w_end = end
    w_first = (end - timedelta(days=end.weekday())) - timedelta(weeks=11)

    sources = space_sources(db, user, space)
    used: list[str] = []
    missing: list[str] = []
    waiting: list[str] = []

    def load(ds: models.DataSource, table: str) -> pd.DataFrame | None:
        try:
            return synced_sources.load_table(db, ds.id, table)
        except ValueError:
            return None
        except Exception as e:  # noqa: BLE001
            print(f"[spaces] could not read {table} of {ds.id}: {e}")
            return None

    def mark(ds: models.DataSource):
        if ds.name not in used:
            used.append(ds.name)

    channels: list[dict] = []
    posts_frames: list[pd.DataFrame] = []
    query_frames: list[pd.DataFrame] = []
    weekly_org: dict[pd.Timestamp, float] = {}
    weekly_paid: dict[pd.Timestamp, float] = {}
    have_org = have_paid = False

    tot = {k: {"cur": None, "prev": None} for k in (
        "audience", "growth", "social_reach", "er_eng", "er_reach", "paid_reach", "spend", "ad_rev",
        "sessions", "social_sessions", "search_clicks", "store_rev", "stripe_rev")}

    def acc(key: str, cur: float | None, prev: float | None):
        tot[key]["cur"] = _add(tot[key]["cur"], cur)
        tot[key]["prev"] = _add(tot[key]["prev"], prev)

    def weekly_add(target: dict, df: pd.DataFrame | None, cols: tuple[str, ...], col: str):
        if df is None or col not in df.columns:
            return
        d = _dates(df, cols)
        if d is None:
            return
        vals = _num(df, col)
        frame = pd.DataFrame({"d": d, "v": vals}).dropna(subset=["d"])
        frame = frame[(frame.d >= pd.Timestamp(w_first)) & (frame.d <= pd.Timestamp(w_end))]
        if frame.empty:
            return
        frame["w"] = frame.d - pd.to_timedelta(frame.d.dt.weekday, unit="D")
        for w, v in frame.groupby("w")["v"].sum(min_count=1).items():
            if pd.notna(v):
                target[w] = target.get(w, 0.0) + float(v)

    kinds = {ds.kind for ds in sources}
    for ds in sources:
        label = kind_label(ds.kind)
        row = {"source_id": ds.id, "name": ds.name, "kind": ds.kind, "label": label, "group": None,
               "audience": None, "audience_growth": None, "audience_growth_pct": None, "reach": None,
               "reach_previous": None, "reach_delta_pct": None, "impressions": None, "engagements": None,
               "engagement_rate": None, "clicks": None, "spend": None, "revenue": None, "roas": None,
               "sessions": None, "orders": None, "video_views": None}
        k = ds.kind
        if k in SOCIAL_KINDS:
            row["group"] = "Organic"
            accounts, daily, posts = load(ds, "accounts"), load(ds, "channel_daily"), load(ds, "posts")
            if accounts is None and daily is None and posts is None:
                waiting.append(ds.name)
                continue
            mark(ds)
            cur = _window(daily, ("date",), start, end)
            prev = _window(daily, ("date",), p_start, p_end)
            cur_posts = _window(posts, ("posted_at", "post_date"), start, end)
            prev_posts = _window(posts, ("posted_at", "post_date"), p_start, p_end)
            reach_col = "reach"
            if k == "youtube" and (_sum(cur, "reach") in (None, 0.0)) and _sum(cur, "video_views"):
                reach_col = "video_views"
            reach, reach_p = _sum(cur, reach_col), _sum(prev, reach_col)
            gained, lost = _sum(cur, "followers_gained"), _sum(cur, "followers_lost")
            growth = None if gained is None else gained - (lost or 0.0)
            eng = _sum(cur, "engagements")
            eng_p = _sum(prev, "engagements")
            if eng is None:
                eng = _post_engagements(cur_posts)
                eng_p = _post_engagements(prev_posts)
            audience = _sum(accounts, "followers")
            row.update({
                "audience": audience, "audience_growth": growth,
                "audience_growth_pct": _r(_ratio(growth, (audience - growth) if audience is not None and growth is not None else None, 100), 2),
                "reach": reach, "reach_previous": reach_p, "reach_delta_pct": _r(pct_change(reach, reach_p), 1),
                "impressions": _sum(cur, "impressions"), "engagements": eng,
                "engagement_rate": _r(_ratio(eng, reach, 100), 2), "clicks": _sum(cur, "clicks"),
                "video_views": _sum(cur, "video_views"),
            })
            acc("audience", audience, (audience - growth) if audience is not None and growth is not None else None)
            acc("growth", growth, None)
            acc("social_reach", reach, reach_p)
            if reach is not None and eng is not None:  # engagement rate uses channels that report both
                acc("er_eng", eng, None)
                acc("er_reach", reach, None)
            if reach_p is not None and eng_p is not None:
                acc("er_eng", None, eng_p)
                acc("er_reach", None, reach_p)
            if daily is not None:
                have_org = True
                weekly_add(weekly_org, daily, ("date",), reach_col)
            if cur_posts is not None and len(cur_posts):
                p = cur_posts.copy()
                p["_eng"] = _num(p, "engagements")
                if p["_eng"].notna().sum() == 0:
                    p["_eng"] = sum(_num(p, c).fillna(0) for c in ("likes", "comments", "shares", "saves"))
                p["_source_id"], p["_kind"] = ds.id, k
                posts_frames.append(p)
        elif k in PAID_KINDS:
            row["group"] = "Paid"
            daily = load(ds, "campaign_daily")
            if daily is None:
                waiting.append(ds.name)
                continue
            mark(ds)
            cur, prev = _window(daily, ("date",), start, end), _window(daily, ("date",), p_start, p_end)
            if k == "meta_ads":
                spend, spend_p = _sum(cur, "spend"), _sum(prev, "spend")
                rev, rev_p = _sum(cur, "purchase_value"), _sum(prev, "purchase_value")
                reach, reach_p = _sum(cur, "reach"), _sum(prev, "reach")
                orders = _sum(cur, "purchases")
                weekly_add(weekly_paid, daily, ("date",), "reach")
                paid_cur, paid_prev = reach, reach_p
            else:
                spend, spend_p = _sum(cur, "cost"), _sum(prev, "cost")
                rev, rev_p = _sum(cur, "conversion_value"), _sum(prev, "conversion_value")
                reach = reach_p = None
                orders = _sum(cur, "conversions")
                weekly_add(weekly_paid, daily, ("date",), "impressions")
                paid_cur, paid_prev = _sum(cur, "impressions"), _sum(prev, "impressions")
            have_paid = True
            row.update({"reach": reach, "reach_previous": reach_p, "reach_delta_pct": _r(pct_change(reach, reach_p), 1),
                        "impressions": _sum(cur, "impressions"), "clicks": _sum(cur, "clicks"), "spend": spend,
                        "revenue": rev, "roas": _r(_ratio(rev, spend), 2), "orders": orders})
            acc("paid_reach", paid_cur, paid_prev)
            acc("spend", spend, spend_p)
            acc("ad_rev", rev, rev_p)
        elif k == "ga4":
            row["group"] = "Web"
            daily = load(ds, "traffic_daily")
            if daily is None:
                waiting.append(ds.name)
                continue
            mark(ds)
            cur, prev = _window(daily, ("date",), start, end), _window(daily, ("date",), p_start, p_end)
            sessions, sessions_p = _sum(cur, "sessions"), _sum(prev, "sessions")

            def social(df):
                if df is None or "channel" not in df.columns:
                    return None
                return _sum(df[df["channel"].astype(str).str.lower().isin(_SOCIAL_SESSION_CHANNELS)], "sessions")
            row.update({"sessions": sessions, "orders": _sum(cur, "transactions"), "revenue": _sum(cur, "purchase_revenue")})
            acc("sessions", sessions, sessions_p)
            acc("social_sessions", social(cur), social(prev))
        elif k == "search_console":
            row["group"] = "Search"
            daily, queries = load(ds, "search_daily"), load(ds, "queries_daily")
            if daily is None and queries is None:
                waiting.append(ds.name)
                continue
            mark(ds)
            base = daily if daily is not None else queries
            cur, prev = _window(base, ("date",), start, end), _window(base, ("date",), p_start, p_end)
            clicks, clicks_p = _sum(cur, "clicks"), _sum(prev, "clicks")
            row.update({"clicks": clicks, "impressions": _sum(cur, "impressions")})
            acc("search_clicks", clicks, clicks_p)
            qc = _window(queries, ("date",), start, end)
            if qc is not None and len(qc) and "query" in qc.columns:
                query_frames.append(qc)
        elif k in ("shopify", "woocommerce"):
            row["group"] = "Store"
            orders = load(ds, "orders")
            if orders is None:
                waiting.append(ds.name)
                continue
            mark(ds)
            if "cancelled" in orders.columns:
                orders = orders[~orders["cancelled"].fillna(False).astype(bool)]
            if k == "woocommerce" and "status" in orders.columns:  # only real sales
                orders = orders[~orders["status"].astype(str).str.lower().isin(_WOO_NOT_SALES)]
            cur = _window(orders, ("order_date", "created_at", "date"), start, end)
            prev = _window(orders, ("order_date", "created_at", "date"), p_start, p_end)
            rev, rev_p = _sum(cur, "net_revenue"), _sum(prev, "net_revenue")
            row.update({"revenue": rev, "orders": float(len(cur)) if cur is not None else None})
            acc("store_rev", rev, rev_p)
        elif k == "stripe":
            row["group"] = "Store"
            charges = load(ds, "charges")
            if charges is None:
                waiting.append(ds.name)
                continue
            mark(ds)
            if "status" in charges.columns:
                charges = charges[charges["status"].astype(str).str.lower() == "succeeded"]
            cur = _window(charges, ("date", "created_at", "created"), start, end)
            prev = _window(charges, ("date", "created_at", "created"), p_start, p_end)
            rev, rev_p = _sum(cur, "amount"), _sum(prev, "amount")
            row.update({"revenue": rev, "orders": float(len(cur)) if cur is not None else None})
            acc("stripe_rev", rev, rev_p)
        elif k == "klaviyo":
            row["group"] = "Email"
            camps = load(ds, "campaigns")
            if camps is None:
                waiting.append(ds.name)
                continue
            mark(ds)
            cols = ("send_date", "sent_at", "send_time", "date", "scheduled_at", "created_at")
            cur = _window(camps, cols, start, end)
            if cur is None:
                cur = camps
            row.update({"revenue": _sum(cur, "revenue"),
                        "clicks": _sum(cur, "clicks") if "clicks" in cur.columns else _sum(cur, "clicks_unique"),
                        "reach": _sum(cur, "recipients") if "recipients" in cur.columns else _sum(cur, "delivered")})
        else:
            continue
        channels.append(row)

    # ---- KPIs
    reach_cur = _add(tot["social_reach"]["cur"], tot["paid_reach"]["cur"])
    reach_prev = _add(tot["social_reach"]["prev"], tot["paid_reach"]["prev"])
    eng_rate = _ratio(tot["er_eng"]["cur"], tot["er_reach"]["cur"], 100)
    eng_rate_p = _ratio(tot["er_eng"]["prev"], tot["er_reach"]["prev"], 100)
    roas = _ratio(tot["ad_rev"]["cur"], tot["spend"]["cur"])
    roas_p = _ratio(tot["ad_rev"]["prev"], tot["spend"]["prev"])
    store_key = "store_rev" if tot["store_rev"]["cur"] is not None else "stripe_rev"
    social_names = [c["name"] for c in channels if c["group"] == "Organic"]
    paid_names = [c["name"] for c in channels if c["group"] == "Paid"]

    def kpi(key, label, cur, prev, display, note, points: bool = False):
        out = {"key": key, "label": label, "value": _r(cur, 4), "display": display(cur) if cur is not None else "—",
               "previous": _r(prev, 4), "previous_display": display(prev) if prev is not None else "—",
               "delta_pct": _r(pct_change(cur, prev), 1) if cur is not None and prev is not None else None,
               "source_note": note, "available": cur is not None}
        if points:
            out["delta_points"] = _r(cur - prev, 2) if cur is not None and prev is not None else None
        return out

    growth = tot["growth"]["cur"]
    aud_note = (social_names[0] if len(social_names) == 1 else f"{len(social_names)} accounts") if social_names \
        else "Connect Instagram, Facebook Pages, LinkedIn Pages or YouTube"
    if growth is not None:
        aud_note = f"{'+' if growth >= 0 else ''}{fmt(growth)} followers in the period · " + aud_note
    soc_sess = tot["social_sessions"]["cur"]
    kpis = [
        kpi("audience", "Audience across pages", tot["audience"]["cur"], tot["audience"]["prev"], _compact, aud_note),
        kpi("reach", "Reach", reach_cur, reach_prev, _compact,
            ("Organic + paid" + (" (Google Ads counted by impressions)" if "google_ads" in kinds else ""))
            if reach_cur is not None else "Connect social pages or ad accounts"),
        kpi("engagement_rate", "Engagement rate", eng_rate, eng_rate_p, _pct_text,
            "Likes, comments, shares, saves ÷ organic reach" if eng_rate is not None else "Connect social pages", points=True),
        kpi("sessions", "Visits to the site", tot["sessions"]["cur"], tot["sessions"]["prev"], _compact,
            (f"GA4 sessions · {fmt(soc_sess)} from social and paid social" if soc_sess is not None else "GA4 sessions")
            if tot["sessions"]["cur"] is not None else "Connect Google Analytics 4"),
        kpi("ad_spend", "Ad spend", tot["spend"]["cur"], tot["spend"]["prev"], _money,
            " · ".join(paid_names) if paid_names else "Connect Meta Ads or Google Ads"),
        kpi("roas", "Return on ad spend", roas, roas_p, lambda v: f"{v:.1f}×",
            f"{_money(tot['ad_rev']['cur'])} attributed revenue" if roas is not None else "Connect Meta Ads or Google Ads"),
        kpi("search_clicks", "Search clicks", tot["search_clicks"]["cur"], tot["search_clicks"]["prev"], _compact,
            "Google Search, from Search Console" if tot["search_clicks"]["cur"] is not None else "Connect Search Console"),
        kpi("store_revenue", "Store revenue", tot[store_key]["cur"], tot[store_key]["prev"], _money,
            ("Net of refunds, cancelled orders left out" if store_key == "store_rev" else "Succeeded Stripe charges")
            if tot[store_key]["cur"] is not None else "Connect Shopify, WooCommerce or Stripe"),
    ]

    # ---- weekly
    weekly = []
    for i in range(12):
        ws = pd.Timestamp(w_first + timedelta(weeks=i))
        weekly.append({"week_start": ws.date().isoformat(),
                       "organic_reach": (weekly_org.get(ws, 0.0) if have_org else None),
                       "paid_reach": (weekly_paid.get(ws, 0.0) if have_paid else None)})

    # ---- top posts
    top_posts = []
    if posts_frames:
        allp = pd.concat(posts_frames, ignore_index=True)
        allp = allp.sort_values("_eng", ascending=False, na_position="last", kind="mergesort").head(8)
        for _, p in allp.iterrows():
            reach = _f(p.get("reach"))
            eng = _f(p.get("_eng"))
            posted = p.get("posted_at") if "posted_at" in allp.columns else p.get("post_date")
            top_posts.append({
                "source_id": p["_source_id"], "kind": p["_kind"], "account": _s(p.get("account")),
                "text": (_s(p.get("text")) or "")[:280], "url": _s(p.get("url")), "type": _s(p.get("type")),
                "posted_at": None if posted is None or (isinstance(posted, float) and posted != posted) else str(posted),
                "reach": reach, "engagements": eng, "engagement_rate": _r(_ratio(eng, reach, 100), 2),
                "video_views": _f(p.get("video_views")),
            })

    # ---- queries
    queries = []
    if query_frames:
        q = pd.concat(query_frames, ignore_index=True)
        q["clicks"], q["impressions"] = _num(q, "clicks").fillna(0), _num(q, "impressions").fillna(0)
        q["_wpos"] = _num(q, "position") * q["impressions"]
        g = q.groupby("query", dropna=True).agg(clicks=("clicks", "sum"), impressions=("impressions", "sum"),
                                                 wpos=("_wpos", "sum")).reset_index()
        g = g.sort_values(["clicks", "impressions"], ascending=[False, False], kind="mergesort").head(10)
        for _, r in g.iterrows():
            imp = float(r["impressions"])
            queries.append({"query": str(r["query"]), "clicks": float(r["clicks"]), "impressions": imp,
                            "ctr": _r(_ratio(float(r["clicks"]), imp, 100), 2),
                            "position": _r(r["wpos"] / imp, 1) if imp else None})

    # ---- what is missing
    if not kinds & set(SOCIAL_KINDS):
        missing.append("Connect Instagram, Facebook Pages, LinkedIn Pages or YouTube to see audience, reach and top posts")
    if not kinds & set(PAID_KINDS):
        missing.append("Connect Meta Ads or Google Ads to see ad spend and return on ad spend")
    if "ga4" not in kinds:
        missing.append("Connect Google Analytics 4 to see visits to the site")
    if "search_console" not in kinds:
        missing.append("Connect Search Console to see what people search for")
    if not kinds & set(STORE_KINDS):
        missing.append("Connect Shopify, WooCommerce or Stripe to see store revenue")
    for name in waiting:
        missing.append(f"{name} has not finished its first sync yet")

    # ---- every table, for any Space
    tables = []
    for ds in sources:
        if source_mode(ds.kind) == "synced":
            for name, rows, at in (db.query(models.SyncedTable.table_name, models.SyncedTable.row_count,
                                            models.SyncedTable.synced_at)
                                   .filter(models.SyncedTable.datasource_id == ds.id)
                                   .order_by(models.SyncedTable.table_name).all()):
                tables.append({"source_id": ds.id, "source": ds.name, "kind": ds.kind, "table": name,
                               "rows": rows, "synced_at": at})
        else:
            cache = ds.schema_cache if isinstance(ds.schema_cache, dict) else {}
            names = [ds.name] if list(cache.keys()) == ["columns"] else list(cache.keys())
            for name in names[:40]:
                tables.append({"source_id": ds.id, "source": ds.name, "kind": ds.kind, "table": name,
                               "rows": None, "synced_at": None})

    for c in channels:
        for key in ("audience", "audience_growth", "reach", "reach_previous", "impressions", "engagements", "clicks",
                    "spend", "revenue", "sessions", "orders", "video_views"):
            c[key] = _r(c[key], 2)

    fresh = freshness(sources)
    return {
        "space": {"id": space.id, "name": space.name, "color": space.color},
        "period": {"days": days, "start": start.isoformat(), "end": end.isoformat(),
                   "previous_start": p_start.isoformat(), "previous_end": p_end.isoformat()},
        "kpis": kpis, "channels": channels, "weekly": weekly, "top_posts": top_posts, "queries": queries,
        "missing": missing, "sources_used": used, "tables": tables,
        "fresh": {"status": fresh["status"], "text": fresh["text"], "last_synced_at": fresh["last_synced_at"]},
    }


def _post_engagements(df: pd.DataFrame | None) -> float | None:
    if df is None:
        return None
    if "engagements" in df.columns and _num(df, "engagements").notna().any():
        return float(_num(df, "engagements").sum())
    parts = [c for c in ("likes", "comments", "shares", "saves") if c in df.columns]
    if not parts:
        return None
    return float(sum(_num(df, c).fillna(0).sum() for c in parts))


def _f(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else round(f, 2)


def _s(v) -> str | None:
    if v is None or (isinstance(v, float) and v != v):
        return None
    return str(v)
