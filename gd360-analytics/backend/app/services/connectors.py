"""
Data connectors.

Design principle: GD360 NEVER writes to a customer source system. Every
connector here only ever reads data, and every raw query path is validated
to be read-only before it touches a real connection. Recommend (in the UI
and README) that users supply a read-only database role/user (or, for
BigQuery, a service account with only the BigQuery Data Viewer + BigQuery
Job User IAM roles) as defense-in-depth on top of this application-level
check.

Supported now: Postgres, MySQL, SQL Server, MongoDB, Supabase (which is
just Postgres under the hood - see _sql_engine_url), CSV, Excel, the
BigQuery data warehouse, and two OAuth "live" connectors - Google Sheets
and Microsoft Excel (OneDrive/SharePoint). The connector interface is
intentionally generic (`load_dataframe`, `introspect_schema`) so new
backends (Snowflake, a generic REST ERP/CRM connector, etc.) can be added
as additional classes without touching the rest of the app -
BigQueryConnector was the first connector to actually exercise that
promise (a service-account JSON key instead of host/port/username/
password); GoogleSheetsConnector/MicrosoftExcelConnector below extend it
again, authenticating with a short-lived OAuth access token instead
(refreshed by services/oauth_tokens.py before either is constructed) and
reading a live spreadsheet/workbook straight over HTTP rather than SQL -
still the exact same `load_dataframe`/`introspect_schema` shape, so
data_loader.py's dispatch and every downstream feature (preview, chat
analysis, exports) needs no special-casing for them.
"""
from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import quote

import pandas as pd
import requests
import sqlparse
from sqlalchemy import create_engine, inspect, text

from ..config import get_settings

settings = get_settings()

FORBIDDEN_SQL_KEYWORDS = {
    "insert", "update", "delete", "drop", "alter", "truncate", "create",
    "grant", "revoke", "merge", "replace", "call", "exec", "execute",
    "into outfile", "load_file", "attach", "detach", "vacuum", "copy",
}


class ReadOnlyViolation(Exception):
    pass


def assert_read_only_sql(raw_sql: str) -> None:
    """Raises ReadOnlyViolation unless raw_sql is a single, plain SELECT."""
    statements = [s for s in sqlparse.parse(raw_sql) if s.token_first(skip_cm=True)]
    if len(statements) != 1:
        raise ReadOnlyViolation("Only a single SELECT statement is allowed.")

    stmt = statements[0]
    stmt_type = stmt.get_type()
    if stmt_type != "SELECT":
        raise ReadOnlyViolation(f"Only SELECT queries are allowed (got {stmt_type}).")

    lowered = raw_sql.lower()
    for kw in FORBIDDEN_SQL_KEYWORDS:
        if re.search(rf"\b{re.escape(kw)}\b", lowered):
            raise ReadOnlyViolation(f"Query contains a forbidden keyword: {kw}.")


def _sql_engine_url(kind: str, host: str, port: int, database: str, username: str, password: str, ssl: bool) -> str:
    from urllib.parse import quote_plus
    user = quote_plus(username)
    pw = quote_plus(password)
    if kind in ("postgres", "supabase"):
        # Supabase's own database IS Postgres - there is no separate
        # "Supabase driver," it just needs its own picker tile so people
        # recognize it by name/logo instead of having to know that fact.
        # One real operational catch worth the person's time, though: a
        # Supabase project's *direct* connection host (db.<ref>.supabase.co)
        # is IPv6-only, and GD360's own servers (Render) have no outbound
        # IPv6 - the exact issue this app's own Supabase-backed database hit
        # during setup (see the build notes). Supabase's *connection
        # pooler* host (aws-0-<region>.pooler.supabase.com, port 6543) is
        # IPv4-reachable, which is why the "supabase" kind's UI defaults the
        # port to 6543 and calls this out - a plain "postgres" connection to
        # some other IPv4-reachable Postgres is unaffected either way.
        url = f"postgresql+psycopg2://{user}:{pw}@{host}:{port}/{database}"
        if ssl:
            url += "?sslmode=require"
        return url
    if kind == "mysql":
        url = f"mysql+pymysql://{user}:{pw}@{host}:{port}/{database}"
        if ssl:
            url += "?ssl_verify_cert=true"
        return url
    if kind == "sqlserver":
        # pymssql (FreeTDS under the hood) rather than pyodbc/pytds - it
        # ships prebuilt manylinux wheels with FreeTDS already bundled, so
        # it installs cleanly on Render's slim Docker image with no extra
        # system packages. Deliberately NOT threading the `ssl` toggle
        # through here the way postgres/mysql do above: pymssql has no
        # simple connection-string flag for it, and most managed SQL Server
        # offerings (Azure SQL among them) require and negotiate encryption
        # on their own regardless of what the client asks for - so rather
        # than wire up a checkbox that would not actually do anything, the
        # UI explains this instead of showing it.
        return f"mssql+pymssql://{user}:{pw}@{host}:{port}/{database}"
    raise ValueError(f"Unsupported SQL kind: {kind}")


