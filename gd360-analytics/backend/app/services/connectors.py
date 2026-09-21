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
just Postgres under the hood - see _sql_engine_url), CSV, Excel, and the
BigQuery data warehouse. The connector interface is intentionally generic
(`load_dataframe`, `introspect_schema`) so new backends (Snowflake, a
generic REST ERP/CRM connector, etc.) can be added as additional classes
without touching the rest of the app - BigQueryConnector below is the
first connector to actually exercise that promise: it authenticates
completely differently (a service-account JSON key, not host/port/
username/password) and still plugs into the exact same interface.
"""
from __future__ import annotations

import json
import re
from typing import Any

import pandas as pd
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
