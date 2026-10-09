"""
2026-10-09 (round 15): more synced apps - social channels (Instagram,
Facebook Pages, LinkedIn Pages, YouTube), Google Search Console, and the
commerce / CRM / finance / email apps (WooCommerce, Stripe, HubSpot,
Klaviyo).

They follow the Round 11 pattern in services/synced_sources.py exactly:
each app has test(creds) -> account label and fetch(creds, info) ->
{table: DataFrame}; synced_sources registers them (APPS, DEFAULT_INTERVAL,
SYNCED_KINDS) and stores every table as Parquet.

The four social apps all produce the same three standard tables, so the
Marketing hub can read any of them the same way:
  accounts      account_id, account, followers, posts_count, url
  channel_daily date, account_id, account, followers_gained, followers_lost,
                reach, impressions, engagements, clicks, video_views,
                profile_views, watch_minutes
  posts         post_id, account_id, account, posted_at, post_date, type,
                text, url, reach, impressions, likes, comments, shares,
                saves, engagements, clicks, video_views
A value an app does not report is None. engagements is likes + comments +
shares + saves when the app has no single figure.

Platforms rename and retire metrics often, so every insights metric is
asked for on its own (or in a small group) and skipped when it errors; one
failing metric or post never fails the whole sync.

Credentials may carry "account_ids" (a list or comma-separated text): only
those pages / accounts / sites / organisations are synced. Without it,
every one the credentials can see is synced.
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

import pandas as pd

from . import synced_sources as ss
from ..config import get_settings

settings = get_settings()
SyncError = ss.SyncError


def _cfg(name: str, default: str = "") -> str:
    """A setting another round may not have added to config.py yet."""
    return str(getattr(settings, name, default) or default)


# ---- shared helpers ---------------------------------------------------------

ACCOUNT_COLS = ["account_id", "account", "followers", "posts_count", "url"]
DAILY_COLS = ["date", "account_id", "account", "followers_gained", "followers_lost", "reach", "impressions",
              "engagements", "clicks", "video_views", "profile_views", "watch_minutes"]
POST_COLS = ["post_id", "account_id", "account", "posted_at", "post_date", "type", "text", "url", "reach",
             "impressions", "likes", "comments", "shares", "saves", "engagements", "clicks", "video_views"]
_NUMERIC = {"followers", "posts_count", "followers_gained", "followers_lost", "reach", "impressions", "engagements",
            "clicks", "video_views", "profile_views", "watch_minutes", "likes", "comments", "shares", "saves",
            "average_view_duration"}
MAX_TEXT = 500


def _account_filter(creds: dict, info: dict | None = None) -> set[str] | None:
    raw = creds.get("account_ids")
    if raw in (None, "", []) and info:
        raw = info.get("account_ids")
    if raw in (None, "", []):
        return None
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            raw = parsed if isinstance(parsed, list) else raw
        except ValueError:
            pass
    items = raw if isinstance(raw, (list, tuple, set)) else str(raw).split(",")
    out = {str(x).strip() for x in items if str(x).strip()}
    return out or None


def _num(v):
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return int(v)
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return int(f) if f.is_integer() else f


def _sum(*vals):
    got = [v for v in vals if v is not None]
    return sum(got) if got else None


def _body(r) -> dict | list:
    try:
        b = r.json()
    except ValueError:
        return {}
    return b if b is not None else {}


def _try_get(url: str, **kw) -> dict | list | None:
    """GET that returns the JSON body, or None when the call fails (a
    retired metric, a post without insights, a timeout). Auth problems
    surface earlier, on the account call, which is not tolerant."""
    try:
        r = ss._get(url, **kw)
    except SyncError as e:
        print(f"[app_connectors] skipped {ss._host(url)}: {e}")
        return None
    if r.status_code >= 400:
        return None
    return _body(r)


def _must_get(url: str, app: str, **kw):
    r = ss._get(url, **kw)
    ss._raise_for(r, app)
    return _body(r)


def _ts(col: pd.Series) -> pd.Series:
    """Mixed ISO text / datetimes -> naive UTC timestamps (never guesses one
    format from the first value and drops the rest)."""
    try:
        out = pd.to_datetime(col, errors="coerce", utc=True, format="ISO8601")
    except (TypeError, ValueError):
        out = pd.to_datetime(col, errors="coerce", utc=True)
    return out.dt.tz_localize(None)


def _naive(v) -> pd.Timestamp | None:
    try:
        t = pd.Timestamp(v)
    except (TypeError, ValueError):
        return None
    return t.tz_convert(None) if t.tzinfo is not None else t


def _frame(rows: list[dict], cols: list[str], dates: tuple = (), stamps: tuple = (), numeric: set | None = None) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    for c in cols:
        if c not in df.columns:
            df[c] = None
    df = df[cols + [c for c in df.columns if c not in cols]]
    for c in stamps:
        if c in df.columns:
            df[c] = _ts(df[c])
    for c in dates:
        if c in df.columns:
            df[c] = _ts(df[c]).dt.date
    for c in df.columns:
        if c in (numeric if numeric is not None else _NUMERIC):
            df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def _social_tables(accounts: list[dict], daily: dict, posts: list[dict]) -> dict[str, pd.DataFrame]:
    for p in posts:
        if p.get("text"):
            p["text"] = str(p["text"])[:MAX_TEXT]
        if p.get("engagements") is None:
            p["engagements"] = _sum(p.get("likes"), p.get("comments"), p.get("shares"), p.get("saves"))
        if p.get("posted_at") and not p.get("post_date"):
            p["post_date"] = p["posted_at"]
    d_rows = sorted(daily.values(), key=lambda r: (str(r["account_id"]), r["date"]))
    out = {
        "accounts": _frame(accounts, ACCOUNT_COLS),
        "channel_daily": _frame(d_rows, DAILY_COLS, dates=("date",)),
        "posts": _frame(posts, POST_COLS, stamps=("posted_at",), dates=("post_date",)),
    }
    if len(out["posts"]):
        # post_date follows posted_at (UTC), so it is a plain date
        out["posts"]["post_date"] = out["posts"]["posted_at"].dt.date
        out["posts"] = out["posts"].sort_values("posted_at", ascending=False, na_position="last").reset_index(drop=True)
    return out


def _put(daily: dict, acc_id: str, acc_name: str, day, key: str, value) -> None:
    if day is None or value is None:
        return
    k = (str(acc_id), day)
    row = daily.get(k)
    if row is None:
        row = daily[k] = {"date": day, "account_id": str(acc_id), "account": acc_name}
    row[key] = value


def _window_start(info: dict, default: int, cap: int | None = None) -> date:
    days = ss._window_days(info, default)
    if cap:
        days = min(days, cap)
    return date.today() - timedelta(days=days)


def _chunks(start: date, end: date, size: int):
    cur = start
    while cur <= end:
        stop = min(cur + timedelta(days=size), end + timedelta(days=1))
        yield cur, stop
        cur = stop


def _unix(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())


def _from_unix(v) -> datetime | None:
    try:
        return datetime.utcfromtimestamp(int(v))
    except (TypeError, ValueError, OverflowError):
        return None


def _from_ms(v) -> datetime | None:
    try:
        return datetime.utcfromtimestamp(int(v) / 1000)
    except (TypeError, ValueError, OverflowError):
        return None


def _ms_day(v) -> date | None:
    t = _from_ms(v)
    return t.date() if t else None


def _label_many(names: list[str]) -> str:
    names = [n for n in names if n]
    if not names:
        return ""
    return names[0] if len(names) == 1 else f"{names[0]} + {len(names) - 1} more"


# ---- Meta (Instagram, Facebook Pages) ---------------------------------------

def _graph_base() -> str:
    return f"https://graph.facebook.com/{settings.META_GRAPH_VERSION}"


def _meta_token(creds: dict) -> str:
    token = str(creds.get("access_token") or "").strip()
    if not token:
        raise SyncError("A Meta access token is required. Sign in with Facebook again, or paste a token.")
    return token


def _graph_pages(url: str, params: dict | None, app: str, cap: int, stop=None) -> list[dict]:
    """Follow paging.next until cap; stop(item) -> True ends early."""
    out: list[dict] = []
    first = True
    while url and len(out) < cap:
        r = ss._get(url, params=params if first else None)
        if first:
            ss._raise_for(r, app)
        elif r.status_code >= 400:
            break  # later pages failing keeps what we have
        body = _body(r) or {}
        items = body.get("data") or []
        for it in items:
            if stop and stop(it):
                return out
            out.append(it)
        url = (body.get("paging") or {}).get("next")
        first = False
        if not items:
            break
    return out[:cap]


def _meta_end_day(end_time: str | None):
    """Graph daily values carry the END of the day (midnight Pacific in
    UTC), so the day they describe is the one before."""
    t = _naive(end_time) if end_time else None
    return (t - timedelta(days=1)).date() if t is not None else None


def _graph_daily(obj_id: str, metric: str, token: str, start: date, end: date, chunk: int,
                 extra: dict | None = None) -> dict | None:
    """{date: value} for one daily insights metric, asked for in chunks.
    None when the metric is not available at all (retired, no permission)."""
    out: dict = {}
    ok = False
    misses = 0
    for a, b in reversed(list(_chunks(start, end, chunk))):  # newest first: a retired metric fails at once
        params = {"metric": metric, "period": "day", "since": _unix(a), "until": _unix(b), "access_token": token,
                  **(extra or {})}
        body = _try_get(f"{_graph_base()}/{obj_id}/insights", params=params)
        if body is None:
            misses += 1
            if not ok and misses >= 2:
                return None  # retired or not allowed: stop asking
            continue
        ok = True
        for series in (body.get("data") or []) if isinstance(body, dict) else []:
            for v in series.get("values") or []:
                day = _meta_end_day(v.get("end_time"))
                val = v.get("value")
                if isinstance(val, dict):  # e.g. broken down by type: total it
                    val = sum(x for x in val.values() if isinstance(x, (int, float)))
                val = _num(val)
                if day is not None and val is not None:
                    out[day] = val  # chunks may share a boundary day: keep one value, never double it
    return out if ok else None


def _insight_values(body) -> dict:
    """{metric: value} from an object's lifetime insights response."""
    out = {}
    for m in (body.get("data") or []) if isinstance(body, dict) else []:
        val = None
        if isinstance(m.get("total_value"), dict):
            val = m["total_value"].get("value")
        elif m.get("values"):
            val = (m["values"][0] or {}).get("value")
        if isinstance(val, dict):
            val = sum(x for x in val.values() if isinstance(x, (int, float)))
        out[m.get("name")] = _num(val)
    return out


