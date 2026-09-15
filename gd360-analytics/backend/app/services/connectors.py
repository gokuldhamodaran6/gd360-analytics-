"""
Data connectors.

Design principle: GD360 NEVER writes to a customer source system. Every
connector here only ever reads data, and every raw query path is validated
to be read-only before it touches a real connection. Recommend (in the UI
and README) that users supply a read-only database role/user as
defense-in-depth on top of this application-level check.

Supported now: Postgres, MySQL, MongoDB, CSV, Excel.
The connector interface is intentionally generic (`load_dataframe`,
`introspect_schema`) so new backends (Snowflake, BigQuery, a generic REST
ERP/CRM connector, etc.) can be added as additional classes without
touching the rest of the app.
"""
from __future__ import annotations

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
    if kind == "postgres":
        url = f"postgresql+psycopg2://{user}:{pw}@{host}:{port}/{database}"
        if ssl:
            url += "?sslmode=require"
        return url
    if kind == "mysql":
        url = f"mysql+pymysql://{user}:{pw}@{host}:{port}/{database}"
        if ssl:
            url += "?ssl_verify_cert=true"
        return url
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
            return pd.read_excel(buf, sheet_name=sheet_name)
        return pd.read_csv(buf)

    def introspect_schema(self) -> dict:
        df = self.load_dataframe()
        return {"columns": [{"name": c, "type": str(df[c].dtype)} for c in df.columns]}