class SQLConnector:
    def __init__(self, kind: str, host: str, port: int, database: str, username: str, password: str, ssl: bool = True):
        self.kind = kind
        self.url = _sql_engine_url(kind, host, port, database, username, password, ssl)

    def test_connection(self) -> None:
        engine = create_engine(self.url, pool_pre_ping=True)
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        engine.dispose()

    def introspect_schema(self, max_tables: int = 50) -> dict:
        engine = create_engine(self.url, pool_pre_ping=True)
        insp = inspect(engine)
        schema = {}
        for table_name in insp.get_table_names()[:max_tables]:
            cols = insp.get_columns(table_name)
            schema[table_name] = [{"name": c["name"], "type": str(c["type"])} for c in cols]
        engine.dispose()
        return schema

    def load_dataframe(self, query_or_table: str, is_raw_sql: bool = False, row_limit: int | None = None) -> pd.DataFrame:
        row_limit = row_limit or settings.MAX_ROWS_LOADED_PER_QUERY
        engine = create_engine(self.url, pool_pre_ping=True)
        try:
            if is_raw_sql:
                assert_read_only_sql(query_or_table)
                sql = query_or_table
                if "limit" not in sql.lower():
                    trimmed_sql = sql.rstrip(";")
                    sql = f"SELECT * FROM ({trimmed_sql}) AS gd360_sub LIMIT {row_limit}"
            else:
                # table name only -> safe parameterized identifier quoting via SQLAlchemy inspect
                insp = inspect(engine)
                if query_or_table not in insp.get_table_names():
                    raise ValueError(f"Unknown table: {query_or_table}")
                quoted = engine.dialect.identifier_preparer.quote(query_or_table)
                sql = f"SELECT * FROM {quoted} LIMIT {row_limit}"
            return pd.read_sql(text(sql), engine)
        finally:
            engine.dispose()


class MongoConnector:
    def __init__(self, host: str, port: int, database: str, username: str, password: str, ssl: bool = True):
        self.database = database
        self._uri_parts = (host, port, username, password, ssl)

    def _client(self):
        from pymongo import MongoClient
        host, port, username, password, ssl = self._uri_parts
        from urllib.parse import quote_plus
        auth = f"{quote_plus(username)}:{quote_plus(password)}@" if username else ""
        uri = f"mongodb://{auth}{host}:{port}/{self.database}"
        return MongoClient(uri, tls=ssl, serverSelectionTimeoutMS=8000)

    def test_connection(self) -> None:
        client = self._client()
        client.admin.command("ping")
        client.close()

    def introspect_schema(self, max_collections: int = 50) -> dict:
        client = self._client()
        db = client[self.database]
        schema = {}
        for coll_name in db.list_collection_names()[:max_collections]:
            sample = db[coll_name].find_one()
            schema[coll_name] = sorted(list(sample.keys())) if sample else []
        client.close()
        return schema

    def load_dataframe(self, collection: str, find_filter: dict | None = None, row_limit: int | None = None) -> pd.DataFrame:
        row_limit = row_limit or settings.MAX_ROWS_LOADED_PER_QUERY
        client = self._client()
        try:
            db = client[self.database]
            cursor = db[collection].find(find_filter or {}).limit(row_limit)
            docs = list(cursor)
            for d in docs:
                d.pop("_id", None)
            return pd.DataFrame(docs)
        finally:
            client.close()