class _MetricSets:
    """Tries metric groups in order and remembers the first that works, so
    a retired metric costs one failed call per sync, not one per post."""

    def __init__(self, groups: list[list[str]]):
        self.groups = groups
        self.good: list[str] | None = None
        self.misses = 0

    def fetch(self, obj_id: str, token: str) -> dict:
        if self.good is not None:
            body = _try_get(f"{_graph_base()}/{obj_id}/insights", params={"metric": ",".join(self.good), "access_token": token})
            return _insight_values(body) if body is not None else {}
        if self.misses >= 5:
            return {}  # five posts in a row had no insights at all: stop asking
        for g in self.groups:
            body = _try_get(f"{_graph_base()}/{obj_id}/insights", params={"metric": ",".join(g), "access_token": token})
            if body is not None:
                self.good = g
                return _insight_values(body)
        self.misses += 1
        return {}  # this post has no insights (e.g. too old or not owned) - try again for the next one


# Instagram ------------------------------------------------------------------

def _ig_discover_raw(creds: dict) -> list[dict]:
    token = _meta_token(creds)
    fields = "id,name,access_token,instagram_business_account{id,username,followers_count}"
    pages = _graph_pages(f"{_graph_base()}/me/accounts", {"fields": fields, "limit": 100, "access_token": token},
                         "Instagram", 1000)
    if not pages:  # the token may itself be a Page token
        body = _try_get(f"{_graph_base()}/me", params={"fields": "id,name,instagram_business_account{id,username,followers_count}",
                                                         "access_token": token})
        if isinstance(body, dict) and body.get("instagram_business_account"):
            pages = [{**body, "access_token": token}]
    out = []
    for p in pages:
        ig = p.get("instagram_business_account") or {}
        if ig.get("id"):
            out.append({"ig_id": str(ig["id"]), "username": ig.get("username"), "followers": ig.get("followers_count"),
                        "page_id": str(p.get("id") or ""), "page_name": p.get("name"),
                        "token": p.get("access_token") or token})
    return out


def _ig_accounts(creds: dict, info: dict | None = None) -> list[dict]:
    found = _ig_discover_raw(creds)
    if not found:
        raise SyncError("No Instagram professional accounts were found. The Instagram account must be a Business or "
                        "Creator account linked to a Facebook Page you manage, and the sign-in must allow "
                        "instagram_basic and instagram_manage_insights.")
    want = _account_filter(creds, info)
    if want:
        found = [a for a in found if a["ig_id"] in want or a["page_id"] in want or (a["username"] or "") in want]
        if not found:
            raise SyncError("None of the selected Instagram accounts can be reached with this sign-in any more. "
                            "Reconnect and pick the accounts again.")
    return found


def instagram_test(creds: dict) -> str:
    return _label_many([f"@{a['username']}" if a.get("username") else a["ig_id"] for a in _ig_accounts(creds)])


def _ig_post_type(m: dict) -> str:
    prod = str(m.get("media_product_type") or "").upper()
    if prod == "REELS":
        return "reel"
    if prod == "STORY":
        return "story"
    return str(m.get("media_type") or "post").lower()


def instagram_fetch(creds: dict, info: dict) -> dict[str, pd.DataFrame]:
    start = _window_start(info, 365, cap=730)
    today = date.today()
    accounts, posts, daily = [], [], {}
    for a in _ig_accounts(creds, info):
        ig, token = a["ig_id"], a["token"]
        prof = _must_get(f"{_graph_base()}/{ig}", "Instagram",
                         params={"fields": "username,followers_count,media_count", "access_token": token}) or {}
        name = f"@{prof.get('username') or a.get('username') or ig}"
        accounts.append({"account_id": ig, "account": name, "followers": _num(prof.get("followers_count")),
                         "posts_count": _num(prof.get("media_count")),
                         "url": f"https://www.instagram.com/{prof.get('username') or a.get('username') or ''}"})
        # daily account insights (each metric separately; retired ones are skipped)
        for metric, col, since, extra in (
            ("reach", "reach", start, None),
            ("follower_count", "followers_gained", max(start, today - timedelta(days=29)), None),
        ):
            series = _graph_daily(ig, metric, token, since, today, 30, extra)
            for day, val in (series or {}).items():
                _put(daily, ig, name, day, col, val)
        # media in the window, newest first
        cutoff = pd.Timestamp(start)
        media = _graph_pages(
            f"{_graph_base()}/{ig}/media",
            {"fields": "id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count",
             "limit": 100, "access_token": token}, "Instagram", 1000,
            stop=lambda m: bool(m.get("timestamp")) and (_naive(m["timestamp"]) or cutoff) < cutoff)
        sets = _MetricSets([["reach", "saved", "shares", "views", "total_interactions"], ["reach", "saved"]])
        for i, m in enumerate(media):
            row = {"post_id": str(m.get("id")), "account_id": ig, "account": name, "posted_at": m.get("timestamp"),
                   "type": _ig_post_type(m), "text": m.get("caption"), "url": m.get("permalink"),
                   "likes": _num(m.get("like_count")), "comments": _num(m.get("comments_count"))}
            if i < 300:
                vals = sets.fetch(row["post_id"], token)
                row["reach"] = vals.get("reach")
                row["saves"] = vals.get("saved")
                row["shares"] = vals.get("shares")
                if vals.get("views") is not None:
                    row["impressions"] = vals.get("views")  # Meta replaced impressions with views (2025)
                    if row["type"] in ("video", "reel"):
                        row["video_views"] = vals.get("views")
                if vals.get("total_interactions") is not None:
                    row["engagements"] = vals.get("total_interactions")
            posts.append(row)
    return _social_tables(accounts, daily, posts)


# Facebook Pages -------------------------------------------------------------

def _fb_discover_raw(creds: dict) -> list[dict]:
    token = _meta_token(creds)
    pages = _graph_pages(f"{_graph_base()}/me/accounts",
                         {"fields": "id,name,access_token,followers_count,fan_count", "limit": 100, "access_token": token},
                         "Facebook", 1000)
    if not pages:  # the token may itself be a Page token
        body = _try_get(f"{_graph_base()}/me", params={"fields": "id,name,followers_count,fan_count", "access_token": token})
        if isinstance(body, dict) and body.get("id") and ("fan_count" in body or "followers_count" in body):
            pages = [{**body, "access_token": token}]
    return [{"page_id": str(p.get("id")), "name": p.get("name"), "token": p.get("access_token") or token,
             "followers": _num(p.get("followers_count")) if p.get("followers_count") is not None else _num(p.get("fan_count"))}
            for p in pages if p.get("id")]


def _fb_pages(creds: dict, info: dict | None = None) -> list[dict]:
    found = _fb_discover_raw(creds)
    if not found:
        raise SyncError("No Facebook Pages were found for this sign-in. You need a task on the Page (Facebook › Page "
                        "settings › Page access), and the sign-in must allow pages_show_list and pages_read_engagement.")
    want = _account_filter(creds, info) or ({x.strip() for x in str(creds.get("page_ids") or "").split(",") if x.strip()} or None)
    if want:
        found = [p for p in found if p["page_id"] in want or (p["name"] or "") in want]
        if not found:
            raise SyncError("None of the selected Facebook Pages can be reached with this sign-in any more. "
                            "Reconnect and pick the Pages again.")
    return found


def facebook_pages_test(creds: dict) -> str:
    return _label_many([p["name"] or p["page_id"] for p in _fb_pages(creds)])


_FB_PAGE_METRICS = (
    # (metric, column) - tried one by one; retired ones are skipped, and a
    # later metric for the same column is only asked for when an earlier one is gone
    ("page_impressions_unique", "reach"),
    ("page_impressions", "impressions"),
    ("page_media_view", "impressions"),        # the newer "views" metric, used when impressions is retired
    ("page_post_engagements", "engagements"),
    ("page_daily_follows_unique", "followers_gained"),
    ("page_daily_unfollows_unique", "followers_lost"),
    ("page_views_total", "profile_views"),
    ("page_video_views", "video_views"),
)


def facebook_pages_fetch(creds: dict, info: dict) -> dict[str, pd.DataFrame]:
    start = _window_start(info, 365, cap=730)
    today = date.today()
    accounts, posts, daily = [], [], {}
    for p in _fb_pages(creds, info):
        pid, token, name = p["page_id"], p["token"], p["name"] or p["page_id"]
        prof = _try_get(f"{_graph_base()}/{pid}", params={"fields": "name,followers_count,fan_count,link", "access_token": token}) or {}
        followers = prof.get("followers_count") if prof.get("followers_count") is not None else prof.get("fan_count")
        name = prof.get("name") or name
        got_cols: set[str] = set()
        for metric, col in _FB_PAGE_METRICS:
            if col in got_cols:
                continue  # a newer fallback is only needed when the older metric is gone
            series = _graph_daily(pid, metric, token, start, today, 90)
            if series is None:
                continue
            got_cols.add(col)
            for day, val in series.items():
                _put(daily, pid, name, day, col, val)
        items = _graph_pages(
            f"{_graph_base()}/{pid}/posts",
            {"fields": "id,message,created_time,permalink_url,status_type,shares,"
                       "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)",
             "since": _unix(start), "limit": 100, "access_token": token}, "Facebook", 1000)
        sets = _MetricSets([["post_impressions_unique", "post_clicks"], ["post_impressions_unique"], ["post_clicks"],
                            ["post_media_view"]])
        for i, it in enumerate(items):
            likes = _num(((it.get("reactions") or {}).get("summary") or {}).get("total_count"))
            comments = _num(((it.get("comments") or {}).get("summary") or {}).get("total_count"))
            shares = _num((it.get("shares") or {}).get("count")) if it.get("shares") else 0
            row = {"post_id": str(it.get("id")), "account_id": pid, "account": name, "posted_at": it.get("created_time"),
                   "type": it.get("status_type") or "post", "text": it.get("message"), "url": it.get("permalink_url"),
                   "likes": likes, "comments": comments, "shares": shares,
                   "engagements": _sum(likes, comments, shares)}
            if i < 200:
                vals = sets.fetch(row["post_id"], token)
                row["reach"] = vals.get("post_impressions_unique")
                row["clicks"] = vals.get("post_clicks")
                if vals.get("post_media_view") is not None:
                    row["impressions"] = vals.get("post_media_view")
            posts.append(row)
        accounts.append({"account_id": pid, "account": name,
                         "followers": _num(followers) if followers is not None else p.get("followers"),
                         "posts_count": len(items), "url": prof.get("link") or f"https://www.facebook.com/{pid}"})
    return _social_tables(accounts, daily, posts)


