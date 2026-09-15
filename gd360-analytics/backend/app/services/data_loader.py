"""
Resolves a DataSource ORM row (+ optional table/collection hint) into an
in-memory pandas DataFrame, decrypting credentials only for the duration
of the request. Nothing here ever writes to the source system.
"""
from __future__ import annotations

import pandas as pd

from .. import models, security
from .connectors import SQLConnector, MongoConnector, FileConnector


class NeedsTableSelection(Exception):
    def __init__(self, available: list[str]):
        self.available = available
        super().__init__("Multiple tables/collections available; please specify one.")


def load_dataframe(ds: models.DataSource, table: str | None = None) -> pd.DataFrame:
    if ds.kind in ("csv", "excel"):
        return FileConnector(ds.file_path).load_dataframe()

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