class BigQueryConnector:
    """Google BigQuery, GD360's first data-warehouse connector.

    Authenticates completely differently from every SQL connector above -
    a pasted service-account key (JSON), never a host/port/username/
    password - so it is its own class rather than squeezed into
    SQLConnector. Everything else (schema introspection, read-only
    querying, the row-limit/quoting logic) reuses the exact same
    SQLAlchemy machinery via the `sqlalchemy-bigquery` dialect, so this
    connector is held to the same read-only discipline as every other one
    here - only how the engine authenticates is different.
    """

    def __init__(self, project_id: str, dataset_id: str, service_account_json: str):
        self.project_id = project_id
        self.dataset_id = dataset_id
        try:
            self.credentials_info = json.loads(service_account_json)
        except json.JSONDecodeError as e:
            raise ValueError(f"Service account key is not valid JSON: {e}")

    def _engine(self):
        # sqlalchemy-bigquery's dialect takes the project/dataset from the
        # URL path and forwards `credentials_info` straight to its
        # `BigQueryDialect.__init__` as a dict - no temp file on disk
        # needed, unlike the more common `credentials_path` form.
        url = f"bigquery://{self.project_id}/{self.dataset_id}"
        return create_engine(url, credentials_info=self.credentials_info)

    def test_connection(self) -> None:
        engine = self._engine()
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        engine.dispose()

    def introspect_schema(self, max_tables: int = 50) -> dict:
        engine = self._engine()
        insp = inspect(engine)
        schema = {}
        for table_name in insp.get_table_names()[:max_tables]:
            cols = insp.get_columns(table_name)
            schema[table_name] = [{"name": c["name"], "type": str(c["type"])} for c in cols]
        engine.dispose()
        return schema

    def load_dataframe(self, query_or_table: str, is_raw_sql: bool = False, row_limit: int | None = None) -> pd.DataFrame:
        row_limit = row_limit or settings.MAX_ROWS_LOADED_PER_QUERY
        engine = self._engine()
        try:
            if is_raw_sql:
                assert_read_only_sql(query_or_table)
                sql = query_or_table
                if "limit" not in sql.lower():
                    trimmed_sql = sql.rstrip(";")
                    sql = f"SELECT * FROM ({trimmed_sql}) AS gd360_sub LIMIT {row_limit}"
            else:
                insp = inspect(engine)
                if query_or_table not in insp.get_table_names():
                    raise ValueError(f"Unknown table: {query_or_table}")
                quoted = engine.dialect.identifier_preparer.quote(query_or_table)
                sql = f"SELECT * FROM {quoted} LIMIT {row_limit}"
            return pd.read_sql(text(sql), engine)
        finally:
            engine.dispose()