# ---- LinkedIn Pages ---------------------------------------------------------

_LI = "https://api.linkedin.com/rest"


def _li_headers(creds: dict, finder: bool = False) -> dict:
    token = str(creds.get("access_token") or "").strip()
    if not token:
        raise SyncError("A LinkedIn access token is required. Sign in with LinkedIn again.")
    h = {"Authorization": f"Bearer {token}", "LinkedIn-Version": _cfg("LINKEDIN_API_VERSION", "202509"),
         "X-Restli-Protocol-Version": "2.0.0"}
    if finder:
        h["X-RestLi-Method"] = "FINDER"
    return h


def _li_org_id(v) -> str:
    return str(v or "").strip().rsplit(":", 1)[-1]


def _li_urn(org_id: str) -> str:
    return f"urn:li:organization:{org_id}"


def _li_enc(urn: str) -> str:
    return quote(urn, safe="")


def _li_raise(r, app="LinkedIn"):
    if r.status_code in (401, 403):
        try:
            msg = (_body(r) or {}).get("message") or ""
        except AttributeError:
            msg = ""
        raise SyncError(f"LinkedIn refused the request ({r.status_code}). The sign-in needs the Community Management "
                        f"API permissions (r_organization_admin, rw_organization_admin) and you must be a Page admin. {msg}".strip())
    ss._raise_for(r, app)


def _li_discover_raw(creds: dict) -> list[dict]:
    ids: list[str] = []
    start = 0
    while len(ids) < 500:
        r = ss._get(f"{_LI}/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=100&start={start}",
                    headers=_li_headers(creds))
        _li_raise(r)
        els = (_body(r) or {}).get("elements") or []
        for e in els:
            oid = _li_org_id(e.get("organization") or e.get("organizationTarget") or e.get("organizationalTarget"))
            if oid and oid not in ids:
                ids.append(oid)
        if len(els) < 100:
            break
        start += 100
    return [_li_org(creds, oid) for oid in ids]


def _li_org(creds: dict, oid: str) -> dict:
    body = _try_get(f"{_LI}/organizations/{oid}", headers=_li_headers(creds)) or {}
    name = body.get("localizedName") or ((body.get("name") or {}).get("localized") or {}).get("en_US") or f"Organization {oid}"
    return {"id": oid, "name": name, "vanity": body.get("vanityName")}


def _li_orgs(creds: dict, info: dict | None = None) -> list[dict]:
    explicit = [_li_org_id(x) for x in str(creds.get("organization_id") or "").split(",") if _li_org_id(x)]
    want = _account_filter(creds, info)
    if explicit:
        orgs = [_li_org(creds, oid) for oid in explicit]
    else:
        orgs = _li_discover_raw(creds)
        if not orgs:
            raise SyncError("No LinkedIn Pages were found where you are an admin. Ask a Page super admin to add you, "
                            "or enter the organization ID from the Page's admin URL.")
    if want:
        orgs = [o for o in orgs if o["id"] in {_li_org_id(w) for w in want}]
        if not orgs:
            raise SyncError("None of the selected LinkedIn Pages can be reached with this sign-in any more. "
                            "Reconnect and pick the Pages again.")
    return orgs


def linkedin_pages_test(creds: dict) -> str:
    orgs = _li_orgs(creds)
    # prove the token can read statistics, not just list pages
    r = ss._get(f"{_LI}/networkSizes/{_li_enc(_li_urn(orgs[0]['id']))}?edgeType=COMPANY_FOLLOWED_BY_MEMBER",
                headers=_li_headers(creds))
    _li_raise(r)
    return _label_many([o["name"] for o in orgs])


def _li_stats_url(kind: str, urn: str, a: date, b: date) -> str:
    # Rest.li 2.0: the structure characters of timeIntervals must not be encoded
    return (f"{_LI}/{kind}?q=organizationalEntity&organizationalEntity={_li_enc(urn)}"
            f"&timeIntervals=(timeRange:(start:{_unix(a) * 1000},end:{_unix(b) * 1000}),timeGranularityType:DAY)")


def _li_post_type(p: dict) -> str:
    c = p.get("content") or {}
    if "article" in c:
        return "article"
    if "multiImage" in c:
        return "carousel"
    if "poll" in c:
        return "poll"
    if "media" in c:
        mid = str((c.get("media") or {}).get("id") or "")
        return "video" if "video" in mid else "document" if "document" in mid else "image"
    return "text"


def linkedin_pages_fetch(creds: dict, info: dict) -> dict[str, pd.DataFrame]:
    # LinkedIn keeps daily page statistics for a rolling 12 months
    start = _window_start(info, 365, cap=365)
    today = date.today()
    accounts, posts, daily = [], [], {}
    for o in _li_orgs(creds, info):
        oid, name = o["id"], o["name"]
        urn = _li_urn(oid)
        size = _try_get(f"{_LI}/networkSizes/{_li_enc(urn)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER", headers=_li_headers(creds)) or {}
        for a, b in _chunks(start, today, 90):
            body = _try_get(_li_stats_url("organizationalEntityFollowerStatistics", urn, a, b), headers=_li_headers(creds))
            for e in (body or {}).get("elements") or []:
                day = _ms_day((e.get("timeRange") or {}).get("start"))
                g = e.get("followerGains") or {}
                _put(daily, oid, name, day, "followers_gained",
                     _sum(_num(g.get("organicFollowerGain")), _num(g.get("paidFollowerGain"))))
            body = _try_get(_li_stats_url("organizationalEntityShareStatistics", urn, a, b), headers=_li_headers(creds))
            for e in (body or {}).get("elements") or []:
                day = _ms_day((e.get("timeRange") or {}).get("start"))
                t = e.get("totalShareStatistics") or {}
                for col, val in (("impressions", t.get("impressionCount")), ("reach", t.get("uniqueImpressionsCount")),
                                 ("clicks", t.get("clickCount")), ("likes", t.get("likeCount")),
                                 ("comments", t.get("commentCount")), ("shares", t.get("shareCount")),
                                 ("engagements", _sum(_num(t.get("likeCount")), _num(t.get("commentCount")),
                                                      _num(t.get("shareCount"))))):
                    _put(daily, oid, name, day, col, _num(val))
        # posts (newest first)
        mine: list[dict] = []
        pos = 0
        cutoff = datetime(start.year, start.month, start.day)
        while len(mine) < 500:
            body = _try_get(f"{_LI}/posts?author={_li_enc(urn)}&q=author&count=100&sortBy=LAST_MODIFIED&start={pos}",
                            headers=_li_headers(creds, finder=True))
            els = (body or {}).get("elements") or []
            for p in els:
                when = _from_ms(p.get("publishedAt") or p.get("createdAt"))
                if when and when < cutoff:
                    continue
                mine.append({"post_id": p.get("id"), "account_id": oid, "account": name, "posted_at": when,
                             "type": _li_post_type(p), "text": p.get("commentary"),
                             "url": f"https://www.linkedin.com/feed/update/{p.get('id')}/" if p.get("id") else None})
            if len(els) < 100:
                break
            pos += 100
        mine = mine[:500]
        # lifetime stats per post, 20 at a time (shares and ugcPosts are asked for separately)
        by_id = {p["post_id"]: p for p in mine if p.get("post_id")}
        for key, prefix in (("shares", "urn:li:share:"), ("ugcPosts", "urn:li:ugcPost:")):
            ids = [i for i in by_id if str(i).startswith(prefix)]
            for k in range(0, len(ids), 20):
                group = ",".join(_li_enc(i) for i in ids[k:k + 20])
                body = _try_get(f"{_LI}/organizationalEntityShareStatistics?q=organizationalEntity"
                                f"&organizationalEntity={_li_enc(urn)}&{key}=List({group})", headers=_li_headers(creds))
                for e in (body or {}).get("elements") or []:
                    target = by_id.get(e.get("share") or e.get("ugcPost"))
                    if not target:
                        continue
                    t = e.get("totalShareStatistics") or {}
                    target.update({"impressions": _num(t.get("impressionCount")), "reach": _num(t.get("uniqueImpressionsCount")),
                                   "clicks": _num(t.get("clickCount")), "likes": _num(t.get("likeCount")),
                                   "comments": _num(t.get("commentCount")), "shares": _num(t.get("shareCount"))})
        posts += mine
        accounts.append({"account_id": oid, "account": name, "followers": _num(size.get("firstDegreeSize")),
                         "posts_count": len(mine),
                         "url": f"https://www.linkedin.com/company/{o.get('vanity') or oid}"})
    out = _social_tables(accounts, daily, posts)
    return out


# ---- YouTube ----------------------------------------------------------------

_YT = "https://www.googleapis.com/youtube/v3"
_YTA = "https://youtubeanalytics.googleapis.com/v2/reports"


def _yt_token(creds: dict) -> str:
    return ss._google_oauth_token(creds, "YouTube")


