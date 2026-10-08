"""
Synced app sources (2026-10-08, round 11): Shopify, Google Analytics 4,
Meta Ads and Google Ads.

Apps are not databases: they are read through their own HTTP APIs, which
are too slow and too rate-limited to call for every question. So GD360
copies their records on a schedule ("synced"), normalises them into a
small set of standard tables per app, and stores each table as Parquet in
models.SyncedTable. From then on they are queried with DuckDB like any
uploaded file - by the project engine, the Data tab and dashboards - and
every answer shows how fresh the copy is.

Each app has:
  test(creds)           - one cheap API call that proves the credentials work
  fetch(creds, info)    - {table_name: DataFrame} for the sync window
Credentials are stored encrypted (security.encrypt_secret) as JSON.

Nothing here writes to the app. Every request has a timeout; a failed sync
keeps the previous copy and records the error on the data source.
"""
from __future__ import annotations

import io
import json
import time
from datetime import date, datetime, timedelta

import pandas as pd
import requests
from sqlalchemy.orm import Session

from .. import models, security
from ..config import get_settings

settings = get_settings()

SYNCED_KINDS = ("shopify", "ga4", "meta_ads", "google_ads")
SYNC_INTERVALS = {"15m": timedelta(minutes=15), "1h": timedelta(hours=1), "6h": timedelta(hours=6),
                  "daily": timedelta(days=1)}
DEFAULT_INTERVAL = {"shopify": "15m", "ga4": "1h", "meta_ads": "1h", "google_ads": "1h"}
HTTP_TIMEOUT = 40
MAX_ROWS_PER_TABLE = 500_000


class SyncError(RuntimeError):
    """A sync failed in a way the person can act on (bad token, no access)."""


# ---- storage -----------------------------------------------------------------

def _columns_of(df: pd.DataFrame) -> list[dict]:
    out = []
    for c in df.columns:
        dt = df[c].dtype
        if pd.api.types.is_datetime64_any_dtype(dt):
            t = "timestamp"
        elif pd.api.types.is_bool_dtype(dt):
            t = "boolean"
        elif pd.api.types.is_integer_dtype(dt):
            t = "integer"
        elif pd.api.types.is_float_dtype(dt):
            t = "double"
        else:
            t = "text"
        out.append({"name": str(c), "type": t})
    return out


def _one_type(col: pd.Series) -> pd.Series:
    """An object column as one Parquet type: dates stay dates (so they
    compare with DATE literals), timestamps become timestamps, nested
    values become JSON text, anything mixed becomes text."""
    vals = col.dropna()
    if vals.empty:
        return col.astype("string") if len(col) else col
    types = {type(v) for v in vals.head(500)}
    if types <= {date}:
        return col
    if types <= {datetime, pd.Timestamp}:
        return pd.to_datetime(col, errors="coerce", utc=False)
    if types <= {str}:
        return col
    if types <= {bool}:
        return col.astype("boolean")
    if types <= {int, float}:
        return pd.to_numeric(col, errors="coerce")
    return col.map(lambda v: None if v is None or (isinstance(v, float) and v != v) else
                   json.dumps(v) if isinstance(v, (dict, list)) else str(v))


def store_table(db: Session, datasource_id: str, name: str, df: pd.DataFrame) -> models.SyncedTable:
    df = df.head(MAX_ROWS_PER_TABLE).copy()
    for c in df.columns:  # Parquet needs one type per column
        if df[c].dtype == object:
            df[c] = _one_type(df[c])
    buf = io.BytesIO()
    df.to_parquet(buf, index=False)
    row = (
        db.query(models.SyncedTable)
        .filter(models.SyncedTable.datasource_id == datasource_id, models.SyncedTable.table_name == name)
        .first()
    )
    if row is None:
        row = models.SyncedTable(datasource_id=datasource_id, table_name=name, parquet_data=b"")
        db.add(row)
    row.parquet_data = buf.getvalue()
    row.row_count = int(len(df))
    row.columns = _columns_of(df)
    row.synced_at = datetime.utcnow()
    _CACHE.pop((datasource_id, name), None)
    return row


_CACHE: dict[tuple[str, str], tuple[datetime, pd.DataFrame]] = {}


