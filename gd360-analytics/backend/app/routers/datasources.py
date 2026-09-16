"""
Datasource management: connect a database (Postgres/MySQL/MongoDB) or
upload a file (CSV/Excel). Credentials are encrypted before storage and
never returned to the client after creation. Every connection is tested
and introspected (read-only) before being saved.

Also exposes the data-preparation surface: a paginated table preview of the
original data or any saved/named table, listing/renaming/deleting those
saved tables, and a download/export of any of them as CSV or Excel.
"""
import io
import json
import os

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .. import models, schemas, security
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..services.connectors import SQLConnector, MongoConnector, FileConnector
from ..services.data_loader import load_dataframe, load_version_dataframe, ensure_legacy_migrated

router = APIRouter(prefix="/datasources", tags=["datasources"])
settings = get_settings()


@router.get("", response_model=list[schemas.DataSourceOut])
def list_datasources(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return db.query(models.DataSource).filter(models.DataSource.owner_id == user.id).all()


@router.post("/database", response_model=schemas.DataSourceOut, status_code=201)
def connect_database(
    payload: schemas.DataSourceCreateDB,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    if payload.kind not in ("postgres", "mysql", "mongodb"):
        raise HTTPException(400, "kind must be one of: postgres, mysql, mongodb")

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
