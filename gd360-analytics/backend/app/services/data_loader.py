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

import threading
from collections import OrderedDict
from datetime import datetime

import pandas as pd
from sqlalchemy.orm import Session

from .. import models, security
from .connectors import SQLConnector, MongoConnector, FileConnector, BigQueryConnector


class NeedsTableSelection(Exception):
    def __init__(self, available: list[str]):
        self.available = available
        super().__init__("Multiple tables/collections available; please specify one.")


# In-process cache of already-parsed DataFrames, keyed by a stable id for
# each of the three genuinely immutable, write-once blobs this app ever
# turns into a DataFrame: an uploaded file's original bytes
# (DataSource.file_data), a datasource's legacy single cleaned snapshot
# (DataSource.cleaned_data), and a named saved table's snapshot
# (DatasetVersion.data). None of these three columns is ever reassigned
# after the row that holds them is first created (confirmed by grep across
# the backend) - a DataSource's file is fixed at upload time, and every
# cleaning/prep result becomes its OWN new DatasetVersion row rather than
# overwriting an old one - so there is no staleness risk here: once a given
# id's bytes have been parsed once in this process, parsing them again can
# only ever produce the exact same DataFrame.
#
# Why this matters for a large file specifically: every page turn/sort/
# filter in the data table, and every single chat message, re-loads its
# table(s) from scratch (see load_dataframe/load_version_dataframe below).
# Before this cache, a 50,000-row Excel upload meant re-parsing the whole
# workbook - several seconds even with the faster `calamine` engine (see
# connectors.py), openpyxl-scale before it - on every single one of those
# interactions, which is what made a big-file analysis feel like it was
# "stuck" rather than just doing real work. With this cache, that parse
# happens once per process lifetime per id; every later load is a plain
# in-memory `.copy()` (milliseconds, not seconds, even at 50,000+ rows).
#
# A bounded, simple LRU (not a TTL cache - these ids never go stale) keeps
# memory use predictable even if many different datasources/tables get
# touched over a long-running process's lifetime; the oldest-touched entry
# is evicted once the cache is full. `threading.Lock` guards it since
# FastAPI can serve requests on more than one thread even in a single
# worker process.
_DF_CACHE_MAX_ENTRIES = 24
_df_cache: "OrderedDict[str, pd.DataFrame]" = OrderedDict()
_df_cache_lock = threading.Lock()


def _cache_get(key: str) -> pd.DataFrame | None:
    with _df_cache_lock:
        cached = _df_cache.get(key)
        if cached is None:
            return None
        _df_cache.move_to_end(key)
        return cached.copy()


def _cache_put(key: str, df: pd.DataFrame) -> None:
    with _df_cache_lock:
        _df_cache[key] = df
        _df_cache.move_to_end(key)
        while len(_df_cache) > _DF_CACHE_MAX_ENTRIES:
            _df_cache.popitem(last=False)


def _load_and_cache(key: str, loader) -> pd.DataFrame:
    """Returns a cached copy of `key`'s DataFrame if this process has
    already parsed it before; otherwise calls `loader()` once, caches the
    result, and returns a copy of that. Always returns a copy (on both the
    hit and the miss path) so nothing a caller does to the returned frame -
    a sort, a filter, an in-place edit inside AI-generated code - can ever
    corrupt the cached original for the next caller."""
    cached = _cache_get(key)
    if cached is not None:
        return cached
    df = loader()
    _cache_put(key, df)
    return df.copy()


def warm_cache(datasource_id: str, df: pd.DataFrame, table: str | None = None) -> None:
    """Called right after a file upload finishes parsing the workbook once
    for its schema - seeds this same already-parsed DataFrame straight into
    the cache under the same key `_load_original` will look for, so the
    very first preview/chat message against a freshly-uploaded large file
    does not pay a second full parse for data this process already has in
    memory. Safe to skip (a cache miss just parses normally), never
    required for correctness.

    `table` is the sheet name for a multi-sheet Excel upload (see
    upload_file in routers/datasources.py, which parses every sheet once
    for the schema and warms all of them here, not just the first) - None
    for a CSV or single-sheet upload, matching `_load_original`'s own
    "no table means the one implicit sheet" default."""
    _cache_put(f"original:{datasource_id}:{table or ''}", df)


def dataframe_to_csv_bytes(df: pd.DataFrame) -> bytes:
    return df.to_csv(index=False).encode("utf-8")


