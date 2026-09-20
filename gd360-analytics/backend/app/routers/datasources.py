"""
Datasource management: connect a database (Postgres/MySQL/SQL Server/
MongoDB/Supabase), a data warehouse (BigQuery), or upload a file
(CSV/Excel). Credentials are encrypted before storage and never returned
to the client after creation. Every connection is tested and introspected
(read-only) before being saved.

Also exposes the data-preparation surface: a paginated table preview of the
original data or any saved/named table, listing/renaming/deleting those
saved tables, and a download/export of any of them as CSV or Excel.
"""
import io
import json
import os
import time

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
import requests

from .. import models, schemas, security
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..services.connectors import SQLConnector, MongoConnector, FileConnector, BigQueryConnector
from ..services.data_loader import load_dataframe, load_version_dataframe, ensure_legacy_migrated

router = APIRouter(prefix="/datasources", tags=["datasources"])
settings = get_settings()

# How long a detected outbound IP address stays cached before being
# re-checked, in seconds. Render (our hosting provider) shares outbound IP
# addresses across every service in a region and does not publish a fixed,
# documented list anywhere an app can read programmatically - the only way
# to hand a person accurate addresses to whitelist on their own managed
# database is to genuinely observe, right now, what this exact server's
# real outbound connections look like from the outside. See
# get_outbound_ips below.
_OUTBOUND_IP_CACHE_SECONDS = 21600  # 6 hours
_outbound_ip_cache: dict = {"ips": set(), "checked_at": 0.0}


def _probe_outbound_ips(attempts_per_service: int = 2, timeout: float = 4.0) -> set[str]:
    """Makes a handful of real outbound HTTP calls from this exact running
    server to three independent public "what's my IP" services, and returns
    every distinct source address seen. Several services (not one) so any
    single one being briefly down never blanks the result, and more than
    one attempt per service so that if the hosting provider's outbound NAT
    round-robins new connections across more than one address, repeat
    calls have a real chance of surfacing each of them - this is never a
    guess or a hardcoded number, only what was actually observed."""
    seen: set[str] = set()
    for _ in range(attempts_per_service):
        try:
            resp = requests.get("https://api.ipify.org?format=json", timeout=timeout)
            resp.raise_for_status()
            ip = (resp.json() or {}).get("ip")
            if ip:
                seen.add(ip)
        except Exception as e:
            print(f"[datasources] outbound IP probe (ipify) failed: {e}")
    for _ in range(attempts_per_service):
        try:
            resp = requests.get("https://ifconfig.me/ip", timeout=timeout)
            resp.raise_for_status()
            ip = resp.text.strip()
            if ip:
                seen.add(ip)
        except Exception as e:
            print(f"[datasources] outbound IP probe (ifconfig.me) failed: {e}")
    for _ in range(attempts_per_service):
        try:
            resp = requests.get("https://checkip.amazonaws.com", timeout=timeout)
            resp.raise_for_status()
            ip = resp.text.strip()
            if ip:
                seen.add(ip)
        except Exception as e:
            print(f"[datasources] outbound IP probe (checkip.amazonaws.com) failed: {e}")
    return seen