def _yt_channels(creds: dict, token: str) -> list[dict]:
    body = _must_get(f"{_YT}/channels", "YouTube", params={"part": "snippet,statistics,contentDetails", "mine": "true"},
                     headers={"Authorization": f"Bearer {token}"})
    items = (body or {}).get("items") or []
    if not items:
        raise SyncError("This Google account has no YouTube channel. Sign in with the Google account (or brand "
                        "account) that owns the channel.")
    return items


def youtube_test(creds: dict) -> str:
    ch = _yt_channels(creds, _yt_token(creds))[0]
    return (ch.get("snippet") or {}).get("title") or ch.get("id")


def _yt_report(token: str, params: dict) -> list[dict] | None:
    body = _try_get(_YTA, params=params, headers={"Authorization": f"Bearer {token}"})
    if body is None:
        return None
    heads = [h.get("name") for h in body.get("columnHeaders") or []]
    return [dict(zip(heads, r)) for r in body.get("rows") or []]


def youtube_fetch(creds: dict, info: dict) -> dict[str, pd.DataFrame]:
    token = _yt_token(creds)
    ch = _yt_channels(creds, token)[0]
    cid, name = ch.get("id"), (ch.get("snippet") or {}).get("title") or ch.get("id")
    stats = ch.get("statistics") or {}
    start = _window_start(info, 365)
    end = date.today()
    base = {"ids": "channel==MINE", "startDate": start.isoformat(), "endDate": end.isoformat()}
    daily: dict = {}
    rows = None
    for mets in ("views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares",
                 "views,estimatedMinutesWatched,subscribersGained,subscribersLost",
                 "views"):
        rows = _yt_report(token, {**base, "metrics": mets, "dimensions": "day", "sort": "day"})
        if rows is not None:
            break
    for r in rows or []:
        try:
            day = date.fromisoformat(str(r.get("day")))
        except ValueError:
            continue
        for col, key in (("video_views", "views"), ("watch_minutes", "estimatedMinutesWatched"),
                         ("average_view_duration", "averageViewDuration"), ("followers_gained", "subscribersGained"),
                         ("followers_lost", "subscribersLost"), ("likes", "likes"), ("comments", "comments"),
                         ("shares", "shares")):
            if key in r:
                _put(daily, cid, name, day, col, _num(r.get(key)))
        if any(k in r for k in ("likes", "comments", "shares")):
            _put(daily, cid, name, day, "engagements", _sum(_num(r.get("likes")), _num(r.get("comments")), _num(r.get("shares"))))
    # uploads (titles and publish times)
    uploads = ((ch.get("contentDetails") or {}).get("relatedPlaylists") or {}).get("uploads")
    videos: dict[str, dict] = {}
    page = None
    while uploads and len(videos) < 500:
        params = {"part": "snippet,contentDetails", "playlistId": uploads, "maxResults": 50}
        if page:
            params["pageToken"] = page
        body = _try_get(f"{_YT}/playlistItems", params=params, headers={"Authorization": f"Bearer {token}"})
        if not body:
            break
        for it in body.get("items") or []:
            vid = (it.get("contentDetails") or {}).get("videoId") or ((it.get("snippet") or {}).get("resourceId") or {}).get("videoId")
            if vid:
                sn = it.get("snippet") or {}
                videos[vid] = {"post_id": vid, "account_id": cid, "account": name, "type": "video",
                               "posted_at": (it.get("contentDetails") or {}).get("videoPublishedAt") or sn.get("publishedAt"),
                               "text": sn.get("title"), "url": f"https://www.youtube.com/watch?v={vid}"}
        page = body.get("nextPageToken")
        if not page:
            break
    per_video = None
    for mets in ("views,estimatedMinutesWatched,likes,comments,shares", "views,estimatedMinutesWatched"):
        per_video = _yt_report(token, {**base, "metrics": mets, "dimensions": "video", "sort": "-views", "maxResults": 200})
        if per_video is not None:
            break
    for r in per_video or []:
        vid = r.get("video")
        if not vid:
            continue
        v = videos.setdefault(vid, {"post_id": vid, "account_id": cid, "account": name, "type": "video",
                                    "url": f"https://www.youtube.com/watch?v={vid}"})
        v.update({"video_views": _num(r.get("views")), "watch_minutes": _num(r.get("estimatedMinutesWatched")),
                  "likes": _num(r.get("likes")), "comments": _num(r.get("comments")), "shares": _num(r.get("shares"))})
    accounts = [{"account_id": cid, "account": name, "followers": _num(stats.get("subscriberCount")),
                 "posts_count": _num(stats.get("videoCount")),
                 "url": f"https://www.youtube.com/{(ch.get('snippet') or {}).get('customUrl') or 'channel/' + str(cid)}"}]
    return _social_tables(accounts, daily, list(videos.values()))


# ---- Google Search Console ----------------------------------------------------

_GSC = "https://www.googleapis.com/webmasters/v3"
_GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"


def _gsc_token(creds: dict) -> str:
    if str(creds.get("refresh_token") or "").strip():
        return ss._google_oauth_token(creds, "Search Console")
    if creds.get("service_account_json"):
        return ss._google_service_account_token(creds, [_GSC_SCOPE])
    raise SyncError("Search Console needs you to sign in with Google, or a service account key that has been "
                    "added as a user on the property.")


def _gsc_sites_raw(token: str) -> list[dict]:
    body = _must_get(f"{_GSC}/sites", "Search Console", headers={"Authorization": f"Bearer {token}"})
    return [s for s in (body or {}).get("siteEntry") or [] if s.get("permissionLevel") != "siteUnverifiedUser"]


def _gsc_sites(creds: dict, token: str, info: dict | None = None) -> list[str]:
    site = str(creds.get("site_url") or "").strip()
    want = _account_filter(creds, info)
    if site:
        return [site]
    if want:
        return sorted(want)
    sites = [s["siteUrl"] for s in _gsc_sites_raw(token)]
    if not sites:
        raise SyncError("No Search Console properties were found for this sign-in. Add the account as a user on the "
                        "property in Search Console › Settings › Users and permissions.")
    return sites


def search_console_test(creds: dict) -> str:
    token = _gsc_token(creds)
    sites = _gsc_sites(creds, token)
    r = ss._get(f"{_GSC}/sites/{quote(sites[0], safe='')}", headers={"Authorization": f"Bearer {token}"})
    if r.status_code == 404 or r.status_code == 403:
        raise SyncError(f"Search Console has no access to {sites[0]} for this account. Check the exact property "
                        "(e.g. sc-domain:example.com or https://www.example.com/) and that the account is a user on it.")
    ss._raise_for(r, "Search Console")
    return _label_many(sites)


def _gsc_query(token: str, site: str, dims: list[str], start: date, end: date, cap: int) -> list[dict]:
    url = f"{_GSC}/sites/{quote(site, safe='')}/searchAnalytics/query"
    rows: list[dict] = []
    start_row = 0
    while len(rows) < cap:
        body = {"startDate": start.isoformat(), "endDate": end.isoformat(), "dimensions": dims,
                "rowLimit": 25000, "startRow": start_row, "dataState": "final"}
        r = ss._post(url, headers={"Authorization": f"Bearer {token}"}, json=body)
        ss._raise_for(r, "Search Console")
        got = (_body(r) or {}).get("rows") or []
        for g in got:
            rec = {"site": site}
            for d, v in zip(dims, g.get("keys") or []):
                rec[d] = v
            rec.update({"clicks": _num(g.get("clicks")), "impressions": _num(g.get("impressions")),
                        "ctr": g.get("ctr"), "position": g.get("position")})
            rows.append(rec)
        if len(got) < 25000:
            break
        start_row += 25000
    return rows[:cap]


def search_console_fetch(creds: dict, info: dict) -> dict[str, pd.DataFrame]:
    token = _gsc_token(creds)
    start = _window_start(info, 480, cap=486)  # Search Console keeps 16 months
    end = date.today() - timedelta(days=1)
    daily, queries, pages = [], [], []
    for site in _gsc_sites(creds, token, info):
        daily += _gsc_query(token, site, ["date", "device", "country"], start, end, 400_000)
        queries += _gsc_query(token, site, ["date", "query"], start, end, 200_000 - len(queries))
        pages += _gsc_query(token, site, ["date", "page"], start, end, 100_000 - len(pages))
    num = {"clicks", "impressions", "ctr", "position"}
    return {
        "search_daily": _frame(daily, ["date", "device", "country", "clicks", "impressions", "ctr", "position", "site"],
                               dates=("date",), numeric=num),
        "queries_daily": _frame(queries, ["date", "query", "clicks", "impressions", "ctr", "position", "site"],
                                dates=("date",), numeric=num),
        "pages_daily": _frame(pages, ["date", "page", "clicks", "impressions", "ctr", "position", "site"],
                              dates=("date",), numeric=num),
    }


# ---- WooCommerce ------------------------------------------------------------

def _woo_store(creds: dict) -> str:
    raw = str(creds.get("store_url") or "").strip().rstrip("/")
    if not raw:
        raise SyncError("The WooCommerce store address is required (e.g. https://shop.example.com).")
    if raw.lower().startswith("http://"):
        raise SyncError("GD360 only connects to WooCommerce over https, because the API keys are sent with every "
                        "request. Use your store's https:// address (and turn on SSL for the store if it is off).")
    if not raw.lower().startswith("https://"):
        raw = "https://" + raw
    for suffix in ("/wp-json/wc/v3", "/wp-json", "/wp-admin"):
        if raw.lower().endswith(suffix):
            raw = raw[: -len(suffix)]
    return raw


