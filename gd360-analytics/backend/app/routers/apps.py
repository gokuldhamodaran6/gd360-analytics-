"""
Connecting synced apps (2026-10-08, round 11): Shopify, Google Analytics 4,
Meta Ads and Google Ads. See services/synced_sources.py for how their
records are copied and queried.

  GET   /apps                       the apps that can be connected, and what each needs
  POST  /apps                       connect one (credentials are tested first)
  POST  /apps/{datasource_id}/sync  copy its records now
  GET   /apps/{datasource_id}       its sync status and tables
  PATCH /apps/{datasource_id}       how often it syncs

2026-10-09 (round 15):
  GET   /apps/catalog               every connector GD360 lists, with what is ready today
  POST  /apps/discover              the accounts / pages / properties a sign-in can see
  GET   /apps/oauth/{kind}/start    the "Sign in with ..." page for an app
  GET   /apps/oauth/{provider}/callback   where the provider sends the browser back
  POST /apps also takes pending_id (from a sign-in), account_ids, space_ids, new_space.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models, security
from ..database import SessionLocal, get_db
from ..deps import get_current_user
from ..services import app_oauth, audit, synced_sources, workspace_access
from ..services import spaces as spaces_service

router = APIRouter(prefix="/apps", tags=["apps"])

HELP = {
    "shopify": {
        "summary": "Orders, line items, products and customers.",
        "fields": [
            {"key": "shop", "label": "Store address", "placeholder": "your-store.myshopify.com", "secret": False},
            {"key": "access_token", "label": "Admin API access token", "placeholder": "shpat_…", "secret": True},
        ],
        "steps": [
            "In Shopify admin open Settings › Apps and sales channels › Develop apps, and create an app.",
            "Under Configuration, give it read access to Orders, Products and Customers (read_orders, read_products, read_customers).",
            "Install the app and copy the Admin API access token (starts with shpat_).",
        ],
    },
    "ga4": {
        "summary": "Daily traffic by channel, campaign, device and country; key events; pages.",
        "fields": [
            {"key": "property_id", "label": "GA4 property ID", "placeholder": "312345678", "secret": False},
            {"key": "service_account_json", "label": "Service account key (JSON)", "placeholder": "{ \"type\": \"service_account\", … }", "secret": True, "multiline": True},
        ],
        "steps": [
            "In Google Cloud, create a service account and download a JSON key (the same kind used for BigQuery).",
            "Enable the Google Analytics Data API for that project.",
            "In GA4 Admin › Property access management, add the service account's email as a Viewer.",
            "Copy the property ID from Admin › Property settings.",
        ],
    },
    "meta_ads": {
        "summary": "Daily campaign spend, reach, clicks, purchases and purchase value; campaign budgets.",
        "fields": [
            {"key": "ad_account_id", "label": "Ad account ID", "placeholder": "act_1234567890", "secret": False},
            {"key": "access_token", "label": "Access token", "placeholder": "EAAG…", "secret": True},
        ],
        "steps": [
            "In Meta Business Settings › Users › System users, create a system user with access to the ad account.",
            "Generate a token for it with the ads_read permission.",
            "Copy the ad account ID from Ads Manager (it starts with act_).",
        ],
    },
    "google_ads": {
        "summary": "Daily campaign cost, clicks, conversions and value; budgets and recent budget changes.",
        "fields": [
            {"key": "customer_id", "label": "Customer ID", "placeholder": "123-456-7890", "secret": False},
            {"key": "refresh_token", "label": "OAuth refresh token", "placeholder": "1//0…", "secret": True},
            {"key": "developer_token", "label": "Developer token (if your company has its own)", "placeholder": "optional", "secret": True, "optional": True},
            {"key": "login_customer_id", "label": "Manager account ID (if you sign in through one)", "placeholder": "optional", "secret": False, "optional": True},
        ],
        "steps": [
            "Google Ads › Tools › API Center: request a developer token (Google approves Basic access in a few days).",
            "Create an OAuth refresh token for a Google user who can see the account (Google's OAuth Playground with the adwords scope works).",
            "Copy the 10-digit customer ID from the top of Google Ads.",
        ],
    },
}


class NewSpace(BaseModel):
    name: str
    color: str | None = None


class ConnectAppRequest(BaseModel):
    kind: str
    name: str = Field(min_length=1, max_length=120)
    credentials: dict = Field(default_factory=dict)
    sync_interval: str | None = None
    history_days: int | None = Field(default=None, ge=7, le=1100)
    workspace_id: str | None = None
    # 2026-10-09 (round 15): a "Sign in with ..." hand-off instead of pasted
    # keys, the accounts/pages chosen, and the Spaces the source goes into.
    pending_id: str | None = None
    account_ids: list[str] | None = None
    space_ids: list[str] | None = None
    new_space: NewSpace | None = None


class DiscoverRequest(BaseModel):
    kind: str
    credentials: dict = Field(default_factory=dict)
    pending_id: str | None = None


class AppSettingsRequest(BaseModel):
    sync_interval: str


def _app(db: Session, datasource_id: str, user: models.User, edit: bool = False) -> models.DataSource:
    ds = db.get(models.DataSource, datasource_id)
    if not ds or ds.kind not in synced_sources.SYNCED_KINDS or not workspace_access.can_access_datasource(db, ds, user):
        raise HTTPException(404, "App connection not found.")
    if edit and not workspace_access.can_edit_datasource(db, ds, user):
        raise HTTPException(403, "You have view-only access to this source.")
    return ds


def _status(db: Session, ds: models.DataSource) -> dict:
    tables = (
        db.query(models.SyncedTable.table_name, models.SyncedTable.row_count, models.SyncedTable.synced_at)
        .filter(models.SyncedTable.datasource_id == ds.id).order_by(models.SyncedTable.table_name).all()
    )
    info = ds.connection_info or {}
    return {
        "id": ds.id, "name": ds.name, "kind": ds.kind, "label": synced_sources.APPS[ds.kind]["label"],
        "sync_interval": info.get("sync_interval") or synced_sources.DEFAULT_INTERVAL.get(ds.kind),
        "history_days": info.get("history_days"), "account": info.get("account_label"),
        "last_synced_at": ds.last_synced_at, "next_sync_at": ds.next_sync_at, "sync_error": ds.sync_error,
        "syncing": ds.id in _SYNCING,
        "tables": [{"name": n, "rows": r, "synced_at": t} for n, r, t in tables],
    }


_SYNCING: set[str] = set()


def _sync_in_background(datasource_id: str) -> None:
    if datasource_id in _SYNCING:
        return
    _SYNCING.add(datasource_id)

    def job():
        db = SessionLocal()
        try:
            ds = db.get(models.DataSource, datasource_id)
            if ds:
                synced_sources.sync_datasource(db, ds, reason="manual")
        except Exception as e:  # noqa: BLE001
            print(f"[apps] background sync failed for {datasource_id}: {e}")
        finally:
            db.close()
            _SYNCING.discard(datasource_id)

    threading.Thread(target=job, daemon=True, name=f"sync-{datasource_id[:8]}").start()


# ---- 2026-10-09 (round 15): the connector catalog -----------------------------
# Every connector the Data > Catalog page lists, with the label, monogram and
# colours of the design. "kind" is the GD360 data source kind behind it (None
# when GD360 cannot connect it yet); "flow" is how it connects when it can.
CATALOG_CATEGORIES = [
    {"id": "social", "label": "Social & brand", "description": "Your pages and profiles — organic reach, engagement, audience"},
    {"id": "ads", "label": "Marketing & ads", "description": "Spend, results and return on every paid channel"},
    {"id": "web", "label": "Website, search & product analytics", "description": "Traffic, search visibility and in-product behaviour"},
    {"id": "commerce", "label": "Commerce & marketplaces", "description": "Stores and marketplaces — orders, products, payouts"},
    {"id": "crm", "label": "CRM, email & sales", "description": "Pipeline, customers and campaigns"},
    {"id": "finance", "label": "Finance & payments", "description": "Revenue, payments, invoices and the books"},
    {"id": "hr", "label": "HR & people", "description": "Headcount, hiring, payroll and attrition"},
    {"id": "product", "label": "Product, support & projects", "description": "Tickets, issues and delivery"},
    {"id": "db", "label": "Databases", "description": "Queried where they live — nothing copied"},
    {"id": "wh", "label": "Warehouses & lakes", "description": "Billions of rows, computed in place"},
    {"id": "files", "label": "Files & sheets", "description": "Upload once or keep in sync"},
    {"id": "dev", "label": "Streaming & APIs", "description": "Events and anything with an API"},
]

_W, _K, _D = "#FFFFFF", "#0B0F10", "#2A3436"
# (category, id, label, monogram, colour, ink, summary, connects-as, ring)
#   connects-as: "app:<kind>" | "database:<kind>" | "warehouse:<kind>" | "file" | "sheets" | "api" | "streaming" | None
_CATALOG = [
    ("social", "instagram", "Instagram", "Ig", "#C1356F", _W, "Business and creator accounts: posts, reels, stories, audience", "app:instagram", None),
    ("social", "facebook_pages", "Facebook Pages", "Fb", "#1668E3", _W, "Page posts, reach, followers, video views", "app:facebook_pages", None),
    ("social", "linkedin_pages", "LinkedIn Pages", "in", "#0A63BC", _W, "Company page followers, post engagement, visitors", "app:linkedin_pages", None),
    ("social", "youtube", "YouTube", "Yt", "#E5242B", _W, "Channel views, watch time, subscribers per video", "app:youtube", None),
    ("social", "tiktok", "TikTok", "Tt", "#111517", "#5CF2E6", "Business account videos, views, followers, audience", None, _D),
    ("social", "x_twitter", "X (Twitter)", "X", "#111517", _W, "Posts, impressions, engagement, followers", None, _D),
    ("social", "pinterest", "Pinterest", "Pi", "#D3132A", _W, "Pins, impressions, saves, outbound clicks", None, None),
    ("social", "threads", "Threads", "@", "#111517", _W, "Posts, views, replies, followers", None, _D),
    ("ads", "meta_ads", "Meta Ads", "Ma", "#1668E3", _W, "Facebook and Instagram campaigns, spend, results", "app:meta_ads", None),
    ("ads", "google_ads", "Google Ads", "GA", "#1A73E8", _W, "Search, Shopping, YouTube and PMax campaigns", "app:google_ads", None),
    ("ads", "linkedin_ads", "LinkedIn Ads", "Li", "#0A63BC", _W, "Sponsored content, lead forms, spend", None, None),
    ("ads", "tiktok_ads", "TikTok Ads", "TA", "#111517", "#FF4D73", "Campaigns, spend, conversions", None, _D),
    ("ads", "microsoft_ads", "Microsoft Ads", "Ms", "#0C77C6", _W, "Bing search campaigns and spend", None, None),
    ("ads", "amazon_ads", "Amazon Ads", "AA", "#232F3E", "#FF9F1C", "Sponsored products, brands and display", None, None),
    ("ads", "pinterest_ads", "Pinterest Ads", "PA", "#D3132A", _W, "Promoted pins, spend, checkouts", None, None),
    ("ads", "snapchat_ads", "Snapchat Ads", "Sn", "#FFF200", _K, "Campaigns, swipes, conversions", None, None),
    ("web", "ga4", "Google Analytics 4", "G4", "#E8710A", _W, "Sessions, channels, events, conversions", "app:ga4", None),
    ("web", "search_console", "Search Console", "SC", "#2B7DE9", _W, "Search clicks, impressions, position by query and page", "app:search_console", None),
    ("web", "mixpanel", "Mixpanel", "Mx", "#5B3FD8", _W, "Events, funnels and retention", None, None),
    ("web", "amplitude", "Amplitude", "Am", "#1F5BD8", _W, "Product events and cohorts", None, None),
    ("web", "hotjar", "Hotjar", "Hj", "#F0533A", _W, "Surveys and feedback responses", None, None),
    ("web", "semrush", "Semrush", "Se", "#FF642D", _W, "Keyword rankings and competitor visibility", None, None),
    ("commerce", "shopify", "Shopify", "Sh", "#5E8E3E", _W, "Orders, products, customers, refunds", "app:shopify", None),
    ("commerce", "woocommerce", "WooCommerce", "Wc", "#7F54B3", _W, "Orders, products, customers", "app:woocommerce", None),
    ("commerce", "amazon_seller", "Amazon Seller Central", "Az", "#232F3E", "#FF9F1C", "Orders, fees, inventory, returns", None, None),
    ("commerce", "ebay", "eBay", "eB", "#E53238", _W, "Listings, orders, fees", None, None),
    ("commerce", "etsy", "Etsy", "Et", "#E8590C", _W, "Shop orders, listings, reviews", None, None),
    ("commerce", "walmart", "Walmart Marketplace", "Wm", "#0071DC", "#FFC220", "Orders, items, returns", None, None),
    ("commerce", "flipkart", "Flipkart Seller", "Fk", "#2874F0", "#FFE11B", "Orders, settlements, returns", None, None),
    ("commerce", "bigcommerce", "BigCommerce", "Bc", "#34313F", _W, "Orders, products, customers", None, None),
    ("crm", "hubspot", "HubSpot", "Hs", "#FF5C35", _W, "Contacts, deals, emails, forms", "app:hubspot", None),
    ("crm", "salesforce", "Salesforce", "Sf", "#0D9DDA", _W, "Accounts, opportunities, cases", None, None),
    ("crm", "klaviyo", "Klaviyo", "Kl", "#1F1F1F", _W, "Email and SMS campaigns, flows, revenue", "app:klaviyo", _D),
    ("crm", "mailchimp", "Mailchimp", "Mc", "#FFE01B", _K, "Audiences, campaigns, opens, clicks", None, None),
    ("crm", "zoho_crm", "Zoho CRM", "Zo", "#E42527", _W, "Leads, deals, activities", None, None),
    ("crm", "pipedrive", "Pipedrive", "Pd", "#1A1A1A", _W, "Deals, stages, activities", None, _D),
    ("finance", "stripe", "Stripe", "St", "#635BFF", _W, "Charges, subscriptions, refunds, payouts", "app:stripe", None),
    ("finance", "paypal", "PayPal", "PP", "#003087", "#7FC4FF", "Transactions and settlements", None, None),
    ("finance", "razorpay", "Razorpay", "Rp", "#0C2451", "#3395FF", "Payments, settlements, refunds", None, None),
    ("finance", "quickbooks", "QuickBooks", "QB", "#2CA01C", _W, "Invoices, bills, P&L accounts", None, None),
    ("finance", "xero", "Xero", "Xe", "#13B5EA", _W, "Invoices, bank transactions, accounts", None, None),
    ("finance", "netsuite", "NetSuite", "Ns", "#1E3A5F", _W, "General ledger, AR, AP", None, None),
    ("hr", "bamboohr", "BambooHR", "Bb", "#73C41D", _K, "Employees, departments, time off", None, None),
    ("hr", "workday", "Workday", "Wd", "#0875E1", _W, "Workers, positions, compensation", None, None),
    ("hr", "greenhouse", "Greenhouse", "Gh", "#24A47F", _W, "Jobs, candidates, stages, offers", None, None),
    ("hr", "gusto", "Gusto", "Gu", "#F45D48", _W, "Payroll runs and benefits", None, None),
    ("hr", "deel", "Deel", "De", "#15357A", _W, "Global contractors and payroll", None, None),
    ("product", "zendesk", "Zendesk", "Zd", "#03363D", "#7FE3D3", "Tickets, satisfaction, agents", None, None),
    ("product", "intercom", "Intercom", "Ic", "#1F8DED", _W, "Conversations, response times, CSAT", None, None),
    ("product", "jira", "Jira", "Ji", "#0C66E4", _W, "Issues, sprints, cycle time", None, None),
    ("product", "github", "GitHub", "Gi", "#161B22", _W, "Pull requests, reviews, deployments", None, _D),
    ("product", "freshdesk", "Freshdesk", "Fd", "#25C16F", _K, "Tickets and agent performance", None, None),
    ("db", "postgres", "PostgreSQL", "Pg", "#2F5D8C", _W, "Live queries, any schema", "database:postgres", None),
    ("db", "mysql", "MySQL / MariaDB", "My", "#00758F", _W, "Live queries, any schema", "database:mysql", None),
    ("db", "sqlserver", "SQL Server", "SQ", "#B52E31", _W, "Live queries, any schema", "database:sqlserver", None),
    ("db", "mongodb", "MongoDB", "Mg", "#0F8B4C", _W, "Collections flattened into tables", "database:mongodb", None),
    ("db", "supabase", "Supabase", "Sb", "#2FBF7E", _K, "Postgres with row-level security kept", "database:supabase", None),
    ("db", "oracle", "Oracle", "Or", "#C74634", _W, "Live queries, any schema", None, None),
    ("wh", "bigquery", "BigQuery", "BQ", "#3B78E7", _W, "Pushdown queries, cost guard on", "warehouse:bigquery", None),
    ("wh", "snowflake", "Snowflake", "Sf", "#1EA7D9", _W, "Pushdown queries, warehouse of your choice", "warehouse:snowflake", None),
    ("wh", "databricks", "Databricks", "Db", "#E8432B", _W, "SQL warehouses and Unity Catalog", None, None),
    ("wh", "redshift", "Redshift", "Rs", "#7A43E6", _W, "Pushdown queries", None, None),
    ("wh", "clickhouse", "ClickHouse", "CH", "#FAD02C", _K, "Pushdown queries", None, None),
    ("files", "files", "CSV / Excel / Parquet", "Fi", "#1C2A25", "#43E5A0", "Up to 2 GB, profiled on upload", "file", "#2A3D36"),
    ("files", "google_sheets", "Google Sheets", "GS", "#1E8E3E", _W, "A sheet that stays in sync", "sheets", None),
    ("files", "s3", "Amazon S3", "S3", "#3F8624", _W, "A folder of files, synced", None, None),
    ("files", "google_drive", "Google Drive", "Dr", "#1A73E8", "#FFD04B", "Files in a shared folder", None, None),
    ("dev", "api", "REST / GraphQL API", "{}", "#151C1D", "#43E5A0", "Any endpoint, paginated and scheduled", "api", _D),
    ("dev", "webhooks", "Webhooks", "Wh", "#151C1D", "#9DB4FF", "Push events to a GD360 URL", "streaming", _D),
    ("dev", "kafka", "Kafka", "Kf", "#1A1A1A", _W, "Topics landed into tables", None, _D),
    ("dev", "segment", "Segment", "Sg", "#52BD94", _K, "Tracked events from every app", None, None),
]
# The data source kinds behind a non-app catalog entry (for "connected").
_FLOW_KINDS = {"file": ("csv", "excel"), "sheets": ("google_sheets",), "api": ("api",), "streaming": ("streaming",)}
_EXISTING_APPS = ("shopify", "ga4", "meta_ads", "google_ads")
_APP_CATEGORY = {"shopify": "commerce", "ga4": "web", "meta_ads": "ads", "google_ads": "ads"}


def _new_help() -> dict:
    """services.app_connectors.HELP (the round-15 apps), or {} until it exists."""
    try:
        from ..services import app_connectors
        return dict(getattr(app_connectors, "HELP", {}) or {})
    except Exception:  # noqa: BLE001
        return {}


def _oauth_provider(kind: str) -> str | None:
    """The provider an app signs in through - only when its connector reads the
    token that sign-in produces, so a "Sign in" button is never offered for an
    app that would then ignore it (GA4 reads a service-account key today)."""
    new = _new_help().get(kind)
    if new is not None:
        return new.get("oauth_provider")
    provider = app_oauth.KIND_PROVIDER.get(kind)
    app = synced_sources.APPS.get(kind)
    if provider and app is not None:
        need = "refresh_token" if provider == "google" else "access_token"
        if need not in (app.get("fields") or []):
            return None
    return provider


def _help_entry(kind: str) -> dict:
    app = synced_sources.APPS[kind]
    new = _new_help().get(kind)
    if kind in HELP:
        base = dict(HELP[kind])
        category = _APP_CATEGORY.get(kind)
    elif new:
        base = {k: v for k, v in new.items() if k in ("summary", "fields", "steps")}
        category = new.get("category")
    else:
        base = {"summary": "", "steps": [],
                "fields": [{"key": f, "label": f.replace("_", " ").capitalize(), "placeholder": "",
                            "secret": "token" in f or "secret" in f or "key" in f} for f in app.get("fields") or []]}
        category = None
    provider = _oauth_provider(kind)
    return {
        "kind": kind, "label": app.get("label") or (new or {}).get("label") or kind, **base,
        "category": category, "oauth_provider": provider, "oauth_ready": app_oauth.configured(provider),
        "discover": bool((new or {}).get("discover")),
        "default_interval": synced_sources.DEFAULT_INTERVAL.get(kind, "1h"),
        "intervals": list(synced_sources.SYNC_INTERVALS),
        "suggested_space": spaces_service.suggest_space(kind),
    }


@router.get("")
def list_apps(user: models.User = Depends(get_current_user)):
    return [_help_entry(k) for k in synced_sources.APPS]


@router.get("/catalog")
def catalog(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    have = {r[0] for r in db.query(models.DataSource.kind)
            .filter(workspace_access.datasource_access_filter(db, user)).distinct().all()}
    new_help = _new_help()
    out = []
    for cat, cid, label, mono, color, ink, summary, connects, ring in _CATALOG:
        kind, flow = None, "request"
        if connects and connects.startswith("app:"):
            app_kind = connects.split(":", 1)[1]
            if app_kind in synced_sources.APPS:
                kind, flow = app_kind, connects
        elif connects:
            flow = connects
            kind = connects.split(":", 1)[1] if ":" in connects else None
        kinds = (kind,) if kind else _FLOW_KINDS.get(flow, ())
        if flow == "request":
            status = "next"
        elif any(k in have for k in kinds):
            status = "connected"
        else:
            status = "live"
        provider = None
        if flow.startswith("app:"):
            provider = _oauth_provider(kind)
            auth = "oauth" if provider else "token"
        elif flow == "sheets":
            provider, auth = "google", "oauth"
        elif flow == "request":
            auth = "oauth" if cat in ("social", "ads", "web", "crm", "hr", "product") else "token"
        else:
            auth = "form"
        out.append({
            "id": cid, "slug": cid, "label": label, "category": cat, "summary": summary, "status": status,
            "flow": flow, "kind": kind, "auth": auth, "oauth_provider": provider,
            "oauth_ready": bool(provider) and flow != "request" and app_oauth.configured(provider),
            "is_new": bool(kind and kind in new_help), "monogram": mono, "color": color, "ink": ink, "ring": ring,
            "suggested_space": spaces_service.suggest_space(kind or cid),
        })
    return {"categories": CATALOG_CATEGORIES, "connectors": out}


def _pending_creds(db: Session, user: models.User, pending_id: str | None, kind: str) -> tuple[dict, models.AppAuthPending | None]:
    if not pending_id:
        return {}, None
    try:
        row = app_oauth.get_pending(db, pending_id, user, kind)
        return app_oauth.pending_credentials(row), row
    except app_oauth.OAuthError as e:
        raise HTTPException(400, str(e))


def _clean_creds(kind: str, raw: dict | None) -> dict:
    fields = synced_sources.APPS[kind].get("fields") or []
    return {k: (v.strip() if isinstance(v, str) else v) for k, v in (raw or {}).items()
            if k in fields and v not in (None, "")}


@router.post("/discover")
def discover(payload: DiscoverRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    if payload.kind not in synced_sources.APPS:
        raise HTTPException(400, f"kind must be one of: {', '.join(synced_sources.APPS)}")
    creds, _row = _pending_creds(db, user, payload.pending_id, payload.kind)
    creds.update(_clean_creds(payload.kind, payload.credentials))
    try:
        from ..services import app_connectors
        fn = app_connectors.discover
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "Finding accounts is not available for this app yet.")
    try:
        accounts = fn(payload.kind, creds) or []
    except synced_sources.SyncError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        print(f"[apps] discover failed ({payload.kind}): {type(e).__name__}")
        raise HTTPException(400, f"Could not list the accounts in {synced_sources.APPS[payload.kind]['label']}: {str(e)[:200]}")
    return {"accounts": [{"id": str(a.get("id")), "name": a.get("name") or str(a.get("id")), "detail": a.get("detail")}
                         for a in accounts if isinstance(a, dict) and a.get("id") is not None]}


@router.get("/oauth/{kind}/start")
def oauth_start(kind: str, user: models.User = Depends(get_current_user)):
    provider = _oauth_provider(kind) if kind in synced_sources.APPS else app_oauth.provider_for(kind)
    if not provider:
        raise HTTPException(400, "This app connects with a key, not a sign-in page.")
    if not app_oauth.configured(provider):
        a, b = app_oauth.env_names(provider)
        raise HTTPException(503, f"Sign-in with {app_oauth.PROVIDER_LABELS[provider]} is not set up on this server yet. "
                                 f"An admin needs to set {a} and {b}.")
    try:
        url = app_oauth.authorize_url(kind, user)
    except app_oauth.OAuthError as e:
        raise HTTPException(400, str(e))
    return {"authorize_url": url, "provider": provider, "redirect_uri": app_oauth.redirect_uri(provider)}


@router.get("/oauth/{provider}/callback", include_in_schema=False)
def oauth_callback(provider: str, code: str | None = None, state: str | None = None, error: str | None = None,
                   error_description: str | None = None, db: Session = Depends(get_db)):
    # No login header here: the browser arrives from the provider. The signed
    # state proves which GD360 user started the sign-in.
    kind = app_oauth.kind_from_state(state or "")
    if provider not in app_oauth.PROVIDERS:
        return RedirectResponse(app_oauth.frontend_return(kind, error="Unknown sign-in provider."), status_code=302)
    if error:
        msg = "The sign-in was cancelled." if error == "access_denied" else \
            f"{app_oauth.PROVIDER_LABELS[provider]} said: {(error_description or error)[:200]}"
        return RedirectResponse(app_oauth.frontend_return(kind, error=msg), status_code=302)
    try:
        user_id, kind = app_oauth.read_state(state or "", provider)
        if not db.get(models.User, user_id):
            raise app_oauth.OAuthError("This sign-in link is not valid. Start again from the connect page.")
        tokens = app_oauth.exchange_code(provider, code or "")
        row = app_oauth.store_pending(db, user_id, provider, kind, tokens)
    except app_oauth.OAuthError as e:
        return RedirectResponse(app_oauth.frontend_return(kind, error=str(e)), status_code=302)
    except Exception as e:  # noqa: BLE001
        print(f"[apps] oauth callback failed ({provider}): {type(e).__name__}")
        return RedirectResponse(app_oauth.frontend_return(kind, error="The sign-in could not be finished. Try again."),
                                status_code=302)
    return RedirectResponse(app_oauth.frontend_return(kind, pending_id=row.id), status_code=302)


def _target_spaces(db: Session, user: models.User, payload: ConnectAppRequest) -> list[models.Space]:
    out = []
    for sid in dict.fromkeys(payload.space_ids or []):
        space = spaces_service.get_space(db, user, sid)
        if not space or not spaces_service.can_edit(db, space, user):
            raise HTTPException(400, "One of those Spaces was not found or you can't add sources to it.")
        out.append(space)
    return out


@router.post("", status_code=201)
def connect_app(payload: ConnectAppRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    if payload.kind not in synced_sources.APPS:
        raise HTTPException(400, f"kind must be one of: {', '.join(synced_sources.APPS)}")
    if payload.sync_interval and payload.sync_interval not in synced_sources.SYNC_INTERVALS:
        raise HTTPException(400, f"sync_interval must be one of: {', '.join(synced_sources.SYNC_INTERVALS)}")
    if payload.workspace_id:
        role = workspace_access.member_role(db, user.id, payload.workspace_id)
        if role not in ("owner", "admin", "member"):
            raise HTTPException(403, "You can't add sources to that workspace.")
    # 2026-10-09 (round 15): a sign-in's tokens, then any typed fields (e.g. the
    # Google Ads customer id), then the accounts/pages that were chosen.
    creds, pending = _pending_creds(db, user, payload.pending_id, payload.kind)
    creds.update(_clean_creds(payload.kind, payload.credentials))
    if payload.account_ids is not None:
        ids = [str(a).strip() for a in payload.account_ids if str(a).strip()][:200]
        if not ids:
            raise HTTPException(400, "Choose at least one account to sync.")
        creds["account_ids"] = ids
    targets = _target_spaces(db, user, payload)
    new_space = None
    if payload.new_space is not None:
        nm = (payload.new_space.name or "").strip()
        if not 1 <= len(nm) <= 60:
            raise HTTPException(400, "Give the new Space a name of 1 to 60 characters.")
        color = payload.new_space.color or spaces_service.SPACE_TEMPLATES.get(nm, {}).get("color") or "#C9A7FF"
        if not spaces_service.HEX_COLOR.match(color):
            raise HTTPException(400, "Colour must look like #C9A7FF.")
        new_space = (nm, color.upper())
    try:
        account = synced_sources.APPS[payload.kind]["test"](creds)
    except synced_sources.SyncError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        print(f"[apps] connection test failed ({payload.kind}): {e}")
        raise HTTPException(400, f"Could not reach {synced_sources.APPS[payload.kind]['label']}: {str(e)[:200]}")
    info = {"sync_interval": payload.sync_interval or synced_sources.DEFAULT_INTERVAL.get(payload.kind, "1h"),
            "account_label": str(account)[:120]}
    if payload.history_days:
        info["history_days"] = payload.history_days
    if pending is not None:
        info["signed_in_with"] = pending.provider
    ds = models.DataSource(
        owner_id=user.id, workspace_id=payload.workspace_id, name=payload.name.strip(), kind=payload.kind,
        connection_info=info, encrypted_secret=security.encrypt_secret(json.dumps(creds)), read_only=True,
        schema_cache={}, next_sync_at=datetime.utcnow() + timedelta(minutes=10),
    )
    db.add(ds)
    db.flush()
    space_ids = []
    for space in targets:
        if ds.id not in (space.source_ids or []):
            space.source_ids = [*(space.source_ids or []), ds.id]
            space.updated_at = datetime.utcnow()
        space_ids.append(space.id)
    if new_space:
        tmpl = spaces_service.SPACE_TEMPLATES.get(new_space[0], {})
        created = models.Space(owner_id=user.id, workspace_id=payload.workspace_id, name=new_space[0],
                               color=new_space[1], description=tmpl.get("description"), access="private",
                               member_ids=[], source_ids=[ds.id])
        db.add(created)
        db.flush()
        space_ids.append(created.id)
    if pending is not None:
        db.delete(pending)
    audit.log_audit_event(db, actor=user, action="datasource_connected", workspace_id=ds.workspace_id,
                          target_type="datasource", target_id=ds.id, metadata={"kind": ds.kind})
    db.commit()
    _sync_in_background(ds.id)
    return _status(db, ds) | {"syncing": True, "space_ids": space_ids}


@router.get("/{datasource_id}")
def app_status(datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return _status(db, _app(db, datasource_id, user))


@router.post("/{datasource_id}/sync")
def sync_now(datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ds = _app(db, datasource_id, user, edit=True)
    _sync_in_background(ds.id)
    return _status(db, ds) | {"syncing": True}


@router.patch("/{datasource_id}")
def update_app(datasource_id: str, payload: AppSettingsRequest, db: Session = Depends(get_db),
               user: models.User = Depends(get_current_user)):
    ds = _app(db, datasource_id, user, edit=True)
    if payload.sync_interval not in synced_sources.SYNC_INTERVALS:
        raise HTTPException(400, f"sync_interval must be one of: {', '.join(synced_sources.SYNC_INTERVALS)}")
    ds.connection_info = {**(ds.connection_info or {}), "sync_interval": payload.sync_interval}
    ds.next_sync_at = synced_sources.next_sync_time(ds, ds.last_synced_at or datetime.utcnow())
    db.commit()
    return _status(db, ds)