@router.get("/network/outbound-ips")
def get_outbound_ips(refresh: bool = False):
    """Real, currently-observed outbound IP address(es) this server uses
    when IT connects OUT to a database - not the person's own IP. Several
    managed databases (AWS RDS, GCP Cloud SQL, MongoDB Atlas, and similar)
    only accept incoming connections from an allowed list of IP addresses,
    so someone connecting one of those needs to add these to its
    firewall/allow-list before GD360 can reach it. Powers the "Show IPs to
    whitelist" panel in the connect-a-database form.

    Deliberately NOT behind get_current_user, unlike every other route in
    this file: the answer is the same fact for every caller (this server's
    own address, never anything about a particular person or their data),
    so there is nothing to protect by requiring login - and leaving it open
    is also what lets this be checked directly (e.g. with curl) to confirm
    it is correct without needing to be signed in first.

    Cached in memory for _OUTBOUND_IP_CACHE_SECONDS so repeat clicks do not
    re-probe every time; refresh=true forces a fresh check on demand (the
    UI's "Refresh" action). The cached set only ever grows within a cache
    window - a probe that (transiently) finds fewer addresses than before
    never makes a previously-confirmed-real one disappear.
    """
    now = time.time()
    is_stale = now - _outbound_ip_cache["checked_at"] > _OUTBOUND_IP_CACHE_SECONDS
    if refresh or is_stale or not _outbound_ip_cache["ips"]:
        newly_seen = _probe_outbound_ips()
        if newly_seen:
            _outbound_ip_cache["ips"] = _outbound_ip_cache["ips"] | newly_seen
            _outbound_ip_cache["checked_at"] = now

    return {
        "ips": sorted(_outbound_ip_cache["ips"]),
        "checked_at": _outbound_ip_cache["checked_at"] or None,
    }