class _Woo:
    """Basic auth first; some hosts strip the Authorization header, so on a
    401 the keys are sent as query parameters instead (still over https)."""

    def __init__(self, creds: dict):
        self.store = _woo_store(creds)
        self.ck = str(creds.get("consumer_key") or "").strip()
        self.cs = str(creds.get("consumer_secret") or "").strip()
        if not (self.ck and self.cs):
            raise SyncError("WooCommerce needs a consumer key (ck_…) and consumer secret (cs_…).")
        self.query_auth = False

    def get(self, path: str, params: dict | None = None):
        url = f"{self.store}/wp-json/wc/v3/{path}"
        p = dict(params or {})
        if self.query_auth:
            r = ss._get(url, params={**p, "consumer_key": self.ck, "consumer_secret": self.cs})
        else:
            r = ss._get(url, params=p, auth=(self.ck, self.cs))
            if r.status_code == 401:
                r2 = ss._get(url, params={**p, "consumer_key": self.ck, "consumer_secret": self.cs})
                if r2.status_code < 400:
                    self.query_auth = True
                r = r2
        if r.status_code == 404:
            raise SyncError(f"{self.store} has no WooCommerce REST API (got 404). Check the store address, and that "
                            "WordPress permalinks are not set to 'Plain'.")
        ss._raise_for(r, "WooCommerce")
        return r

    def pages(self, path: str, params: dict, cap: int) -> list[dict]:
        out: list[dict] = []
        page = 1
        while len(out) < cap:
            r = self.get(path, {**params, "per_page": 100, "page": page})
            items = _body(r) or []
            if not isinstance(items, list) or not items:
                break
            out += items
            try:
                total = int(r.headers.get("X-WP-TotalPages") or r.headers.get("x-wp-totalpages") or 0)
            except ValueError:
                total = 0
            if (total and page >= total) or (not total and len(items) < 100):
                break
            page += 1
        return out[:cap]


def woocommerce_test(creds: dict) -> str:
    w = _Woo(creds)
    w.get("orders", {"per_page": 1})
    body = _try_get(f"{w.store}/wp-json/")
    if isinstance(body, dict) and body.get("name"):
        return str(body["name"])
    return ss._host(w.store)


def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


_WOO_PAID = {"processing", "completed"}
# not revenue: never paid, or cancelled (the Marketing hub drops rows where cancelled is true, as for Shopify)
_WOO_NOT_SALES = {"cancelled", "failed", "pending", "checkout-draft", "trash"}


def woocommerce_fetch(creds: dict, info: dict) -> dict[str, pd.DataFrame]:
    w = _Woo(creds)
    since = (datetime.utcnow() - timedelta(days=ss._window_days(info, 730))).strftime("%Y-%m-%dT00:00:00")
    orders = w.pages("orders", {"after": since, "orderby": "date", "order": "desc"}, 200_000)
    o_rows, l_rows = [], []
    per_customer: dict[str, list] = {}
    for o in orders:
        refunded = sum(abs(_f(rf.get("total"))) for rf in o.get("refunds") or [])
        total = _f(o.get("total"))
        created = o.get("date_created_gmt") or o.get("date_created")
        local = str(o.get("date_created") or created or "")
        cust = str(o.get("customer_id") or "")
        cust = cust if cust not in ("", "0") else None
        status = o.get("status")
        o_rows.append({
            "order_id": str(o.get("id")), "order_number": o.get("number"), "order_date": local[:10] or None,
            "created_at": created, "status": status, "is_paid": status in _WOO_PAID,
            "cancelled": status in _WOO_NOT_SALES, "currency": o.get("currency"),
            "total_price": total, "total_tax": _f(o.get("total_tax")), "total_discounts": _f(o.get("discount_total")),
            "shipping_total": _f(o.get("shipping_total")), "refunded_amount": refunded, "net_revenue": total - refunded,
            "customer_id": cust,
            "country": (o.get("shipping") or {}).get("country") or (o.get("billing") or {}).get("country") or None,
            "payment_method": o.get("payment_method_title") or o.get("payment_method"),
            "coupon_codes": ",".join(c.get("code", "") for c in o.get("coupon_lines") or []) or None,
            "created_via": o.get("created_via"),
            "line_item_count": len(o.get("line_items") or []),
        })
        if cust:
            per_customer.setdefault(cust, []).append(total - refunded if status in _WOO_PAID else 0.0)
        for li in o.get("line_items") or []:
            qty = int(_f(li.get("quantity")))
            l_rows.append({
                "order_id": str(o.get("id")), "order_date": local[:10] or None,
                "product_id": str(li.get("product_id") or "") or None,
                "variant_id": str(li.get("variation_id") or "") if li.get("variation_id") else None,
                "sku": li.get("sku") or None, "title": li.get("name"), "quantity": qty, "price": _f(li.get("price")),
                "line_revenue": _f(li.get("total")),
            })
    products = w.pages("products", {"status": "any"}, 50_000)
    p_rows = [{"product_id": str(p.get("id")), "title": p.get("name"), "product_type": p.get("type"), "sku": p.get("sku") or None,
               "status": p.get("status"), "price": _f(p.get("price")) if p.get("price") not in (None, "") else None,
               "stock_status": p.get("stock_status"), "stock_quantity": _num(p.get("stock_quantity")),
               "categories": ",".join(c.get("name", "") for c in p.get("categories") or []) or None,
               "total_sales": _num(p.get("total_sales")), "created_at": p.get("date_created_gmt") or p.get("date_created")}
              for p in products]
    try:
        customers = w.pages("customers", {"role": "all"}, 200_000)
    except SyncError as e:  # a read-only key may not see customers on some setups
        print(f"[app_connectors] woocommerce customers skipped: {e}")
        customers = []
    c_rows = [{"customer_id": str(c.get("id")), "created_at": c.get("date_created_gmt") or c.get("date_created"),
               "orders_count": len(per_customer.get(str(c.get("id")), [])),
               "total_spent": round(sum(per_customer.get(str(c.get("id")), [])), 2),
               "country": (c.get("billing") or {}).get("country") or (c.get("shipping") or {}).get("country") or None,
               "is_paying_customer": bool(c.get("is_paying_customer"))}
              for c in customers]
    out = {
        "orders": _frame(o_rows, ["order_id", "order_date", "created_at", "status", "currency", "total_price", "total_tax",
                                  "total_discounts", "shipping_total", "refunded_amount", "net_revenue", "customer_id",
                                  "country", "payment_method", "coupon_codes", "line_item_count"],
                         dates=("order_date",), stamps=("created_at",), numeric=set()),
        "order_lines": _frame(l_rows, ["order_id", "order_date", "product_id", "variant_id", "sku", "title", "quantity",
                                       "price", "line_revenue"], dates=("order_date",), numeric=set()),
        "products": _frame(p_rows, ["product_id", "title", "product_type", "sku", "status", "price"],
                           stamps=("created_at",), numeric={"price"}),
        "customers": _frame(c_rows, ["customer_id", "created_at", "orders_count", "total_spent", "country"],
                            stamps=("created_at",), numeric=set()),
    }
    return out


# ---- Stripe -----------------------------------------------------------------

_STRIPE = "https://api.stripe.com/v1"
ZERO_DECIMAL = {"bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"}


def _money(amount, currency) -> float | None:
    if amount is None:
        return None
    try:
        a = float(amount)
    except (TypeError, ValueError):
        return None
    return a if str(currency or "").lower() in ZERO_DECIMAL else a / 100.0


def _stripe_headers(creds: dict) -> dict:
    key = str(creds.get("api_key") or "").strip()
    if not key:
        raise SyncError("A Stripe secret or restricted key is required (rk_live_… is recommended).")
    if key.startswith("pk_"):
        raise SyncError("That is a publishable key (pk_…), which cannot read data. Create a restricted key (rk_…) "
                        "with read access in Stripe › Developers › API keys.")
    return {"Authorization": f"Bearer {key}"}


def stripe_test(creds: dict) -> str:
    h = _stripe_headers(creds)
    r = ss._get(f"{_STRIPE}/account", headers=h)
    if r.status_code == 403:  # a restricted key without Account read: check it can read charges instead
        r2 = ss._get(f"{_STRIPE}/charges", headers=h, params={"limit": 1})
        ss._raise_for(r2, "Stripe")
        key = str(creds.get("api_key"))
        return f"Stripe ({'test' if '_test_' in key else 'live'} key …{key[-4:]})"
    ss._raise_for(r, "Stripe")
    a = _body(r) or {}
    return ((a.get("business_profile") or {}).get("name") or ((a.get("settings") or {}).get("dashboard") or {}).get("display_name")
            or a.get("id") or "Stripe account")


def _stripe_list(creds: dict, path: str, params: dict, cap: int = 200_000, required: bool = True) -> list[dict]:
    h = _stripe_headers(creds)
    out: list[dict] = []
    after = None
    while len(out) < cap:
        p = {**params, "limit": 100}
        if after:
            p["starting_after"] = after
        r = ss._get(f"{_STRIPE}/{path}", headers=h, params=p)
        if r.status_code == 403 and not required:
            print(f"[app_connectors] stripe {path} skipped: the key has no read access")
            return out
        ss._raise_for(r, "Stripe")
        body = _body(r) or {}
        data = body.get("data") or []
        out += data
        if not body.get("has_more") or not data:
            break
        after = data[-1].get("id")
    return out[:cap]


_PER_MONTH = {"day": 365.0 / 12.0, "week": 52.0 / 12.0, "month": 1.0, "year": 1.0 / 12.0}


def _sub_row(s: dict) -> dict:
    items = ((s.get("items") or {}).get("data") or [])
    first = items[0] if items else {}
    price = first.get("price") or first.get("plan") or s.get("plan") or {}
    rec = price.get("recurring") or {}
    interval = rec.get("interval") or price.get("interval")
    count = rec.get("interval_count") or price.get("interval_count") or 1
    currency = price.get("currency") or s.get("currency")
    mrr = 0.0
    if s.get("status") in ("active", "trialing", "past_due"):
        for it in items or [{"price": price, "quantity": s.get("quantity") or 1}]:
            pr = it.get("price") or it.get("plan") or {}
            rc = pr.get("recurring") or {}
            iv = rc.get("interval") or pr.get("interval")
            n = rc.get("interval_count") or pr.get("interval_count") or 1
            unit = pr.get("unit_amount") if pr.get("unit_amount") is not None else pr.get("amount")
            if unit is None and pr.get("unit_amount_decimal") is not None:
                unit = pr.get("unit_amount_decimal")
            amt = _money(unit, pr.get("currency") or currency) or 0.0
            mrr += amt * float(it.get("quantity") or 1) * _PER_MONTH.get(iv, 0.0) / float(n or 1)
    unit = price.get("unit_amount") if price.get("unit_amount") is not None else price.get("amount")
    return {
        "subscription_id": s.get("id"), "customer_id": s.get("customer") if isinstance(s.get("customer"), str) else (s.get("customer") or {}).get("id"),
        "status": s.get("status"), "created_at": _from_unix(s.get("created")), "canceled_at": _from_unix(s.get("canceled_at")),
        "ended_at": _from_unix(s.get("ended_at")), "cancel_at_period_end": bool(s.get("cancel_at_period_end")),
        "current_period_end": _from_unix(s.get("current_period_end") or first.get("current_period_end")),
        "interval": interval, "interval_count": int(count or 1), "currency": currency,
        "unit_amount": _money(unit, currency), "quantity": int(first.get("quantity") or s.get("quantity") or 1),
        "items": len(items), "mrr": round(mrr, 2),
    }


