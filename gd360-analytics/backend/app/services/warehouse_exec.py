"""
Warehouse SQL execution as a SERVICE (2026-10-06, warehouse-native
dashboards layer).

routers/chat.py's `_execute_sql_attempt` is the chat endpoint's single
execution chokepoint for a warehouse/database data source: it builds the
right connector for `ds.kind`, runs ONE read-only statement with every
guard that connector enforces (assert_read_only_sql, BigQuery's dry-run
byte ceiling, Snowflake's statement timeout, SQLConnector's row cap),
and writes one audit row. services/dashboard_engine.py needs exactly the
same chokepoint - and a service must never import a router - so the
execution itself lives here, split into two layers:

  - `run_sql(ds, sql, ctes)`: the thread-safe core. Constructs a FRESH
    connector per call (a BigQuery client, a Snowflake connection, a
    SQLAlchemy engine - none is shared between calls or threads), runs the
    statement, returns (df, bytes_scanned). Raises the connector's own
    error. Touches NO SQLAlchemy session, so the dashboard engine can run
    several blocks concurrently in a ThreadPoolExecutor and do the
    session-bound audit logging afterwards, on the request thread, where
    the Session is safe to use.
  - `execute_sql(db, ds, user_id, sql, ctes)`: the audited wrapper with
    the same return contract as chat's `_execute_sql_attempt` (a dict with
    "df" on success, "attempt" always) and the same status vocabulary in
    the PushdownQueryLog row, for callers that run one statement at a time.
  - `describe_sql(ds, sql)`: the zero-row validation (BigQuery dry run /
    `LIMIT 0` / `WHERE 1=0` / `TOP 0` - each connector's describe_query),
    returning ([{name, type}], estimated_bytes | None). What "set a
    block's spec" uses to prove the compiled SQL is valid without reading
    a row or spending budget.
  - `daily_budget_exhausted(db, ds, user_id)`: the shared per-user daily
    scanned-bytes budget check for the metered kinds.

routers/chat.py keeps its own `_execute_sql_attempt` unchanged this
round (its retry-bookkeeping and 177-case policy tests are built around
it); the connector construction below is the same code, kept
deliberately identical so the two can be unified in a later pass.
"""
from __future__ import annotations

import json
import re

from sqlalchemy.orm import Session

from .. import models, security
from ..config import get_settings
from . import warehouse_tables
from .connectors import (
    BigQueryConnector, QueryTooExpensive, ReadOnlyViolation, SQLConnector, SnowflakeConnector,
)
from .pushdown_budget import log_pushdown, todays_pushdown_bytes

settings = get_settings()

SQL_WAREHOUSE_KINDS = ("bigquery", "snowflake", "postgres", "mysql", "sqlserver", "supabase")
BUDGETED_KINDS = ("bigquery", "snowflake")


def is_sql_warehouse(kind: str | None) -> bool:
    return kind in SQL_WAREHOUSE_KINDS


def _bigquery_connector(ds: models.DataSource) -> BigQueryConnector:
    info = ds.connection_info or {}
    service_account_json = security.decrypt_secret(ds.encrypted_secret)
    return BigQueryConnector(info["project_id"], info["dataset_id"], service_account_json)


def _snowflake_connector(ds: models.DataSource) -> SnowflakeConnector:
    info = ds.connection_info or {}
    creds = json.loads(security.decrypt_secret(ds.encrypted_secret))
    return SnowflakeConnector(
        account=info["account"], warehouse=info["warehouse"], database=info["database"],
        db_schema=info.get("db_schema"), role=info.get("role"),
        username=creds["username"], password=creds["password"],
    )


def _sql_connector(ds: models.DataSource) -> SQLConnector:
    info = ds.connection_info or {}
    username, password = security.decrypt_secret(ds.encrypted_secret).split("␟")
    return SQLConnector(ds.kind, info["host"], info["port"], info["database"], username, password, info.get("ssl", True))


def wrap_ctes(sql: str, ctes: list[tuple[str, str]] | None) -> str:
    """`WITH alias AS (query_sql), ... <sql>` for the saved-query versions
    in scope (warehouse_tables.wrap_with_ctes, flat); unchanged without
    CTEs. Raises warehouse_tables.CteConflict."""
    if not ctes:
        return warehouse_tables.strip_trailing_semicolon(sql)
    return warehouse_tables.wrap_with_ctes(sql, ctes)