def load_table(db: Session, datasource_id: str, name: str | None = None) -> pd.DataFrame:
    q = db.query(models.SyncedTable).filter(models.SyncedTable.datasource_id == datasource_id)
    if name:
        q = q.filter(models.SyncedTable.table_name == name)
    row = q.order_by(models.SyncedTable.table_name).first()
    if row is None:
        raise ValueError("No data has been synced from this app yet.")
    key = (datasource_id, row.table_name)
    hit = _CACHE.get(key)
    if hit and hit[0] == row.synced_at:
        return hit[1].copy()
    df = pd.read_parquet(io.BytesIO(row.parquet_data))
    if len(_CACHE) > 24:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = (row.synced_at, df)
    return df.copy()


def schema_cache_for(db: Session, datasource_id: str) -> dict:
    rows = db.query(models.SyncedTable).filter(models.SyncedTable.datasource_id == datasource_id).all()
    return {r.table_name: r.columns or [] for r in rows}


# ---- helpers -----------------------------------------------------------------

def _host(url: str) -> str:
    try:
        return url.split("//", 1)[1].split("/", 1)[0]
    except IndexError:
        return url


def _send(method, url: str, **kw) -> requests.Response:
    try:
        return method(url, **kw)
    except requests.Timeout as e:
        raise SyncError(f"{_host(url)} did not answer in time. Try again in a minute.") from e
    except requests.RequestException as e:
        raise SyncError(f"Could not reach {_host(url)}. Check the address and that the service is up.") from e


def _get(url: str, **kw) -> requests.Response:
    kw.setdefault("timeout", HTTP_TIMEOUT)
    for attempt in range(3):
        r = _send(requests.get, url, **kw)
        if r.status_code == 429 and attempt < 2:
            time.sleep(float(r.headers.get("Retry-After", 2 + attempt * 3)))
            continue
        return r
    return r


def _post(url: str, **kw) -> requests.Response:
    kw.setdefault("timeout", HTTP_TIMEOUT)
    for attempt in range(3):
        r = _send(requests.post, url, **kw)
        if r.status_code == 429 and attempt < 2:
            time.sleep(float(r.headers.get("Retry-After", 2 + attempt * 3)))
            continue
        return r
    return r


def _raise_for(r: requests.Response, app: str):
    if r.status_code < 400:
        return
    try:
        body = r.json()
    except ValueError:
        body = {}
    msg = ""
    if isinstance(body, dict):
        err = body.get("error") or body.get("errors")
        if isinstance(err, dict):
            msg = err.get("message") or err.get("error_user_msg") or ""
        elif isinstance(err, list) and err:
            msg = err[0].get("message", "") if isinstance(err[0], dict) else str(err[0])
        elif isinstance(err, str):
            msg = err
    if r.status_code in (401, 403):
        raise SyncError(f"{app} refused the credentials ({r.status_code}). {msg}".strip())
    raise SyncError(f"{app} returned an error ({r.status_code}). {msg}".strip())


def _window_days(info: dict, default: int) -> int:
    try:
        return max(7, min(int(info.get("history_days") or default), 1100))
    except (TypeError, ValueError):
        return default


# ---- Shopify -----------------------------------------------------------------

def _shop(creds: dict) -> str:
    shop = str(creds.get("shop") or "").strip().lower().replace("https://", "").replace("http://", "").strip("/")
    if not shop:
        raise SyncError("The Shopify store address is required (e.g. your-store.myshopify.com).")
    if "." not in shop:
        shop = f"{shop}.myshopify.com"
    return shop


def _shopify_headers(creds: dict) -> dict:
    token = str(creds.get("access_token") or "").strip()
    if not token:
        raise SyncError("A Shopify Admin API access token is required.")
    return {"X-Shopify-Access-Token": token, "Accept": "application/json"}


def _shopify_url(creds: dict, path: str) -> str:
    return f"https://{_shop(creds)}/admin/api/{settings.SHOPIFY_API_VERSION}/{path}"


def shopify_test(creds: dict) -> str:
    r = _get(_shopify_url(creds, "shop.json"), headers=_shopify_headers(creds))
    _raise_for(r, "Shopify")
    shop = (r.json() or {}).get("shop") or {}
    return shop.get("name") or _shop(creds)