def stripe_fetch(creds: dict, info: dict) -> dict[str, pd.DataFrame]:
    since = int((datetime.utcnow() - timedelta(days=ss._window_days(info, 730))).timestamp())
    win = {"created[gte]": since}
    charges = []
    for c in _stripe_list(creds, "charges", win):
        cur = c.get("currency")
        created = _from_unix(c.get("created"))
        charges.append({
            "charge_id": c.get("id"), "created_at": created, "date": created.date() if created else None,
            "amount": _money(c.get("amount"), cur), "amount_refunded": _money(c.get("amount_refunded"), cur),
            "currency": cur, "status": c.get("status"), "paid": bool(c.get("paid")), "refunded": bool(c.get("refunded")),
            "customer_id": c.get("customer") if isinstance(c.get("customer"), str) else None,
            "payment_method_type": (c.get("payment_method_details") or {}).get("type"),
            "failure_code": c.get("failure_code"),
            "invoice_id": c.get("invoice") if isinstance(c.get("invoice"), str) else None,
            "country": ((c.get("billing_details") or {}).get("address") or {}).get("country"),
        })
    refunds = []
    for rf in _stripe_list(creds, "refunds", win, required=False):
        created = _from_unix(rf.get("created"))
        refunds.append({"refund_id": rf.get("id"), "charge_id": rf.get("charge") if isinstance(rf.get("charge"), str) else None,
                        "created_at": created, "date": created.date() if created else None,
                        "amount": _money(rf.get("amount"), rf.get("currency")), "currency": rf.get("currency"),
                        "status": rf.get("status"), "reason": rf.get("reason")})
    # every subscription, not just recent ones - MRR needs the old ones too
    subs = [_sub_row(s) for s in _stripe_list(creds, "subscriptions", {"status": "all"}, required=False)]
    payouts = []
    for p in _stripe_list(creds, "payouts", win, required=False):
        created = _from_unix(p.get("created"))
        payouts.append({"payout_id": p.get("id"), "created_at": created,
                        "arrival_date": (_from_unix(p.get("arrival_date")) or datetime.min).date() if p.get("arrival_date") else None,
                        "amount": _money(p.get("amount"), p.get("currency")), "currency": p.get("currency"),
                        "status": p.get("status"), "method": p.get("method")})
    bts = []
    for b in _stripe_list(creds, "balance_transactions", win, required=False):
        created = _from_unix(b.get("created"))
        cur = b.get("currency")
        bts.append({"balance_transaction_id": b.get("id"), "created_at": created, "date": created.date() if created else None,
                    "type": b.get("type"), "reporting_category": b.get("reporting_category"),
                    "amount": _money(b.get("amount"), cur), "fee": _money(b.get("fee"), cur), "net": _money(b.get("net"), cur),
                    "currency": cur, "source_id": b.get("source") if isinstance(b.get("source"), str) else None})
    customers = []
    for c in _stripe_list(creds, "customers", {}, required=False):
        customers.append({"customer_id": c.get("id"), "created_at": _from_unix(c.get("created")),
                          "country": (c.get("address") or {}).get("country") or ((c.get("shipping") or {}).get("address") or {}).get("country"),
                          "delinquent": bool(c.get("delinquent")), "currency": c.get("currency")})
    return {
        "charges": _frame(charges, ["charge_id", "created_at", "date", "amount", "amount_refunded", "currency", "status", "paid",
                                    "refunded", "customer_id", "payment_method_type", "failure_code", "invoice_id"],
                          dates=("date",), stamps=("created_at",), numeric={"amount", "amount_refunded"}),
        "refunds": _frame(refunds, ["refund_id", "charge_id", "created_at", "date", "amount", "currency", "status", "reason"],
                          dates=("date",), stamps=("created_at",), numeric={"amount"}),
        "subscriptions": _frame(subs, ["subscription_id", "customer_id", "status", "created_at", "canceled_at", "interval",
                                       "unit_amount", "quantity", "mrr"],
                                stamps=("created_at", "canceled_at", "ended_at", "current_period_end"),
                                numeric={"unit_amount", "mrr"}),
        "payouts": _frame(payouts, ["payout_id", "created_at", "arrival_date", "amount", "currency", "status", "method"],
                          dates=("arrival_date",), stamps=("created_at",), numeric={"amount"}),
        "balance_transactions": _frame(bts, ["balance_transaction_id", "created_at", "date", "type", "reporting_category",
                                             "amount", "fee", "net", "currency"],
                                       dates=("date",), stamps=("created_at",), numeric={"amount", "fee", "net"}),
        "customers": _frame(customers, ["customer_id", "created_at", "country", "delinquent"], stamps=("created_at",),
                            numeric=set()),
    }


# ---- HubSpot ----------------------------------------------------------------

_HS = "https://api.hubapi.com"


def _hs_token(creds: dict) -> str:
    refresh = str(creds.get("refresh_token") or "").strip()
    cid, secret = _cfg("HUBSPOT_CLIENT_ID"), _cfg("HUBSPOT_CLIENT_SECRET")
    if refresh and cid and secret:
        r = ss._post(f"{_HS}/oauth/v1/token", data={"grant_type": "refresh_token", "client_id": cid,
                                                    "client_secret": secret, "refresh_token": refresh})
        if r.status_code < 400 and (_body(r) or {}).get("access_token"):
            return _body(r)["access_token"]
        if not creds.get("access_token"):
            raise SyncError("HubSpot no longer accepts the saved sign-in. Reconnect HubSpot.")
    token = str(creds.get("access_token") or "").strip()
    if not token:
        raise SyncError("A HubSpot private app access token is required (pat-…).")
    return token


def hubspot_test(creds: dict) -> str:
    body = _must_get(f"{_HS}/account-info/v3/details", "HubSpot", headers={"Authorization": f"Bearer {_hs_token(creds)}"}) or {}
    return body.get("companyName") or (f"HubSpot portal {body.get('portalId')}" if body.get("portalId") else "HubSpot")


def _hs_list(token: str, obj: str, props: list[str], cap: int = 200_000) -> list[dict] | None:
    """Every record of one CRM object; None when the token lacks the scope."""
    out: list[dict] = []
    after = None
    while len(out) < cap:
        params = {"limit": 100, "properties": ",".join(props), "archived": "false"}
        if after:
            params["after"] = after
        r = ss._get(f"{_HS}/crm/v3/objects/{obj}", headers={"Authorization": f"Bearer {token}"}, params=params)
        if r.status_code == 403 and not out:
            print(f"[app_connectors] hubspot {obj} skipped: the token has no read scope for it")
            return None
        ss._raise_for(r, "HubSpot")
        body = _body(r) or {}
        out += body.get("results") or []
        after = ((body.get("paging") or {}).get("next") or {}).get("after")
        if not after:
            break
    return out[:cap]


def hubspot_fetch(creds: dict, info: dict) -> dict[str, pd.DataFrame]:
    token = _hs_token(creds)
    h = {"Authorization": f"Bearer {token}"}
    stages: dict[str, dict] = {}
    pipelines: dict[str, str] = {}
    body = _try_get(f"{_HS}/crm/v3/pipelines/deals", headers=h) or {}
    for p in body.get("results") or []:
        pipelines[str(p.get("id"))] = p.get("label")
        for st in p.get("stages") or []:
            md = st.get("metadata") or {}
            closed = str(md.get("isClosed")).lower() == "true"
            try:
                won = closed and float(md.get("probability")) >= 1.0
            except (TypeError, ValueError):
                won = False
            stages[str(st.get("id"))] = {"label": st.get("label"), "closed": closed, "won": won}
    owners_raw = []
    after = None
    while len(owners_raw) < 10_000:
        params = {"limit": 100}
        if after:
            params["after"] = after
        ob = _try_get(f"{_HS}/crm/v3/owners", headers=h, params=params)
        if not ob:
            break
        owners_raw += ob.get("results") or []
        after = ((ob.get("paging") or {}).get("next") or {}).get("after")
        if not after:
            break
    owners = {str(o.get("id")): (" ".join(x for x in (o.get("firstName"), o.get("lastName")) if x) or str(o.get("id")))
              for o in owners_raw}
    deals_raw = _hs_list(token, "deals", ["dealname", "amount", "dealstage", "pipeline", "createdate", "closedate",
                                          "hubspot_owner_id", "hs_is_closed", "hs_is_closed_won"])
    if deals_raw is None:
        raise SyncError("The HubSpot token cannot read deals. Give the private app the crm.objects.deals.read scope.")
    deals = []
    for d in deals_raw:
        pr = d.get("properties") or {}
        st = stages.get(str(pr.get("dealstage")), {})
        closed = st.get("closed") if st else str(pr.get("hs_is_closed")).lower() == "true"
        won = st.get("won") if st else str(pr.get("hs_is_closed_won")).lower() == "true"
        deals.append({"deal_id": str(d.get("id")), "name": pr.get("dealname"), "amount": _num(pr.get("amount")),
                      "stage_id": pr.get("dealstage"), "stage": st.get("label") or pr.get("dealstage"),
                      "pipeline": pipelines.get(str(pr.get("pipeline"))) or pr.get("pipeline"),
                      "is_closed": bool(closed), "is_won": bool(won),
                      "created_at": pr.get("createdate") or d.get("createdAt"), "close_date": pr.get("closedate"),
                      "owner": owners.get(str(pr.get("hubspot_owner_id"))) or (pr.get("hubspot_owner_id") or None)})
    contacts = [{"contact_id": str(c.get("id")), "created_at": (c.get("properties") or {}).get("createdate") or c.get("createdAt"),
                 "lifecycle_stage": (c.get("properties") or {}).get("lifecyclestage"),
                 "lead_status": (c.get("properties") or {}).get("hs_lead_status"),
                 "country": (c.get("properties") or {}).get("country"),
                 "source": (c.get("properties") or {}).get("hs_analytics_source")}
                for c in _hs_list(token, "contacts", ["createdate", "lifecyclestage", "hs_lead_status", "country",
                                                      "hs_analytics_source"]) or []]
    companies = [{"company_id": str(c.get("id")), "name": (c.get("properties") or {}).get("name"),
                  "industry": (c.get("properties") or {}).get("industry"),
                  "employees": _num((c.get("properties") or {}).get("numberofemployees")),
                  "country": (c.get("properties") or {}).get("country"),
                  "annual_revenue": _num((c.get("properties") or {}).get("annualrevenue")),
                  "created_at": (c.get("properties") or {}).get("createdate") or c.get("createdAt")}
                 for c in _hs_list(token, "companies", ["name", "industry", "numberofemployees", "country", "annualrevenue",
                                                        "createdate"]) or []]
    return {
        "deals": _frame(deals, ["deal_id", "name", "amount", "stage_id", "stage", "pipeline", "is_closed", "is_won",
                                "created_at", "close_date", "owner"], stamps=("created_at",), dates=("close_date",),
                        numeric={"amount"}),
        "contacts": _frame(contacts, ["contact_id", "created_at", "lifecycle_stage", "lead_status", "country", "source"],
                           stamps=("created_at",), numeric=set()),
        "companies": _frame(companies, ["company_id", "name", "industry", "employees", "country", "annual_revenue", "created_at"],
                            stamps=("created_at",), numeric={"employees", "annual_revenue"}),
        "owners": _frame([{"owner_id": k, "name": v} for k, v in owners.items()], ["owner_id", "name"], numeric=set()),
    }


