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
from collections import defaultdict

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
import requests

from .. import models, schemas, security
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..services.connectors import SQLConnector, MongoConnector, FileConnector, BigQueryConnector
from ..services.data_loader import (
    load_dataframe, load_version_dataframe, ensure_legacy_migrated, warm_cache, default_table_for_preview,
)

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
    # Parse the workbook/CSV exactly once here per sheet (for the schema),
    # instead of once here AND again on whatever the person's first
    # preview/chat turns out to be - for a large file that second,
    # redundant parse was pure waste. A CSV, or an Excel workbook with only
    # one sheet, keeps the original flat schema shape (a single implicit
    # table) exactly as before. A genuinely multi-sheet workbook instead
    # gets one schema entry PER SHEET (see FileConnector.introspect_schema)
    # so every sheet - not just the first - is a pickable table in the
    # WORKING ON selector, the same way a multi-table database already
    # works; every sheet is parsed once, right here, and its DataFrame is
    # handed to warm_cache below so the very first time each one is
    # actually used is instant rather than a fresh parse.
    connector = FileConnector(contents, ext)
    try:
        sheet_names = connector.list_sheet_names()
        if not sheet_names or len(sheet_names) <= 1:
            df = connector.load_dataframe(sheet_name=(sheet_names[0] if sheet_names else 0))
            schema = {"columns": [{"name": c, "type": str(df[c].dtype)} for c in df.columns]}
            sheet_frames = None
        else:
            sheet_frames = {}
            schema = {}
            for sheet in sheet_names[:50]:
                sdf = connector.load_dataframe(sheet_name=sheet)
                sheet_frames[sheet] = sdf
                schema[sheet] = [{"name": c, "type": str(sdf[c].dtype)} for c in sdf.columns]
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
    # Seeds the in-process cache with the parse(s) this request already
    # did, so the very first preview/chat message against this new
    # datasource - commonly the next thing that happens - is instant
    # instead of paying a full re-parse of a possibly large file/sheet. See
    # data_loader.py's cache comment for why this is always safe
    # (ds.file_data never changes).
    if sheet_frames is None:
        warm_cache(ds.id, df)
    else:
        for sheet, sdf in sheet_frames.items():
            warm_cache(ds.id, sdf, table=sheet)
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


def _conversation_id_by_version(db: Session, user: models.User, version_ids: list[str]) -> dict[str, str]:
    """Which conversation's chat prompt actually created each of these
    saved/AI-built tables, keyed by DatasetVersion.id - the same
    Message.new_version_id lookup get_data_flow below already does for the
    Flow tab's lineage map, reused here so the Data tab's own table strip
    (and the chat panel's WORKING ON picker, which reads this same list -
    see Workspace.tsx) can be scoped to "this conversation" by default
    instead of showing every table ever built for this data source, no
    matter which past chat built it. A version with no matching message
    (created before this attribution existed, or the legacy-migration's own
    first version - see ensure_legacy_migrated) is simply absent from the
    returned dict; the caller treats that as "not tied to one chat" and
    always shows it, the same as Original data."""
    if not version_ids:
        return {}
    creator_msgs = (
        db.query(models.Message)
        .join(models.Conversation, models.Message.conversation_id == models.Conversation.id)
        .filter(models.Message.new_version_id.in_(version_ids), models.Conversation.owner_id == user.id)
        .all()
    )
    return {m.new_version_id: m.conversation_id for m in creator_msgs}


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
    conv_by_version = _conversation_id_by_version(db, user, [v.id for v in versions])
    return [
        {
            "id": v.id,
            "name": v.name,
            "parent_version_id": v.parent_version_id,
            "step_count": len(v.cleaning_log or []),
            "created_at": v.created_at,
            "conversation_id": conv_by_version.get(v.id),
        }
        for v in versions
    ]


