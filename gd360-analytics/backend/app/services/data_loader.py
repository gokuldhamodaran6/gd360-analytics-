"""
Resolves a DataSource ORM row (+ optional table/collection hint) into an
in-memory pandas DataFrame, decrypting credentials only for the duration
of the request. Nothing here ever writes to the source system.

Every datasource can also carry an AI-prepared "cleaned" snapshot
(DataSource.cleaned_data), stored as CSV bytes regardless of the source
kind - it is a point-in-time copy the user asked GD360 to clean/prepare,
never a write-back to their real database or file. `version` picks which
copy to load: "original" always loads fresh from the real source,
"cleaned" loads the prepared snapshot (and fails clearly if none exists
yet), and "auto" (the default) prefers the cleaned snapshot when one
exists, otherwise falls back to the original.
"""
from __future__ import annotations

from datetime import datetime

import pandas as pd
from sqlalchemy.orm import Session

from .. import models, security
from .connectors import SQLConnector, MongoConnector, FileConnector


class NeedsTableSelection(Exception):
    def __init__(self, available: list[str]):
        self.available = available
        super().__init__("Multiple tables/collections available; please specify one.")


def dataframe_to_csv_bytes(df: pd.DataFrame) -> bytes:
    return df.to_csv(index=False).encode("utf-8")


def load_dataframe(ds: models.DataSource, table: str | None = None, version: str = "auto") -> pd.DataFrame:
    use_cleaned = version == "cleaned" or (version == "auto" and ds.cleaned_data is not None)
    if version == "original":
        use_cleaned = False

    if use_cleaned:
        if not ds.cleaned_data:
            raise ValueError("This data source does not have a cleaned/prepared version yet.")
        return FileConnector(ds.cleaned_data, ".csv").load_dataframe()

    return _load_original(ds, table)


def _load_original(ds: models.DataSource, table: str | None = None) -> pd.DataFrame:
    if ds.kind in ("csv", "excel"):
        if not ds.file_data:
            raise ValueError(
                "The data for this file is missing - it was uploaded before a storage fix and its "
                "content did not survive a server restart. Please remove this data source and "
                "upload the file again; new uploads are stored permanently and will not be lost."
            )
        ext_hint = ".xlsx" if ds.kind == "excel" else ".csv"
        return FileConnector(ds.file_data, ext_hint).load_dataframe()

    if ds.kind in ("postgres", "mysql"):
        username, password = security.decrypt_secret(ds.encrypted_secret).split("␟")
        info = ds.connection_info
        connector = SQLConnector(ds.kind, info["host"], info["port"], info["database"], username, password, info.get("ssl", True))
        table = table or _pick_single(ds.schema_cache)
        return connector.load_dataframe(table, is_raw_sql=False)

    if ds.kind == "mongodb":
        username, password = security.decrypt_secret(ds.encrypted_secret).split("␟")
        info = ds.connection_info
        connector = MongoConnector(info["host"], info["port"], info["database"], username, password, info.get("ssl", True))
        table = table or _pick_single(ds.schema_cache)
        return connector.load_dataframe(table)

    raise ValueError(f"Unsupported datasource kind: {ds.kind}")


def _pick_single(schema_cache: dict | None) -> str:
    keys = list((schema_cache or {}).keys())
    if len(keys) == 1:
        return keys[0]
    raise NeedsTableSelection(keys)


def load_version_dataframe(version: models.DatasetVersion) -> pd.DataFrame:
    """Loads a specific saved/named snapshot (one of the person tables),
    as opposed to the always-live original data."""
    return FileConnector(version.data, ".csv").load_dataframe()


def ensure_legacy_migrated(db: Session, ds: models.DataSource) -> None:
    """One-time upgrade path: a datasource that was cleaned/prepared before
    named, multi-table history existed has its single old snapshot turned
    into this datasource first named table (Version 1), so nothing already
    prepared is lost when this ships. Safe to call on every request - it
    only does anything the first time, for a datasource that still has the
    old-style snapshot and no saved tables yet."""
    if not ds.cleaned_data:
        return
    already_migrated = (
        db.query(models.DatasetVersion).filter(models.DatasetVersion.datasource_id == ds.id).first()
    )
    if already_migrated:
        return
    version = models.DatasetVersion(
        datasource_id=ds.id,
        name="Version 1",
        parent_version_id=None,
        data=ds.cleaned_data,
        cleaning_log=ds.cleaning_log or [],
        position=1,
        created_at=ds.cleaned_updated_at or datetime.utcnow(),
    )
    db.add(version)
    db.commit()