def _next_link(r: requests.Response) -> str | None:
    link = r.headers.get("Link") or r.headers.get("link") or ""
    for part in link.split(","):
        if 'rel="next"' in part:
            return part.split(";")[0].strip().strip("<>")
    return None


def _shopify_pages(creds: dict, path: str, key: str, params: dict, cap: int) -> list[dict]:
    out: list[dict] = []
    url = _shopify_url(creds, path)
    first = True
    while url and len(out) < cap:
        r = _get(url, headers=_shopify_headers(creds), params=params if first else None)
        _raise_for(r, "Shopify")
        out += (r.json() or {}).get(key) or []
        url = _next_link(r)
        first = False
    return out[:cap]


def shopify_fetch(creds: dict, info: dict) -> dict[str, pd.DataFrame]:
    since = (datetime.utcnow() - timedelta(days=_window_days(info, 730))).strftime("%Y-%m-%dT00:00:00Z")
    orders = _shopify_pages(creds, "orders.json", "orders",
                            {"status": "any", "limit": 250, "created_at_min": since}, 200_000)
    o_rows, l_rows = [], []
    for o in orders:
        refunds = 0.0
        for rf in o.get("refunds") or []:
            for t in rf.get("transactions") or []:
                try:
                    refunds += float(t.get("amount") or 0)
                except (TypeError, ValueError):
                    pass
        total = float(o.get("total_price") or 0)
        o_rows.append({
            "order_id": str(o.get("id")), "order_name": o.get("name"),
            "created_at": o.get("created_at"), "processed_at": o.get("processed_at"),
            "order_date": (o.get("processed_at") or o.get("created_at") or "")[:10],
            "financial_status": o.get("financial_status"), "fulfillment_status": o.get("fulfillment_status"),
            "cancelled": bool(o.get("cancelled_at")),
            "currency": o.get("currency"),
            "total_price": total, "subtotal_price": float(o.get("subtotal_price") or 0),
            "total_discounts": float(o.get("total_discounts") or 0), "total_tax": float(o.get("total_tax") or 0),
            "refunded_amount": refunds, "net_revenue": total - refunds,
            "customer_id": str((o.get("customer") or {}).get("id") or "") or None,
            "source_name": o.get("source_name"),
            "landing_site": o.get("landing_site"), "referring_site": o.get("referring_site"),
            "discount_codes": ",".join(d.get("code", "") for d in o.get("discount_codes") or []) or None,
            "country": ((o.get("shipping_address") or o.get("billing_address") or {}) or {}).get("country_code"),
            "line_item_count": len(o.get("line_items") or []),
        })
        for li in o.get("line_items") or []:
            l_rows.append({
                "order_id": str(o.get("id")), "order_date": (o.get("processed_at") or o.get("created_at") or "")[:10],
                "product_id": str(li.get("product_id") or "") or None, "variant_id": str(li.get("variant_id") or "") or None,
                "sku": li.get("sku"), "title": li.get("title"), "vendor": li.get("vendor"),
                "quantity": int(li.get("quantity") or 0), "price": float(li.get("price") or 0),
                "line_revenue": float(li.get("price") or 0) * int(li.get("quantity") or 0),
            })
    products = _shopify_pages(creds, "products.json", "products", {"limit": 250}, 50_000)
    p_rows = [{"product_id": str(p.get("id")), "title": p.get("title"), "product_type": p.get("product_type"),
               "vendor": p.get("vendor"), "status": p.get("status"), "created_at": p.get("created_at")} for p in products]
    customers = _shopify_pages(creds, "customers.json", "customers", {"limit": 250}, 200_000)
    c_rows = [{"customer_id": str(c.get("id")), "created_at": c.get("created_at"),
               "orders_count": int(c.get("orders_count") or 0), "total_spent": float(c.get("total_spent") or 0),
               "country": ((c.get("default_address") or {}) or {}).get("country_code"),
               "accepts_marketing": bool(c.get("accepts_marketing") or c.get("email_marketing_consent", {}).get("state") == "subscribed")}
              for c in customers]
    out = {
        "orders": pd.DataFrame(o_rows, columns=list(o_rows[0].keys()) if o_rows else [
            "order_id", "order_date", "total_price", "net_revenue", "customer_id", "source_name"]),
        "order_lines": pd.DataFrame(l_rows, columns=list(l_rows[0].keys()) if l_rows else [
            "order_id", "order_date", "sku", "quantity", "price", "line_revenue"]),
        "products": pd.DataFrame(p_rows, columns=list(p_rows[0].keys()) if p_rows else ["product_id", "title"]),
        "customers": pd.DataFrame(c_rows, columns=list(c_rows[0].keys()) if c_rows else ["customer_id", "created_at"]),
    }
    for name in ("orders", "order_lines"):
        if "order_date" in out[name].columns and len(out[name]):
            out[name]["order_date"] = pd.to_datetime(out[name]["order_date"], errors="coerce").dt.date
    return out


