"""
Datasource management: connect a database (Postgres/MySQL/MongoDB) or
upload a file (CSV/Excel). Credentials are encrypted before storage and
never returned to the client after creation. Every connection is tested
and introspected (read-only) before being saved.

Also exposes the data-preparation surface: a paginated table preview
(original or AI-cleaned), a reset back to the original data, and a
download/export of either version as CSV or Excel.
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
from ..services.data_loader import load_dataframe

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


@router.get("/{datasource_id}/preview")
def preview_datasource(
    datasource_id: str,
    version: str = "auto",
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ds = _get_owned_datasource(db, user, datasource_id)
    try:
        df = load_dataframe(ds, version=version)
    except Exception as e:
        raise HTTPException(400, f"Could not load data: {e}")

    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    page = df.iloc[offset: offset + limit]
    rows = json.loads(page.to_json(orient="records"))

    return {
        "columns": [str(c) for c in df.columns],
        "dtypes": {str(c): str(df[c].dtype) for c in df.columns},
        "rows": rows,
        "total_rows": int(len(df)),
        "offset": offset,
        "limit": limit,
        "has_cleaned_version": bool(ds.cleaned_data),
        "cleaned_updated_at": ds.cleaned_updated_at,
        "cleaning_log": ds.cleaning_log or [],
    }


@router.get("/{datasource_id}/export")
def export_datasource(
    datasource_id: str,
    version: str = "auto",
    export_format: str = "csv",
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    ds = _get_owned_datasource(db, user, datasource_id)
    try:
        df = load_dataframe(ds, version=version)
    except Exception as e:
        raise HTTPException(400, f"Could not load data: {e}")

    buf = io.BytesIO()
    safe_name = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in ds.name) or "data"
    label = "cleaned" if (version == "cleaned" or (version == "auto" and ds.cleaned_data)) else "original"

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


@router.post("/{datasource_id}/reset-cleaning", status_code=204)
def reset_cleaning(datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ds = _get_owned_datasource(db, user, datasource_id)
    ds.cleaned_data = None
    ds.cleaning_log = None
    ds.cleaned_updated_at = None
    db.commit()
    return None


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