class FileConnector:
    """CSV / Excel uploads. The file bytes are always passed in from the
    database (DataSource.file_data) rather than read from local disk - the
    application server local disk is wiped on every redeploy, so anything
    saved only there would be lost. Keeping this in-memory-only also means
    the data never touches disk at all, which is a nice extra safety property."""

    def __init__(self, file_bytes: bytes, ext_hint: str = ""):
        self.file_bytes = file_bytes
        self.ext_hint = ext_hint.lower()

    def _is_excel(self) -> bool:
        return self.ext_hint.endswith((".xlsx", ".xls"))

    def load_dataframe(self, sheet_name: str | int | None = 0) -> pd.DataFrame:
        import io
        buf = io.BytesIO(self.file_bytes)
        if self._is_excel():
            # `calamine` (via the python-calamine package, a Rust XLSX/XLS
            # parser) is dramatically faster than pandas' default `openpyxl`
            # engine for a large workbook - benchmarked at roughly 6x faster
            # end-to-end on a realistic 50,000-row/11-column sheet (about
            # 0.7s vs 4.1s), with byte-identical dtypes and values, since
            # openpyxl is a pure-Python XML parser and calamine is a
            # compiled Rust one doing the same job. This is the single
            # biggest lever on how long a big-file upload/analysis "feels"
            # slow, since every load of that file (until it is cached - see
            # data_loader.py) pays this parse cost in full. Tried first and
            # falls back to pandas' own default engine selection (still
            # openpyxl under the hood) on ANY failure - a corrupt/unusual
            # workbook calamine cannot parse, or the dependency missing in
            # some environment - so this can only ever make a load faster,
            # never break one that used to work.
            #
            # `sheet_name` is a real sheet NAME (never left as the pandas-
            # special None, which would return every sheet at once as a
            # dict instead of a single DataFrame - see list_sheet_names/
            # data_loader.py for how a specific sheet gets selected) once a
            # workbook has more than one sheet; it stays the default `0`
            # (the first sheet) for a single-sheet workbook or a plain CSV
            # caller, exactly as this always behaved before multi-sheet
            # support existed.
            buf.seek(0)
            try:
                return pd.read_excel(buf, sheet_name=sheet_name, engine="calamine")
            except Exception as e:
                print(f"[connectors] calamine engine failed, falling back to default: {e}")
                buf.seek(0)
                return pd.read_excel(buf, sheet_name=sheet_name)
        return pd.read_csv(buf)

    def list_sheet_names(self) -> list[str] | None:
        """Every sheet name in this workbook, in file order - just the
        table of contents, not a parse of any sheet's actual rows, so this
        stays cheap even for a workbook with a lot of data in each sheet.
        Returns None for a CSV upload, which has no concept of sheets (the
        caller uses that to tell "this is a single-table file" apart from
        "this is a one-sheet workbook", which matter differently for the
        multi-sheet schema shape below)."""
        if not self._is_excel():
            return None
        import io
        buf = io.BytesIO(self.file_bytes)
        try:
            return list(pd.ExcelFile(buf, engine="calamine").sheet_names)
        except Exception as e:
            print(f"[connectors] calamine sheet-name read failed, falling back to default: {e}")
            buf.seek(0)
            return list(pd.ExcelFile(buf).sheet_names)

    def introspect_schema(self, max_sheets: int = 50) -> dict:
        """CSV (and, for backward compatibility, an excel workbook read by
        older code) returns the original flat shape: {"columns": [...]}, a
        single implicit table. A multi-sheet Excel workbook instead returns
        one entry per sheet - {sheet_name: [{"name": c, "type": t}, ...]} -
        the exact same dict-of-table shape SQLConnector/MongoConnector/
        BigQueryConnector already return for a multi-table source, so every
        piece of code that already knows how to offer someone a choice of
        tables (see data_loader._pick_single/NeedsTableSelection, and the
        frontend's getTableEntries) works for a workbook's sheets with no
        special-casing. Capped at max_sheets, matching the same safety cap
        every other multi-table connector already applies."""
        sheet_names = self.list_sheet_names()
        if sheet_names is None or len(sheet_names) <= 1:
            df = self.load_dataframe(sheet_name=(sheet_names[0] if sheet_names else 0))
            return {"columns": [{"name": c, "type": str(df[c].dtype)} for c in df.columns]}
        schema: dict = {}
        for sheet in sheet_names[:max_sheets]:
            df = self.load_dataframe(sheet_name=sheet)
            schema[sheet] = [{"name": c, "type": str(df[c].dtype)} for c in df.columns]
        return schema


def _rows_to_dataframe(rows: list[list]) -> pd.DataFrame:
    """Shared by GoogleSheetsConnector/MicrosoftExcelConnector below: both
    APIs hand back a spreadsheet/worksheet as a plain list-of-lists (the
    first row is the header), never a ready-made table - short rows (a row
    that ran out of trailing blank cells before the widest row did, which
    both Sheets and Excel omit rather than pad) are right-padded with None
    so every row lines up with the header before pandas ever sees it, and a
    completely empty sheet becomes an empty, columnless DataFrame instead of
    raising."""
    if not rows:
        return pd.DataFrame()
    header = [str(h).strip() if h not in (None, "") else f"Column {i + 1}" for i, h in enumerate(rows[0])]
    # Two different blank-named columns would collide once used as a
    # DataFrame's column labels (pandas silently allows duplicate labels,
    # but every downstream feature here - filters, chat, exports - assumes
    # each column name is unique), so a repeat gets a suffix.
    seen: dict[str, int] = {}
    deduped = []
    for h in header:
        if h in seen:
            seen[h] += 1
            deduped.append(f"{h} ({seen[h]})")
        else:
            seen[h] = 0
            deduped.append(h)
    width = len(deduped)
    body = []
    for row in rows[1:]:
        row = list(row)
        if len(row) < width:
            row = row + [None] * (width - len(row))
        elif len(row) > width:
            row = row[:width]
        body.append(row)
    return pd.DataFrame(body, columns=deduped)


