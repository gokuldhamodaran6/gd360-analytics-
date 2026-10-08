"""
Connecting synced apps (2026-10-08, round 11): Shopify, Google Analytics 4,
Meta Ads and Google Ads. See services/synced_sources.py for how their
records are copied and queried.

  GET   /apps                       the apps that can be connected, and what each needs
  POST  /apps                       connect one (credentials are tested first)
  POST  /apps/{datasource_id}/sync  copy its records now
  GET   /apps/{datasource_id}       its sync status and tables
  PATCH /apps/{datasource_id}       how often it syncs
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models, security
from ..database import SessionLocal, get_db
from ..deps import get_current_user
from ..services import audit, synced_sources, workspace_access

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


class ConnectAppRequest(BaseModel):
    kind: str
    name: str = Field(min_length=1, max_length=120)
    credentials: dict
    sync_interval: str | None = None
    history_days: int | None = Field(default=None, ge=7, le=1100)
    workspace_id: str | None = None


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
                synced_sources.sync_datasource(db, ds)
        except Exception as e:  # noqa: BLE001
            print(f"[apps] background sync failed for {datasource_id}: {e}")
        finally:
            db.close()
            _SYNCING.discard(datasource_id)

    threading.Thread(target=job, daemon=True, name=f"sync-{datasource_id[:8]}").start()


@router.get("")
def list_apps(user: models.User = Depends(get_current_user)):
    return [
        {"kind": k, "label": synced_sources.APPS[k]["label"], **HELP[k],
         "default_interval": synced_sources.DEFAULT_INTERVAL[k], "intervals": list(synced_sources.SYNC_INTERVALS)}
        for k in synced_sources.SYNCED_KINDS
    ]


@router.post("", status_code=201)
def connect_app(payload: ConnectAppRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    if payload.kind not in synced_sources.APPS:
        raise HTTPException(400, f"kind must be one of: {', '.join(synced_sources.SYNCED_KINDS)}")
    if payload.sync_interval and payload.sync_interval not in synced_sources.SYNC_INTERVALS:
        raise HTTPException(400, f"sync_interval must be one of: {', '.join(synced_sources.SYNC_INTERVALS)}")
    creds = {k: (v.strip() if isinstance(v, str) else v) for k, v in (payload.credentials or {}).items()
             if k in synced_sources.APPS[payload.kind]["fields"] and v not in (None, "")}
    if payload.workspace_id:
        role = workspace_access.member_role(db, user.id, payload.workspace_id)
        if role not in ("owner", "member"):
            raise HTTPException(403, "You can't add sources to that workspace.")
    try:
        account = synced_sources.APPS[payload.kind]["test"](creds)
    except synced_sources.SyncError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        print(f"[apps] connection test failed ({payload.kind}): {e}")
        raise HTTPException(400, f"Could not reach {synced_sources.APPS[payload.kind]['label']}: {str(e)[:200]}")
    info = {"sync_interval": payload.sync_interval or synced_sources.DEFAULT_INTERVAL[payload.kind],
            "account_label": str(account)[:120]}
    if payload.history_days:
        info["history_days"] = payload.history_days
    ds = models.DataSource(
        owner_id=user.id, workspace_id=payload.workspace_id, name=payload.name.strip(), kind=payload.kind,
        connection_info=info, encrypted_secret=security.encrypt_secret(json.dumps(creds)), read_only=True,
        schema_cache={}, next_sync_at=datetime.utcnow() + timedelta(minutes=10),
    )
    db.add(ds)
    db.flush()
    audit.log_audit_event(db, actor=user, action="datasource_connected", workspace_id=ds.workspace_id,
                          target_type="datasource", target_id=ds.id, metadata={"kind": ds.kind})
    db.commit()
    _sync_in_background(ds.id)
    return _status(db, ds) | {"syncing": True}


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
