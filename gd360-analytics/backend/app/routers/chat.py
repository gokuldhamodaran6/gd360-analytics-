"""
The core AI analytics endpoint. Given a prompt + a datasource, it:
  1. Loads the relevant data (read-only), preferring an AI-cleaned snapshot
     when one exists and the caller did not ask for the original.
  2. Asks the AI engine to plan + (safely) execute pandas code - either a
     data cleaning/preparation transform, or a chart-producing analysis.
  3. For a transform, persists the cleaned snapshot back onto the
     datasource (never onto the real file/database the user connected) and
     logs what changed.
  4. Persists the conversation turn.
  5. Returns chart spec + insight + follow-up suggestions, or a
     clarifying question if the AI/system needs more info.

For a warehouse/database data source (PUSHDOWN_ELIGIBLE_KINDS) step 1 is
different since 2026-10-06 (warehouse-honesty round): rows are never
pulled into the app for analysis. The question is answered by one real
query that runs inside the warehouse over every row (AI-written, built
deterministically from the person's query_builder spec, or their own
raw_sql), and the small result is what step 2 charts - or, when no such
query could be produced, the turn is action="needs_query_help" and
nothing is computed. See the section comment above _multi_table_schema_text.
"""
import json
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, schemas, security
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..schemas_extra import ChatRequestFull, VerifyRequest
from ..services import ai_engine, data_access_rules, learned_answers, query_builder, warehouse_tables, workspace_access
from ..services.profile_cache import cached_exact_total_rows
from ..services.transforms import apply_transform_steps, describe_transform
from ..services.connectors import (
    BigQueryConnector, SnowflakeConnector, SQLConnector, MongoConnector, QueryTooExpensive, ReadOnlyViolation,
    assert_read_only_sql,
)
from ..services.data_loader import (
    load_dataframe, load_version_dataframe, dataframe_to_csv_bytes, ensure_legacy_migrated, NeedsTableSelection,
    purpose_label, is_warehouse_query, WAREHOUSE_QUERY_SOURCE_KIND,
)

router = APIRouter(prefix="/chat", tags=["chat"])
settings = get_settings()

# Simple in-memory sliding-window rate limiter (per process). Protects the
# free AI tier from accidental hammering; swap for Redis in multi-instance
# deployments. Generous by default - see config.RATE_LIMIT_PER_MINUTE.
_call_log: dict[str, deque] = defaultdict(deque)


def _check_rate_limit(user_id: str):
    now = time.time()
    window = _call_log[user_id]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= settings.RATE_LIMIT_PER_MINUTE:
        raise HTTPException(429, "You are sending requests a bit fast for the free AI tier - please wait a few seconds and try again.")
    window.append(now)


# --- Warehouse pushdown ---------------------------------------------------
# 2026-10-06 (warehouse-honesty round - a product-policy change, not a bug
# fix): for a warehouse/database data source (PUSHDOWN_ELIGIBLE_KINDS
# below), a chat question is answered ONLY by one real query that runs
# inside the warehouse over every row. The app never pulls a row-capped
# SAMPLE of a warehouse table into pandas and analyzes that - the founder's
# firm decision is that an answer computed on a sample is a wrong answer
# and must never be produced. The only two honest outcomes for such a
# source are:
#   - "computed inside the warehouse over every row" (used_pushdown=True),
#   - "not computed yet - here is how to finish it" (action=
#     "needs_query_help": the attempts made, a prefilled deterministic
#     query builder, or the person's own SQL - see _needs_query_help_response
#     and schemas.ChatResponse).
# Before this round, a failed pushdown silently fell through to
# _load_selected_tables -> load_dataframe, which loaded e.g. 2,000 BigQuery
# rows (settings.BIGQUERY_MAX_ROWS_LOADED) and analyzed those as if they
# were the data. That path is gone for warehouse kinds; it is unchanged for
# every file-based kind (csv/excel/api/googlesheets/...), whose data is
# already complete in the app.

def _multi_table_schema_text(schema_cache: dict) -> str:
    """Every table in a warehouse dataset (BigQuery or Snowflake - both
    use the exact same multi-table {table_name: [{"name","type"}, ...]}
    schema_cache shape, see BigQueryConnector/SnowflakeConnector.
    introspect_schema), formatted for ai_engine.generate_bigquery_sql /
    generate_snowflake_sql."""
    lines = []
    for table_name, columns in (schema_cache or {}).items():
        lines.append(f"Table `{table_name}`:")
        for col in columns or []:
            lines.append(f"  - {col.get('name')} ({col.get('type')})")
    return "\n".join(lines)


def _mongo_schema_text(schema_cache: dict) -> str:
    """MongoDB's introspect_schema shape - {collection_name: [{"name",
    "type", "present_count", "sample_size"}, ...]} - since a document
    database has no fixed schema; the field list itself is inferred from
    a SAMPLE of documents per collection (see MongoConnector.
    introspect_schema, 2026-10-06 round: up to settings.MONGO_SCHEMA_
    SAMPLE_SIZE documents, not just one), so it may not include every
    field that appears elsewhere in the same collection, and a field only
    present on some of the sampled documents is called out as sparse
    right here rather than looking identical to a universal one.
    Formatted for ai_engine.generate_mongo_pipeline.

    2026-10-06: updated alongside that introspect_schema rewrite - each
    field entry used to be a bare string; it's a dict now (real inferred
    type + sparsity, not just a name), so this reads entry["name"]/
    entry.get("type")/entry.get("present_count") instead of treating `f`
    itself as the field name. A legacy string entry (an older cached
    schema_cache from before this round that hasn't been refreshed yet)
    is still handled so this never breaks for a datasource that simply
    hasn't been reconnected/refreshed since."""
    lines = []
    for coll_name, fields in (schema_cache or {}).items():
        lines.append(f"Collection `{coll_name}` (fields seen in a sample of documents - others may exist):")
        for f in fields or []:
            if isinstance(f, dict):
                name = f.get("name")
                ftype = f.get("type")
                present = f.get("present_count")
                total = f.get("sample_size")
                sparse_note = (
                    f", present on {present}/{total} sampled docs"
                    if present is not None and total is not None and present < total
                    else ""
                )
                lines.append(f"  - {name} ({ftype}{sparse_note})" if ftype else f"  - {name}{sparse_note}")
            else:
                # Legacy bare-string entry from before this round.
                lines.append(f"  - {f}")
    return "\n".join(lines)


def _scoped_schema_cache(schema_cache, scope_tables: list[str] | None) -> dict:
    """The schema_cache narrowed to exactly `scope_tables` (every table when
    None) - what the SQL/pipeline writer is shown, so it can only ever
    reference the tables the person actually selected."""
    if not isinstance(schema_cache, dict):
        return {}
    if scope_tables is None:
        return schema_cache
    return {k: v for k, v in schema_cache.items() if k in scope_tables}


# 2026-10-05: _log_pushdown/_todays_pushdown_bytes used to be defined
# here directly. Moved to services/pushdown_budget.py (imported below,
# under their original names so every call site in this file is
# unchanged) so routers/datasources.py's new Data-tab profiling endpoint
# can share the exact same per-user daily cost budget and audit log
# instead of duplicating this logic - a person's profiling calls and
# their chat questions both spend from one real budget, not two that
# each look safe alone. See that module's own docstring for the full
# reasoning.
from ..services.pushdown_budget import log_pushdown as _log_pushdown, todays_pushdown_bytes as _todays_pushdown_bytes


# Every datasource kind the chat endpoint ever runs a query INSIDE the
# source for - exactly the set the dispatch in _run_warehouse_pushdown
# handles. For these kinds the sample path is gone (see the module
# comment above). A kind NOT in this set (a CSV/Excel upload, a plain API
# connection, Google Sheets, ...) never attempts pushdown at all and keeps
# today's pull-and-pandas path completely unchanged.
PUSHDOWN_ELIGIBLE_KINDS = {"bigquery", "snowflake", "postgres", "mysql", "sqlserver", "supabase", "mongodb"}
# The metered warehouses whose scans count against the shared per-user
# daily byte budget (services/pushdown_budget.py). A customer's own
# Postgres/MySQL/SQL Server/Supabase/Mongo server has no per-query billing
# to guard, so those skip the budget (unchanged from before this round).
_BUDGETED_KINDS = {"bigquery", "snowflake"}
_SQL_PUSHDOWN_KINDS = {"bigquery", "snowflake", "postgres", "mysql", "sqlserver", "supabase"}


@dataclass
class PushdownOutcome:
    """What one warehouse pushdown cycle actually did - replaces the old
    "DataFrame or None" return so the caller can be honest about a failure
    instead of silently falling back to a sample.

    df             - the small result when the query ran, else None.
    sql            - the SQL (or, for MongoDB, the JSON {"collection",
                     "pipeline"} text) that actually produced `df`; None
                     when nothing ran.
    bytes_scanned  - real bytes scanned when the provider meters it
                     (BigQuery dry-run estimate / Snowflake's own figure).
    duration_ms    - wall-clock ms around the whole generate+execute
                     cycle(s), time.perf_counter based.
    attempts       - every attempt, in order: {"sql", "status", "error"},
                     status in "ok" | "rejected_unsafe" |
                     "rejected_too_expensive" | "error" | "not_possible" |
                     "needs_table" | "generation_failed".
    skipped_reason - why no (or no further) attempt was made:
                     "daily_budget" | "empty_schema" | "needs_table" |
                     "not_possible" | None. "restricted_role" and
                     "unsupported_selection" are set by chat() itself,
                     before any pushdown function is called.
    """
    df: object = None
    sql: str | None = None
    bytes_scanned: int | None = None
    duration_ms: int = 0
    attempts: list = field(default_factory=list)
    skipped_reason: str | None = None

    @property
    def ok(self) -> bool:
        return self.df is not None


def _version_ctes(versions) -> list[tuple[str, str]]:
    """[(sql_alias, query_sql)] for the saved-query versions in a scope -
    what every statement that references one is wrapped in (always all of
    them: an unused CTE is harmless)."""
    return [
        (v.sql_alias, v.query_sql)
        for v in (versions or [])
        if getattr(v, "sql_alias", None) and getattr(v, "query_sql", None)
    ]


def _execute_sql_attempt(
    db: Session, ds: models.DataSource, user_id: str, sql: str, is_retry: bool = False,
    ctes: list[tuple[str, str]] | None = None,
) -> dict:
    """Runs ONE already-written SQL statement inside the warehouse/database
    `ds` points at - the single execution chokepoint shared by the
    AI-written pushdown path, the deterministic query builder and the
    person's own raw_sql, so all three get exactly the same read-only
    check (assert_read_only_sql inside each connector), per-query cost
    guard (BigQuery dry run), statement timeout (Snowflake), row cap
    (SQLConnector) and audit-log row. Returns:
      {"df": DataFrame, "bytes_scanned": int|None, "attempt": {...}} on
        success;
      {"retry": bool, "attempt": {...}} on failure, where `retry` says
        whether the AI pushdown path may hand this SQL+error back to the
        model for its one bounded retry (True for ReadOnlyViolation and any
        execution error on a first attempt; always False for
        QueryTooExpensive - valid SQL that is simply too costly, which a
        rewrite cannot fix - and always False on a retry).
    Never raises past the caller for a query/connection failure; only a
    genuinely unexpected kind reaches the ValueError below.

    2026-10-06 ("generated data is a saved query" layer): `ctes` -
    [(alias, query_sql)] of the saved-query versions in scope - wraps the
    statement as `WITH alias AS (query_sql), ... <sql>` before it runs
    (warehouse_tables.wrap_with_ctes, flat at the top level), so a
    question on a saved table is still ONE query over every row, inside
    the warehouse. The attempt's recorded "sql" is the wrapped text that
    actually ran."""
    kind = ds.kind
    info = ds.connection_info or {}
    if ctes:
        try:
            sql = warehouse_tables.wrap_with_ctes(sql, ctes)
        except warehouse_tables.CteConflict as e:
            _log_pushdown(db, user_id, ds.id, kind, sql, None, "error", str(e))
            return {"retry": not is_retry, "attempt": {"sql": sql, "status": "error", "error": str(e)}}
    try:
        if kind == "bigquery":
            service_account_json = security.decrypt_secret(ds.encrypted_secret)
            connector = BigQueryConnector(info["project_id"], info["dataset_id"], service_account_json)
            df, bytes_scanned = connector.run_pushdown_query(sql, max_bytes=settings.BIGQUERY_MAX_BYTES_SCANNED_PER_QUERY)
        elif kind == "snowflake":
            creds = json.loads(security.decrypt_secret(ds.encrypted_secret))
            connector = SnowflakeConnector(
                account=info["account"], warehouse=info["warehouse"], database=info["database"],
                db_schema=info.get("db_schema"), role=info.get("role"),
                username=creds["username"], password=creds["password"],
            )
            df, bytes_scanned = connector.run_pushdown_query(
                sql, statement_timeout_seconds=settings.SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS
            )
        elif kind in ("postgres", "mysql", "sqlserver", "supabase"):
            username, password = security.decrypt_secret(ds.encrypted_secret).split("␟")
            connector = SQLConnector(
                kind, info["host"], info["port"], info["database"], username, password, info.get("ssl", True)
            )
            df = connector.load_dataframe(sql, is_raw_sql=True)
            bytes_scanned = None
        else:
            raise ValueError(f"_execute_sql_attempt does not handle kind {kind!r}")
        _log_pushdown(db, user_id, ds.id, kind, sql, bytes_scanned, "ok")
        return {"df": df, "bytes_scanned": bytes_scanned, "attempt": {"sql": sql, "status": "ok", "error": None}}
    except ReadOnlyViolation as e:
        label = "unsafe, giving up" if is_retry else "unsafe, will retry once with the error shown to the model"
        print(f"[chat] {kind} pushdown query rejected ({label}): {e}")
        _log_pushdown(db, user_id, ds.id, kind, sql, None, "rejected_unsafe", str(e))
        return {"retry": not is_retry, "attempt": {"sql": sql, "status": "rejected_unsafe", "error": str(e)}}
    except QueryTooExpensive as e:
        # Valid SQL, just too costly - a retry can't fix that and would
        # only waste a second model call, so never retry here.
        print(f"[chat] {kind} pushdown query rejected (too expensive): {e}")
        _log_pushdown(db, user_id, ds.id, kind, sql, e.estimated_bytes, "rejected_too_expensive", str(e))
        return {"retry": False, "attempt": {"sql": sql, "status": "rejected_too_expensive", "error": str(e)}}
    except Exception as e:
        label = "giving up" if is_retry else "will retry once with the error shown to the model"
        print(f"[chat] {kind} pushdown query failed, {label}: {e}")
        _log_pushdown(db, user_id, ds.id, kind, sql, None, "error", str(e))
        return {"retry": not is_retry, "attempt": {"sql": sql, "status": "error", "error": str(e)}}


def _daily_budget_exhausted(db: Session, ds: models.DataSource, user_id: str) -> bool:
    """The shared per-user daily scanned-bytes budget check, for the
    metered kinds only (see _BUDGETED_KINDS). Logs the rejection to the
    audit table exactly as before this round."""
    if ds.kind not in _BUDGETED_KINDS:
        return False
    already_scanned_today = _todays_pushdown_bytes(db, user_id)
    if already_scanned_today >= settings.PUSHDOWN_MAX_BYTES_SCANNED_PER_DAY_PER_USER:
        print(f"[chat] {ds.kind} pushdown skipped, daily cost budget already used: {already_scanned_today} bytes")
        _log_pushdown(db, user_id, ds.id, ds.kind, "", None, "rejected_daily_budget")
        return True
    return False