# ---- Google Analytics 4 ------------------------------------------------------

def _ga4_token(creds: dict) -> str:
    raw = creds.get("service_account_json")
    try:
        info = json.loads(raw) if isinstance(raw, str) else dict(raw or {})
    except ValueError as e:
        raise SyncError("The service account key is not valid JSON.") from e
    if not info.get("client_email"):
        raise SyncError("The service account key is missing client_email.")
    try:
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account
        cred = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/analytics.readonly"])
        cred.refresh(Request())
        return cred.token
    except Exception as e:  # noqa: BLE001
        raise SyncError(f"Google rejected the service account key: {str(e)[:200]}") from e


def _ga4_property(creds: dict) -> str:
    pid = str(creds.get("property_id") or "").strip().replace("properties/", "")
    if not pid.isdigit():
        raise SyncError("The GA4 property ID is a number, e.g. 312345678 (Admin › Property settings).")
    return pid


def _ga4_report(token: str, pid: str, dims: list[str], mets: list[str], start: str, end: str, cap: int) -> pd.DataFrame:
    url = f"https://analyticsdata.googleapis.com/v1beta/properties/{pid}:runReport"
    rows: list[dict] = []
    offset = 0
    while len(rows) < cap:
        body = {"dateRanges": [{"startDate": start, "endDate": end}],
                "dimensions": [{"name": d} for d in dims], "metrics": [{"name": m} for m in mets],
                "limit": 100000, "offset": offset, "keepEmptyRows": False}
        r = _post(url, headers={"Authorization": f"Bearer {token}"}, json=body)
        _raise_for(r, "Google Analytics")
        data = r.json() or {}
        for row in data.get("rows") or []:
            rec = {}
            for d, v in zip(dims, row.get("dimensionValues") or []):
                rec[d] = v.get("value")
            for m, v in zip(mets, row.get("metricValues") or []):
                try:
                    rec[m] = float(v.get("value"))
                except (TypeError, ValueError):
                    rec[m] = None
            rows.append(rec)
        total = int(data.get("rowCount") or 0)
        offset += 100000
        if offset >= total:
            break
    df = pd.DataFrame(rows, columns=dims + mets)
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"], format="%Y%m%d", errors="coerce").dt.date
    return df.rename(columns=_snake)


def _snake(name: str) -> str:
    import re
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def ga4_test(creds: dict) -> str:
    token = _ga4_token(creds)
    pid = _ga4_property(creds)
    r = _get(f"https://analyticsadmin.googleapis.com/v1beta/properties/{pid}", headers={"Authorization": f"Bearer {token}"})
    if r.status_code == 403 or r.status_code == 404:
        # the Admin API may be disabled while the Data API works - try a tiny report
        _ga4_report(token, pid, ["date"], ["sessions"], "7daysAgo", "today", 10)
        return f"GA4 property {pid}"
    _raise_for(r, "Google Analytics")
    return (r.json() or {}).get("displayName") or f"GA4 property {pid}"