def purpose_label(prompt: str | None, fallback: str = "Prepared data") -> str:
    """A short, readable label derived from the prompt that produced a
    saved table - the same idea as the chart tabs' own short_chart_label on
    the frontend (see Workspace.tsx), so a table tab reads as what it
    actually is ("Remove duplicate orders", "Group sales by region") instead
    of a bare sequence number like the old "Version 3". The person can
    always overwrite this with their own name via the rename icon on the
    tab - this only decides the starting name."""
    text = " ".join((prompt or "").split())
    if not text:
        return fallback
    return text if len(text) <= 34 else f"{text[:34].rstrip()}…"


def load_dataframe(ds: models.DataSource, table: str | None = None, version: str = "auto") -> pd.DataFrame:
    use_cleaned = version == "cleaned" or (version == "auto" and ds.cleaned_data is not None)
    if version == "original":
        use_cleaned = False

    if use_cleaned:
        if not ds.cleaned_data:
            raise ValueError("This data source does not have a cleaned/prepared version yet.")
        return _load_and_cache(
            f"cleaned:{ds.id}", lambda: FileConnector(ds.cleaned_data, ".csv").load_dataframe()
        )

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
        # A multi-sheet Excel workbook (schema_cache in the new
        # {sheet_name: [...]} shape - see connectors.FileConnector.
        # introspect_schema) needs to know WHICH sheet to load, the same
        # way a multi-table database needs to know which table - reuses
        # the exact same _pick_single/NeedsTableSelection mechanism DB/
        # Mongo/BigQuery already use just below. A CSV, or an Excel upload
        # with only one sheet (old flat {"columns": [...]} schema shape,
        # from before multi-sheet support existed, or a fresh single-sheet
        # upload), has nothing to pick - `sheet` stays None and this loads
        # exactly the one implicit table, exactly as it always did.
        sheet = _excel_sheet_name(table, ds.schema_cache) if ds.kind == "excel" else None
        # This is the hot path for a big uploaded file: every page turn,
        # sort, filter and chat message against the original data lands
        # here. See the cache's own module-level comment above for why this
        # is safe to cache with no invalidation - ds.file_data is fixed at
        # upload time and never changes afterward. The cache key includes
        # the sheet so two different sheets of the same workbook are never
        # confused for each other.
        return _load_and_cache(
            f"original:{ds.id}:{sheet or ''}",
            lambda: FileConnector(ds.file_data, ext_hint).load_dataframe(sheet_name=sheet if sheet else 0),
        )

    if ds.kind in ("postgres", "mysql", "sqlserver", "supabase"):
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

    if ds.kind == "bigquery":
        service_account_json = security.decrypt_secret(ds.encrypted_secret)
        info = ds.connection_info
        connector = BigQueryConnector(info["project_id"], info["dataset_id"], service_account_json)
        table = table or _pick_single(ds.schema_cache)
        return connector.load_dataframe(table, is_raw_sql=False)

    raise ValueError(f"Unsupported datasource kind: {ds.kind}")


def _pick_single(schema_cache: dict | None) -> str:
    keys = list((schema_cache or {}).keys())
    if len(keys) == 1:
        return keys[0]
    raise NeedsTableSelection(keys)


def _is_multi_sheet_schema(schema_cache: dict | None) -> bool:
    """True only for the new per-sheet Excel schema shape (see
    connectors.FileConnector.introspect_schema) - a dict keyed by real
    sheet names. False for the old flat {"columns": [...]} shape (a CSV,
    or an Excel upload from before multi-sheet support / with only one
    sheet), which is a single implicit table, not a dict of sheet names
    that happens to have one entry."""
    keys = list((schema_cache or {}).keys())
    return keys != ["columns"] and len(keys) > 0


def _excel_sheet_name(table: str | None, schema_cache: dict | None) -> str | None:
    """Resolves which sheet an Excel load should use. `table` wins when
    given (an explicit pick, from the WORKING ON selection or a legacy
    clarify-then-retry). Otherwise: a plain flat-schema file (CSV-shaped,
    see _is_multi_sheet_schema) has nothing to pick - returns None, meaning
    "the one implicit sheet", exactly as this always behaved. A genuinely
    multi-sheet workbook with nothing specified raises NeedsTableSelection
    (same contract as _pick_single above) rather than silently guessing
    which sheet was meant - the caller (chat.py) turns that into a
    clarifying question the same way it already does for a multi-table
    database."""
    if table:
        return table
    if not _is_multi_sheet_schema(schema_cache):
        return None
    return _pick_single(schema_cache)