def _warehouse_schema_text(ds: models.DataSource, scope_tables: list[str] | None, versions=None) -> str:
    """The schema text every SQL writer sees for a warehouse scope: the
    real tables (scoped - _scoped_schema_cache) plus, 2026-10-06
    ("generated data is a saved query" layer), one `Table \`<sql_alias>\``
    block per saved-query version in scope with its columns_json
    (warehouse_tables.versions_schema_text) - a version is a table the
    writer may select from exactly like a real one; the statement is
    wrapped in the matching CTEs before it runs."""
    text = _multi_table_schema_text(_scoped_schema_cache(ds.schema_cache, scope_tables))
    extra = warehouse_tables.versions_schema_text(versions) if versions else ""
    return "\n".join(part for part in (text, extra) if part)


def _run_sql_pushdown_cycle(
    db: Session, ds: models.DataSource, user_id: str, prompt: str, generate, scope_tables: list[str] | None,
    versions=None,
) -> PushdownOutcome:
    """The shared generate-then-execute cycle behind _try_bigquery_pushdown
    / _try_snowflake_pushdown / _try_sql_pushdown. `generate(schema_text,
    previous_sql, previous_error) -> str` is the provider's SQL writer.

    Retry behaviour is exactly what each provider had before this round
    (self-correcting pushdown round, 2026-10-06): when the FIRST attempt
    fails in a way that is plausibly the model's own mistake and genuinely
    correctable by showing it the error - a ReadOnlyViolation, or a real
    execution/dry-run rejection - the exact previous SQL and error are
    handed back to the SQL writer for exactly ONE corrected second
    attempt. Never a retry on QueryTooExpensive (valid SQL that is simply
    too costly - only BigQuery raises it), never on a generation failure
    or NOT_POSSIBLE/NEEDS_TABLE, never a third attempt. The daily budget
    (metered kinds only) is checked once, before the first attempt: a
    query that was rejected or failed never scanned/billed anything, so
    there is nothing a second check would catch. Both attempts are
    audit-logged separately (see _execute_sql_attempt) and both are
    reported in the outcome's `attempts`, so the person can see exactly
    what was tried."""
    started = time.perf_counter()
    outcome = PushdownOutcome()
    schema_text = _warehouse_schema_text(ds, scope_tables, versions)
    if not schema_text.strip():
        outcome.skipped_reason = "empty_schema"
        return outcome
    if _daily_budget_exhausted(db, ds, user_id):
        outcome.skipped_reason = "daily_budget"
        return outcome
    ctes = _version_ctes(versions)

    def _attempt(is_retry: bool, previous_sql: str | None = None, previous_error: str | None = None) -> dict:
        """One generate-then-execute cycle. Returns {"df", "bytes_scanned"}
        on success, {"retry": bool} otherwise - after appending this
        attempt to outcome.attempts either way."""
        try:
            sql = generate(schema_text, previous_sql, previous_error)
        except Exception as e:
            print(f"[chat] {ds.kind} pushdown SQL generation failed{' (retry)' if is_retry else ''}: {e}")
            outcome.attempts.append({"sql": None, "status": "generation_failed", "error": str(e)})
            return {"retry": False}
        marker = (sql or "").strip().upper().rstrip(";").strip()
        if not sql or marker == "NOT_POSSIBLE":
            outcome.attempts.append({"sql": None, "status": "not_possible", "error": None})
            if not is_retry:
                outcome.skipped_reason = "not_possible"
            return {"retry": False}
        if marker == "NEEDS_TABLE":
            # The question asks for a row-level table (clean/transform/
            # filter/add a column), not a summary - see the NEEDS_TABLE
            # rule in the SQL system prompts. Treated like NOT_POSSIBLE
            # for retry purposes (no retry), but recorded distinctly so
            # the response can say "creating a new table from a live
            # warehouse source is coming in the next update".
            outcome.attempts.append({"sql": None, "status": "needs_table", "error": None})
            outcome.skipped_reason = "needs_table"
            return {"retry": False}
        res = _execute_sql_attempt(db, ds, user_id, sql, is_retry=is_retry, ctes=ctes)
        outcome.attempts.append(res["attempt"])
        if "df" in res:
            return res
        return {"retry": bool(res.get("retry")), "sql": sql, "error": res["attempt"].get("error")}

    try:
        first = _attempt(is_retry=False)
        final = first
        if "df" not in first and first.get("retry"):
            # Exactly one bounded retry: give the model its own previous
            # SQL and the exact error it produced, then execute the
            # corrected query exactly once more. Whatever this returns is
            # final.
            final = _attempt(is_retry=True, previous_sql=first["sql"], previous_error=first["error"])
        if "df" in final:
            outcome.df = final["df"]
            outcome.bytes_scanned = final.get("bytes_scanned")
            outcome.sql = outcome.attempts[-1]["sql"]
    except Exception as e:
        # Nothing in the cycle is supposed to raise past here; this is the
        # last-line guard that keeps a surprise from turning into a 500.
        print(f"[chat] {ds.kind} pushdown cycle raised unexpectedly: {e}")
        outcome.attempts.append({"sql": None, "status": "error", "error": str(e)})
    outcome.duration_ms = int((time.perf_counter() - started) * 1000)
    return outcome


def _try_bigquery_pushdown(
    db: Session, ds: models.DataSource, user_id: str, prompt: str, scope_tables: list[str] | None = None,
    versions=None,
) -> PushdownOutcome:
    """Answers `prompt` with one governed SQL query run directly inside
    BigQuery over every row. Cost guards: a dry-run byte estimate per
    query (BigQueryConnector.run_pushdown_query, settings.BIGQUERY_MAX_
    BYTES_SCANNED_PER_QUERY) and the shared per-user daily budget. See
    _run_sql_pushdown_cycle for the one bounded retry and the full
    PushdownOutcome contract; `scope_tables`, when given, limits the
    schema the SQL writer sees to exactly those tables."""
    return _run_sql_pushdown_cycle(
        db, ds, user_id, prompt,
        lambda schema_text, prev_sql, prev_err: ai_engine.generate_bigquery_sql(
            prompt, schema_text, previous_sql=prev_sql, previous_error=prev_err
        ),
        scope_tables,
        versions=versions,
    )


def _try_snowflake_pushdown(
    db: Session, ds: models.DataSource, user_id: str, prompt: str, scope_tables: list[str] | None = None,
    versions=None,
) -> PushdownOutcome:
    """Answers `prompt` with one governed SQL query run directly inside
    Snowflake over every row. Snowflake bills by compute time, not bytes,
    so there is no free pre-flight cost check; safety is a strict
    per-query statement timeout (settings.SNOWFLAKE_STATEMENT_TIMEOUT_
    SECONDS) plus the shared daily byte budget, fed by Snowflake's own
    post-hoc bytes_scanned. There is no QueryTooExpensive here, so EVERY
    first-attempt failure is a candidate for the one bounded retry. See
    _run_sql_pushdown_cycle."""
    return _run_sql_pushdown_cycle(
        db, ds, user_id, prompt,
        lambda schema_text, prev_sql, prev_err: ai_engine.generate_snowflake_sql(
            prompt, schema_text, previous_sql=prev_sql, previous_error=prev_err
        ),
        scope_tables,
        versions=versions,
    )


def _try_sql_pushdown(
    db: Session, ds: models.DataSource, user_id: str, prompt: str, scope_tables: list[str] | None = None,
    versions=None,
) -> PushdownOutcome:
    """Answers `prompt` with one governed SQL query run directly inside the
    person's own Postgres/MySQL/SQL Server/Supabase database over every
    row. No metered cost to guard (a customer's own server), so no byte
    budget; SQLConnector.load_dataframe's is_raw_sql path still applies
    assert_read_only_sql and its dialect-aware row cap. Every
    first-attempt failure is a candidate for the one bounded retry. See
    _run_sql_pushdown_cycle."""
    return _run_sql_pushdown_cycle(
        db, ds, user_id, prompt,
        lambda schema_text, prev_sql, prev_err: ai_engine.generate_sql_pushdown_sql(
            prompt, schema_text, ds.kind, previous_sql=prev_sql, previous_error=prev_err
        ),
        scope_tables,
        versions=versions,
    )


def _try_mongo_pushdown(
    db: Session, ds: models.DataSource, user_id: str, prompt: str, scope_tables: list[str] | None = None,
    versions=None,
) -> PushdownOutcome:
    """Answers `prompt` with one governed MongoDB aggregation pipeline run
    directly inside the person's own MongoDB database - the MongoDB
    counterpart to _try_sql_pushdown, with an aggregation pipeline instead
    of SQL. No metered cost, no budget; MongoConnector.run_pushdown_query
    applies the read-only stage check, automatic $limit cap and maxTimeMS.
    One attempt, no retry (unchanged from before this round). The
    outcome's `sql`/attempt "sql" carry the JSON {"collection",
    "pipeline"} text. `scope_tables` limits the collections the pipeline
    writer sees. NOTE: the deterministic query builder (services/
    query_builder.py) is SQL-only - for mongodb chat() returns
    builder_suggestion=None and the frontend offers rephrase/try again
    only."""
    started = time.perf_counter()
    outcome = PushdownOutcome()
    schema_text = _mongo_schema_text(_scoped_schema_cache(ds.schema_cache, scope_tables))
    if not schema_text.strip():
        outcome.skipped_reason = "empty_schema"
        return outcome

    try:
        raw = ai_engine.generate_mongo_pipeline(prompt, schema_text)
    except Exception as e:
        print(f"[chat] Mongo pushdown pipeline generation failed: {e}")
        outcome.attempts.append({"sql": None, "status": "generation_failed", "error": str(e)})
        outcome.duration_ms = int((time.perf_counter() - started) * 1000)
        return outcome

    if not raw or raw.strip().upper() == "NOT_POSSIBLE":
        outcome.attempts.append({"sql": None, "status": "not_possible", "error": None})
        outcome.skipped_reason = "not_possible"
        outcome.duration_ms = int((time.perf_counter() - started) * 1000)
        return outcome
    if raw.strip().upper().rstrip(";").strip() == "NEEDS_TABLE":
        # 2026-10-06 ("generated data is a saved query" layer): MongoDB is
        # out of that layer's scope - a row-level request keeps today's
        # interim "needs_table" card (see _NEEDS_QUERY_HELP_REPLIES) rather
        # than being treated as unparseable JSON.
        outcome.attempts.append({"sql": None, "status": "needs_table", "error": None})
        outcome.skipped_reason = "needs_table"
        outcome.duration_ms = int((time.perf_counter() - started) * 1000)
        return outcome

    try:
        parsed = json.loads(raw)
        collection = parsed["collection"]
        pipeline = parsed["pipeline"]
    except Exception as e:
        print(f"[chat] Mongo pushdown pipeline was not valid JSON: {e}")
        _log_pushdown(db, user_id, ds.id, "mongodb", raw, None, "error", f"invalid pipeline JSON: {e}")
        outcome.attempts.append({"sql": raw, "status": "error", "error": f"invalid pipeline JSON: {e}"})
        outcome.duration_ms = int((time.perf_counter() - started) * 1000)
        return outcome

    log_text = json.dumps({"collection": collection, "pipeline": pipeline})
    try:
        username, password = security.decrypt_secret(ds.encrypted_secret).split("␟")
        info = ds.connection_info
        connector = MongoConnector(info["host"], info["port"], info["database"], username, password, info.get("ssl", True))
        df = connector.run_pushdown_query(
            collection, pipeline, timeout_seconds=settings.MONGO_AGGREGATION_TIMEOUT_SECONDS
        )
        _log_pushdown(db, user_id, ds.id, "mongodb", log_text, None, "ok")
        outcome.attempts.append({"sql": log_text, "status": "ok", "error": None})
        outcome.df = df
        outcome.sql = log_text
    except ReadOnlyViolation as e:
        print(f"[chat] Mongo pushdown pipeline rejected (unsafe): {e}")
        _log_pushdown(db, user_id, ds.id, "mongodb", log_text, None, "rejected_unsafe", str(e))
        outcome.attempts.append({"sql": log_text, "status": "rejected_unsafe", "error": str(e)})
    except Exception as e:
        print(f"[chat] Mongo pushdown query failed: {e}")
        _log_pushdown(db, user_id, ds.id, "mongodb", log_text, None, "error", str(e))
        outcome.attempts.append({"sql": log_text, "status": "error", "error": str(e)})
    outcome.duration_ms = int((time.perf_counter() - started) * 1000)
    return outcome


def _run_warehouse_pushdown(
    db: Session, ds: models.DataSource, user_id: str, prompt: str, scope_tables: list[str] | None, versions=None,
) -> PushdownOutcome:
    """Dispatches to the right provider's pushdown for ds.kind. `versions`
    (2026-10-06) are the saved-query DatasetVersions in scope - see
    _warehouse_schema_text/_execute_sql_attempt; always empty for mongodb."""
    if ds.kind == "bigquery":
        return _try_bigquery_pushdown(db, ds, user_id, prompt, scope_tables, versions=versions)
    if ds.kind == "snowflake":
        return _try_snowflake_pushdown(db, ds, user_id, prompt, scope_tables, versions=versions)
    if ds.kind in ("postgres", "mysql", "sqlserver", "supabase"):
        return _try_sql_pushdown(db, ds, user_id, prompt, scope_tables, versions=versions)
    if ds.kind == "mongodb":
        return _try_mongo_pushdown(db, ds, user_id, prompt, scope_tables)
    raise ValueError(f"_run_warehouse_pushdown does not handle kind {ds.kind!r}")


def _run_prewritten_sql(
    db: Session, ds: models.DataSource, user_id: str, sql: str, ctes: list[tuple[str, str]] | None = None,
) -> PushdownOutcome:
    """Executes SQL that did NOT come from the model - the deterministic
    query builder's output, or the person's own raw_sql - through the
    exact same chokepoint as AI pushdown (_execute_sql_attempt): same
    read-only check, same cost guards, same daily budget, same audit log.
    One attempt, no LLM, no retry. A failure (QueryTooExpensive,
    ReadOnlyViolation, a database error) comes back as a failed
    PushdownOutcome with that one attempt and its error - never a 500."""
    started = time.perf_counter()
    outcome = PushdownOutcome()
    if ds.kind not in _SQL_PUSHDOWN_KINDS:
        outcome.skipped_reason = "unsupported_kind"
        return outcome
    if _daily_budget_exhausted(db, ds, user_id):
        outcome.skipped_reason = "daily_budget"
        return outcome
    try:
        # Reject an unsafe statement up front (the connectors re-check, but
        # doing it here means a bad raw_sql never even opens a connection).
        assert_read_only_sql(sql)
    except ReadOnlyViolation as e:
        _log_pushdown(db, user_id, ds.id, ds.kind, sql, None, "rejected_unsafe", str(e))
        outcome.attempts.append({"sql": sql, "status": "rejected_unsafe", "error": str(e)})
        outcome.duration_ms = int((time.perf_counter() - started) * 1000)
        return outcome
    except Exception as e:
        # sqlparse itself choking on the text - treat as unsafe/unparseable.
        _log_pushdown(db, user_id, ds.id, ds.kind, sql, None, "rejected_unsafe", str(e))
        outcome.attempts.append({"sql": sql, "status": "rejected_unsafe", "error": f"Could not parse this SQL: {e}"})
        outcome.duration_ms = int((time.perf_counter() - started) * 1000)
        return outcome
    res = _execute_sql_attempt(db, ds, user_id, sql, is_retry=True, ctes=ctes)
    outcome.attempts.append(res["attempt"])
    if "df" in res:
        outcome.df = res["df"]
        outcome.bytes_scanned = res.get("bytes_scanned")
        outcome.sql = res["attempt"]["sql"]
    outcome.duration_ms = int((time.perf_counter() - started) * 1000)
    return outcome