def run_sql(ds: models.DataSource, sql: str, ctes: list[tuple[str, str]] | None = None, params=None):
    """The thread-safe core: ONE statement, a fresh connector, every guard
    the connector enforces. Returns (df, bytes_scanned). Raises
    ReadOnlyViolation / QueryTooExpensive / the warehouse's own error.
    Never touches a SQLAlchemy session.

    `params` (2026-10-07, SQL cells with dashboard parameters) is the
    dialect-shaped bound-parameter payload services/dashboard_engine.
    bind_parameters produced for THIS `ds.kind`: a list of {name, type,
    value|values} for BigQuery (real query parameters in the job config),
    a {name: value} dict for every other kind (SQLAlchemy / Snowflake
    binding). Values are never spliced into the SQL text anywhere."""
    kind = ds.kind
    sql = wrap_ctes(sql, ctes)
    # `params` is only passed when there is something to bind, so the
    # unparameterised path calls the connectors exactly as before.
    extra = {"params": params} if params else {}
    if kind == "bigquery":
        df, bytes_scanned = _bigquery_connector(ds).run_pushdown_query(
            sql, max_bytes=settings.BIGQUERY_MAX_BYTES_SCANNED_PER_QUERY, **extra,
        )
        return df, bytes_scanned
    if kind == "snowflake":
        df, bytes_scanned = _snowflake_connector(ds).run_pushdown_query(
            sql, statement_timeout_seconds=settings.SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS, **extra,
        )
        return df, bytes_scanned
    if kind in ("postgres", "mysql", "sqlserver", "supabase"):
        df = _sql_connector(ds).load_dataframe(sql, is_raw_sql=True, **extra)
        return df, None
    raise ValueError(f"run_sql does not handle kind {kind!r}")


# --- error messages (2026-10-07, real end-to-end run) -------------------------
#
# What a failed statement used to put on the page, verbatim:
#   (psycopg2.errors.UndefinedColumn) column "x" does not exist
#   LINE 1: SELECT x FROM ...
#   [SQL: SELECT x FROM ...]
#   (Background on this error at: https://sqlalche.me/e/20/f405)
# The driver's class name, an echo of the whole statement and a link to
# SQLAlchemy's documentation are noise to the person reading a dashboard.
# clean_warehouse_error keeps what the DATABASE said - its own sentence,
# plus a short LINE / HINT when it gave one - and drops the wrapping. It is
# the one function every warehouse failure passes through on its way to an
# HTTP `detail`, a block result's `error` or a chat attempt's `error`; the
# full original text still goes to the server log and the audit row.

_ERR_SQL_ECHO_RE = re.compile(r"\s*\[SQL:.*", re.S)
_ERR_PARAMS_RE = re.compile(r"\s*\[parameters:.*", re.S)
_ERR_BACKGROUND_RE = re.compile(r"\s*\(Background on this error at:[^)]*\)", re.I)
_ERR_CLASS_PREFIX_RE = re.compile(r"^\((?:[A-Za-z_]\w*\.)+[A-Za-z_]\w*\)\s*")
_ERR_DBAPI_TUPLE_RE = re.compile(r"""^\(\s*(?:-?\d+|'[^']*'|"[^"]*")\s*,\s*b?(?P<q>['"])(?P<msg>.*)(?P=q)\s*\)\s*$""", re.S)
_ERR_HTTP_PREFIX_RE = re.compile(r"^\d{3}\s+(?:(?:GET|POST|PUT|PATCH|DELETE)\s+\S+?:\s+)?(?:Bad Request:\s+)?")
_ERR_BQ_REASON_RE = re.compile(r";\s*reason:\s*\w+.*", re.S)
_ERR_URL_RE = re.compile(r"\(?https?://\S+\)?")
_ERR_SNOWFLAKE_CODE_RE = re.compile(r"^\d{6}\s*\([0-9A-Za-z]{5}\):\s*")
_ERR_QUERY_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\s*", re.I)
_ERR_MYSQL_CODE_RE = re.compile(r"^\d{3,5}\s*\([0-9A-Za-z]{5}\):\s*")
_ERR_ODBC_TAG_RE = re.compile(r"^(?:\[[^\]]*\]\s*)+")
_ERR_ODBC_TAIL_RE = re.compile(r"(?:\s*\(\d+\))?\s*\(SQL[A-Za-z]+\)\s*$")
_ERR_DROP_LINE_RE = re.compile(
    r"^(?:\^+|location:\s*\S+|job id:\s*\S+|\(job id:[^)]*\)|context:.*|query id:.*|db-lib error message.*|"
    r"general sql server error.*)$",
    re.I,
)
_ERR_HINT_MAX = 160
_ERR_LINE_MAX = 80