@router.get("/{datasource_id}/flow")
def get_data_flow(datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Every saved table and every chart/analysis ever built for this data
    source, across every past conversation - the raw material for the
    Flow tab's data-lineage map (frontend components/DataFlowMap.tsx).
    Nothing here is computed fresh: it only reads back what chat.py's
    _persist_and_respond already recorded on each assistant Message
    (Message.sources / Message.new_version_id - see models.py for what
    those hold) and what each DatasetVersion already carries
    (parent_version_id/parent_version_ids), so this stays cheap to call
    even for a data source with a long history."""
    ds = _get_owned_datasource(db, user, datasource_id)
    ensure_legacy_migrated(db, ds)

    versions = (
        db.query(models.DatasetVersion)
        .filter(models.DatasetVersion.datasource_id == ds.id)
        .order_by(models.DatasetVersion.position, models.DatasetVersion.created_at)
        .all()
    )
    version_out = [
        {
            "id": v.id,
            "name": v.name,
            "parent_version_id": v.parent_version_id,
            "parent_version_ids": v.parent_version_ids,
            "step_count": len(v.cleaning_log or []),
            "created_at": v.created_at,
        }
        for v in versions
    ]

    conversations = (
        db.query(models.Conversation)
        .filter(models.Conversation.datasource_id == ds.id, models.Conversation.owner_id == user.id)
        .all()
    )
    if not conversations:
        return {"datasource_id": ds.id, "datasource_name": ds.name, "versions": version_out, "nodes": []}

    conv_by_id = {c.id: c for c in conversations}
    all_msgs = (
        db.query(models.Message)
        .filter(models.Message.conversation_id.in_(list(conv_by_id.keys())))
        .order_by(models.Message.created_at)
        .all()
    )
    # Grouped by conversation, in chronological order, so each assistant
    # turn can find the nearest preceding user turn as its own question
    # text - the same walk-backwards logic Workspace.tsx already does
    # client-side when resuming one conversation, just across all of them
    # here at once.
    by_conv: dict[str, list[models.Message]] = defaultdict(list)
    for m in all_msgs:
        by_conv[m.conversation_id].append(m)

    nodes = []
    for conv_id, msgs in by_conv.items():
        conv = conv_by_id[conv_id]
        last_user_text = ""
        for m in msgs:
            if m.role == "user":
                last_user_text = m.content
                continue
            if m.role != "assistant":
                continue
            # Only a turn that actually produced something belongs on the
            # map - a clarifying question or a plain explain answer has
            # nothing to draw.
            if not m.chart_spec and not m.new_version_id:
                continue
            nodes.append({
                "message_id": m.id,
                "conversation_id": conv_id,
                "conversation_title": conv.title,
                "prompt": last_user_text,
                "action": m.action,
                "chart_type": m.chart_type,
                "has_chart": bool(m.chart_spec),
                "created_at": m.created_at,
                "sources": m.sources,
                "new_version_id": m.new_version_id,
            })

    return {"datasource_id": ds.id, "datasource_name": ds.name, "versions": version_out, "nodes": nodes}


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


def _column_stats(df: pd.DataFrame) -> dict:
    """Per-column aggregates for the Data tab's Totals row - computed once,
    server-side, over the full already-loaded/filtered/sorted `df` (before
    it gets sliced down to just the current page below), so switching pages
    never changes what a total reads and a filter narrows it exactly the
    way it narrows the rows themselves. A numeric column gets the usual
    sum/mean/min/max on top of the count every column gets; anything else
    (text, dates, booleans) gets a distinct-value count instead, since sum/
    mean have no meaning there - the frontend's per-column picker only ever
    offers the aggregates that are actually present here."""
    stats: dict = {}
    for col in df.columns:
        s = df[col]
        non_null = int(s.notna().sum())
        entry: dict = {
            "count": int(len(s)), "non_null": non_null,
            "sum": None, "mean": None, "min": None, "max": None, "distinct": None,
        }
        if pd.api.types.is_bool_dtype(s):
            entry["distinct"] = int(s.nunique(dropna=True))
        elif pd.api.types.is_numeric_dtype(s):
            if non_null:
                numeric = pd.to_numeric(s, errors="coerce")
                entry["sum"] = float(numeric.sum())
                entry["mean"] = float(numeric.mean())
                entry["min"] = float(numeric.min())
                entry["max"] = float(numeric.max())
        else:
            try:
                entry["distinct"] = int(s.nunique(dropna=True))
            except Exception:
                entry["distinct"] = None
            if non_null:
                try:
                    entry["min"] = str(s.dropna().min())
                    entry["max"] = str(s.dropna().max())
                except Exception:
                    pass
        stats[str(col)] = entry
    return stats


@router.get("/{datasource_id}/preview")
def preview_datasource(
    datasource_id: str,
    version_id: str | None = None,
    table: str | None = None,
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
        # `table` (new) is the Data tab's own per-table/per-sheet tab strip
        # asking for one specific original table by name - the same
        # mechanism the chat WORKING ON picker already uses (see
        # data_loader.load_dataframe). Left unset, a multi-table datasource
        # (see data_loader.default_table_for_preview) always defaults to its
        # first table/sheet here rather than raising - there is no
        # back-and-forth in a page view to ask "which one?" through, so this
        # never dead-ends the way an ambiguous WORKING ON chat selection
        # would.
        df = (
            load_version_dataframe(active_version)
            if active_version
            else load_dataframe(
                ds, table=table or default_table_for_preview(ds), version="original",
                row_limit=settings.PREVIEW_ROW_LIMIT,
            )
        )
    except Exception as e:
        raise HTTPException(400, f"Could not load data: {e}")

    # How many rows actually got loaded before any filter/sort - used just
    # below to tell a Totals row honestly whether it's summing the WHOLE
    # table or only however much of a big live-connector table
    # PREVIEW_ROW_LIMIT allowed in (a CSV/Excel upload never hits this,
    # since its full file is already in memory - see data_loader.py).
    loaded_row_count = len(df)

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
    column_stats = _column_stats(df)
    # Only a live-connector datasource (Postgres/MySQL/SQL Server/Supabase/
    # MongoDB/BigQuery) can actually be short of its own true row count -
    # see data_loader.py's row_limit plumbing. loaded_row_count hitting the
    # cap exactly is the only signal available without a separate COUNT(*)
    # query against the real source; a CSV/Excel upload's full file is
    # always already in memory, so it is never capped here.
    stats_capped = ds.kind not in ("csv", "excel") and loaded_row_count >= settings.PREVIEW_ROW_LIMIT
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
        "column_stats": column_stats,
        "stats_capped": stats_capped,
    }


@router.get("/{datasource_id}/export")
def export_datasource(
    datasource_id: str,
    version_id: str | None = None,
    table: str | None = None,
    export_format: str = "csv",
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ds = _get_owned_datasource(db, user, datasource_id)
    ensure_legacy_migrated(db, ds)

    active_version = _get_owned_version(db, ds, version_id) if version_id else None
    try:
        df = (
            load_version_dataframe(active_version)
            if active_version
            else load_dataframe(ds, table=table or default_table_for_preview(ds), version="original")
        )
    except Exception as e:
        raise HTTPException(400, f"Could not load data: {e}")

    buf = io.BytesIO()
    safe_name = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in ds.name) or "data"
    label = (
        "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in active_version.name)
        if active_version
        else "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in table) if table else "original"
    )

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