# --- Selection scope for a warehouse kind ----------------------------------

def _resolve_warehouse_scope(
    ds: models.DataSource, requested_ids: list, table: str | None, db: Session | None = None,
) -> tuple[str, list[str] | None]:
    """(mode, scope_tables) - see _resolve_warehouse_selection, which this
    wraps for callers that do not need the saved-query versions. Without
    `db`, a bare DatasetVersion id cannot be looked up, so every one is
    treated as a file-backed saved table (today's "saved_only")."""
    mode, scope_tables, _versions = _resolve_warehouse_selection(db, ds, requested_ids, table)
    return mode, scope_tables


def _resolve_warehouse_selection(
    db: Session | None, ds: models.DataSource, requested_ids: list, table: str | None,
) -> tuple[str, list[str] | None, list]:
    """Decides, for a warehouse/database kind, what a WORKING ON selection
    means under the no-samples policy. Returns (mode, scope_tables,
    versions) - `versions` is the list of saved-query DatasetVersion rows
    in scope (2026-10-06, "generated data is a saved query" layer; always
    [] for every mode but "versions"):
      ("versions", tables|None, [v, ...]) - every bare id is a
                               source_kind="warehouse_query" version of
                               THIS datasource (optionally mixed with
                               "original" - then tables is None, every
                               real table in scope - or "sheet:<name>"
                               entries of this datasource): the question
                               runs inside the warehouse with each
                               version's definition wrapped as a CTE. A
                               file-backed version mixed in, or any
                               version of another datasource, is
                               "unsupported" (there is no honest way to
                               push a CSV into the warehouse).
      ("all", None)          - requested_ids == ["original"]: every table in
                               ds.schema_cache is in scope (today's
                               behaviour).
      ("tables", [names])    - every entry is "sheet:<name>" of THIS
                               datasource and every <name> is a key of
                               ds.schema_cache: exactly those tables are
                               in scope (one or several - several lets
                               the SQL writer join them; it is already
                               told how).
      ("saved_only", None)   - NO entry refers to this datasource's live
                               data at all: every entry is a bare
                               DatasetVersion id (a complete, saved CSV in
                               the app, not a sample). The caller keeps
                               today's pandas path for these.
      ("unsupported", None)  - anything else: a "ds:" cross-datasource
                               entry, a mix of live tables and saved
                               tables, a sheet name not in the schema, or
                               a forced `table` that is not a schema key.
                               The caller must NOT load samples; it
                               answers needs_query_help with
                               skipped_reason="unsupported_selection".

    2026-10-06: this REPLACES the old _is_effectively_original_selection
    gate, which only let a single "sheet:<name>" through when that name
    was the datasource's ONLY table (because the SQL writer was always
    handed the FULL schema). Now the schema text is scoped to exactly the
    selected tables (_scoped_schema_cache), so any subset of this
    datasource's own tables is safe to push down.

    A forced `table` (payload.table - no current frontend code sends it,
    but API clients may) is treated as a scope narrowing when it is a real
    schema key and the selection is "original"; it is never a reason to
    load a sample.

    Written defensively: ds.schema_cache can be None/{}/not a dict, and
    this must return a safe answer rather than raise - a raise here would
    break every chat request for that datasource."""
    try:
        schema_cache = ds.schema_cache if isinstance(ds.schema_cache, dict) else {}
        ids = [i for i in (requested_ids if isinstance(requested_ids, list) else []) if isinstance(i, str)]
        if not ids:
            ids = ["original"]
        if table:
            if ids == ["original"] and table in schema_cache:
                return "tables", [table], []
            return "unsupported", None, []
        if ids == ["original"]:
            return "all", None, []
        if all(i.startswith("sheet:") for i in ids):
            names: list[str] = []
            for i in ids:
                name = i[len("sheet:"):]
                if name not in schema_cache:
                    return "unsupported", None, []
                if name not in names:
                    names.append(name)
            return "tables", names, []
        if any(i.startswith("ds:") for i in ids):
            return "unsupported", None, []
        bare_ids = [i for i in ids if i != "original" and not i.startswith("sheet:")]
        versions: list = []
        if db is not None and bare_ids and ds.kind != "mongodb":
            rows = db.query(models.DatasetVersion).filter(models.DatasetVersion.id.in_(bare_ids)).all()
            by_id = {r.id: r for r in rows if r is not None}
            # Every bare id must be a saved-query version of THIS datasource
            # for the warehouse path; one file-backed (or foreign) version
            # means the whole selection cannot run inside the warehouse.
            if all(
                i in by_id and is_warehouse_query(by_id[i]) and by_id[i].datasource_id == ds.id
                for i in bare_ids
            ):
                versions = [by_id[i] for i in bare_ids]
        if versions:
            if "original" in ids:
                return "versions", None, versions
            names = []
            for i in ids:
                if i.startswith("sheet:"):
                    name = i[len("sheet:"):]
                    if name not in schema_cache:
                        return "unsupported", None, []
                    if name not in names:
                        names.append(name)
            # Only versions selected: scope_tables stays [] (no real table
            # in the writer's schema text - the versions are the tables).
            return "versions", names, versions
        is_live = lambda i: i == "original" or i.startswith("sheet:") or i.startswith("ds:")  # noqa: E731
        if not any(is_live(i) for i in ids):
            if db is not None and bare_ids and ds.kind != "mongodb":
                # A mix of saved-query and file-backed versions: neither
                # path can honour it.
                rows_by_id = {r.id: r for r in db.query(models.DatasetVersion).filter(models.DatasetVersion.id.in_(bare_ids)).all()}
                if any(is_warehouse_query(rows_by_id.get(i)) for i in bare_ids):
                    return "unsupported", None, []
            return "saved_only", None, []
        return "unsupported", None, []
    except Exception as e:
        print(f"[chat] _resolve_warehouse_selection could not evaluate, treating as unsupported: {e}")
        return "unsupported", None, []


def _scope_manifest(ds: models.DataSource, mode: str, scope_tables: list[str] | None, versions=None) -> list[dict]:
    """The sources manifest (see _load_selected_tables' docstring for the
    shape) for a warehouse-computed turn: one entry per scoped table, in
    the same kind/sheet/datasource_id terms the Flow tab's lineage and
    Workspace.tsx's restore-on-refresh already understand - the label of
    the in-memory `tables` dict ("Query result") is NOT what either keys
    off, so changing it is lineage-safe. Saved-query versions in scope
    (2026-10-06) appear as the same "version" entries _load_selected_tables
    writes for a file-backed saved table."""
    out: list[dict] = []
    if mode == "versions":
        if scope_tables is None:
            out.append({"kind": "original", "label": "Original data", "datasource_id": ds.id, "version_id": None, "sheet": None})
        else:
            out.extend(
                {"kind": "sheet", "label": name, "datasource_id": ds.id, "version_id": None, "sheet": name}
                for name in scope_tables
            )
        out.extend(
            {"kind": "version", "label": v.name, "datasource_id": ds.id, "version_id": v.id, "sheet": None}
            for v in (versions or [])
        )
        return out
    if mode == "tables" and scope_tables:
        return [
            {"kind": "sheet", "label": name, "datasource_id": ds.id, "version_id": None, "sheet": name}
            for name in scope_tables
        ]
    return [{"kind": "original", "label": "Original data", "datasource_id": ds.id, "version_id": None, "sheet": None}]


_NEEDS_QUERY_HELP_REPLIES = {
    "restricted_role": (
        "Your access to this data source is limited by row/column rules, and a question against a live "
        "warehouse table runs inside the warehouse where those rules cannot be applied - so I haven't "
        "produced an answer, and I won't estimate from a sample. Ask a workspace admin to run it, or work "
        "from a saved table instead."
    ),
    "unsupported_selection": (
        "For a live warehouse table, questions run inside the warehouse itself - and this selection mixes "
        "in something I can't query there yet (a saved table or another data source). Pick just this "
        "source's own table(s) and ask again, or work from the saved table on its own."
    ),
    "daily_budget": (
        "Today's warehouse query budget for your account is already used up, so I haven't run this - I "
        "won't estimate from a sample instead. It resets at midnight UTC; you can still write the query "
        "yourself to run tomorrow."
    ),
    "empty_schema": (
        "I don't have this data source's table and column list yet, so I can't write a query that runs "
        "inside your warehouse - and I won't estimate from a sample. Reconnect or refresh the data source "
        "and ask again."
    ),
    "needs_table": (
        "This asks for a new table of rows (a clean-up, filter or transformation) rather than a summary. "
        "Creating a new table from a live warehouse source is coming in the next update - for now I can "
        "answer summary questions (totals, breakdowns, top-N) that run inside your warehouse. Ask one of "
        "those, or write the SQL yourself below."
    ),
    "table_failed": (
        "I couldn't write a safe query that builds this table inside your {provider} warehouse (what I "
        "tried is shown below), so no table was created - and I won't build one from a sample. Rephrase "
        "what the new table should contain, or write the SELECT yourself and save it as a table."
    ),
    "not_possible": (
        "I couldn't turn this into a query that runs inside your {provider} table - usually because it "
        "needs a column or table that isn't in this source. I haven't produced an answer, and I won't "
        "estimate from a sample. Finish it below, rephrase, or write the SQL yourself."
    ),
    "builder_or_raw_failed": (
        "That query didn't run inside your {provider} table (the error is shown below), so I haven't "
        "produced an answer - I won't estimate from a sample. Adjust it and try again."
    ),
}
_DEFAULT_NEEDS_QUERY_HELP_REPLY = (
    "I couldn't turn this into a query that runs inside your {provider} table, so I haven't produced an "
    "answer - I won't estimate from a sample. Finish it below, rephrase, or write the SQL yourself."
)
_PROVIDER_LABELS = {
    "bigquery": "BigQuery", "snowflake": "Snowflake", "postgres": "Postgres", "mysql": "MySQL",
    "sqlserver": "SQL Server", "supabase": "Supabase", "mongodb": "MongoDB",
}


def _needs_query_help_response(
    db: Session, conversation_id: str, ds: models.DataSource, prompt: str, outcome: PushdownOutcome | None,
    scope_tables: list[str] | None, skipped_reason: str | None, reply_key: str | None = None,
    suggest: bool = True, versions=None,
) -> schemas.ChatResponse:
    """The one honest "not computed yet" response for a warehouse kind -
    persisted as action="needs_query_help" with code=None, the attempts
    JSON and the skipped reason, and returned with everything the
    frontend needs to let the person finish the question: the attempts
    (sql+status+error), a validated builder prefill (SQL kinds only -
    never for MongoDB, never for a restricted role), and the scoped
    tables' columns. Nothing was loaded or analyzed: used_pushdown=False,
    sample_row_count=None, no chart, no insight."""
    provider = _PROVIDER_LABELS.get(ds.kind, ds.kind)
    attempts = list(outcome.attempts) if outcome else []
    reason = skipped_reason or (outcome.skipped_reason if outcome else None)
    key = reply_key or reason
    reply = (_NEEDS_QUERY_HELP_REPLIES.get(key or "") or _DEFAULT_NEEDS_QUERY_HELP_REPLY).format(provider=provider)

    # 2026-10-06 ("generated data is a saved query" layer): saved-query
    # versions in scope are offered to the builder as tables too, keyed by
    # sql_alias - the builder's SQL is wrapped in their CTEs when it runs.
    builder_schema, _aliases = query_builder.with_version_aliases(ds.schema_cache, versions)
    builder_scope = None
    if scope_tables is not None or versions:
        real_tables = scope_tables if scope_tables is not None else list((ds.schema_cache or {}).keys() if isinstance(ds.schema_cache, dict) else [])
        builder_scope = list(real_tables) + [v.sql_alias for v in (versions or []) if v.sql_alias]
    builder_columns = query_builder.builder_columns(builder_schema, builder_scope) or None
    builder_suggestion = None
    # MongoDB: the builder is SQL-only for now, so no prefill - the frontend
    # shows rephrase/try again only. A restricted role must not be handed a
    # builder either: the builder's query would run inside the warehouse,
    # outside this app's row/column filtering, exactly like AI pushdown.
    if suggest and ds.kind in query_builder.SQL_KINDS and reason not in ("restricted_role", "daily_budget", "empty_schema"):
        try:
            schema_text = _warehouse_schema_text(ds, scope_tables, versions)
            raw_spec = ai_engine.suggest_query_spec(prompt, schema_text) if schema_text.strip() else None
            if raw_spec:
                builder_suggestion = query_builder.sanitize_suggested_spec(raw_spec, builder_schema)
                if builder_suggestion and builder_scope and builder_suggestion.get("table") not in builder_scope:
                    # The model reached for a table outside the selection -
                    # drop the suggestion rather than widen the scope.
                    builder_suggestion = None
        except Exception as e:
            print(f"[chat] builder suggestion failed (non-fatal): {e}")
            builder_suggestion = None

    return _persist_and_respond(
        db, conversation_id, reply,
        action="needs_query_help",
        needs_clarification=False,
        ok=True,
        code=None,
        sources=_scope_manifest(ds, "versions" if versions else ("tables" if scope_tables else "all"), scope_tables, versions),
        duration_ms=outcome.duration_ms if outcome else None,
        used_pushdown=False,
        sample_row_count=None,
        pushdown_attempts=attempts,
        pushdown_skipped_reason=reason,
        pushdown_duration_ms=outcome.duration_ms if outcome else None,
        pushdown_provider=ds.kind,
        builder_suggestion=builder_suggestion,
        builder_columns=builder_columns,
    )


# --- Saved-query tables (2026-10-06, "generated data is a saved query") ----
# For a SQL warehouse kind (PUSHDOWN_ELIGIBLE_KINDS minus mongodb) a request
# for a NEW TABLE OF ROWS - "keep only non-canceled bookings and add a total
# nights column" - is not answered by copying rows into the app. It becomes
# ONE standalone, read-only SELECT (the table's definition) stored on a
# DatasetVersion(source_kind="warehouse_query") and re-run inside the
# warehouse whenever the table is profiled, sampled, downloaded or asked a
# follow-up question (its definition is wrapped as a CTE - see
# _execute_sql_attempt's `ctes`). See services/warehouse_tables.py for every
# text helper and models.DatasetVersion.source_kind for the columns.
#
# The path, in order: generate (ai_engine.generate_warehouse_table_sql) ->
# assert_read_only_sql -> inline the scope's CTEs so the definition is
# standalone -> validate without reading a row (BigQuery dry run, else the
# dialect's zero-row statement) and capture the result schema -> one
# bounded retry with the exact error, exactly like pushdown -> one
# COUNT(*) (billable on BigQuery, through the same audit log/daily budget;
# a failure here leaves row_count null, never fails creation) -> create the
# version. "Save as a real BigQuery table" (CTAS) is deliberately NOT here:
# this layer never writes to a customer warehouse.

_TABLE_KINDS = _SQL_PUSHDOWN_KINDS


@dataclass
class TableOutcome:
    """What one saved-query creation cycle did. `version` is the created
    DatasetVersion on success; `attempts` mirrors PushdownOutcome.attempts
    (status: "validated" | "rejected_unsafe" | "error" | "not_possible" |
    "generation_failed"); `skipped_reason` is "daily_budget" |
    "empty_schema" | None."""
    version: object = None
    definition_sql: str | None = None
    columns: list = field(default_factory=list)
    row_count: int | None = None
    source_row_count: int | None = None
    bytes_scanned: int | None = None
    duration_ms: int = 0
    attempts: list = field(default_factory=list)
    skipped_reason: str | None = None

    @property
    def ok(self) -> bool:
        return self.version is not None


