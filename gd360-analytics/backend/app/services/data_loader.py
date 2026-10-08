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

import json
import threading
from collections import OrderedDict
from datetime import datetime

import pandas as pd
from sqlalchemy.orm import Session

from .. import models, security
from . import oauth_tokens
from .connectors import (
    SQLConnector, MongoConnector, FileConnector, BigQueryConnector, SnowflakeConnector,
    GoogleSheetsConnector, MicrosoftExcelConnector,
)


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
# A bounded LRU (not a TTL cache - these ids never go stale) keeps memory
# use predictable even if many different datasources/tables get touched
# over a long-running process's lifetime; the oldest-touched entry is
# evicted once the cache is full. `threading.Lock` guards it since FastAPI
# can serve requests on more than one thread even in a single worker
# process.
#
# 2026-10-05 root-cause fix: this was bounded ONLY by entry COUNT
# (_DF_CACHE_MAX_ENTRIES = 24), with no idea how large any entry actually
# was. That is fine for a demo-sized file, but real production evidence
# (server memory graph + the host's own OOM kill, twice, confirmed from
# Render's logs/metrics) showed this process climbing straight past its
# 512MB container limit and getting killed mid-request while a user was
# working with a 119,390-row dataset - 24 cached copies of a dataset that
# size (each cache hit AND the original `_cache_put` miss path both
# `.copy()` a full DataFrame) is enormous, and nothing here ever noticed.
# A dataset's byte footprint, not how many OTHER datasets happen to be
# cached alongside it, is what actually matters for staying under a fixed
# memory ceiling - so this is now bounded by approximate total bytes
# (via `DataFrame.memory_usage(deep=True)`, which prices in the real
# per-cell cost of object/string columns, not just a pointer-sized
# estimate) as the primary limit, with the old entry-count cap kept as a
# cheap secondary safety net against a cache that is all small entries.
# _DF_CACHE_MAX_BYTES is deliberately conservative relative to a 512MB
# host: it leaves headroom for the FastAPI/pandas/numpy process baseline
# AND for the 2-4x-working-copy overhead a single in-flight request's own
# pandas operations (a merge, a group-by, a sandboxed AI transform) need
# on top of whatever is sitting in this cache.
_DF_CACHE_MAX_ENTRIES = 24
_DF_CACHE_MAX_BYTES = 160 * 1024 * 1024  # 160MB
_df_cache: "OrderedDict[str, pd.DataFrame]" = OrderedDict()
_df_cache_bytes: dict[str, int] = {}
_df_cache_total_bytes = 0
_df_cache_lock = threading.Lock()


def _approx_bytes(df: pd.DataFrame) -> int:
    try:
        return int(df.memory_usage(deep=True, index=True).sum())
    except Exception:
        # Pathological/empty frame, or a dtype memory_usage can't walk -
        # never let a sizing failure block caching; just don't count it
        # toward the byte budget (the entry-count cap still applies).
        return 0


def _cache_get(key: str) -> pd.DataFrame | None:
    with _df_cache_lock:
        cached = _df_cache.get(key)
        if cached is None:
            return None
        _df_cache.move_to_end(key)
        return cached.copy()


def _evict_locked() -> None:
    """Must be called with _df_cache_lock held. Evicts oldest-touched
    entries until both the byte budget and the entry-count cap are
    satisfied. A single entry larger than the whole byte budget (a very
    large file) is still kept - it's the one the caller just asked for,
    evicting it immediately would defeat the cache entirely - but it will
    be the only thing left in the cache afterward, which is the correct,
    safe behavior."""
    global _df_cache_total_bytes
    while (
        (_df_cache_total_bytes > _DF_CACHE_MAX_BYTES or len(_df_cache) > _DF_CACHE_MAX_ENTRIES)
        and len(_df_cache) > 1
    ):
        oldest_key, _ = _df_cache.popitem(last=False)
        _df_cache_total_bytes -= _df_cache_bytes.pop(oldest_key, 0)