def clean_warehouse_error(error, fallback: str = "The warehouse rejected this query.") -> str:
    """A driver / SQLAlchemy / BigQuery / Snowflake exception (or its text)
    as the sentence the database itself wrote: no driver class prefix, no
    `[SQL: ...]` echo, no sqlalche.me link, no job URL or job id. A
    `LINE n: ...` position is kept when it shows a whole short line (not a
    "..." excerpt of a long one), and so is a short HINT / DETAIL. Text that
    carries none of that wrapping (one of GD360's own messages) comes back
    unchanged, so the function is safe to apply twice."""
    text = "" if error is None else str(error)
    text = text.replace("\r\n", "\n").replace("\\n", "\n").strip()
    if not text:
        return fallback
    text = _ERR_SQL_ECHO_RE.sub("", text)
    text = _ERR_PARAMS_RE.sub("", text)
    text = _ERR_BACKGROUND_RE.sub("", text)
    text = _ERR_CLASS_PREFIX_RE.sub("", text.strip())
    m = _ERR_DBAPI_TUPLE_RE.match(text.strip())
    if m:
        # (1054, "Unknown column 'foo' in 'field list'") / ('42S22', "[42S22] [Microsoft]...")
        text = m.group("msg").replace("\\'", "'").replace('\\"', '"')
    text = _ERR_HTTP_PREFIX_RE.sub("", text.strip())
    text = _ERR_BQ_REASON_RE.sub("", text)
    text = _ERR_URL_RE.sub("", text)

    lines: list[str] = []
    for raw in text.split("\n"):
        line = raw.strip()
        if not line or _ERR_DROP_LINE_RE.match(line):
            continue
        lines.append(line)
    if not lines:
        return fallback

    head = lines[0]
    for rx in (_ERR_SNOWFLAKE_CODE_RE, _ERR_QUERY_ID_RE, _ERR_MYSQL_CODE_RE):
        head = rx.sub("", head)
    head = _ERR_ODBC_TAG_RE.sub("", head)
    head = _ERR_ODBC_TAIL_RE.sub("", head).strip()
    rest = lines[1:]
    # Snowflake / some drivers break the sentence over two lines:
    #   "SQL compilation error: error line 1 at position 7" / "invalid identifier 'FOO'"
    if rest and not re.match(r"^(LINE\s+\d+:|HINT:|DETAIL:)", rest[0], re.I) and (
        head.endswith(":") or re.search(r"\b(?:at|line) (?:position )?\d+$", head, re.I) or not head
    ):
        joined = rest.pop(0)
        head = f"{head} {joined}".strip() if head.endswith(":") or not head else f"{head}: {joined}"
    if not head:
        return fallback

    extras: list[str] = []
    for line in rest:
        mm = re.match(r"^(LINE\s+\d+:)\s*(.*)$", line, re.I)
        if mm:
            # Kept only when it is the whole (short) line of a short
            # statement. Postgres cuts a long line to an excerpt with "..."
            # - a fragment of generated SQL that tells the reader nothing
            # the sentence did not.
            excerpt = mm.group(2).strip()
            if excerpt and len(excerpt) <= _ERR_LINE_MAX and not excerpt.startswith("...") and not excerpt.endswith("..."):
                extras.append(f"{mm.group(1).upper().replace('LINE', 'Line')} {excerpt}")
            continue
        mm = re.match(r"^(HINT|DETAIL):\s*(.*)$", line, re.I)
        if mm:
            if mm.group(2) and len(mm.group(2)) <= _ERR_HINT_MAX:
                extras.append(f"{mm.group(1).capitalize()}: {mm.group(2)}")
            continue
    out = " · ".join([head.rstrip()] + extras)
    out = re.sub(r"[ \t]+", " ", out).strip()
    return out[:600] if out else fallback