def _describe_definition(ds: models.DataSource, definition_sql: str) -> tuple[list[dict], int | None]:
    """Validates a definition inside the warehouse WITHOUT reading a row
    and returns (columns_json, estimated_bytes|None): BigQuery's free dry
    run (estimated bytes too), Snowflake `LIMIT 0`, the SQL kinds' `WHERE
    1=0`/`TOP 0` - see each connector's describe_query. Raises the
    warehouse's own error for an invalid definition (handed to the writer
    for its one bounded retry)."""
    info = ds.connection_info or {}
    if ds.kind == "bigquery":
        service_account_json = security.decrypt_secret(ds.encrypted_secret)
        connector = BigQueryConnector(info["project_id"], info["dataset_id"], service_account_json)
        return connector.describe_query(definition_sql)
    if ds.kind == "snowflake":
        creds = json.loads(security.decrypt_secret(ds.encrypted_secret))
        connector = SnowflakeConnector(
            account=info["account"], warehouse=info["warehouse"], database=info["database"],
            db_schema=info.get("db_schema"), role=info.get("role"),
            username=creds["username"], password=creds["password"],
        )
        return connector.describe_query(definition_sql, statement_timeout_seconds=settings.SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS), None
    if ds.kind in ("postgres", "mysql", "sqlserver", "supabase"):
        username, password = security.decrypt_secret(ds.encrypted_secret).split("␟")
        connector = SQLConnector(ds.kind, info["host"], info["port"], info["database"], username, password, info.get("ssl", True))
        return connector.describe_query(definition_sql), None
    raise ValueError(f"_describe_definition does not handle kind {ds.kind!r}")


def _validate_definition(
    db: Session, ds: models.DataSource, user_id: str, statement_sql: str, ctes: list[tuple[str, str]],
    is_retry: bool,
) -> dict:
    """One validation of a candidate table definition. Returns
    {"definition_sql", "columns", "estimated_bytes", "attempt"} on success
    or {"retry": bool, "attempt": {...}} on failure - the attempt's "sql"
    is the standalone definition (CTEs inlined) that was checked."""
    try:
        assert_read_only_sql(statement_sql)
        definition_sql = warehouse_tables.wrap_with_ctes(statement_sql, ctes)
        if definition_sql != statement_sql:
            assert_read_only_sql(definition_sql)
    except ReadOnlyViolation as e:
        _log_pushdown(db, user_id, ds.id, ds.kind, statement_sql, None, "rejected_unsafe", str(e))
        return {"retry": not is_retry, "attempt": {"sql": statement_sql, "status": "rejected_unsafe", "error": str(e)}}
    except Exception as e:
        _log_pushdown(db, user_id, ds.id, ds.kind, statement_sql, None, "error", str(e))
        return {"retry": not is_retry, "attempt": {"sql": statement_sql, "status": "error", "error": str(e)}}
    try:
        columns, estimated = _describe_definition(ds, definition_sql)
    except ReadOnlyViolation as e:
        _log_pushdown(db, user_id, ds.id, ds.kind, definition_sql, None, "rejected_unsafe", str(e))
        return {"retry": not is_retry, "attempt": {"sql": definition_sql, "status": "rejected_unsafe", "error": str(e)}}
    except Exception as e:
        print(f"[chat] {ds.kind} table definition failed validation{' (retry)' if is_retry else ''}: {e}")
        _log_pushdown(db, user_id, ds.id, ds.kind, definition_sql, None, "error", str(e))
        return {"retry": not is_retry, "attempt": {"sql": definition_sql, "status": "error", "error": str(e)}}
    if not columns:
        err = "The query returned no columns."
        _log_pushdown(db, user_id, ds.id, ds.kind, definition_sql, None, "error", err)
        return {"retry": not is_retry, "attempt": {"sql": definition_sql, "status": "error", "error": err}}
    # The dry run / zero-row check is not billed - logged as "validated"
    # (not "ok") so it never counts toward the daily scanned-bytes budget.
    _log_pushdown(db, user_id, ds.id, ds.kind, definition_sql, None, "validated")
    return {
        "definition_sql": definition_sql, "columns": columns, "estimated_bytes": estimated,
        "attempt": {"sql": definition_sql, "status": "validated", "error": None},
    }


def _count_definition_rows(db: Session, ds: models.DataSource, user_id: str, definition_sql: str) -> tuple[int | None, int | None]:
    """(row_count, bytes_scanned) from ONE `SELECT COUNT(*) FROM
    (<definition>) AS gd360_v` through the shared chokepoint (same guards,
    same audit row, same daily budget). Never raises: (None, None) when it
    could not run - a saved table with an unknown row count is still a
    valid saved table (the Data-tab profile fills it in later)."""
    try:
        res = _execute_sql_attempt(db, ds, user_id, warehouse_tables.count_sql(ds.kind, definition_sql), is_retry=True)
        if "df" in res:
            return warehouse_tables.count_from_frame(res["df"]), res.get("bytes_scanned")
    except Exception as e:
        print(f"[chat] row count for a new saved query failed (non-fatal): {e}")
    return None, None


def _version_sql_aliases(db: Session, ds: models.DataSource) -> set[str]:
    rows = db.query(models.DatasetVersion.sql_alias).filter(models.DatasetVersion.datasource_id == ds.id).all()
    out: set[str] = set()
    for row in rows or []:
        alias = row[0] if isinstance(row, (tuple, list)) else getattr(row, "sql_alias", row)
        if isinstance(alias, str) and alias:
            out.add(alias)
    return out


def _source_row_count(ds: models.DataSource, scope_tables: list[str] | None, versions, source_table: str | None) -> int | None:
    """rows_before for a new saved query, when honestly known: a single
    parent version's own row_count, else the Data-tab profile's cached
    COUNT(*) of the one real table it reads - never a fresh query."""
    if versions and len(versions) == 1 and getattr(versions[0], "row_count", None) is not None:
        return int(versions[0].row_count)
    if versions:
        return None
    if source_table:
        return cached_exact_total_rows(ds.id, source_table)
    return None


def _create_version_from_definition(
    db: Session, ds: models.DataSource, prompt: str, name: str, definition_sql: str, columns: list[dict],
    row_count: int | None, source_table: str | None, versions, scope_tables: list[str] | None,
    duration_ms: int | None, source_row_count: int | None, summary: str,
) -> models.DatasetVersion:
    """The DatasetVersion row for a saved query - numbered like
    _save_cleaning_result (position = max + 1), parent lineage = the
    selected saved-query versions when chaining, cleaning_log = the
    parents' log plus one entry shaped the way _save_cleaning_result
    writes it (so the Flow tab works unchanged), data = b"" (NOT NULL
    column, no file - see data_loader.is_warehouse_query)."""
    max_position = (
        db.query(func.max(models.DatasetVersion.position))
        .filter(models.DatasetVersion.datasource_id == ds.id)
        .scalar()
        or 0
    )
    parent_ids = [v.id for v in (versions or [])] or None
    prior_log: list = []
    for v in versions or []:
        prior_log.extend(v.cleaning_log or [])
    log_entry = {
        "prompt": prompt,
        "summary": summary,
        "rows_before": source_row_count,
        "rows_after": row_count,
        "nulls_before": None,
        "nulls_after": None,
        "created_at": datetime.utcnow().isoformat(),
        "source_kind": WAREHOUSE_QUERY_SOURCE_KIND,
        "query_sql": definition_sql,
    }
    alias = warehouse_tables.derive_sql_alias(name, _version_sql_aliases(db, ds))
    version = models.DatasetVersion(
        datasource_id=ds.id,
        name=name[:80],
        parent_version_id=parent_ids[0] if parent_ids else None,
        parent_version_ids=parent_ids,
        data=b"",
        cleaning_log=prior_log + [log_entry],
        position=max_position + 1,
        duration_ms=duration_ms,
        method_summary="Saved warehouse query",
        used_pushdown=True,
        sample_row_count=None,
        source_kind=WAREHOUSE_QUERY_SOURCE_KIND,
        query_sql=definition_sql,
        sql_alias=alias,
        source_table=source_table,
        columns_json=columns,
        row_count=row_count,
    )
    db.add(version)
    db.commit()
    db.refresh(version)
    return version


def _build_warehouse_table(
    db: Session, ds: models.DataSource, user_id: str, prompt: str, scope_tables: list[str] | None, versions,
    raw_sql: str | None = None,
) -> TableOutcome:
    """Creates a saved-query table from `prompt` (the AI writes the
    definition, one bounded retry) or, with `raw_sql`, from the person's
    own SELECT (one validation, no model). See the section comment above
    for the full path. Never raises for a model/warehouse failure - a
    failed outcome carries the attempts."""
    started = time.perf_counter()
    outcome = TableOutcome()
    schema_text = _warehouse_schema_text(ds, scope_tables, versions)
    if not raw_sql and not schema_text.strip():
        outcome.skipped_reason = "empty_schema"
        return outcome
    if _daily_budget_exhausted(db, ds, user_id):
        outcome.skipped_reason = "daily_budget"
        return outcome
    ctes = _version_ctes(versions)
    name_hint: str | None = None

    def _attempt(is_retry: bool, previous_sql: str | None = None, previous_error: str | None = None) -> dict:
        nonlocal name_hint
        if raw_sql:
            statement = warehouse_tables.strip_trailing_semicolon(raw_sql)
            if not statement:
                outcome.attempts.append({"sql": None, "status": "not_possible", "error": None})
                return {"retry": False}
        else:
            try:
                raw = ai_engine.generate_warehouse_table_sql(
                    prompt, schema_text, ds.kind, previous_sql=previous_sql, previous_error=previous_error
                )
            except Exception as e:
                print(f"[chat] {ds.kind} table definition generation failed{' (retry)' if is_retry else ''}: {e}")
                outcome.attempts.append({"sql": None, "status": "generation_failed", "error": str(e)})
                return {"retry": False}
            statement, parsed_name = warehouse_tables.parse_table_sql_response(raw)
            if parsed_name and not name_hint:
                name_hint = parsed_name
            if not statement:
                outcome.attempts.append({"sql": None, "status": "not_possible", "error": None})
                return {"retry": False}
        res = _validate_definition(db, ds, user_id, statement, ctes, is_retry=is_retry)
        outcome.attempts.append(res["attempt"])
        if "definition_sql" in res:
            return res
        return {"retry": bool(res.get("retry")) and not raw_sql, "sql": statement, "error": res["attempt"].get("error")}

    try:
        first = _attempt(is_retry=False)
        final = first
        if "definition_sql" not in first and first.get("retry"):
            final = _attempt(is_retry=True, previous_sql=first["sql"], previous_error=first["error"])
        if "definition_sql" in final:
            definition_sql = final["definition_sql"]
            columns = final["columns"]
            row_count, count_bytes = _count_definition_rows(db, ds, user_id, definition_sql)
            schema_keys = list(ds.schema_cache.keys()) if isinstance(ds.schema_cache, dict) else []
            source_table = None
            if versions:
                source_table = next((v.source_table for v in versions if getattr(v, "source_table", None)), None)
            if not source_table:
                source_table = warehouse_tables.detect_source_table(definition_sql, scope_tables or schema_keys)
            source_row_count = _source_row_count(ds, scope_tables, versions, source_table)
            name = (name_hint or warehouse_tables.derive_table_name(prompt))
            duration_ms = int((time.perf_counter() - started) * 1000)
            summary = _table_summary(name, columns, row_count, source_row_count, source_table, bool(raw_sql))
            version = _create_version_from_definition(
                db, ds, prompt, name, definition_sql, columns, row_count, source_table, versions, scope_tables,
                duration_ms, source_row_count, summary,
            )
            outcome.version = version
            outcome.definition_sql = definition_sql
            outcome.columns = columns
            outcome.row_count = row_count
            outcome.source_row_count = source_row_count
            outcome.bytes_scanned = count_bytes if count_bytes is not None else final.get("estimated_bytes")
    except Exception as e:
        print(f"[chat] {ds.kind} saved-query creation raised unexpectedly: {e}")
        outcome.attempts.append({"sql": None, "status": "error", "error": str(e)})
    outcome.duration_ms = int((time.perf_counter() - started) * 1000)
    return outcome


def _table_summary(
    name: str, columns: list[dict], row_count: int | None, source_row_count: int | None, source_table: str | None,
    from_raw_sql: bool,
) -> str:
    """The plain narrative for a new saved query - what it is, where it
    runs, and the row count when known ("75,166 of 119,386 rows kept")."""
    how = "the SQL you wrote" if from_raw_sql else "one query"
    parts = [f"Saved \"{name}\" as a query, not a copy - {how} that runs inside your warehouse"]
    if source_table:
        parts[-1] += f" on top of {source_table}"
    parts[-1] += "; nothing was downloaded."
    if row_count is not None and source_row_count:
        pct = round(100 * row_count / source_row_count) if source_row_count else None
        parts.append(f"{row_count:,} of {source_row_count:,} rows kept" + (f" ({pct}%)." if pct is not None else "."))
    elif row_count is not None:
        parts.append(f"{row_count:,} rows.")
    else:
        parts.append("Its exact row count will appear once the Data tab profiles it.")
    if columns:
        parts.append(f"{len(columns)} columns.")
    return " ".join(parts)


def _warehouse_table_response(
    db: Session, conversation_id: str, ds: models.DataSource, prompt: str, outcome: TableOutcome,
    scope_mode: str, scope_tables: list[str] | None, versions,
) -> schemas.ChatResponse:
    """The transform turn for a created saved query - persisted and
    returned exactly like a file-backed transform (new_version_id/name,
    code=None) plus the warehouse disclosure fields (used_pushdown=True,
    pushdown_sql = the definition, pushdown_result_rows = row_count)."""
    v = outcome.version
    reply = (v.cleaning_log or [{}])[-1].get("summary") or f"Saved \"{v.name}\" as a query inside your warehouse."
    return _persist_and_respond(
        db, conversation_id, reply,
        action="transform",
        needs_clarification=False,
        ok=True,
        rows_before=outcome.source_row_count,
        rows_after=outcome.row_count,
        new_version_id=v.id,
        new_version_name=v.name,
        code=None,
        sources=_scope_manifest(ds, scope_mode, scope_tables, versions),
        duration_ms=outcome.duration_ms,
        method_summary="Saved warehouse query",
        used_pushdown=True,
        sample_row_count=None,
        pushdown_sql=outcome.definition_sql,
        pushdown_provider=ds.kind,
        pushdown_bytes_scanned=outcome.bytes_scanned,
        pushdown_duration_ms=outcome.duration_ms,
        pushdown_result_rows=outcome.row_count,
        pushdown_attempts=list(outcome.attempts),
        exact_total_rows=outcome.row_count,
    )


def _table_failed_response(
    db: Session, conversation_id: str, ds: models.DataSource, prompt: str, outcome: TableOutcome,
    scope_tables: list[str] | None, versions,
) -> schemas.ChatResponse:
    """needs_query_help for a saved query that could not be built: the
    attempts, reason "table_failed" (or the budget/schema skip reason),
    builder_suggestion always None (an aggregate builder cannot define a
    table of rows)."""
    pseudo = PushdownOutcome(attempts=list(outcome.attempts), duration_ms=outcome.duration_ms)
    reason = outcome.skipped_reason or "table_failed"
    return _needs_query_help_response(
        db, conversation_id, ds, prompt, pseudo, scope_tables, reason, reply_key=reason, suggest=False,
        versions=versions,
    )