class GoogleSheetsConnector:
    """A live Google Sheets connector: every `load_dataframe` call hits the
    Sheets API fresh (no caching layer of its own, same as every other
    live/database connector in this file - see data_loader.py's own
    "no scheduler needed" design note), so an edit made in the real
    spreadsheet shows up in GD360 the next time anyone asks it a question
    or opens the Data tab - no separate sync/refresh step required.

    Authenticates with a short-lived OAuth access token, never a password -
    the caller (services/oauth_tokens.py) is responsible for making sure
    that token is currently valid (refreshing it first if it has expired)
    before constructing this connector; this class itself never refreshes
    or persists a token, matching how every other connector here takes a
    credential that is already good to use.

    A workbook with several tabs is treated exactly like a multi-sheet
    Excel upload (see FileConnector above) or a multi-table database: each
    tab is a separate pickable "table" in introspect_schema/load_dataframe,
    using the exact same {sheet_name: [{name,type}, ...]} schema_cache
    shape, so nothing downstream (data_loader._pick_single/
    NeedsTableSelection, the frontend's getTableEntries) needs to know this
    is Google Sheets rather than an Excel workbook.
    """

    SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
    _TIMEOUT = 20

    def __init__(self, access_token: str, spreadsheet_id: str):
        self.access_token = access_token
        self.spreadsheet_id = spreadsheet_id

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.access_token}"}

    def _get(self, url: str, params: dict | None = None) -> dict:
        resp = requests.get(url, headers=self._headers(), params=params, timeout=self._TIMEOUT)
        if resp.status_code == 401:
            raise ValueError("Google Sheets access token was rejected (expired or revoked) - reconnect this data source.")
        if resp.status_code == 403:
            raise ValueError("GD360 no longer has permission to read this spreadsheet - it may have been unshared, or access revoked in your Google account.")
        if resp.status_code == 404:
            raise ValueError("This spreadsheet could not be found - it may have been deleted or moved.")
        resp.raise_for_status()
        return resp.json()

    def _metadata(self) -> dict:
        return self._get(f"{self.SHEETS_API}/{self.spreadsheet_id}", params={"fields": "properties.title,sheets.properties.title"})

    def test_connection(self) -> None:
        self._metadata()

    def list_sheet_names(self) -> list[str]:
        meta = self._metadata()
        return [s["properties"]["title"] for s in meta.get("sheets", [])]

    def spreadsheet_title(self) -> str:
        meta = self._metadata()
        return meta.get("properties", {}).get("title") or self.spreadsheet_id

    def load_dataframe(self, sheet_name: str | None = None, row_limit: int | None = None) -> pd.DataFrame:
        row_limit = row_limit or settings.MAX_ROWS_LOADED_PER_QUERY
        if not sheet_name:
            names = self.list_sheet_names()
            if not names:
                raise ValueError("This spreadsheet has no sheets.")
            sheet_name = names[0]
        # A bare (properly quoted) sheet name as the range - with no cell
        # range appended - returns every used cell on that sheet, which is
        # exactly "the whole table" with no need to know its size up front.
        # UNFORMATTED_VALUE keeps numbers as real numbers/dates as serials
        # rather than whatever locale-specific display string the sheet
        # happens to be formatted with (e.g. "$1,234.00" as text), so pandas
        # infers sane dtypes the same way it would for any other connector.
        quoted_range = f"'{sheet_name.replace(chr(39), chr(39) * 2)}'"
        data = self._get(
            f"{self.SHEETS_API}/{self.spreadsheet_id}/values/{quote(quoted_range)}",
            params={"valueRenderOption": "UNFORMATTED_VALUE", "dateTimeRenderOption": "FORMATTED_STRING"},
        )
        rows = data.get("values", [])
        if row_limit and len(rows) > row_limit + 1:
            rows = rows[: row_limit + 1]
        return _rows_to_dataframe(rows)

    def introspect_schema(self, max_sheets: int = 50) -> dict:
        names = self.list_sheet_names()
        if len(names) <= 1:
            df = self.load_dataframe(sheet_name=(names[0] if names else None), row_limit=200)
            return {"columns": [{"name": c, "type": str(df[c].dtype)} for c in df.columns]}
        schema: dict = {}
        for sheet in names[:max_sheets]:
            # Only a small sample per sheet just to infer column names/
            # dtypes - the real, full-sized load happens on demand via
            # load_dataframe, exactly like every other connector's
            # introspect_schema only ever samples too (SQLConnector reads
            # column metadata, not rows; FileConnector genuinely re-parses
            # the whole sheet since a local file read is cheap - a live API
            # round trip per sheet is not, so this caps it).
            df = self.load_dataframe(sheet_name=sheet, row_limit=200)
            schema[sheet] = [{"name": c, "type": str(df[c].dtype)} for c in df.columns]
        return schema