def default_table_for_preview(ds: models.DataSource) -> str | None:
    """The table/sheet a plain "show me this data" view (the Data tab
    preview, and its CSV/Excel export) should default to when nothing more
    specific was asked - always the FIRST table/sheet for any datasource
    with more than one (a multi-sheet Excel workbook, or a multi-table
    Postgres/MySQL/SQL Server/Supabase/MongoDB/BigQuery connection), never a
    clarifying question: unlike a chat prompt, there is no back-and-forth
    here to ask a question through, and defaulting to the first one is
    exactly the same zero-ambiguity behavior a single-table file/database
    already had before multi-table support existed.

    IMPORTANT (bug fixed here, 2026-09-21): this used to only apply to
    ds.kind == "excel", so opening the Data tab (or exporting) on a
    multi-table SQL/Mongo/BigQuery datasource with nothing explicitly
    selected fell straight through to _pick_single raising
    NeedsTableSelection, which the preview/export endpoints only ever catch
    generically - the person just saw a raw "Could not load data: Multiple
    tables/collections available; please specify one." error instead of any
    data at all. _is_multi_sheet_schema's underlying check (a dict keyed by
    real table/sheet names, as opposed to the old flat {"columns": [...]}
    shape) was already completely kind-agnostic - SQL/Mongo/BigQuery's
    schema_cache is shaped exactly the same way a multi-sheet Excel
    workbook's is - so the kind restriction here was the only thing making
    this Excel-only; removing it fixes every multi-table kind uniformly with
    no other change needed. Returns None for anything with only one table
    (nothing to default - the existing single implicit table loads as
    before)."""
    if not _is_multi_sheet_schema(ds.schema_cache):
        return None
    return next(iter((ds.schema_cache or {}).keys()), None)


def load_version_dataframe(version: models.DatasetVersion) -> pd.DataFrame:
    """Loads a specific saved/named snapshot (one of the person tables),
    as opposed to the always-live original data. Cached the same way as the
    original data above - a DatasetVersion's `.data` is set once when the
    row is created and never updated afterward (each new cleaning/prep
    result becomes its own new row instead), so it is just as safe to cache
    with no invalidation, and just as worth it: working through a chain of
    saved tables re-loads whichever one is selected on every chat message
    the same way the original data does."""
    return _load_and_cache(f"version:{version.id}", lambda: FileConnector(version.data, ".csv").load_dataframe())


def ensure_legacy_migrated(db: Session, ds: models.DataSource) -> None:
    """One-time upgrade path: a datasource that was cleaned/prepared before
    named, multi-table history existed has its single old snapshot turned
    into this datasource first named table (Version 1), so nothing already
    prepared is lost when this ships. Safe to call on every request - it
    only does anything the first time, for a datasource that still has the
    old-style snapshot and has not been migrated yet.

    The data table and the tab list both load on first page view, as two
    separate requests that can arrive at the database at almost the same
    moment. To make sure that never creates two duplicate "Version 1"
    tables, the migration is claimed atomically first: `legacy_migrated_at`
    is only ever flipped from NULL by exactly one of those two requests
    (the database serializes the conflicting UPDATEs), and only the request
    that wins the claim goes on to create the version."""
    if not ds.cleaned_data or ds.legacy_migrated_at:
        return

    claimed = (
        db.query(models.DataSource)
        .filter(models.DataSource.id == ds.id, models.DataSource.legacy_migrated_at.is_(None))
        .update({models.DataSource.legacy_migrated_at: datetime.utcnow()})
    )
    if not claimed:
        db.rollback()
        return

    already_migrated = (
        db.query(models.DatasetVersion).filter(models.DatasetVersion.datasource_id == ds.id).first()
    )
    if already_migrated:
        db.commit()
        return

    prior_log = ds.cleaning_log or []
    label = purpose_label(prior_log[-1].get("prompt") if prior_log else None)
    version = models.DatasetVersion(
        datasource_id=ds.id,
        name=label,
        parent_version_id=None,
        parent_version_ids=None,
        data=ds.cleaned_data,
        cleaning_log=prior_log,
        position=1,
        created_at=ds.cleaned_updated_at or datetime.utcnow(),
    )
    db.add(version)
    db.commit()