@router.post("", response_model=schemas.ChatResponse)
def chat(payload: ChatRequestFull, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _check_rate_limit(user.id)

    ds = db.query(models.DataSource).filter(models.DataSource.id == payload.datasource_id).first()
    if not ds or not workspace_access.can_access_datasource(db, ds, user):
        raise HTTPException(404, "Datasource not found.")
    # Running an analysis is a write action (it can save a new table,
    # persists a conversation/message) - editable tier, so a workspace
    # "viewer" (2026-09-23) sees this data source everywhere else but can't
    # chat/analyze against it.
    if not workspace_access.can_edit_datasource(db, ds, user):
        raise HTTPException(403, "You have view-only access to this data source.")
    ensure_legacy_migrated(db, ds)

    conversation = _get_or_create_conversation(db, user, payload.conversation_id, ds.id, payload.prompt)

    user_msg = models.Message(conversation_id=conversation.id, role="user", content=payload.prompt)
    db.add(user_msg)
    db.commit()

    # The person picks which saved table(s) - or the original data - this
    # prompt runs against, never inferred silently: "original" always means
    # this datasource's untouched data, a bare id is a DatasetVersion.id
    # (any datasource the person owns, not just this one - see
    # _load_selected_tables), "sheet:<name>" is one specific sheet of THIS
    # datasource when it is a multi-sheet Excel workbook, and
    # "ds:<other_datasource_id>:original" / "ds:<other_datasource_id>:
    # sheet:<name>" pulls in another, separately-connected data source's
    # own original data or a specific sheet of it - the "+ Add more data"
    # picker in the chat panel. Picking more than one lets a single prompt
    # compare or combine several tables (from one datasource or several) at
    # once; each entry is only loaded once even if listed twice.
    requested_ids = payload.source_version_ids or ["original"]

    # --- Warehouse policy (2026-10-06, warehouse-honesty round) ---------
    # For a warehouse/database kind (PUSHDOWN_ELIGIBLE_KINDS) the answer is
    # computed inside the warehouse over every row, or it is not computed
    # at all - never on a loaded sample. See the module comment above
    # _multi_table_schema_text. The three ways a warehouse question runs:
    #   1. the AI writes one SQL/pipeline (_run_warehouse_pushdown, one
    #      bounded retry),
    #   2. the person's structured query_builder spec, turned into SQL
    #      deterministically (services/query_builder.py, no LLM),
    #   3. the person's own raw_sql,
    # all through the same execution chokepoint (_execute_sql_attempt) and
    # the same guards. When none produced a result, the reply is
    # action="needs_query_help" (see _needs_query_help_response) and
    # nothing is loaded or analyzed.
    #
    # Phase 5, Batch B (data governance & quality - row/column permissions):
    # a pushdown query runs directly inside the customer's own warehouse/
    # database/Mongo server and its result never passes through
    # load_dataframe, so it can never be filtered by services/
    # data_access_rules.filter_dataframe_for_role after the fact. The only
    # correct fix is to never attempt pushdown at all for a restricted
    # role - see that module's own docstring. Before this round a
    # restricted caller fell through to the sample path; under the
    # no-samples policy that is no longer allowed either, so a restricted
    # role on a warehouse kind gets needs_query_help (restricted_role) -
    # and, for the same reason, neither the builder nor raw_sql may run
    # for them (both would also execute inside the warehouse, unfiltered).
    warehouse_outcome: PushdownOutcome | None = None
    warehouse_scope: list[str] | None = None
    warehouse_scope_mode: str | None = None
    finish_note: str | None = None  # extra context for analyze() on a builder/raw_sql turn
    is_warehouse_kind = ds.kind in PUSHDOWN_ELIGIBLE_KINDS

    wants_finish_path = payload.query_builder is not None or bool(payload.raw_sql)
    if wants_finish_path and not is_warehouse_kind:
        raise HTTPException(400, "A query builder or SQL request only applies to a warehouse or database data source.")

    # 2026-10-06 ("generated data is a saved query" layer): the saved-query
    # DatasetVersions in scope (see _resolve_warehouse_selection) - the
    # question runs with their definitions wrapped as CTEs, and a new
    # table built from them inlines those definitions.
    warehouse_versions: list = []
    is_table_kind = ds.kind in _TABLE_KINDS

    if is_warehouse_kind:
        warehouse_scope_mode, warehouse_scope, warehouse_versions = _resolve_warehouse_selection(
            db, ds, requested_ids, payload.table
        )
        if payload.save_as_table and not is_table_kind:
            raise HTTPException(400, "Saving a query as a table is SQL-only for now; MongoDB sources are not supported yet.")
        if warehouse_scope_mode == "saved_only" and not wants_finish_path:
            # Every entry is a saved DatasetVersion - a complete CSV in the
            # app, not a sample - so today's pandas path below is kept as
            # is (row/column rules are applied there by _load_selected_
            # tables). The only warehouse-specific difference: no
            # merge-fallback reload of the live table (see the
            # `original_df is None` block further down), since that would
            # be a sample.
            pass
        elif data_access_rules.has_active_restrictions(db, ds, user):
            return _needs_query_help_response(
                db, conversation.id, ds, payload.prompt, None, warehouse_scope, "restricted_role", suggest=False,
            )
        elif payload.query_builder is not None:
            # Deterministic builder: validate every identifier against the
            # schema (HTTP 400 on anything unknown), render SQL for this
            # dialect, run it once through the shared chokepoint. The spec
            # names its own table, so the WORKING ON selection only matters
            # as a consistency check when it was itself a table selection.
            # A saved-query version in scope is a valid builder table too
            # (by sql_alias - query_builder.with_version_aliases); its SQL
            # is wrapped in the scope's CTEs when it runs.
            builder_schema, alias_tables = query_builder.with_version_aliases(ds.schema_cache, warehouse_versions)
            try:
                built_sql, built_spec = query_builder.build_sql(
                    payload.query_builder, ds.kind, builder_schema, ds.connection_info, alias_tables
                )
            except query_builder.QueryBuilderError as e:
                raise HTTPException(400, str(e))
            if warehouse_scope_mode == "tables" and warehouse_scope and built_spec["table"] not in warehouse_scope:
                raise HTTPException(400, "The query builder's table is not part of the current WORKING ON selection.")
            if warehouse_scope_mode == "versions":
                allowed = set(warehouse_scope or []) | alias_tables
                if warehouse_scope is not None and built_spec["table"] not in allowed:
                    raise HTTPException(400, "The query builder's table is not part of the current WORKING ON selection.")
            else:
                warehouse_scope = [built_spec["table"]]
                warehouse_scope_mode = "tables"
            warehouse_outcome = _run_prewritten_sql(db, ds, user.id, built_sql, ctes=_version_ctes(warehouse_versions))
            if not warehouse_outcome.ok:
                return _needs_query_help_response(
                    db, conversation.id, ds, payload.prompt, warehouse_outcome, warehouse_scope,
                    warehouse_outcome.skipped_reason, reply_key=warehouse_outcome.skipped_reason or "builder_or_raw_failed",
                    suggest=False, versions=warehouse_versions,
                )
            finish_note = (
                "This table is the already-computed result of a query the person built themselves and ran inside "
                f"their {_PROVIDER_LABELS.get(ds.kind, ds.kind)} warehouse over every row: "
                f"{query_builder.describe_spec(built_spec)}. Chart and describe this result as-is; do not "
                "re-derive, re-aggregate or second-guess it."
            )
        elif payload.raw_sql:
            if ds.kind == "mongodb":
                raise HTTPException(400, "Writing your own query is SQL-only for now; MongoDB sources are not supported yet.")
            if warehouse_scope_mode not in ("tables", "versions"):
                warehouse_scope, warehouse_scope_mode = None, "all"
            if payload.save_as_table:
                # 2026-10-06 ("generated data is a saved query" layer): the
                # person's own SELECT becomes a saved-query table - validated
                # exactly like an AI-written definition, never charted.
                table_outcome = _build_warehouse_table(
                    db, ds, user.id, payload.prompt, warehouse_scope, warehouse_versions, raw_sql=payload.raw_sql,
                )
                if not table_outcome.ok:
                    return _table_failed_response(
                        db, conversation.id, ds, payload.prompt, table_outcome, warehouse_scope, warehouse_versions,
                    )
                return _warehouse_table_response(
                    db, conversation.id, ds, payload.prompt, table_outcome, warehouse_scope_mode or "all",
                    warehouse_scope, warehouse_versions,
                )
            warehouse_outcome = _run_prewritten_sql(
                db, ds, user.id, payload.raw_sql.strip(), ctes=_version_ctes(warehouse_versions)
            )
            if not warehouse_outcome.ok:
                return _needs_query_help_response(
                    db, conversation.id, ds, payload.prompt, warehouse_outcome, warehouse_scope,
                    warehouse_outcome.skipped_reason, reply_key=warehouse_outcome.skipped_reason or "builder_or_raw_failed",
                    suggest=False, versions=warehouse_versions,
                )
            finish_note = (
                "This table is the already-computed result of SQL the person wrote themselves and ran inside "
                f"their {_PROVIDER_LABELS.get(ds.kind, ds.kind)} warehouse over every row. Chart and describe this "
                "result as-is; do not re-derive, re-aggregate or second-guess it."
            )
        elif warehouse_scope_mode == "unsupported":
            return _needs_query_help_response(
                db, conversation.id, ds, payload.prompt, None, None, "unsupported_selection", suggest=False,
            )
        else:
            # 2026-10-06 ("generated data is a saved query" layer): the
            # guided "clean" step is, by definition, a request for a new
            # table of rows - go straight to the table-definition writer
            # for a SQL warehouse kind (MongoDB keeps today's pipeline
            # path and its interim needs_table card).
            warehouse_outcome = None
            if not (is_table_kind and payload.intent == "clean"):
                warehouse_outcome = _run_warehouse_pushdown(
                    db, ds, user.id, payload.prompt, warehouse_scope, versions=warehouse_versions
                )
            if warehouse_outcome is None or (
                not warehouse_outcome.ok and warehouse_outcome.skipped_reason == "needs_table" and is_table_kind
            ):
                # The summary writer said NEEDS_TABLE (or the step is
                # "clean"): build the table as a saved query instead of
                # the old interim card. Its own attempts are appended after
                # the summary writer's so the person sees the whole story.
                table_outcome = _build_warehouse_table(
                    db, ds, user.id, payload.prompt, warehouse_scope, warehouse_versions,
                )
                if warehouse_outcome is not None:
                    table_outcome.attempts = list(warehouse_outcome.attempts) + list(table_outcome.attempts)
                if not table_outcome.ok:
                    return _table_failed_response(
                        db, conversation.id, ds, payload.prompt, table_outcome, warehouse_scope, warehouse_versions,
                    )
                return _warehouse_table_response(
                    db, conversation.id, ds, payload.prompt, table_outcome, warehouse_scope_mode or "all",
                    warehouse_scope, warehouse_versions,
                )
            if not warehouse_outcome.ok:
                return _needs_query_help_response(
                    db, conversation.id, ds, payload.prompt, warehouse_outcome, warehouse_scope,
                    warehouse_outcome.skipped_reason, versions=warehouse_versions,
                )

    if warehouse_outcome is not None and warehouse_outcome.ok:
        # The small, already-aggregated result is the ONLY table this turn
        # analyzes - labelled for what it is. Nothing downstream keys off
        # the literal "Original data" label (verified: learned_answers
        # fingerprints column names, the Flow tab/Workspace restore read
        # the manifest's kind/sheet/datasource_id, not the label), so this
        # is lineage-safe. original_df stays None on purpose: a warehouse
        # turn has no in-app copy of the real data to offer as a
        # merge-fallback reference, and loading one would be a sample.
        tables = {"Query result": warehouse_outcome.df}
        source_versions = []
        original_df = None
        sources_manifest = _scope_manifest(ds, warehouse_scope_mode or "all", warehouse_scope, warehouse_versions)
    else:
        try:
            tables, source_versions, original_df, sources_manifest = _load_selected_tables(
                db, user, ds, requested_ids, table=payload.table
            )
        except NeedsTableSelection as e:
            available_list = ", ".join(e.available)
            reply = f"This datasource has multiple tables/collections: {available_list}. Which one would you like to analyze?"
            return _persist_and_respond(db, conversation.id, reply, needs_clarification=True)

    # Merge-fallback reload of the original data - FILE-BASED KINDS ONLY.
    # When the person is working on a derived table, the original is also
    # loaded (best-effort, never blocks the request) so a prep step can
    # pull in a column that table is missing straight from there - see
    # ai_engine._schema_with_fallback. 2026-10-06 (warehouse-honesty
    # round): for a warehouse kind this reload is skipped outright. On a
    # warehouse-computed turn there is nothing to reload (the result IS
    # the answer); on a saved-tables-only turn, load_dataframe would pull
    # a row-capped SAMPLE of the live table and hand it to the model as a
    # reference table - which is analysis on a sample, exactly what the
    # policy forbids. Saved tables (complete CSVs) still analyze fine on
    # their own; they just no longer get a sampled "Original data" sidecar.
    if original_df is None and not is_warehouse_kind:
        try:
            original_df = load_dataframe(ds, table=payload.table, version="original", db=db)
            original_df = data_access_rules.filter_dataframe_for_role(db, original_df, ds, user)
        except Exception as e:
            print(f"[chat] Could not load original data as a merge fallback: {e}")
            original_df = None

    # used_pushdown / sample_row_count (see models.Message's docstring):
    #   None  - a file-based kind: "did it run inside your warehouse" does
    #           not apply; nothing to disclose.
    #   True  - a warehouse kind, answer computed inside the warehouse over
    #           every row (AI pushdown, the builder, or raw_sql).
    #   None  - a warehouse kind whose selection was saved tables only (no
    #           live table involved at all - complete CSVs, not samples).
    # 2026-10-06 (warehouse-honesty round): there is no `False` case left
    # on this path. A warehouse kind that could not run its query never
    # reaches here - it returned action="needs_query_help" above with
    # used_pushdown=False and sample_row_count=None, because nothing was
    # loaded. sample_row_count only ever described the sample path, which
    # warehouse kinds no longer take, so it is always None from here on.
    if not is_warehouse_kind:
        used_pushdown = None
    elif warehouse_outcome is not None and warehouse_outcome.ok:
        used_pushdown = True
    else:
        used_pushdown = None
    sample_row_count = None

    # What the insight writer needs to describe a warehouse-computed
    # result honestly (see ai_engine.analyze's `warehouse_context`):
    # never "n = <size of the tiny result>", never "sample". The real
    # total row count is cited only when a single table was scoped AND
    # the Data tab's profile already computed and cached it - never a
    # fresh COUNT(*) here (billable).
    warehouse_context = None
    exact_total_rows = None
    if used_pushdown:
        if warehouse_versions:
            # 2026-10-06: a question over exactly one saved query cites
            # that query's own exact row count (captured at creation or by
            # the Data-tab profile) - never the underlying table's.
            if len(warehouse_versions) == 1 and not warehouse_scope and warehouse_scope is not None:
                rc = getattr(warehouse_versions[0], "row_count", None)
                exact_total_rows = int(rc) if isinstance(rc, int) and not isinstance(rc, bool) else None
        elif warehouse_scope and len(warehouse_scope) == 1:
            exact_total_rows = cached_exact_total_rows(ds.id, warehouse_scope[0])
        elif not warehouse_scope and isinstance(ds.schema_cache, dict) and len(ds.schema_cache) == 1:
            exact_total_rows = cached_exact_total_rows(ds.id, next(iter(ds.schema_cache)))
        warehouse_context = {
            "provider": ds.kind,
            "exact_total_rows": exact_total_rows,
            "bytes_scanned": warehouse_outcome.bytes_scanned,
            "sql": warehouse_outcome.sql,
        }

    history = _recent_history(db, conversation.id)

    # Permanent, per-account memory (2026-09-22 - see services/
    # learned_answers.py for the full rationale): if this SAME person has
    # already answered this SAME question correctly before - in this
    # conversation or any earlier one - against a schema that still
    # matches exactly, hand that proven (action, narrative, code,
    # chart_type) to analyze() so it replays it directly instead of
    # asking the AI to write new code. Skipped on a skip_prep continuation
    # call (the "Continue -> run the analysis" click after a guided
    # pause) for the same reason the in-conversation version of this
    # already excludes it - see the persisted_code note further below:
    # that call's prompt text is the ORIGINAL question, not a fresh one,
    # and it must go straight into the paused analysis step, never get
    # rerouted into replaying a past turn instead.
    durable_repeat = None
    if not payload.skip_prep:
        durable_repeat = learned_answers.find_learned_answer(db, user.id, tables, payload.prompt)

    # Automatic cross-source context (2026-09-29): a lightweight, access-
    # checked list of every OTHER data source this person has connected -
    # names and column names only, never the actual data - so the model
    # can recognize a question needs a table it was not explicitly handed
    # and say so (action="needs_data") instead of guessing with the wrong
    # table or asking the person to manually add it via "+ Add more data"
    # when the answer to "which one" is already visible right here. See
    # ai_engine.SYSTEM_PROMPT's "Automatically finding data in another
    # connected source" rule and _other_sources_catalog's own docstring.
    exclude_ids = {ds.id} | {m.get("datasource_id") for m in sources_manifest if m.get("datasource_id")}
    # 2026-10-06 (warehouse-honesty round): on a warehouse-computed turn
    # the catalog is NOT offered. If the model answered needs_data, the
    # auto-expand below would call _load_selected_tables with this turn's
    # own requested_ids - loading a row-capped SAMPLE of the warehouse
    # table alongside the extra source. The result it was handed is the
    # whole answer; combining it with another source is a question for a
    # saved table, not this path.
    catalog = [] if used_pushdown else _other_sources_catalog(db, user, exclude_ids)

    # Semantic layer v1 (2026-09-30): this data source's own saved metric
    # glossary, handed to ai_engine.analyze so a question naming one of
    # these gets the exact same formula every dashboard KPI/gauge tile
    # built from it already uses - see models.MetricDefinition's own
    # docstring and services/metrics.py, the one shared place that
    # formula is actually resolved. Deliberately not re-fetched on the
    # auto-expand-with-more-data retry below (same as `catalog` is not),
    # since that retry is scoped to whatever NEW datasource was just
    # loaded, not this one.
    metric_definitions = _metric_definitions_for_datasource(db, ds.id)

    # Transformation layer v1 (2026-09-30): this data source's own saved
    # transforms (models.DataTransform), each one resolved against the
    # ORIGINAL data (already loaded above as `original_df`, best-effort).
    # Handed to ai_engine.analyze as two SEPARATE things, not pre-merged
    # into `tables` here - see that function's own transform_tables/
    # transform_definitions docstring for exactly why (merging here first
    # would make every one of these background saved tables count toward
    # "more than one table was selected for this request", a framing meant
    # for tables the person actually picked, not ones quietly available in
    # the background). A transform that can't currently resolve (a column
    # it references was renamed/removed, or the original data couldn't be
    # loaded at all) is silently left out, exactly like `catalog`'s own "no
    # usable schema, don't show it" tradeoff - never shown as a broken or
    # partial table.
    transform_tables: dict[str, object] = {}
    transform_glossary: list[dict] = []
    if original_df is not None:
        transform_rows = (
            db.query(models.DataTransform)
            .filter(models.DataTransform.datasource_id == ds.id)
            .order_by(models.DataTransform.name.asc())
            .all()
        )
        for t in transform_rows:
            result_df, error = apply_transform_steps(original_df, t.steps or [])
            if error or result_df is None or result_df.empty:
                continue
            key = t.name
            n = 2
            while key in tables or key in transform_tables:
                key = f"{t.name} ({n})"
                n += 1
            transform_tables[key] = result_df
            transform_glossary.append({
                "name": key, "description": t.description, "step_summary": describe_transform(t.steps or []),
            })

    # Flow tab transparency round: a real wall-clock measurement of this
    # turn's own analyze/transform call - never estimated - threaded
    # through to whatever it ends up creating (a DatasetVersion and/or a
    # Message) below, purely so the Flow tab can show something truer
    # than "recently" on its cards. Left running across the auto-expand
    # retry just below (when it happens) since that is still genuinely
    # part of this one turn's total work, not a separate one.
    _analyze_started_at = time.perf_counter()
    # On a warehouse-computed turn the prompt handed to analyze() carries a
    # short note saying the one table IS the already-computed answer (so
    # the chart/insight describe it rather than re-derive it). The person's
    # own message was already stored verbatim above; only the model sees
    # this note.
    analyze_prompt = payload.prompt
    if used_pushdown:
        if finish_note:
            analyze_prompt = f"{payload.prompt}\n\n(Context: {finish_note})"
        else:
            analyze_prompt = (
                f"{payload.prompt}\n\n(Context: the table \"Query result\" is the already-computed answer to this "
                f"question, produced by one query that ran inside the person's "
                f"{_PROVIDER_LABELS.get(ds.kind, ds.kind)} warehouse over every row. Chart and describe it as-is; "
                "do not re-derive or re-aggregate it unless the question clearly needs a further step on top.)"
            )
    try:
        result = ai_engine.analyze(
            analyze_prompt, tables, history=history, chart_override=payload.chart_override, intent=payload.intent,
            guided=(payload.analysis_mode == "guided"), skip_prep=payload.skip_prep, original_df=original_df,
            durable_repeat=durable_repeat, catalog=catalog, metric_definitions=metric_definitions,
            transform_tables=transform_tables, transform_definitions=transform_glossary,
            warehouse_context=warehouse_context,
        )
    except Exception as e:
        print(f"[chat] AI analysis failed: {e}")
        raise HTTPException(502, ai_engine.friendly_ai_error(e))

    if result.get("action") == "needs_data" and result.get("needs_datasource_ids") and not used_pushdown:
        # The model recognized this question needs a table from the
        # catalog above and named its id(s) instead of guessing or asking
        # the person - load it for real (through the exact same "ds:"
        # mechanism the "+ Add more data" picker already uses, so it gets
        # the same access checks and sheet/table resolution) and ask
        # again, once, with it available. Never retried a second time -
        # `catalog` is simply not passed on this second call below, so
        # the model cannot ask for yet another source and loop.
        extra_ids = [str(i) for i in result["needs_datasource_ids"] if i and str(i) not in exclude_ids]
        expanded = None
        if extra_ids:
            try:
                expanded = _load_selected_tables(
                    db, user, ds, list(requested_ids) + [f"ds:{i}:original" for i in extra_ids], table=payload.table
                )
            except HTTPException as e:
                print(f"[chat] Could not auto-load suggested datasource(s) {extra_ids}: {e.detail}")
        if expanded:
            tables, source_versions, original_df, sources_manifest = expanded
            added_names = [m["label"] for m in sources_manifest if m.get("datasource_id") in extra_ids]
            try:
                result = ai_engine.analyze(
                    payload.prompt, tables, history=history, chart_override=payload.chart_override,
                    intent=payload.intent, guided=(payload.analysis_mode == "guided"), skip_prep=payload.skip_prep,
                    original_df=original_df, durable_repeat=None,
                )
            except Exception as e:
                print(f"[chat] AI analysis failed after auto-loading more data: {e}")
                raise HTTPException(502, ai_engine.friendly_ai_error(e))
            if result.get("action") == "needs_data":
                # Defensive only - `catalog` is not passed on this second
                # call, so the model has nothing left to name, but never
                # let this internal marker itself reach the person as a
                # bare "Done." if it happens anyway.
                result = {
                    **result,
                    "action": "clarify",
                    "needs_clarification": True,
                    "clarifying_question": (
                        "I was not able to find the right data for this one - could you tell me more about "
                        "what you're looking for, or add the relevant source with \"+ Add more data\"?"
                    ),
                }
            if added_names and result.get("action") != "clarify":
                steps = [{
                    "label": f"Automatically connected {', '.join(added_names)}",
                    "detail": (
                        "This question needed data from another one of your connected sources, so it was "
                        "pulled in automatically instead of asking you to add it by hand first."
                    ),
                }] + list(result.get("steps") or [])
                result["steps"] = steps
        else:
            # Named a source but it could not actually be loaded (no
            # longer accessible, deleted, or every id was already
            # loaded/invalid) - a plain, honest clarifying question beats
            # ever letting this internal marker reach the person as an
            # empty "Done." reply.
            result = {
                **result,
                "action": "clarify",
                "needs_clarification": True,
                "clarifying_question": (
                    "This looks like it needs data from another connected source, but I could not load it "
                    "just now. Could you add it with \"+ Add more data\", or tell me more about what you're "
                    "looking for?"
                ),
            }
    elif result.get("action") == "needs_data":
        # Defensive only: on a warehouse-computed turn no catalog was
        # offered, so the model has nothing to name - but never let this
        # internal marker reach the person as a bare "Done.".
        result = {
            **result,
            "action": "clarify",
            "needs_clarification": True,
            "clarifying_question": (
                "This result was computed inside your warehouse from the selected table(s) only. To combine it "
                "with another data source, save it as a table first, then ask again with that table selected."
            ),
        }

    duration_ms = int((time.perf_counter() - _analyze_started_at) * 1000)
    method_summary = ai_engine._derive_method_summary(result.get("action"), result.get("chart_type"), result.get("code"))

    # Learn from this turn for next time - only when it was a genuine,
    # freshly AI-planned success (never a clarifying question, never a
    # paused step-by-step prep-only turn, and never a turn that was ITSELF
    # already answered from memory - see ai_engine.analyze's
    # _answered_from_memory marker - since there is nothing new to learn
    # from replaying something already learned). save_learned_answer is a
    # no-op for anything that is not a real analyze/transform result with
    # real code, and never raises - a failure here can never break the
    # response the person is waiting on.
    if (
        not result.get("needs_clarification")
        and not result.get("paused_for_continue")
        and not result.get("_answered_from_memory")
        # Semantic layer v1: a metric-backed answer is already a static,
        # exact definition (services/metrics.py) - there is nothing new
        # to "learn" from re-running the same phrasing again.
        and not result.get("_answered_from_metric_definition")
    ):
        learned_answers.save_learned_answer(
            db, user.id, tables, payload.prompt,
            result.get("action"), result.get("narrative"), result.get("code"), result.get("chart_type"),
        )

    # A "transform" always persists its result as a new saved table; so
    # does an "analyze" that had to prepare its own table first (see
    # ai_engine._run_analyze_with_prep) - either way, cleaned_df being set
    # is what means a real, executed table exists to save, regardless of
    # which action produced it.
    new_version = None
    if result.get("cleaned_df") is not None:
        new_version = _save_cleaning_result(
            db, ds, source_versions, payload.prompt, result,
            duration_ms=duration_ms, method_summary=method_summary,
            used_pushdown=used_pushdown, sample_row_count=sample_row_count,
        )

    # Named-results round (2026-09-28): when this turn's `results` are
    # several distinct, named analyses (see ai_engine's "Multiple results
    # in one answer"), also save each one as its own real, selectable
    # table - chained off the table it was actually built from (the new
    # prep table just saved above, when there was one; otherwise whatever
    # was originally selected for this turn) - and fold each saved
    # table's id/name back into the matching `results` entry the person
    # already sees, so the chat reply can show "Saved as <name>" right on
    # that card instead of the saving happening invisibly.
    results_out = result.get("results")
    named_tables = result.get("named_tables")
    if named_tables:
        parent_ids = [new_version.id] if new_version else ([v.id for v in source_versions] or None)
        saved_named = _save_named_results(
            db, ds, parent_ids, payload.prompt, named_tables,
            named_table_timing=result.get("named_table_timing"),
        )
        by_label = {s["label"]: s for s in saved_named}
        if results_out:
            results_out = [
                {**entry, **{k: v for k, v in by_label.get(entry.get("label"), {}).items() if k != "label"}}
                for entry in results_out
            ]

    reply_text = result.get("clarifying_question") or result.get("narrative") or "Done."
    if result.get("rows_before") is not None:
        rows_before = result.get("rows_before")
        rows_after = result.get("rows_after")
        nulls_before = result.get("nulls_before")
        nulls_after = result.get("nulls_after")
        arrow = "→"
        reply_text += f" ({rows_before} {arrow} {rows_after} rows, {nulls_before} {arrow} {nulls_after} missing values)"

    # Step-by-step mode stops right after preparation - hand back a single
    # clear button that continues into the actual analysis against the
    # table just prepared and saved, instead of silently going nowhere.
    continue_action = None
    if result.get("paused_for_continue") and new_version:
        continue_action = {
            "label": "Continue → run the analysis",
            "prompt": payload.prompt,
            "version_id": new_version.id,
        }

    # A paused turn only ran the preparation step, not a complete analysis -
    # its code is not something a later "give me the code" should hand
    # back, and, more importantly, it must never be stored as a
    # repeat-matchable marker (see ai_engine._find_repeated_prompt_code):
    # the "Continue" click re-sends this SAME question text, and if this
    # turn prep-only code were tagged as a real action=analyze marker, that
    # exact-repeat shortcut would wrongly replay just the preparation step
    # as if it were the whole analysis instead of actually continuing.
    persisted_code = None if result.get("paused_for_continue") else result.get("code")

    return _persist_and_respond(
        db, conversation.id, reply_text,
        action=result.get("action", "analyze"),
        chart_spec=result.get("chart_spec"),
        insight=result.get("insight"),
        suggestions={
            "charts": result.get("suggested_charts"),
            "stats": result.get("suggested_stats"),
            "follow_up": result.get("follow_up_suggestions"),
        },
        needs_clarification=result.get("needs_clarification", False),
        rows_before=result.get("rows_before"),
        rows_after=result.get("rows_after"),
        nulls_before=result.get("nulls_before"),
        nulls_after=result.get("nulls_after"),
        new_version_id=new_version.id if new_version else None,
        new_version_name=new_version.name if new_version else None,
        code=persisted_code,
        chart_type=result.get("chart_type"),
        continue_action=continue_action,
        result_columns=result.get("result_columns"),
        result_rows=result.get("result_rows"),
        result_truncated=result.get("result_truncated", False),
        sources=sources_manifest,
        ok=result.get("ok", True),
        steps=result.get("steps") or None,
        results=results_out or None,
        self_critique=result.get("self_critique") or None,
        duration_ms=duration_ms,
        method_summary=method_summary,
        used_pushdown=used_pushdown,
        sample_row_count=sample_row_count,
        # 2026-10-06 (warehouse-honesty round): what actually ran inside
        # the warehouse - see schemas.ChatResponse's own comment.
        pushdown_sql=warehouse_outcome.sql if used_pushdown else None,
        pushdown_provider=ds.kind if used_pushdown else None,
        pushdown_bytes_scanned=warehouse_outcome.bytes_scanned if used_pushdown else None,
        pushdown_duration_ms=warehouse_outcome.duration_ms if used_pushdown else None,
        pushdown_result_rows=int(len(warehouse_outcome.df)) if used_pushdown else None,
        pushdown_attempts=list(warehouse_outcome.attempts) if used_pushdown else None,
        exact_total_rows=exact_total_rows,
    )


_CATALOG_MAX_SOURCES = 20


def _catalog_columns_from_schema_cache(schema_cache) -> list[str] | None:
    """Best-effort column-name list from a DataSource.schema_cache for the
    cross-source catalog handed to ai_engine.analyze (see its `catalog`
    param and the "needs_data" action) - only for the single-table
    {"columns": [{"name", "type"}, ...]} shape a plain CSV/Excel-single-
    sheet/API/single-DB-table connection uses (see _api_schema_and_bytes
    in routers/datasources.py and the plain CSV upload path). A warehouse
    (BigQuery/Snowflake) or MongoDB source uses a different, multi-table
    {name: [...]} shape (see _multi_table_schema_text/_mongo_schema_text
    above) and is deliberately left out of the catalog for now: auto-
    loading one of those needs a specific table/collection name chosen
    first, not just "original", which this first version of automatic
    cross-source lookup does not attempt - the "ds:" branch of
    _load_selected_tables below only ever loads a source's single default
    table. Returns None (not []) when this schema_cache is not that
    single-table shape, so the caller can skip the source entirely rather
    than show it with an empty or misleading column list."""
    if not isinstance(schema_cache, dict):
        return None
    columns = schema_cache.get("columns")
    if not isinstance(columns, list):
        return None
    return [str(c["name"]) for c in columns if isinstance(c, dict) and c.get("name") is not None]


def _other_sources_catalog(db: Session, user: models.User, exclude_ids: set[str]) -> list[dict]:
    """The lightweight "what else does this person have connected" list
    handed to ai_engine.analyze so a question can be answered from a
    table the person never explicitly selected for THIS turn - the same
    "+ Add more data" tables the chat picker already lets them add by
    hand, just also visible to the model itself instead of only to the
    person (see the SYSTEM_PROMPT "Automatically finding data in another
    connected source" rule). Every source is access-checked the same way
    list_datasources checks them (owned, or shared into a workspace this
    person is a member of) - this never shows or lets the model load
    anything the person could not already see in their own "+ Add more
    data" picker. Deliberately bounded: at most _CATALOG_MAX_SOURCES
    sources (most recently created first, out of at most 200 considered),
    never every source a heavy user has ever connected, and only the ones
    with a usable single-table schema_cache (see
    _catalog_columns_from_schema_cache) - a source with no schema_cache
    yet, or one this helper cannot read, is silently left out rather than
    shown with nothing useful in it."""
    rows = (
        db.query(models.DataSource)
        .filter(workspace_access.datasource_access_filter(db, user))
        .order_by(models.DataSource.created_at.desc())
        .limit(200)
        .all()
    )
    catalog: list[dict] = []
    for row in rows:
        if row.id in exclude_ids:
            continue
        columns = _catalog_columns_from_schema_cache(row.schema_cache)
        if not columns:
            continue
        catalog.append({"id": row.id, "name": row.name, "columns": columns})
        if len(catalog) >= _CATALOG_MAX_SOURCES:
            break
    return catalog


def _metric_definitions_for_datasource(db: Session, datasource_id: str) -> list[dict]:
    """The saved metric glossary (models.MetricDefinition) for this one
    data source, handed to ai_engine.analyze so a plain-English question
    that names one of these metrics gets the exact same formula every
    dashboard KPI/gauge tile built from it already uses - see
    services/metrics.py, the one shared place that formula is actually
    resolved. A small, cheap query (a data source's own metric glossary is
    never large) - unlike _other_sources_catalog above, this never needs
    pagination across every data source a person has, just this one."""
    rows = (
        db.query(models.MetricDefinition)
        .filter(models.MetricDefinition.datasource_id == datasource_id)
        .order_by(models.MetricDefinition.name.asc())
        .all()
    )
    return [
        {"id": m.id, "name": m.name, "metric_column": m.metric_column, "agg": m.agg, "filters": m.filters or []}
        for m in rows
    ]


def _load_selected_tables(
    db: Session, user: models.User, ds: models.DataSource, requested_ids: list[str], table: str | None = None
) -> tuple[dict[str, object], list[models.DatasetVersion], object, list[dict]]:
    """Loads every table a WORKING ON selection points at, shared by the
    live /chat endpoint, /chat/verify (which re-checks a prior answer
    against the same kind of selection it originally ran against), and
    /goku/chat. Each entry in `requested_ids` is one of:
      - "original": this datasource's own untouched original data (its
        first/only sheet, for Excel).
      - "sheet:<name>": one specific sheet of THIS datasource, when it is a
        multi-sheet Excel workbook (see data_loader._is_multi_sheet_schema).
      - a bare DatasetVersion.id: a saved table - globally unique, so this
        can be a table saved under ANY data source the person owns, not
        only this one; picking a table someone built while working on a
        different, separately-connected data source is exactly what lets
        one prompt combine two data sources, since a saved table's
        ownership is checked directly rather than assumed from which
        datasource happened to be open when it was picked.
      - "ds:<other_datasource_id>:original" / "ds:<other_datasource_id>:
        sheet:<name>": another, separately-connected data source's own
        original data (or one sheet of it) - the "+ Add more data" picker.
    Raises NeedsTableSelection when a table/sheet is ambiguous and none was
    specified, or HTTPException for any other load failure (including
    trying to use a table/datasource this user does not own) - the caller
    decides how to turn NeedsTableSelection into a response, since /chat
    and /chat/verify handle it differently.

    Also returns the original, untouched dataframe for THIS datasource
    whenever it was part of this selection (None otherwise - loading it
    when it was not asked for is the caller's job, see the "original data
    as a merge fallback" note in both endpoints below and
    ai_engine._schema_with_fallback), and - as the 4th value - an ordered
    "sources manifest": one small dict per entry in `requested_ids`, shaped
    {"kind": "original" | "sheet" | "version", "label": the exact display
    label just resolved for it, "datasource_id": which datasource it
    belongs to, "version_id": set only for kind "version", "sheet": set
    only for kind "sheet"}. A caller that goes on to save this turn as a
    Message stores this verbatim on Message.sources - it is the one place
    precise enough to later draw an accurate lineage diagram of exactly
    which table(s) fed which chart/table (see routers/datasources.py
    get_data_flow), including a merge across separately-connected data
    sources, which parent_version_id alone cannot represent."""
    ordered_ids: list[str] = []
    for raw_id in requested_ids:
        key = raw_id or "original"
        if key not in ordered_ids:
            ordered_ids.append(key)

    tables: dict[str, object] = {}
    used_names: set[str] = set()
    source_versions: list[models.DatasetVersion] = []
    sources_manifest: list[dict] = []
    original_df = None
    # Another datasource this same selection already pulled in - fetched at
    # most once each even if more than one of its sheets/tables is picked.
    other_ds_cache: dict[str, models.DataSource] = {}

    def _unique_key(name: str) -> str:
        key, n = name, 2
        while key in used_names:
            key = f"{name} ({n})"
            n += 1
        used_names.add(key)
        return key

    def _get_other_ds(other_id: str) -> models.DataSource:
        if other_id in other_ds_cache:
            return other_ds_cache[other_id]
        other_ds = db.query(models.DataSource).filter(models.DataSource.id == other_id).first()
        if not other_ds or not workspace_access.can_access_datasource(db, other_ds, user):
            raise HTTPException(404, "One of the added data sources no longer exists or is not accessible to you.")
        other_ds_cache[other_id] = other_ds
        return other_ds

    for source_id in ordered_ids:
        if source_id == "original":
            try:
                original_df = load_dataframe(ds, table=table, version="original", db=db)
                original_df = data_access_rules.filter_dataframe_for_role(db, original_df, ds, user)
            except NeedsTableSelection:
                raise
            except Exception as e:
                raise HTTPException(400, f"Could not load data: {e}")
            tables[_unique_key("Original data")] = original_df
            sources_manifest.append({
                "kind": "original", "label": "Original data", "datasource_id": ds.id,
                "version_id": None, "sheet": None,
            })
            continue

        if source_id.startswith("sheet:"):
            sheet_name = source_id[len("sheet:"):]
            try:
                sheet_df = load_dataframe(ds, table=sheet_name, version="original", db=db)
                sheet_df = data_access_rules.filter_dataframe_for_role(db, sheet_df, ds, user)
            except Exception as e:
                raise HTTPException(400, f"Could not load data: {e}")
            tables[_unique_key(sheet_name)] = sheet_df
            sources_manifest.append({
                "kind": "sheet", "label": sheet_name, "datasource_id": ds.id,
                "version_id": None, "sheet": sheet_name,
            })
            continue

        if source_id.startswith("ds:"):
            # "ds:<other_datasource_id>:original" or
            # "ds:<other_datasource_id>:sheet:<name>" - another, separately
            # connected data source added via "+ Add more data".
            rest = source_id[len("ds:"):]
            other_id, _, selector = rest.partition(":")
            other_ds = _get_other_ds(other_id)
            other_sheet = selector[len("sheet:"):] if selector.startswith("sheet:") else None
            try:
                other_df = load_dataframe(other_ds, table=other_sheet, version="original", db=db)
                other_df = data_access_rules.filter_dataframe_for_role(db, other_df, other_ds, user)
            except Exception as e:
                raise HTTPException(400, f"Could not load data from {other_ds.name}: {e}")
            label = f"{other_ds.name} — {other_sheet}" if other_sheet else f"{other_ds.name} (original)"
            tables[_unique_key(label)] = other_df
            sources_manifest.append({
                "kind": "sheet" if other_sheet else "original", "label": label, "datasource_id": other_id,
                "version_id": None, "sheet": other_sheet,
            })
            continue

        # A bare id is a saved table (DatasetVersion) - looked up globally
        # (not scoped to `ds`) and ownership-checked through a join, since
        # picking a table saved under a DIFFERENT, separately-connected
        # data source than the one this endpoint was opened for is exactly
        # what "+ Add more data" lets someone do.
        version = (
            db.query(models.DatasetVersion)
            .join(models.DataSource, models.DatasetVersion.datasource_id == models.DataSource.id)
            .filter(models.DatasetVersion.id == source_id, workspace_access.datasource_access_filter(db, user))
            .first()
        )
        if not version:
            raise HTTPException(404, "One of the selected tables no longer exists. Please update your selection and try again.")
        label = version.name
        owning_ds = ds
        if version.datasource_id != ds.id:
            owning_ds = _get_other_ds(version.datasource_id)
            label = f"{owning_ds.name} — {version.name}"
        try:
            version_df = load_version_dataframe(version, ds=owning_ds)
            version_df = data_access_rules.filter_dataframe_for_role(db, version_df, owning_ds, user)
        except Exception as e:
            raise HTTPException(400, f"Could not load data: {e}")
        tables[_unique_key(label)] = version_df
        sources_manifest.append({
            "kind": "version", "label": label, "datasource_id": version.datasource_id,
            "version_id": version.id, "sheet": None,
        })
        # `source_versions` becomes the `parent_version_ids`/cleaning-log
        # lineage of whatever new table this prompt might save (see
        # _save_cleaning_result) - that lineage only makes sense within
        # THIS datasource's own version history (the delete-guard in
        # routers/datasources.py that checks "does anything depend on this
        # table?" only ever looks within one datasource's versions), so a
        # table added in from a different, separately-connected data source
        # contributes its DATA to this analysis without being recorded as a
        # parent of any new table saved here.
        if version.datasource_id == ds.id:
            source_versions.append(version)

    return tables, source_versions, original_df, sources_manifest


@router.post("/verify", response_model=schemas.VerifyResponse)
def verify_message(payload: VerifyRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """The "Double-check this" action a person can trigger on any prior
    analyze/transform answer, instead of just trusting the first pass
    forever: re-runs the exact code that produced it against the current
    data, then has a fresh, independent AI review pass check that the code
    and the insight genuinely hold up - and if not, redoes it correctly and
    updates this same message in place. See ai_engine.verify_answer for
    exactly what is checked."""
    msg = db.query(models.Message).filter(models.Message.id == payload.message_id).first()
    if not msg:
        raise HTTPException(404, "Message not found.")

    conversation = db.query(models.Conversation).filter(models.Conversation.id == msg.conversation_id).first()
    if not conversation or not workspace_access.can_access_conversation(db, conversation, user):
        raise HTTPException(404, "Message not found.")
    # Re-running/correcting a result is a write action, same as chatting -
    # editable tier, so a workspace "viewer" can read a verified answer but
    # not trigger a re-verify themselves.
    if not workspace_access.can_edit_conversation(db, conversation, user):
        raise HTTPException(403, "You have view-only access to this Project.")

    if msg.role != "assistant" or not msg.code or msg.action not in ("analyze", "transform"):
        raise HTTPException(400, "There is no computed result attached to this message to verify.")

    if not conversation.datasource_id:
        raise HTTPException(400, "This conversation has no linked data source to verify against.")
    ds = db.query(models.DataSource).filter(models.DataSource.id == conversation.datasource_id).first()
    if not ds:
        raise HTTPException(404, "Datasource not found.")
    ensure_legacy_migrated(db, ds)

    # The original question this message answered - the nearest preceding
    # user turn in the same conversation.
    prior_user_msg = (
        db.query(models.Message)
        .filter(
            models.Message.conversation_id == conversation.id,
            models.Message.role == "user",
            models.Message.created_at <= msg.created_at,
        )
        .order_by(models.Message.created_at.desc())
        .first()
    )
    prompt = prior_user_msg.content if prior_user_msg else msg.content

    requested_ids = payload.source_version_ids or ["original"]

    # 2026-10-06 (warehouse-honesty round): "Double-check this" re-runs the
    # stored pandas code against freshly loaded data. For a warehouse kind
    # that would mean loading a row-capped SAMPLE of the live table - and,
    # for a turn that was computed inside the warehouse, re-running chart
    # code (written against the small query result) on raw sample rows,
    # then possibly overwriting a correct answer with a sample-based
    # "correction". Neither is allowed under the no-samples policy, so a
    # warehouse turn is verified by asking the question again (which
    # re-runs the real query), and only a selection made entirely of saved
    # tables can still be double-checked here.
    is_warehouse_kind = ds.kind in PUSHDOWN_ELIGIBLE_KINDS
    if is_warehouse_kind:
        # db is passed so a saved-query version (2026-10-06) resolves to
        # mode "versions" - which has no in-app copy to re-check against
        # either - rather than looking like a file-backed saved table.
        scope_mode, _ = _resolve_warehouse_scope(ds, requested_ids, None, db=db)
        if msg.used_pushdown or scope_mode != "saved_only":
            return schemas.VerifyResponse(
                status="unavailable",
                message=(
                    "This answer was computed by a query inside your warehouse over every row, so there is no "
                    "in-app copy to re-check it against (and I won't check it against a sample). Ask the "
                    "question again to recompute it directly in the warehouse."
                ),
                message_id=msg.id,
            )

    try:
        tables, source_versions, original_df, sources_manifest = _load_selected_tables(
            db, user, ds, requested_ids, table=None
        )
    except NeedsTableSelection as e:
        available_list = ", ".join(e.available)
        raise HTTPException(400, f"This datasource has multiple tables/collections ({available_list}); please pick one before verifying.")

    if original_df is None and not is_warehouse_kind:
        try:
            original_df = load_dataframe(ds, table=None, version="original", db=db)
            original_df = data_access_rules.filter_dataframe_for_role(db, original_df, ds, user)
        except Exception as e:
            print(f"[chat] Could not load original data as a merge fallback for verify: {e}")
            original_df = None

    history = _recent_history(db, conversation.id)

    try:
        audit = ai_engine.verify_answer(
            prompt, tables, code=msg.code, action=msg.action, chart_type=msg.chart_type,
            insight=msg.insight, history=history, original_df=original_df,
        )
    except Exception as e:
        print(f"[chat] Verification failed: {e}")
        raise HTTPException(502, ai_engine.friendly_ai_error(e))

    # Counts real usage of the "Double-check this" trust feature for the
    # admin dashboard, regardless of whether this particular check found
    # anything to correct - committed separately, right away, so it is
    # never lost even if something below this point raises.
    msg.verified_count = (msg.verified_count or 0) + 1
    db.commit()

    status = audit["status"]
    if status != "corrected":
        return schemas.VerifyResponse(status=status, message=audit["message"], message_id=msg.id)

    result = audit["result"]
    new_version = None
    if result.get("cleaned_df") is not None:
        new_version = _save_cleaning_result(db, ds, source_versions, prompt, result)

    reply_text = result.get("narrative") or "Corrected."
    if result.get("rows_before") is not None:
        rows_before = result.get("rows_before")
        rows_after = result.get("rows_after")
        nulls_before = result.get("nulls_before")
        nulls_after = result.get("nulls_after")
        arrow = "→"
        reply_text += f" ({rows_before} {arrow} {rows_after} rows, {nulls_before} {arrow} {nulls_after} missing values)"

    msg.content = reply_text
    msg.chart_spec = result.get("chart_spec")
    msg.insight = result.get("insight")
    msg.code = result.get("code")
    msg.chart_type = result.get("chart_type")
    msg.result_columns = result.get("result_columns")
    msg.result_rows = result.get("result_rows")
    msg.result_truncated = result.get("result_truncated", False)
    # A re-verify can run against a different WORKING ON selection than the
    # turn originally used (the person may have changed it since) - refresh
    # the recorded sources to match what THIS check actually ran against,
    # so the lineage diagram (get_data_flow) always reflects the truth.
    # The table this correction created (if any) replaces the old one the
    # same way; if this check made no new table, the old link is kept.
    msg.sources = sources_manifest
    if new_version:
        msg.new_version_id = new_version.id
    db.commit()
    db.refresh(msg)

    return schemas.VerifyResponse(
        status="corrected",
        message=audit["message"],
        message_id=msg.id,
        reply_text=reply_text,
        chart_spec=msg.chart_spec,
        chart_type=msg.chart_type,
        result_columns=msg.result_columns,
        result_rows=msg.result_rows,
        result_truncated=msg.result_truncated or False,
        insight=msg.insight,
        new_version_id=new_version.id if new_version else None,
        new_version_name=new_version.name if new_version else None,
    )


# 2026-09-29 (plain-language findings round): _METHOD_PATTERNS and
# _derive_method_summary used to live here - they moved to ai_engine.py
# (unchanged) so that module can also classify one multi-result piece's own
# code inline, right where that piece's real code is available (see
# ai_engine._entries_from_pieces' use of it), instead of only ever being
# usable after the fact, here, on a whole turn's combined code. Every call
# site below now reads ai_engine._derive_method_summary instead of a local
# copy - same function, same behavior, just one shared definition instead
# of two that could silently drift apart.


def _save_cleaning_result(
    db: Session, ds: models.DataSource, source_versions: list[models.DatasetVersion], prompt: str, result: dict,
    duration_ms: int | None = None, method_summary: str | None = None,
    used_pushdown: bool | None = None, sample_row_count: int | None = None,
) -> models.DatasetVersion:
    """Every cleaning/prep prompt becomes its own new saved table, built on
    top of whichever table(s) the person picked as the source, instead of
    overwriting anything - so earlier results stay around to come back to.
    Numbering is based on the highest position used so far (not a row
    count), so it never reuses a number after an earlier table was deleted,
    and never collides even if two prompts land close together."""
    cleaned_df = result["cleaned_df"]
    log_entry = {
        "prompt": prompt,
        "summary": result.get("narrative"),
        "rows_before": result.get("rows_before"),
        "rows_after": result.get("rows_after"),
        "nulls_before": result.get("nulls_before"),
        "nulls_after": result.get("nulls_after"),
        "created_at": datetime.utcnow().isoformat(),
    }
    prior_log: list = []
    for v in source_versions:
        prior_log.extend(v.cleaning_log or [])

    max_position = (
        db.query(func.max(models.DatasetVersion.position))
        .filter(models.DatasetVersion.datasource_id == ds.id)
        .scalar()
        or 0
    )
    parent_ids = [v.id for v in source_versions] or None
    version = models.DatasetVersion(
        datasource_id=ds.id,
        name=purpose_label(prompt),
        parent_version_id=parent_ids[0] if parent_ids else None,
        parent_version_ids=parent_ids,
        data=dataframe_to_csv_bytes(cleaned_df),
        cleaning_log=prior_log + [log_entry],
        position=max_position + 1,
        duration_ms=duration_ms,
        method_summary=method_summary,
        used_pushdown=used_pushdown,
        sample_row_count=sample_row_count,
    )
    db.add(version)
    db.commit()
    db.refresh(version)
    return version


def _save_named_results(
    db: Session, ds: models.DataSource, parent_ids: list[str] | None, prompt: str, named_tables: dict,
    named_table_timing: dict | None = None,
) -> list[dict]:
    """2026-09-28 (named-results round): when one question genuinely asked
    for several distinct analyses at once (see ai_engine's "Multiple
    results in one answer" and the named_tables key its analyze() now
    returns for that case), each named piece becomes its own real, saved,
    selectable DatasetVersion here - not just a chat-response card that
    disappears once the conversation scrolls past it. This is what makes a
    multi-analysis answer genuinely CHAINABLE: "Demand forecast",
    "Customer segments", "Anomalies flagged", and so on each show up in
    the Data tab and the WORKING ON table picker exactly like any other
    saved table, and a later question can pick one of them by name as its
    starting point - the same thing Hex's notebook gives you for free by
    making every named cell a real object, now true here too.

    Named the same way _save_cleaning_result above names a single saved
    table, except each piece keeps its own label (e.g. "Customer
    segments") instead of a name derived from the shared prompt - six
    tables from one prompt sharing one prompt-derived name would be
    indistinguishable in the Data tab, which defeats the entire point of
    this feature. All positions are reserved up front from a single query
    (rather than one query per piece, as calling _save_cleaning_result in
    a loop would do) so N tables saved from the same turn always land in a
    stable, gapless order.

    duration_ms/method_summary, per piece (2026-09-29 parallel-pieces
    round): `named_table_timing`, when given, is
    {label: {"duration_ms", "code"}} from ai_engine._run_pieces_concurrently
    - each piece ran as its own separate, individually-timed sandboxed
    call (see SYSTEM_PROMPT's result_pieces rule), so unlike the
    dict-in-`code` multi-result path (still the only path for a piece NOT
    in named_table_timing), a real, accurate duration_ms and a real
    method_summary (derived from that ONE piece's own code, the same way
    _derive_method_summary already classifies a single-result turn's code)
    are both genuinely available here. Left null exactly as before for any
    label with no entry in named_table_timing - the honest "not measured
    for this path" null Phase 2 established, never a real-looking number
    that isn't actually accurate at that granularity.
    """
    if not named_tables:
        return []
    timing = named_table_timing or {}
    log_entry_base = {
        "prompt": prompt,
        "created_at": datetime.utcnow().isoformat(),
    }
    max_position = (
        db.query(func.max(models.DatasetVersion.position))
        .filter(models.DatasetVersion.datasource_id == ds.id)
        .scalar()
        or 0
    )
    saved: list[dict] = []
    position = max_position
    for label, df in named_tables.items():
        position += 1
        name = label if len(label) <= 34 else f"{label[:34].rstrip()}…"
        piece_meta = timing.get(label) or {}
        piece_duration_ms = piece_meta.get("duration_ms")
        piece_code = piece_meta.get("code")
        piece_method_summary = ai_engine._derive_method_summary("analyze", None, piece_code) if piece_code else None
        version = models.DatasetVersion(
            datasource_id=ds.id,
            name=name,
            parent_version_id=parent_ids[0] if parent_ids else None,
            parent_version_ids=parent_ids,
            data=dataframe_to_csv_bytes(df),
            cleaning_log=[{
                **log_entry_base,
                "summary": f"One of {len(named_tables)} results from this analysis: {label}",
                "label": label,
            }],
            position=position,
            duration_ms=piece_duration_ms,
            method_summary=piece_method_summary,
        )
        db.add(version)
        saved.append({"label": label, "version": version})
    db.commit()
    for entry in saved:
        db.refresh(entry["version"])
    return [
        {"label": e["label"], "version_id": e["version"].id, "version_name": e["version"].name}
        for e in saved
    ]


def _get_or_create_conversation(
    db: Session, user: models.User, conversation_id: str | None, datasource_id: str, first_prompt: str
) -> models.Conversation:
    if conversation_id:
        # Resuming an existing Project to keep chatting in it is a write
        # action, so this needs editable tier (2026-09-23) - a workspace
        # "viewer" can read a teammate's Project but not continue it, and
        # this also closes a narrower gap: gating on the CONVERSATION's own
        # access, not just the caller's already-checked access to the
        # `datasource_id` argument, means a mismatched/crafted
        # conversation_id from a workspace where the caller only has
        # view-tier (or no) access can never be resumed just because the
        # request's OTHER datasource_id happens to be one they can edit.
        # Falling through to create a brand-new conversation for an
        # inaccessible id would otherwise silently start a duplicate
        # instead of raising.
        conv = db.query(models.Conversation).filter(models.Conversation.id == conversation_id).first()
        if conv and workspace_access.can_edit_conversation(db, conv, user):
            return conv
    title = (first_prompt or "").strip()
    if len(title) > 60:
        title = title[:57] + "..."
    conv = models.Conversation(owner_id=user.id, datasource_id=datasource_id, title=title or "New analysis")
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return conv


def _recent_history(db: Session, conversation_id: str, limit: int = 8) -> list[dict]:
    msgs = (
        db.query(models.Message)
        .filter(models.Message.conversation_id == conversation_id)
        .order_by(models.Message.created_at.desc())
        .limit(limit)
        .all()
    )
    history = []
    for m in reversed(msgs):
        content = m.content
        # For an assistant turn that actually ran code, fold the exact code
        # into what the model sees for this turn (not into what the person
        # sees - that stays in the plain reply above). This is what lets a
        # later "give me the python code" / "show me the code" be answered
        # with the real code instead of the model having nothing to go on,
        # and - when the action is known (rows written after this column
        # was added) - lets an exact repeat of the same question reuse the
        # identical code instead of asking the AI to write it again, so the
        # same question on unchanged data is guaranteed to give the same
        # answer. Older rows saved before this column existed have no
        # action recorded; the marker still carries the code for the
        # "give me the code" case, just without the action tag, so a repeat
        # of one of those older questions simply falls back to the normal
        # AI-planned flow instead of being reused.
        if m.role == "assistant" and m.code:
            if m.action:
                chart_type_tag = f" chart_type={m.chart_type}" if m.chart_type else ""
                content = f"{content}\n\n(The exact python code used for this - action={m.action}{chart_type_tag}: ```python\n{m.code}\n```)"
            else:
                content = f"{content}\n\n(The exact python code used for this: ```python\n{m.code}\n```)"
        history.append({"role": m.role, "content": content})
    return history


def _persist_and_respond(
    db: Session, conversation_id: str, reply_text: str, action: str = "analyze",
    chart_spec=None, insight=None, suggestions=None, needs_clarification=False,
    rows_before=None, rows_after=None, nulls_before=None, nulls_after=None,
    new_version_id=None, new_version_name=None, code=None, chart_type=None,
    continue_action=None, result_columns=None, result_rows=None, result_truncated=False,
    sources=None, ok: bool = True, steps=None, results=None, self_critique=None,
    duration_ms=None, method_summary=None, used_pushdown=None, sample_row_count=None,
    pushdown_sql=None, pushdown_provider=None, pushdown_bytes_scanned=None, pushdown_duration_ms=None,
    pushdown_result_rows=None, pushdown_attempts=None, pushdown_skipped_reason=None, exact_total_rows=None,
    builder_suggestion=None, builder_columns=None,
) -> schemas.ChatResponse:
    # 2026-10-06 (warehouse-honesty round): the builder prefill rides
    # inside the existing `suggestions` JSON (no new column needed) so
    # reopening the conversation can restore it - see
    # routers/conversations.py, which lifts it back out to top level.
    # builder_columns is NOT persisted: it is derived from ds.schema_cache,
    # which the frontend already has for the open data source.
    if builder_suggestion is not None:
        suggestions = {**(suggestions or {}), "builder_suggestion": builder_suggestion}
    msg = models.Message(
        conversation_id=conversation_id,
        role="assistant",
        content=reply_text,
        chart_spec=chart_spec,
        insight=insight,
        suggestions=suggestions,
        needs_clarification=needs_clarification,
        code=code,
        action=action,
        chart_type=chart_type,
        result_columns=result_columns,
        result_rows=result_rows,
        result_truncated=result_truncated,
        # Persisted here (not just returned in the response below) so a
        # LATER visit - opening this data source's Flow tab, possibly in a
        # different conversation entirely - can still show exactly which
        # table(s) this turn ran against and which table it created. See
        # Message.sources/new_version_id and routers/datasources.py
        # get_data_flow.
        sources=sources,
        new_version_id=new_version_id,
        # The real "what I did" trace - see Message.steps' own docstring.
        steps=steps,
        # The extra chart/table cards beyond the first, and the honest
        # trustworthiness caveat - see Message.results/self_critique.
        results=results,
        self_critique=self_critique,
        # Flow tab transparency round - see Message.duration_ms/
        # method_summary's own docstring in models.py.
        duration_ms=duration_ms,
        method_summary=method_summary,
        # Pushdown-honesty round - see Message.used_pushdown/
        # sample_row_count's own docstring in models.py.
        used_pushdown=used_pushdown,
        sample_row_count=sample_row_count,
        # Warehouse-honesty round - see models.Message.pushdown_sql and
        # friends' own docstring.
        pushdown_sql=pushdown_sql,
        pushdown_attempts=pushdown_attempts,
        pushdown_bytes_scanned=pushdown_bytes_scanned,
        pushdown_duration_ms=pushdown_duration_ms,
        pushdown_result_rows=pushdown_result_rows,
        pushdown_skipped_reason=pushdown_skipped_reason,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    return schemas.ChatResponse(
        conversation_id=conversation_id,
        message_id=msg.id,
        action=action,
        reply_text=reply_text,
        ok=ok,
        steps=steps,
        results=results,
        self_critique=self_critique,
        chart_spec=chart_spec,
        chart_type=chart_type,
        result_columns=result_columns,
        result_rows=result_rows,
        result_truncated=result_truncated,
        insight=insight,
        suggested_charts=(suggestions or {}).get("charts"),
        suggested_stats=(suggestions or {}).get("stats"),
        follow_up_suggestions=(suggestions or {}).get("follow_up"),
        needs_clarification=needs_clarification,
        rows_before=rows_before,
        rows_after=rows_after,
        nulls_before=nulls_before,
        nulls_after=nulls_after,
        new_version_id=new_version_id,
        new_version_name=new_version_name,
        continue_action=continue_action,
        # 2026-09-29 (plain-language findings round): both were already
        # computed for every turn (Phase 1) and already saved to Message -
        # just never actually handed back in the live response, so "show
        # calculation" had nothing to show without a page reload. See
        # schemas.ChatResponse's own comment on these two fields.
        method_summary=method_summary,
        code=code,
        duration_ms=duration_ms,
        # Pushdown-honesty round - see schemas.ChatResponse's own comment
        # on these two fields for what they mean and why.
        used_pushdown=used_pushdown,
        sample_row_count=sample_row_count,
        # Warehouse-honesty round - see schemas.ChatResponse's own comment.
        pushdown_sql=pushdown_sql,
        pushdown_provider=pushdown_provider,
        pushdown_bytes_scanned=pushdown_bytes_scanned,
        pushdown_duration_ms=pushdown_duration_ms,
        pushdown_result_rows=pushdown_result_rows,
        exact_total_rows=exact_total_rows,
        pushdown_attempts=pushdown_attempts,
        pushdown_skipped_reason=pushdown_skipped_reason,
        builder_suggestion=builder_suggestion,
        builder_columns=builder_columns,
    )