@router.get("", response_model=list[schemas.DataSourceOut])
def list_datasources(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return db.query(models.DataSource).filter(models.DataSource.owner_id == user.id).all()


@router.post("/database", response_model=schemas.DataSourceOut, status_code=201)
def connect_database(
    payload: schemas.DataSourceCreateDB,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    if payload.kind not in ("postgres", "mysql", "mongodb", "sqlserver", "supabase"):
        raise HTTPException(400, "kind must be one of: postgres, mysql, mongodb, sqlserver, supabase")

    try:
        if payload.kind == "mongodb":
            connector = MongoConnector(payload.host, payload.port, payload.database, payload.username, payload.password, payload.ssl)
        else:
            connector = SQLConnector(payload.kind, payload.host, payload.port, payload.database, payload.username, payload.password, payload.ssl)
        connector.test_connection()
        schema = connector.introspect_schema()
    except Exception as e:
        raise HTTPException(400, f"Could not connect: {e}")

    secret_blob = f"{payload.username}␟{payload.password}"
    ds = models.DataSource(
        owner_id=user.id,
        name=payload.name,
        kind=payload.kind,
        connection_info={
            "host": payload.host, "port": payload.port,
            "database": payload.database, "ssl": payload.ssl,
        },
        encrypted_secret=security.encrypt_secret(secret_blob),
        read_only=True,
        schema_cache=schema,
    )
    db.add(ds)
    db.commit()
    db.refresh(ds)
    return ds


@router.post("/warehouse", response_model=schemas.DataSourceOut, status_code=201)
def connect_warehouse(
    payload: schemas.DataSourceCreateWarehouse,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Connects a data warehouse - BigQuery today, more can be added later
    the same way this app's other connectors were: a new kind here, a new
    class in services/connectors.py, and a matching branch in
    services/data_loader.py, without touching anything else. Authenticates
    with a pasted service-account key rather than host/port/username/
    password, so it is a separate endpoint and request shape from
    /datasources/database above, not a variant of it."""
    if payload.kind not in ("bigquery",):
        raise HTTPException(400, "kind must be one of: bigquery")

    try:
        connector = BigQueryConnector(payload.project_id, payload.dataset_id, payload.service_account_json)
        connector.test_connection()
        schema = connector.introspect_schema()
    except Exception as e:
        raise HTTPException(400, f"Could not connect: {e}")

    ds = models.DataSource(
        owner_id=user.id,
        name=payload.name,
        kind=payload.kind,
        connection_info={"project_id": payload.project_id, "dataset_id": payload.dataset_id},
        # The whole service-account key JSON is the secret here - there is
        # no separate username/password to join with the "␟" delimiter the
        # way connect_database does above.
        encrypted_secret=security.encrypt_secret(payload.service_account_json),
        read_only=True,
        schema_cache=schema,
    )
    db.add(ds)
    db.commit()
    db.refresh(ds)
    return ds


@router.post("/file", response_model=schemas.DataSourceOut, status_code=201)
async def upload_file(
    name: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in (".csv", ".xlsx", ".xls"):
        raise HTTPException(400, "Only .csv, .xlsx, .xls files are supported.")

    contents = await file.read()
    if len(contents) > settings.MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(400, f"File too large. Max {settings.MAX_UPLOAD_MB}MB.")

    kind = "excel" if ext in (".xlsx", ".xls") else "csv"
    try:
        schema = FileConnector(contents, ext).introspect_schema()
    except Exception as e:
        raise HTTPException(400, f"Could not read file: {e}")

    ds = models.DataSource(
        owner_id=user.id,
        name=name,
        kind=kind,
        connection_info={"original_filename": file.filename},
        file_data=contents,
        read_only=True,
        schema_cache=schema,
    )
    db.add(ds)
    db.commit()
    db.refresh(ds)
    return ds


@router.patch("/{datasource_id}")
def rename_datasource(
    datasource_id: str,
    payload: schemas.RenameDataSourceRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Renames a connected data source - the name shown as "Analyzing:
    <name>" at the top of its Workspace page, on its card on the homepage,
    and everywhere else this data source is listed. Nothing about the
    underlying connection, credentials, or saved tables changes - this is
    a display name only, same shape of response as the saved-table rename
    right above (just {id, name}) rather than the full connection record."""
    ds = _get_owned_datasource(db, user, datasource_id)
    name = payload.name.strip()[:120]
    if name:
        ds.name = name
    db.commit()
    return {"id": ds.id, "name": ds.name}


@router.get("/{datasource_id}/schema")
def get_schema(datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ds = _get_owned_datasource(db, user, datasource_id)
    return ds.schema_cache or {}


@router.get("/{datasource_id}/versions")
def list_versions(datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ds = _get_owned_datasource(db, user, datasource_id)
    ensure_legacy_migrated(db, ds)
    versions = (
        db.query(models.DatasetVersion)
        .filter(models.DatasetVersion.datasource_id == ds.id)
        .order_by(models.DatasetVersion.position, models.DatasetVersion.created_at)
        .all()
    )
    return [
        {
            "id": v.id,
            "name": v.name,
            "parent_version_id": v.parent_version_id,
            "step_count": len(v.cleaning_log or []),
            "created_at": v.created_at,
        }
        for v in versions
    ]


@router.patch("/{datasource_id}/versions/{version_id}")
def rename_version(
    datasource_id: str,
    version_id: str,
    payload: schemas.RenameVersionRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ds = _get_owned_datasource(db, user, datasource_id)
    v = _get_owned_version(db, ds, version_id)
    v.name = payload.name.strip()[:80] or v.name
    db.commit()
    return {"id": v.id, "name": v.name}


@router.delete("/{datasource_id}/versions/{version_id}", status_code=204)
def delete_version(
    datasource_id: str, version_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    ds = _get_owned_datasource(db, user, datasource_id)
    v = _get_owned_version(db, ds, version_id)
    # A table can now be built from more than one source table at once, so
    # checking "does anything depend on this?" means scanning the full
    # source list on every other table, not just a single parent field.
    other_versions = (
        db.query(models.DatasetVersion)
        .filter(models.DatasetVersion.datasource_id == ds.id, models.DatasetVersion.id != v.id)
        .all()
    )
    has_children = any(v.id in (child.parent_version_ids or []) for child in other_versions)
    if has_children:
        raise HTTPException(400, "Delete the newer tables built from this one first.")
    db.delete(v)
    db.commit()
    return None


@router.get("/{datasource_id}/preview")
def preview_datasource(
    datasource_id: str,
    version_id: str | None = None,
    limit: int = 50,
    offset: int = 0,
    sort_by: str | None = None,
    sort_dir: str = "asc",
    filters: str | None = None,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ds = _get_owned_datasource(db, user, datasource_id)
    ensure_legacy_migrated(db, ds)

    active_version = _get_owned_version(db, ds, version_id) if version_id else None
    try:
        df = load_version_dataframe(active_version) if active_version else load_dataframe(ds, version="original")
    except Exception as e:
        raise HTTPException(400, f"Could not load data: {e}")

    # Per-column text filter, applied before pagination so it always
    # searches the full dataset, not just whatever page happens to be
    # showing. A simple case-insensitive "contains" match reads naturally
    # for both text and numbers (typing "39" finds 39 and 39.5 alike).
    if filters:
        try:
            filter_map = json.loads(filters)
        except Exception:
            filter_map = {}
        for col, needle in (filter_map or {}).items():
            if col in df.columns and needle not in (None, ""):
                df = df[df[col].astype(str).str.contains(str(needle), case=False, na=False, regex=False)]

    # Column sort, also applied before pagination for the same reason -
    # sorting only the current page would look broken to the person using it.
    if sort_by and sort_by in df.columns:
        df = df.sort_values(by=sort_by, ascending=(sort_dir != "desc"), na_position="last", kind="mergesort")

    total_rows = int(len(df))
    limit = max(1, min(limit, 5000))
    offset = max(0, offset)
    page = df.iloc[offset: offset + limit]
    rows = json.loads(page.to_json(orient="records"))

    return {
        "columns": [str(c) for c in df.columns],
        "dtypes": {str(c): str(df[c].dtype) for c in df.columns},
        "rows": rows,
        "total_rows": total_rows,
        "offset": offset,
        "limit": limit,
        "version_id": active_version.id if active_version else None,
        "version_name": active_version.name if active_version else "Original data",
        "cleaning_log": (active_version.cleaning_log if active_version else None) or [],
    }


@router.get("/{datasource_id}/export")
def export_datasource(
    datasource_id: str,
    version_id: str | None = None,
    export_format: str = "csv",
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ds = _get_owned_datasource(db, user, datasource_id)
    ensure_legacy_migrated(db, ds)

    active_version = _get_owned_version(db, ds, version_id) if version_id else None
    try:
        df = load_version_dataframe(active_version) if active_version else load_dataframe(ds, version="original")
    except Exception as e:
        raise HTTPException(400, f"Could not load data: {e}")

    buf = io.BytesIO()
    safe_name = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in ds.name) or "data"
    label = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in active_version.name) if active_version else "original"

    if export_format == "xlsx":
        df.to_excel(buf, index=False, engine="openpyxl")
        media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        filename = f"{safe_name}_{label}.xlsx"
    else:
        buf.write(df.to_csv(index=False).encode("utf-8"))
        media_type = "text/csv"
        filename = f"{safe_name}_{label}.csv"

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename=\"{filename}\""},
    )


@router.delete("/{datasource_id}", status_code=204)
def delete_datasource(datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ds = _get_owned_datasource(db, user, datasource_id)
    # Past conversations may reference this data source. Keep the chat
    # history (it is still useful on its own) but detach it from the data
    # source that is about to be removed, otherwise the database correctly
    # refuses the delete to avoid orphaning those records.
    db.query(models.Conversation).filter(models.Conversation.datasource_id == datasource_id).update(
        {models.Conversation.datasource_id: None}
    )
    # Goku conversation history only ever makes sense grounded in this
    # exact data source columns/profile - unlike the main chat above, it
    # has nothing useful to say once the data it was about is gone, so it
    # is deleted outright here instead of detached.
    db.query(models.GokuMessage).filter(models.GokuMessage.datasource_id == datasource_id).delete()
    db.delete(ds)
    db.commit()
    return None


def _get_owned_datasource(db: Session, user: models.User, datasource_id: str) -> models.DataSource:
    ds = db.query(models.DataSource).filter(
        models.DataSource.id == datasource_id, models.DataSource.owner_id == user.id
    ).first()
    if not ds:
        raise HTTPException(404, "Datasource not found.")
    return ds


def _get_owned_version(db: Session, ds: models.DataSource, version_id: str) -> models.DatasetVersion:
    v = db.query(models.DatasetVersion).filter(
        models.DatasetVersion.id == version_id, models.DatasetVersion.datasource_id == ds.id
    ).first()
    if not v:
        raise HTTPException(404, "That saved table no longer exists.")
    return v