class MicrosoftExcelConnector:
    """A live Microsoft Excel connector (an .xlsx workbook stored in
    OneDrive or a SharePoint document library), read through the Microsoft
    Graph API's workbook endpoints. Same live-on-every-call design as
    GoogleSheetsConnector above - no caching of its own, no background sync,
    just a fresh API read on every `load_dataframe` call - and the same
    multi-worksheet-as-multi-table treatment.

    `drive_id` is None for a personal OneDrive item (addressed as
    /me/drive/items/{item_id}) and set for a SharePoint/shared-library item
    (addressed as /drives/{drive_id}/items/{item_id}) - Graph requires
    knowing which drive an item lives in for anything but "my own drive".
    """

    GRAPH_API = "https://graph.microsoft.com/v1.0"
    _TIMEOUT = 20

    def __init__(self, access_token: str, item_id: str, drive_id: str | None = None):
        self.access_token = access_token
        self.item_id = item_id
        self.drive_id = drive_id

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.access_token}"}

    def _item_base(self) -> str:
        if self.drive_id:
            return f"{self.GRAPH_API}/drives/{self.drive_id}/items/{self.item_id}"
        return f"{self.GRAPH_API}/me/drive/items/{self.item_id}"

    def _get(self, url: str, params: dict | None = None) -> dict:
        resp = requests.get(url, headers=self._headers(), params=params, timeout=self._TIMEOUT)
        if resp.status_code == 401:
            raise ValueError("Microsoft access token was rejected (expired or revoked) - reconnect this data source.")
        if resp.status_code == 403:
            raise ValueError("GD360 no longer has permission to read this workbook - access may have been revoked in your Microsoft account.")
        if resp.status_code == 404:
            raise ValueError("This workbook could not be found - it may have been deleted or moved.")
        resp.raise_for_status()
        return resp.json()

    def file_name(self) -> str:
        meta = self._get(self._item_base(), params={"$select": "name"})
        return meta.get("name") or self.item_id

    def test_connection(self) -> None:
        self._get(self._item_base(), params={"$select": "id"})

    def list_sheet_names(self) -> list[str]:
        data = self._get(f"{self._item_base()}/workbook/worksheets", params={"$select": "name"})
        return [w["name"] for w in data.get("value", [])]

    def load_dataframe(self, sheet_name: str | None = None, row_limit: int | None = None) -> pd.DataFrame:
        row_limit = row_limit or settings.MAX_ROWS_LOADED_PER_QUERY
        if not sheet_name:
            names = self.list_sheet_names()
            if not names:
                raise ValueError("This workbook has no worksheets.")
            sheet_name = names[0]
        escaped = sheet_name.replace("'", "''")
        # usedRange(valuesOnly=true) is the Graph API's own "just give me
        # the real cells" range - it skips formatting metadata entirely
        # (much smaller/faster than the plain usedRange) and already
        # excludes trailing empty rows/columns, so there is no separate
        # "how big is this sheet" call needed first.
        data = self._get(f"{self._item_base()}/workbook/worksheets('{quote(escaped)}')/usedRange(valuesOnly=true)", params={"$select": "values"})
        rows = data.get("values", [])
        if row_limit and len(rows) > row_limit + 1:
            rows = rows[: row_limit + 1]
        return _rows_to_dataframe(rows)

    def introspect_schema(self, max_sheets: int = 50) -> dict:
        names = self.list_sheet_names()
        if len(names) <= 1:
            df = self.load_dataframe(sheet_name=(names[0] if names else None), row_limit=200)
            return {"columns": [{"name": c, "type": str(df[c].dtype)} for c in df.columns]}
        schema: dict = {}
        for sheet in names[:max_sheets]:
            df = self.load_dataframe(sheet_name=sheet, row_limit=200)
            schema[sheet] = [{"name": c, "type": str(df[c].dtype)} for c in df.columns]
        return schema