# ---- Klaviyo ----------------------------------------------------------------

_KL = "https://a.klaviyo.com/api"
_KL_STATS = ["recipients", "delivered", "opens_unique", "clicks_unique", "open_rate", "click_rate", "unsubscribes",
             "conversions", "conversion_value"]
_KL_SUMS = ("recipients", "delivered", "opens_unique", "clicks_unique", "unsubscribes", "conversions", "conversion_value")


def _kl_headers(creds: dict) -> dict:
    key = str(creds.get("api_key") or "").strip()
    if not key:
        raise SyncError("A Klaviyo private API key is required (pk_…, created in Klaviyo › Settings › API keys).")
    return {"Authorization": f"Klaviyo-API-Key {key}", "revision": _cfg("KLAVIYO_REVISION", "2025-07-15"),
            "accept": "application/vnd.api+json", "content-type": "application/vnd.api+json"}


def klaviyo_test(creds: dict) -> str:
    body = _must_get(f"{_KL}/accounts", "Klaviyo", headers=_kl_headers(creds)) or {}
    acc = (body.get("data") or [{}])[0]
    return ((acc.get("attributes") or {}).get("contact_information") or {}).get("organization_name") or acc.get("id") or "Klaviyo account"


def _kl_list(creds: dict, url: str, params: dict | None, cap: int = 20_000, required: bool = True) -> list[dict]:
    out: list[dict] = []
    first = True
    while url and len(out) < cap:
        r = ss._get(url, headers=_kl_headers(creds), params=params if first else None)
        if r.status_code >= 400 and not required:
            return out
        ss._raise_for(r, "Klaviyo")
        body = _body(r) or {}
        out += body.get("data") or []
        url = (body.get("links") or {}).get("next")
        first = False
    return out[:cap]


def _kl_report(creds: dict, kind: str, group_key: str, metric_id: str | None) -> dict[str, dict]:
    """{campaign_id or flow_id: stats summed over its messages}; {} when the report fails."""
    stats = _KL_STATS if metric_id else [s for s in _KL_STATS if not s.startswith("conversion")]
    attrs = {"statistics": stats, "timeframe": {"key": "last_365_days"}}
    if metric_id:
        attrs["conversion_metric_id"] = metric_id
    try:
        r = ss._post(f"{_KL}/{kind}-values-reports", headers=_kl_headers(creds),
                     json={"data": {"type": f"{kind}-values-report", "attributes": attrs}})
    except SyncError as e:
        print(f"[app_connectors] klaviyo {kind} report skipped: {e}")
        return {}
    if r.status_code >= 400:
        print(f"[app_connectors] klaviyo {kind} report skipped ({r.status_code})")
        return {}
    out: dict[str, dict] = {}
    for res in (((_body(r) or {}).get("data") or {}).get("attributes") or {}).get("results") or []:
        gid = (res.get("groupings") or {}).get(group_key)
        if not gid:
            continue
        agg = out.setdefault(str(gid), {k: 0.0 for k in _KL_SUMS})
        for k in _KL_SUMS:
            v = (res.get("statistics") or {}).get(k)
            if isinstance(v, (int, float)):
                agg[k] += v
    for agg in out.values():
        d = agg.get("delivered") or 0
        agg["open_rate"] = (agg["opens_unique"] / d) if d else None
        agg["click_rate"] = (agg["clicks_unique"] / d) if d else None
        agg["revenue"] = agg.pop("conversion_value")
        agg["clicks"] = agg["clicks_unique"]
        if not metric_id:
            agg["conversions"] = None
            agg["revenue"] = None
    return out


def klaviyo_fetch(creds: dict, info: dict) -> dict[str, pd.DataFrame]:
    camps = []
    for channel in ("email", "sms"):
        for c in _kl_list(creds, f"{_KL}/campaigns", {"filter": f"equals(messages.channel,'{channel}')"},
                          required=(channel == "email")):
            a = c.get("attributes") or {}
            camps.append({"campaign_id": c.get("id"), "name": a.get("name"), "channel": channel, "status": a.get("status"),
                          "send_time": a.get("send_time") or a.get("scheduled_at"), "created_at": a.get("created_at")})
    metric_id = None
    for m in _kl_list(creds, f"{_KL}/metrics", None, cap=5000, required=False):
        if ((m.get("attributes") or {}).get("name") or "").strip().lower() == "placed order":
            metric_id = m.get("id")
            break
    c_stats = _kl_report(creds, "campaign", "campaign_id", metric_id) if camps else {}
    for c in camps:
        c.update(c_stats.get(str(c["campaign_id"]), {}))
        c["send_date"] = c.get("send_time")
    flows = []
    for f in _kl_list(creds, f"{_KL}/flows", None, required=False):
        a = f.get("attributes") or {}
        flows.append({"flow_id": f.get("id"), "name": a.get("name"), "status": a.get("status"),
                      "trigger_type": a.get("trigger_type"), "created_at": a.get("created"), "updated_at": a.get("updated")})
    f_stats = _kl_report(creds, "flow", "flow_id", metric_id) if flows else {}
    for f in flows:
        f.update(f_stats.get(str(f["flow_id"]), {}))
    stat_cols = ["recipients", "delivered", "opens_unique", "clicks_unique", "open_rate", "click_rate", "unsubscribes",
                 "conversions", "revenue"]
    return {
        "campaigns": _frame(camps, ["campaign_id", "name", "channel", "status", "send_time", "send_date"] + stat_cols,
                            stamps=("send_time", "created_at"), dates=("send_date",), numeric=set(stat_cols) | {"clicks"}),
        "flows": _frame(flows, ["flow_id", "name", "status"] + stat_cols, stamps=("created_at", "updated_at"),
                        numeric=set(stat_cols) | {"clicks"}),
    }


# ---- discovery ----------------------------------------------------------------

def discover(kind: str, creds: dict) -> list[dict]:
    """The pages / accounts / sites the credentials can see, for the
    "pick which accounts to sync" step: [{id, name, detail}]."""
    if kind == "instagram":
        found = _ig_discover_raw(creds)
        if not found:
            raise SyncError("No Instagram professional accounts were found. Switch the Instagram account to a Business "
                            "or Creator account and link it to a Facebook Page you manage, then sign in again.")
        return [{"id": a["ig_id"], "name": f"@{a['username']}" if a.get("username") else a["ig_id"],
                 "detail": " · ".join(x for x in (f"{a['followers']:,} followers" if isinstance(a.get("followers"), int) else "",
                                                 f"via {a['page_name']}" if a.get("page_name") else "") if x)}
                for a in found]
    if kind == "facebook_pages":
        found = _fb_discover_raw(creds)
        if not found:
            raise SyncError("No Facebook Pages were found for this sign-in. Make sure you have a task on the Page and "
                            "that you ticked the Pages when Facebook asked which ones to share.")
        return [{"id": p["page_id"], "name": p["name"] or p["page_id"],
                 "detail": f"{p['followers']:,} followers" if isinstance(p.get("followers"), int) else ""} for p in found]
    if kind == "linkedin_pages":
        found = _li_discover_raw(creds)
        if not found:
            raise SyncError("No LinkedIn Pages were found where you are an admin. Ask a Page super admin to add you as "
                            "an admin, then sign in again.")
        return [{"id": o["id"], "name": o["name"], "detail": f"linkedin.com/company/{o['vanity']}" if o.get("vanity") else ""}
                for o in found]
    if kind == "search_console":
        found = _gsc_sites_raw(_gsc_token(creds))
        if not found:
            raise SyncError("No Search Console properties were found for this Google account. Add the account as a "
                            "user on the property in Search Console › Settings › Users and permissions.")
        return [{"id": s["siteUrl"], "name": s["siteUrl"].replace("sc-domain:", ""),
                 "detail": ("Domain property" if s["siteUrl"].startswith("sc-domain:") else "URL-prefix property")
                           + f" · {str(s.get('permissionLevel') or '').replace('site', '').lower()}"} for s in found]
    if kind == "youtube":
        items = _yt_channels(creds, _yt_token(creds))
        return [{"id": c.get("id"), "name": (c.get("snippet") or {}).get("title") or c.get("id"),
                 "detail": f"{int((c.get('statistics') or {}).get('subscriberCount') or 0):,} subscribers"} for c in items]
    return []