def ga4_fetch(creds: dict, info: dict) -> dict[str, pd.DataFrame]:
    token = _ga4_token(creds)
    pid = _ga4_property(creds)
    start = (date.today() - timedelta(days=_window_days(info, 480))).isoformat()
    end = date.today().isoformat()
    traffic = _ga4_report(token, pid,
                          ["date", "sessionDefaultChannelGroup", "sessionSource", "sessionMedium", "sessionCampaignName",
                           "deviceCategory", "country"],
                          ["sessions", "totalUsers", "newUsers", "engagedSessions", "keyEvents", "transactions",
                           "purchaseRevenue"], start, end, 400_000)
    traffic = traffic.rename(columns={"session_default_channel_group": "channel", "session_source": "source",
                                      "session_medium": "medium", "session_campaign_name": "campaign",
                                      "device_category": "device"})
    funnel = _ga4_report(token, pid, ["date", "eventName", "deviceCategory"], ["eventCount", "totalUsers"],
                         start, end, 200_000).rename(columns={"event_name": "event", "device_category": "device"})
    keep = {"session_start", "view_item", "add_to_cart", "begin_checkout", "add_shipping_info", "add_payment_info",
            "purchase", "sign_up", "generate_lead", "page_view"}
    if len(funnel):
        funnel = funnel[funnel["event"].isin(keep)]
    pages = _ga4_report(token, pid, ["date", "pagePath"], ["screenPageViews", "sessions"], start, end, 200_000) \
        .rename(columns={"page_path": "page"})
    return {"traffic_daily": traffic, "events_daily": funnel, "pages_daily": pages}


# ---- Meta Ads ----------------------------------------------------------------

_META_PURCHASE = ("omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase")


def _meta_account(creds: dict) -> str:
    acc = str(creds.get("ad_account_id") or "").strip()
    if not acc:
        raise SyncError("The Meta ad account ID is required (e.g. act_1234567890).")
    return acc if acc.startswith("act_") else f"act_{acc}"


def _meta_base() -> str:
    return f"https://graph.facebook.com/{settings.META_GRAPH_VERSION}"


def meta_test(creds: dict) -> str:
    token = str(creds.get("access_token") or "").strip()
    if not token:
        raise SyncError("A Meta access token is required.")
    r = _get(f"{_meta_base()}/{_meta_account(creds)}", params={"fields": "name,currency", "access_token": token})
    _raise_for(r, "Meta")
    return (r.json() or {}).get("name") or _meta_account(creds)


def _meta_action(actions, kinds=_META_PURCHASE) -> float:
    best = {}
    for a in actions or []:
        if a.get("action_type") in kinds:
            try:
                best[a["action_type"]] = float(a.get("value") or 0)
            except (TypeError, ValueError):
                pass
    for k in kinds:  # prefer the de-duplicated "omni" figure
        if k in best:
            return best[k]
    return 0.0


def meta_fetch(creds: dict, info: dict) -> dict[str, pd.DataFrame]:
    token = str(creds.get("access_token") or "").strip()
    acc = _meta_account(creds)
    since = (date.today() - timedelta(days=_window_days(info, 400))).isoformat()
    until = date.today().isoformat()
    url = f"{_meta_base()}/{acc}/insights"
    params = {
        "access_token": token, "level": "campaign", "time_increment": 1, "limit": 500,
        "fields": "campaign_id,campaign_name,date_start,spend,impressions,clicks,reach,actions,action_values",
        "time_range": json.dumps({"since": since, "until": until}),
    }
    rows = []
    while url and len(rows) < 400_000:
        r = _get(url, params=params)
        _raise_for(r, "Meta")
        body = r.json() or {}
        for it in body.get("data") or []:
            rows.append({
                "date": it.get("date_start"), "campaign_id": it.get("campaign_id"), "campaign": it.get("campaign_name"),
                "spend": float(it.get("spend") or 0), "impressions": float(it.get("impressions") or 0),
                "clicks": float(it.get("clicks") or 0), "reach": float(it.get("reach") or 0),
                "purchases": _meta_action(it.get("actions")), "purchase_value": _meta_action(it.get("action_values")),
            })
        url = ((body.get("paging") or {}).get("next"))
        params = None  # the next link carries every parameter
    df = pd.DataFrame(rows, columns=["date", "campaign_id", "campaign", "spend", "impressions", "clicks", "reach",
                                     "purchases", "purchase_value"])
    if len(df):
        df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.date
    camps_r = _get(f"{_meta_base()}/{acc}/campaigns",
                   params={"access_token": token, "fields": "id,name,status,objective,daily_budget,lifetime_budget", "limit": 500})
    _raise_for(camps_r, "Meta")
    camps = [{"campaign_id": c.get("id"), "campaign": c.get("name"), "status": c.get("status"), "objective": c.get("objective"),
              "daily_budget": float(c.get("daily_budget") or 0) / 100.0 if c.get("daily_budget") else None}
             for c in (camps_r.json() or {}).get("data") or []]
    return {"campaign_daily": df, "campaigns": pd.DataFrame(camps, columns=["campaign_id", "campaign", "status", "objective", "daily_budget"])}


