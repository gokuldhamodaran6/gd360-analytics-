"""
Datasource management: connect a database (Postgres/MySQL/MongoDB) or
upload a file (CSV/Excel). Credentials are encrypted before storage and
never returned to the client after creation. Every connection is tested
and introspected (read-only) before being saved.
"""
import os

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session

from .. import models, schemas, security
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..services.connectors import SQLConnector, MongoConnector, FileConnector

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


@router.delete("/{datasource_id}", status_code=204)
def delete_datasource(datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ds = _get_owned_datasource(db, user, datasource_id)
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