def _cache_put(key: str, df: pd.DataFrame) -> None:
    global _df_cache_total_bytes
    size = _approx_bytes(df)
    with _df_cache_lock:
        if key in _df_cache:
            _df_cache_total_bytes -= _df_cache_bytes.get(key, 0)
        _df_cache[key] = df
        _df_cache_bytes[key] = size
        _df_cache_total_bytes += size
        _df_cache.move_to_end(key)
        _evict_locked()


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
    "no table means the one implicit sheet" default.

    Also doubles, deliberately, as this cache's ONE way of invalidating a
    stale entry: routers/datasources.py's refresh_api (Phase 2, feature 4)
    is the one place in this whole app that reassigns an existing
    DataSource.file_data after its row was first created - the module
    docstring above describes every OTHER caller of this cache as reading
    from columns that are "write-once" for exactly this reason. refresh_api
    calls this function again, right after overwriting file_data, with the
    freshly-fetched DataFrame - `_cache_put` unconditionally overwrites
    whatever was there under that same key, so the stale pre-refresh
    DataFrame this process may have already cached is replaced in the same
    request, not left to be served again until some unrelated eviction.
    One real limitation this does NOT solve, worth stating plainly rather
    than silently assuming away: if this backend ever runs across more than
    one worker process, only the process that actually handled a given
    refresh call updates ITS OWN cache - any other worker process still
    holding the old DataFrame under this key keeps serving it until that
    entry ages out of its own LRU or that worker restarts. This app has no
    shared cache layer (e.g. Redis) to fix that across processes, and
    today's deployment is a single web process (see services/scheduler.py's
    own module docstring for the same "single process" assumption
    elsewhere in this app) - revisit this the same day a second worker
    process is ever introduced."""
    _cache_put(f"original:{datasource_id}:{table or ''}", df)


def drop_cached_original(datasource_id: str, table: str | None = None) -> None:
    """2026-10-06 (pro local-file Data tab): forgets this process's parsed
    copy of one original table/sheet, so the next load re-reads the stored
    bytes. The ONE caller is routers/datasources.py's re-run-import
    endpoint, which changes HOW the unchanged bytes are read (header row,
    delimiter, type fixes - see services/file_import.py), so the cached
    frame no longer equals what the stored settings produce. Same single-
    process caveat as warm_cache above."""
    global _df_cache_total_bytes
    key = f"original:{datasource_id}:{table or ''}"
    with _df_cache_lock:
        if key in _df_cache:
            _df_cache.pop(key, None)
            _df_cache_total_bytes -= _df_cache_bytes.pop(key, 0)


def file_import_settings_for(ds: models.DataSource, sheet: str | None) -> tuple[dict | None, dict | None]:
    """The import settings + summary a person chose for one sheet of a
    CSV/Excel upload (POST /datasources/{id}/import), or (None, None) when
    the file has only ever been read with pandas' defaults. Stored inside
    DataSource.connection_info ("import_by_sheet", keyed by sheet name,
    "" for a CSV / single-sheet file) - never a new column."""
    info = ds.connection_info or {}
    by_sheet = info.get("import_by_sheet") or {}
    entry = by_sheet.get(sheet or "")
    if not isinstance(entry, dict):
        return None, None
    return entry.get("settings"), entry.get("summary")


def _load_file_original(ds: models.DataSource, ext_hint: str, sheet: str | None) -> pd.DataFrame:
    """One sheet of an uploaded file, exactly as the last import run read
    it: with the chosen settings (header row, delimiter, decimal/thousands,
    trim, skip-empty) and the type fixes that run recorded - so a restart
    of this process rebuilds the SAME frame the person saw, never a fresh
    inference that could drift. A file with no stored settings reads with
    the plain FileConnector exactly as it always did."""
    settings, summary = file_import_settings_for(ds, sheet)
    if not settings:
        return FileConnector(ds.file_data, ext_hint).load_dataframe(sheet_name=sheet if sheet else 0)
    from . import file_import

    filename = (ds.connection_info or {}).get("original_filename") or ("upload" + ext_hint)
    df = file_import.load_with_settings(ds.file_data, filename, {**settings, "sheet": sheet or settings.get("sheet")})
    return file_import.reapply_recorded_fixes(df, summary, settings)


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


def load_dataframe(
    ds: models.DataSource, table: str | None = None, version: str = "auto", row_limit: int | None = None,
    db: Session | None = None,
) -> pd.DataFrame:
    """`row_limit` only matters for a live-connector datasource (Postgres/
    MySQL/SQL Server/Supabase/MongoDB/BigQuery/Google Sheets/Microsoft
    Excel) loading its always-live original data - it overrides
    settings.MAX_ROWS_LOADED_PER_QUERY for just this call (see
    connectors.py), so a caller that only needs a small page (the Data tab
    preview/export - see datasources.py, which passes
    settings.PREVIEW_ROW_LIMIT) doesn't have to pull as many rows into
    memory as a caller doing real AI analysis (chat.py, which leaves this
    None and gets the higher default). Left as None everywhere else,
    matching the old behavior exactly. A CSV/Excel upload or a cleaned/
    saved-table snapshot is unaffected either way - those are already
    bounded at upload/save time, not by this per-query limit.

    `db` is only used for the two OAuth connectors (google_sheets/
    microsoft_excel) - passing the current request's Session lets a
    rotated access token (refreshed just-in-time by oauth_tokens.py) be
    persisted back to this datasource's encrypted_secret immediately,
    instead of every single request re-refreshing it again. Safe to leave
    None (every non-OAuth kind ignores it entirely); an OAuth datasource
    still works with db=None, it just refreshes its token more often than
    it strictly needs to."""
    use_cleaned = version == "cleaned" or (version == "auto" and ds.cleaned_data is not None)
    if version == "original":
        use_cleaned = False

    if use_cleaned:
        if not ds.cleaned_data:
            raise ValueError("This data source does not have a cleaned/prepared version yet.")
        return _load_and_cache(
            f"cleaned:{ds.id}", lambda: FileConnector(ds.cleaned_data, ".csv").load_dataframe()
        )

    return _load_original(ds, table, row_limit, db=db)


def _load_original(
    ds: models.DataSource, table: str | None = None, row_limit: int | None = None, db: Session | None = None,
) -> pd.DataFrame:
    if ds.kind in ("shopify", "ga4", "meta_ads", "google_ads"):
        # 2026-10-08 (round 11): a synced app source - its tables are the
        # Parquet copies services/synced_sources.py keeps (one per table).
        from . import synced_sources
        from ..database import SessionLocal
        own = db is None
        session = SessionLocal() if own else db
        try:
            df = synced_sources.load_table(session, ds.id, table)
        finally:
            if own:
                session.close()
        return df.head(row_limit) if row_limit else df
    if ds.kind in ("csv", "excel", "api"):
        if not ds.file_data:
            raise ValueError(
                "The data for this file is missing - it was uploaded before a storage fix and its "
                "content did not survive a server restart. Please remove this data source and "
                "upload the file again; new uploads are stored permanently and will not be lost."
            )
        # kind == "api" (Phase 2, feature 4): the fetch-from-a-REST-API
        # step only ever happens at connect time or on an explicit manual
        # refresh (see routers/datasources.py connect_api/refresh_api) -
        # the result is flattened and stored as CSV bytes in this SAME
        # file_data column an uploaded CSV/Excel file already uses, so from
        # this point on an "api" source reads through the exact same
        # cached, file-based path as any other upload, with zero special-
        # casing beyond picking ".csv" as its ext_hint here (an API
        # response is never treated as a multi-sheet workbook - sheet
        # stays None below, same as a plain CSV).
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
        # 2026-10-06 (pro local-file Data tab): a CSV/Excel upload that has
        # been re-imported with chosen settings (see _load_file_original)
        # rebuilds that exact frame on a cache miss; everything else (the
        # "api" kind included) reads through the plain FileConnector as
        # before.
        if ds.kind in ("csv", "excel"):
            return _load_and_cache(
                f"original:{ds.id}:{sheet or ''}",
                lambda: _load_file_original(ds, ext_hint, sheet),
            )
        return _load_and_cache(
            f"original:{ds.id}:{sheet or ''}",
            lambda: FileConnector(ds.file_data, ext_hint).load_dataframe(sheet_name=sheet if sheet else 0),
        )

    if ds.kind in ("postgres", "mysql", "sqlserver", "supabase"):
        username, password = security.decrypt_secret(ds.encrypted_secret).split("␟")
        info = ds.connection_info
        connector = SQLConnector(ds.kind, info["host"], info["port"], info["database"], username, password, info.get("ssl", True))
        table = table or _pick_single(ds.schema_cache)
        return connector.load_dataframe(table, is_raw_sql=False, row_limit=row_limit)

    if ds.kind == "mongodb":
        username, password = security.decrypt_secret(ds.encrypted_secret).split("␟")
        info = ds.connection_info
        connector = MongoConnector(info["host"], info["port"], info["database"], username, password, info.get("ssl", True))
        table = table or _pick_single(ds.schema_cache)
        return connector.load_dataframe(table, row_limit=row_limit)

    if ds.kind == "bigquery":
        service_account_json = security.decrypt_secret(ds.encrypted_secret)
        info = ds.connection_info
        connector = BigQueryConnector(info["project_id"], info["dataset_id"], service_account_json)
        table = table or _pick_single(ds.schema_cache)
        return connector.load_dataframe(table, is_raw_sql=False, row_limit=row_limit)

    if ds.kind == "snowflake":
        creds = json.loads(security.decrypt_secret(ds.encrypted_secret))
        info = ds.connection_info
        connector = SnowflakeConnector(
            account=info["account"], warehouse=info["warehouse"], database=info["database"],
            db_schema=info.get("db_schema"), role=info.get("role"),
            username=creds["username"], password=creds["password"],
        )
        table = table or _pick_single(ds.schema_cache)
        return connector.load_dataframe(table, is_raw_sql=False, row_limit=row_limit)

    if ds.kind == "google_sheets":
        access_token = oauth_tokens.get_valid_access_token(ds, db=db)
        info = ds.connection_info
        connector = GoogleSheetsConnector(access_token, info["spreadsheet_id"])
        # A single-tab spreadsheet's schema_cache is the flat {"columns":
        # [...]} shape (see GoogleSheetsConnector.introspect_schema) - the
        # same "nothing to pick" convention as a single-sheet Excel upload,
        # so `table` stays None (meaning "the sheet's own default/first
        # tab") rather than forcing a lookup against a schema_cache that
        # was never keyed by sheet name in the first place.
        sheet = table or (_pick_single(ds.schema_cache) if _is_multi_sheet_schema(ds.schema_cache) else None)
        return connector.load_dataframe(sheet_name=sheet, row_limit=row_limit)

    if ds.kind == "microsoft_excel":
        access_token = oauth_tokens.get_valid_access_token(ds, db=db)
        info = ds.connection_info
        connector = MicrosoftExcelConnector(access_token, info["item_id"], info.get("drive_id"))
        sheet = table or (_pick_single(ds.schema_cache) if _is_multi_sheet_schema(ds.schema_cache) else None)
        return connector.load_dataframe(sheet_name=sheet, row_limit=row_limit)

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


WAREHOUSE_QUERY_SOURCE_KIND = "warehouse_query"

_PROVIDER_LABELS = {
    "bigquery": "BigQuery", "snowflake": "Snowflake", "postgres": "Postgres", "mysql": "MySQL",
    "sqlserver": "SQL Server", "supabase": "Supabase",
}


def is_warehouse_query(version) -> bool:
    """True for a DatasetVersion that is a saved query living in the
    person's warehouse (2026-10-06 "generated data is a saved query"
    layer - see models.DatasetVersion.source_kind): it has NO CSV copy
    inside GD360 (`data` is b"" there, since that column is NOT NULL and
    cannot be relaxed without a migration tool). NULL source_kind means a
    plain file-backed version, exactly as every version before this layer.
    Every reader of a version's rows must check this before touching
    `.data` - load_version_dataframe below does, so a caller that goes
    through it can simply catch the ValueError."""
    if version is None:
        return False
    return getattr(version, "source_kind", None) == WAREHOUSE_QUERY_SOURCE_KIND


class WarehouseQueryHasNoFile(ValueError):
    """Raised by load_version_dataframe for a saved-query version: there
    are no rows to load into pandas, by design."""


def warehouse_no_file_message(version, ds=None) -> str:
    kind = getattr(ds, "kind", None) if ds is not None else None
    if kind is None:
        owner = getattr(version, "datasource", None)
        kind = getattr(owner, "kind", None)
    provider = _PROVIDER_LABELS.get(kind or "", kind or "data")
    return f"This table is a saved query that lives in your {provider} warehouse; it has no copy inside GD360."


def load_version_dataframe(version: models.DatasetVersion, ds: models.DataSource | None = None) -> pd.DataFrame:
    """Loads a specific saved/named snapshot (one of the person tables),
    as opposed to the always-live original data. Cached the same way as the
    original data above - a DatasetVersion's `.data` is set once when the
    row is created and never updated afterward (each new cleaning/prep
    result becomes its own new row instead), so it is just as safe to cache
    with no invalidation, and just as worth it: working through a chain of
    saved tables re-loads whichever one is selected on every chat message
    the same way the original data does.

    2026-10-06: a warehouse saved-query version (is_warehouse_query) has no
    file - raises WarehouseQueryHasNoFile (a ValueError) with a plain
    message instead of ever parsing its empty `data` into a blank frame.
    Every caller already wraps this in `except Exception -> HTTP 400`
    (routers/chat.py _load_selected_tables, routers/datasources.py
    preview/distinct-values/parse-filter/export), so the person sees that
    sentence, never a 500 or a silent empty table."""
    if is_warehouse_query(version):
        # `ds` (optional) only names the provider in the message; without
        # it the version's own datasource relationship is used.
        raise WarehouseQueryHasNoFile(warehouse_no_file_message(version, ds))
    return _load_and_cache(
        f"version:{version.id}",
        lambda: _restore_datetime_columns(FileConnector(version.data, ".csv").load_dataframe()),
    )


_ISO_DATETIME_RE = r"^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$"


def _restore_datetime_columns(df: pd.DataFrame) -> pd.DataFrame:
    """2026-10-07 (real end-to-end run): a saved table is stored as CSV
    (dataframe_to_csv_bytes), and CSV has no date type - a datetime column
    is written as "2015-01-04" and came back as plain text. So the moment
    a person applied ONE cleaning suggestion to an uploaded file, the new
    version's date column was text again: the Data tab re-offered "Convert
    `Booking Date` from text to date" for a fix the import had already
    made, the date-coverage tile went blank and the column could no longer
    be a dashboard's time axis.

    pandas writes a datetime column in exactly one shape (ISO date, or ISO
    date + time), so a text column where EVERY non-empty value has that
    shape is read back as the datetime it was. Anything else - one stray
    value is enough - is left untouched as text."""
    for col in df.columns:
        s = df[col]
        if s.dtype != object:
            continue
        non_null = s.dropna()
        if non_null.empty or not isinstance(non_null.iloc[0], str):
            continue
        try:
            if not non_null.head(50).str.match(_ISO_DATETIME_RE).all() or not non_null.str.match(_ISO_DATETIME_RE).all():
                continue
            parsed = pd.to_datetime(s, errors="coerce", format="ISO8601")
        except Exception:
            continue
        if int(parsed.notna().sum()) == int(non_null.shape[0]):
            df[col] = parsed
    return df


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