# ---- Google Ads --------------------------------------------------------------

def _gads_token(creds: dict) -> str:
    client_id = creds.get("client_id") or settings.GOOGLE_OAUTH_CLIENT_ID
    client_secret = creds.get("client_secret") or settings.GOOGLE_OAUTH_CLIENT_SECRET
    refresh = str(creds.get("refresh_token") or "").strip()
    if not (client_id and client_secret and refresh):
        raise SyncError("Google Ads needs an OAuth client ID, client secret and refresh token.")
    r = _post("https://oauth2.googleapis.com/token", data={
        "client_id": client_id, "client_secret": client_secret, "refresh_token": refresh, "grant_type": "refresh_token"})
    _raise_for(r, "Google")
    return (r.json() or {}).get("access_token")


def _gads_headers(creds: dict, token: str) -> dict:
    dev = str(creds.get("developer_token") or settings.GOOGLE_ADS_DEVELOPER_TOKEN or "").strip()
    if not dev:
        raise SyncError("Google Ads needs a developer token (Google Ads › Tools › API Center).")
    h = {"Authorization": f"Bearer {token}", "developer-token": dev, "Content-Type": "application/json"}
    login = str(creds.get("login_customer_id") or "").replace("-", "").strip()
    if login:
        h["login-customer-id"] = login
    return h


def _gads_customer(creds: dict) -> str:
    cid = str(creds.get("customer_id") or "").replace("-", "").strip()
    if not cid.isdigit():
        raise SyncError("The Google Ads customer ID is the 10-digit number at the top of Google Ads (123-456-7890).")
    return cid


def _gads_query(creds: dict, token: str, gaql: str) -> list[dict]:
    url = f"https://googleads.googleapis.com/{settings.GOOGLE_ADS_API_VERSION}/customers/{_gads_customer(creds)}/googleAds:searchStream"
    r = _post(url, headers=_gads_headers(creds, token), json={"query": gaql})
    _raise_for(r, "Google Ads")
    out = []
    for chunk in r.json() or []:
        out += chunk.get("results") or []
    return out


def google_ads_test(creds: dict) -> str:
    token = _gads_token(creds)
    res = _gads_query(creds, token, "SELECT customer.descriptive_name, customer.currency_code FROM customer LIMIT 1")
    if res:
        return (res[0].get("customer") or {}).get("descriptiveName") or f"Google Ads {_gads_customer(creds)}"
    return f"Google Ads {_gads_customer(creds)}"


def google_ads_fetch(creds: dict, info: dict) -> dict[str, pd.DataFrame]:
    token = _gads_token(creds)
    start = (date.today() - timedelta(days=_window_days(info, 400))).isoformat()
    end = date.today().isoformat()
    rows = _gads_query(creds, token, (
        "SELECT segments.date, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, "
        "campaign_budget.amount_micros, metrics.cost_micros, metrics.impressions, metrics.clicks, "
        "metrics.conversions, metrics.conversions_value FROM campaign "
        f"WHERE segments.date BETWEEN '{start}' AND '{end}'"
    ))
    recs = []
    for r in rows:
        seg, camp, bud, met = r.get("segments") or {}, r.get("campaign") or {}, r.get("campaignBudget") or {}, r.get("metrics") or {}
        recs.append({
            "date": seg.get("date"), "campaign_id": str(camp.get("id") or ""), "campaign": camp.get("name"),
            "status": camp.get("status"), "channel_type": camp.get("advertisingChannelType"),
            "daily_budget": float(bud.get("amountMicros") or 0) / 1e6 if bud.get("amountMicros") else None,
            "cost": float(met.get("costMicros") or 0) / 1e6, "impressions": float(met.get("impressions") or 0),
            "clicks": float(met.get("clicks") or 0), "conversions": float(met.get("conversions") or 0),
            "conversion_value": float(met.get("conversionsValue") or 0),
        })
    df = pd.DataFrame(recs, columns=["date", "campaign_id", "campaign", "status", "channel_type", "daily_budget", "cost",
                                     "impressions", "clicks", "conversions", "conversion_value"])
    if len(df):
        df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.date
    # budget history (when a budget changed) - from the change history the API keeps for 30 days
    changes = []
    try:
        ch = _gads_query(creds, token, (
            "SELECT change_event.change_date_time, change_event.change_resource_type, change_event.campaign, "
            "change_event.changed_fields, change_event.user_email FROM change_event "
            f"WHERE change_event.change_date_time >= '{(date.today() - timedelta(days=29)).isoformat()}' "
            "AND change_event.change_resource_type IN ('CAMPAIGN_BUDGET', 'CAMPAIGN') LIMIT 1000"
        ))
        for c in ch:
            ev = c.get("changeEvent") or {}
            changes.append({"changed_at": ev.get("changeDateTime"), "resource": ev.get("changeResourceType"),
                            "campaign": ev.get("campaign"), "fields": ev.get("changedFields"), "by": ev.get("userEmail")})
    except SyncError as e:
        print(f"[synced_sources] google ads change history skipped: {e}")
    return {"campaign_daily": df,
            "changes": pd.DataFrame(changes, columns=["changed_at", "resource", "campaign", "fields", "by"])}