# ---- registry ---------------------------------------------------------------

APPS = {
    "instagram": {"label": "Instagram", "test": instagram_test, "fetch": instagram_fetch,
                  "fields": ["access_token", "account_ids"]},
    "facebook_pages": {"label": "Facebook Pages", "test": facebook_pages_test, "fetch": facebook_pages_fetch,
                       "fields": ["access_token", "account_ids", "page_ids"]},
    "linkedin_pages": {"label": "LinkedIn Pages", "test": linkedin_pages_test, "fetch": linkedin_pages_fetch,
                       "fields": ["access_token", "organization_id", "account_ids", "refresh_token"]},
    "youtube": {"label": "YouTube", "test": youtube_test, "fetch": youtube_fetch,
                "fields": ["refresh_token", "client_id", "client_secret", "account_ids"]},
    "search_console": {"label": "Google Search Console", "test": search_console_test, "fetch": search_console_fetch,
                       "fields": ["site_url", "service_account_json", "refresh_token", "client_id", "client_secret",
                                  "account_ids"]},
    "woocommerce": {"label": "WooCommerce", "test": woocommerce_test, "fetch": woocommerce_fetch,
                    "fields": ["store_url", "consumer_key", "consumer_secret"]},
    "stripe": {"label": "Stripe", "test": stripe_test, "fetch": stripe_fetch, "fields": ["api_key"]},
    "hubspot": {"label": "HubSpot", "test": hubspot_test, "fetch": hubspot_fetch,
                "fields": ["access_token", "refresh_token"]},
    "klaviyo": {"label": "Klaviyo", "test": klaviyo_test, "fetch": klaviyo_fetch, "fields": ["api_key"]},
}

DEFAULT_INTERVAL = {"instagram": "1h", "facebook_pages": "1h", "linkedin_pages": "1h", "youtube": "6h",
                    "search_console": "6h", "woocommerce": "1h", "stripe": "1h", "hubspot": "1h", "klaviyo": "1h"}

_SOCIAL_SUMMARY = "Followers, daily reach and engagement, and every post with its likes, comments and shares."

HELP = {
    "instagram": {
        "label": "Instagram", "category": "social", "oauth_provider": "meta", "discover": True,
        "summary": "Followers, daily reach and follower gains, and every post and reel with reach, likes, comments, saves and shares.",
        "fields": [
            {"key": "access_token", "label": "Access token", "placeholder": "EAAG…", "secret": True, "optional": False, "multiline": False},
            {"key": "account_ids", "label": "Instagram account IDs to sync (blank = all)", "placeholder": "17841400000000000",
             "secret": False, "optional": True, "multiline": False},
        ],
        "steps": [
            "Make sure the Instagram account is a Business or Creator account and is linked to a Facebook Page you manage.",
            "Click Sign in with Facebook and allow access to the Page and its Instagram account (instagram_basic, instagram_manage_insights, pages_show_list, pages_read_engagement).",
            "Pick which Instagram accounts to sync. Or paste a long-lived access token from a Meta system user with those permissions.",
        ],
    },
    "facebook_pages": {
        "label": "Facebook Pages", "category": "social", "oauth_provider": "meta", "discover": True,
        "summary": "Page followers, daily reach, impressions, engagement and follows, and every post with reactions, comments, shares, reach and clicks.",
        "fields": [
            {"key": "access_token", "label": "Access token", "placeholder": "EAAG…", "secret": True, "optional": False, "multiline": False},
            {"key": "account_ids", "label": "Page IDs to sync (blank = all)", "placeholder": "1234567890",
             "secret": False, "optional": True, "multiline": False},
        ],
        "steps": [
            "You need a task on the Page (Facebook › your Page › Settings › Page access).",
            "Click Sign in with Facebook and tick the Pages to share (pages_show_list, pages_read_engagement, read_insights).",
            "Pick which Pages to sync. Or paste a long-lived token from a Meta system user that has access to the Pages.",
        ],
    },
    "linkedin_pages": {
        "label": "LinkedIn Pages", "category": "social", "oauth_provider": "linkedin", "discover": True,
        "summary": "Company Page followers, daily follower gains, impressions, clicks and engagement, and every post with its stats.",
        "fields": [
            {"key": "access_token", "label": "Access token", "placeholder": "AQV…", "secret": True, "optional": False, "multiline": False},
            {"key": "organization_id", "label": "Organization ID (blank = every Page you admin)", "placeholder": "12345678",
             "secret": False, "optional": True, "multiline": False},
        ],
        "steps": [
            "You must be an admin of the LinkedIn Page (Page › Admin tools › Manage admins).",
            "Click Sign in with LinkedIn and allow GD360 to read your Pages' statistics.",
            "Pick which Pages to sync. The organization ID is the number in the Page's admin URL (linkedin.com/company/12345678/admin).",
            "Note: LinkedIn's Community Management API needs LinkedIn's approval for the GD360 app; if sign-in says the app is not allowed, ask your GD360 admin.",
        ],
    },
    "youtube": {
        "label": "YouTube", "category": "social", "oauth_provider": "google", "discover": True,
        "summary": "Subscribers, daily views, watch time and subscriber gains, and every video with views, watch time, likes and comments.",
        "fields": [
            {"key": "refresh_token", "label": "Google sign-in (refresh token)", "placeholder": "1//0…", "secret": True,
             "optional": False, "multiline": False},
        ],
        "steps": [
            "Click Sign in with Google using the Google account (or brand account) that owns the channel.",
            "Allow GD360 to see your YouTube channel and its YouTube Analytics reports (read-only).",
            "GD360 syncs the channel the sign-in belongs to; for another channel, connect again with that account.",
        ],
    },
    "search_console": {
        "label": "Google Search Console", "category": "web", "oauth_provider": "google", "discover": True,
        "summary": "Daily clicks, impressions, CTR and position by device and country, plus top queries and pages (16 months).",
        "fields": [
            {"key": "site_url", "label": "Property (blank = pick after sign-in)", "placeholder": "sc-domain:example.com or https://www.example.com/",
             "secret": False, "optional": True, "multiline": False},
            {"key": "service_account_json", "label": "Service account key (JSON), if not signing in with Google",
             "placeholder": "{ \"type\": \"service_account\", … }", "secret": True, "optional": True, "multiline": True},
        ],
        "steps": [
            "Easiest: click Sign in with Google with an account that can see the property, then pick the properties to sync.",
            "Or use a service account: in Google Cloud enable the Search Console API and create a JSON key.",
            "Then in Search Console › Settings › Users and permissions, add the service account's email as a user (Restricted is enough).",
            "Enter the property exactly as Search Console shows it: sc-domain:example.com for a Domain property, or the full https:// address for a URL-prefix one.",
        ],
    },
    "woocommerce": {
        "label": "WooCommerce", "category": "commerce", "oauth_provider": None, "discover": False,
        "summary": "Orders, line items, refunds, products and customers (no emails).",
        "fields": [
            {"key": "store_url", "label": "Store address", "placeholder": "https://shop.example.com", "secret": False,
             "optional": False, "multiline": False},
            {"key": "consumer_key", "label": "Consumer key", "placeholder": "ck_…", "secret": True, "optional": False, "multiline": False},
            {"key": "consumer_secret", "label": "Consumer secret", "placeholder": "cs_…", "secret": True, "optional": False, "multiline": False},
        ],
        "steps": [
            "In WordPress open WooCommerce › Settings › Advanced › REST API and click Add key.",
            "Choose a user who can see orders, set Permissions to Read, and generate the key.",
            "Copy the consumer key (ck_…) and consumer secret (cs_…). The store must use https.",
        ],
    },
    "stripe": {
        "label": "Stripe", "category": "finance", "oauth_provider": None, "discover": False,
        "summary": "Charges, refunds, subscriptions with MRR, payouts, balance transactions and customers (no emails).",
        "fields": [
            {"key": "api_key", "label": "Restricted API key", "placeholder": "rk_live_…", "secret": True, "optional": False, "multiline": False},
        ],
        "steps": [
            "In Stripe open Developers › API keys and click Create restricted key.",
            "Give it Read access to Charges, Refunds, Subscriptions, Payouts, Balance, Customers and Account (everything else: None).",
            "Copy the key (rk_live_…). A secret key (sk_…) also works, but a read-only restricted key is safer.",
        ],
    },
    "hubspot": {
        "label": "HubSpot", "category": "crm", "oauth_provider": "hubspot", "discover": False,
        "summary": "Deals with stages, pipelines and won/lost, contacts by lifecycle stage and source, companies and owners (no emails).",
        "fields": [
            {"key": "access_token", "label": "Private app access token", "placeholder": "pat-na1-…", "secret": True,
             "optional": False, "multiline": False},
        ],
        "steps": [
            "Click Sign in with HubSpot, or in HubSpot open Settings › Integrations › Private apps and create a private app.",
            "Give it the read scopes crm.objects.deals.read, crm.objects.contacts.read, crm.objects.companies.read, crm.objects.owners.read and crm.schemas.deals.read.",
            "Create the app and copy its access token (pat-…).",
        ],
    },
    "klaviyo": {
        "label": "Klaviyo", "category": "ads", "oauth_provider": None, "discover": False,
        "summary": "Email and SMS campaigns and flows with recipients, opens, clicks, unsubscribes, orders and revenue (last 365 days).",
        "fields": [
            {"key": "api_key", "label": "Private API key", "placeholder": "pk_…", "secret": True, "optional": False, "multiline": False},
        ],
        "steps": [
            "In Klaviyo open Settings › Account › API keys and click Create private API key.",
            "Choose Read-only access (or Custom with read access to Accounts, Campaigns, Flows and Metrics).",
            "Copy the key (it starts with pk_).",
        ],
    },
}

ss.register_connectors(sys.modules[__name__])