def classify_error(e: Exception) -> str:
    """The PushdownQueryLog status for an execution failure - the same
    vocabulary routers/chat.py uses."""
    if isinstance(e, ReadOnlyViolation):
        return "rejected_unsafe"
    if isinstance(e, QueryTooExpensive):
        return "rejected_too_expensive"
    if isinstance(e, warehouse_tables.CteConflict):
        return "error"
    return "error"


def execute_sql(
    db: Session, ds: models.DataSource, user_id: str, sql: str, ctes: list[tuple[str, str]] | None = None,
    params=None,
) -> dict:
    """The audited one-at-a-time wrapper. Returns {"df", "bytes_scanned",
    "attempt": {sql, status, error}} on success, {"attempt": {...}} on
    failure (never raises for a query/connection failure). Every call
    writes one PushdownQueryLog row."""
    try:
        wrapped = wrap_ctes(sql, ctes)
    except warehouse_tables.CteConflict as e:
        log_pushdown(db, user_id, ds.id, ds.kind, sql, None, "error", str(e))
        return {"attempt": {"sql": sql, "status": "error", "error": str(e)}}
    try:
        df, bytes_scanned = run_sql(ds, wrapped, params=params)
    except QueryTooExpensive as e:
        log_pushdown(db, user_id, ds.id, ds.kind, wrapped, e.estimated_bytes, "rejected_too_expensive", str(e))
        return {"attempt": {"sql": wrapped, "status": "rejected_too_expensive", "error": str(e)}}
    except Exception as e:
        status = classify_error(e)
        # The audit row keeps the driver's full text; the caller (a block
        # result, a rail control) gets the database's own sentence.
        log_pushdown(db, user_id, ds.id, ds.kind, wrapped, None, status, str(e))
        return {"attempt": {"sql": wrapped, "status": status, "error": clean_warehouse_error(e)}}
    log_pushdown(db, user_id, ds.id, ds.kind, wrapped, bytes_scanned, "ok")
    return {"df": df, "bytes_scanned": bytes_scanned, "attempt": {"sql": wrapped, "status": "ok", "error": None}}


def describe_sql(
    ds: models.DataSource, sql: str, ctes: list[tuple[str, str]] | None = None, params=None,
) -> tuple[list[dict], int | None]:
    """Zero-row validation of `sql` inside the warehouse: ([{name, type}],
    estimated_bytes | None). Raises the warehouse's own error for an
    invalid statement. Not billed (BigQuery dry run; a LIMIT 0 / WHERE
    1=0 / TOP 0 statement elsewhere). `params` as in run_sql."""
    sql = wrap_ctes(sql, ctes)
    kind = ds.kind
    extra = {"params": params} if params else {}
    if kind == "bigquery":
        return _bigquery_connector(ds).describe_query(sql, **extra)
    if kind == "snowflake":
        return _snowflake_connector(ds).describe_query(
            sql, statement_timeout_seconds=settings.SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS, **extra,
        ), None
    if kind in ("postgres", "mysql", "sqlserver", "supabase"):
        return _sql_connector(ds).describe_query(sql, **extra), None
    raise ValueError(f"describe_sql does not handle kind {kind!r}")


def daily_budget_exhausted(db: Session, ds: models.DataSource, user_id: str) -> bool:
    """The shared per-user daily scanned-bytes budget, metered kinds only
    (routers/chat._daily_budget_exhausted's twin). Logs the rejection."""
    if ds.kind not in BUDGETED_KINDS:
        return False
    already = todays_pushdown_bytes(db, user_id)
    if already >= settings.PUSHDOWN_MAX_BYTES_SCANNED_PER_DAY_PER_USER:
        log_pushdown(db, user_id, ds.id, ds.kind, "", None, "rejected_daily_budget")
        return True
    return False