# ---- registry and sync -------------------------------------------------------

APPS = {
    "shopify": {"label": "Shopify", "test": shopify_test, "fetch": shopify_fetch,
                "fields": ["shop", "access_token"]},
    "ga4": {"label": "Google Analytics 4", "test": ga4_test, "fetch": ga4_fetch,
            "fields": ["property_id", "service_account_json"]},
    "meta_ads": {"label": "Meta Ads", "test": meta_test, "fetch": meta_fetch,
                 "fields": ["ad_account_id", "access_token"]},
    "google_ads": {"label": "Google Ads", "test": google_ads_test, "fetch": google_ads_fetch,
                   "fields": ["customer_id", "developer_token", "refresh_token", "login_customer_id", "client_id", "client_secret"]},
}


def credentials(ds: models.DataSource) -> dict:
    try:
        return json.loads(security.decrypt_secret(ds.encrypted_secret) or "{}")
    except Exception:  # noqa: BLE001
        return {}


def next_sync_time(ds: models.DataSource, now: datetime | None = None) -> datetime:
    now = now or datetime.utcnow()
    interval = (ds.connection_info or {}).get("sync_interval") or DEFAULT_INTERVAL.get(ds.kind, "1h")
    return now + SYNC_INTERVALS.get(interval, timedelta(hours=1))


def sync_datasource(db: Session, ds: models.DataSource) -> dict:
    """Fetch and store every table of one synced source. Never raises: the
    outcome (tables, rows, error) is returned and recorded on the source."""
    app = APPS.get(ds.kind)
    started = time.perf_counter()
    if not app:
        return {"ok": False, "error": f"{ds.kind} is not a synced app."}
    try:
        tables = app["fetch"](credentials(ds), ds.connection_info or {})
        counts = {}
        for name, df in tables.items():
            store_table(db, ds.id, name, df)
            counts[name] = int(len(df))
        ds.schema_cache = schema_cache_for(db, ds.id) or {n: _columns_of(t) for n, t in tables.items()}
        ds.last_synced_at = datetime.utcnow()
        ds.sync_error = None
        ds.next_sync_at = next_sync_time(ds)
        db.commit()
        return {"ok": True, "tables": counts, "seconds": round(time.perf_counter() - started, 1)}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        msg = str(e) if isinstance(e, SyncError) else f"The sync failed: {str(e)[:300]}"
        print(f"[synced_sources] sync of {ds.id} ({ds.kind}) failed: {e}")
        ds = db.merge(ds)
        ds.sync_error = msg
        ds.next_sync_at = next_sync_time(ds)
        db.commit()
        return {"ok": False, "error": msg}


def due_sources(db: Session, now: datetime | None = None) -> list[models.DataSource]:
    now = now or datetime.utcnow()
    return (
        db.query(models.DataSource)
        .filter(models.DataSource.kind.in_(SYNCED_KINDS))
        .filter((models.DataSource.next_sync_at.is_(None)) | (models.DataSource.next_sync_at <= now))
        .all()
    )
