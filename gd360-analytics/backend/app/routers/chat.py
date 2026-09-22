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
"""
import json
import time
from collections import defaultdict, deque
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, schemas, security
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..schemas_extra import ChatRequestFull, VerifyRequest
from ..services import ai_engine
from ..services.connectors import BigQueryConnector, SnowflakeConnector, QueryTooExpensive, ReadOnlyViolation
from ..services.data_loader import (
    load_dataframe, load_version_dataframe, dataframe_to_csv_bytes, ensure_legacy_migrated, NeedsTableSelection,
    purpose_label,
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


# --- Warehouse pushdown (Enterprise Scale Roadmap, Phase 1 + 2) ------------
# Scoped narrowly on purpose: only the plain "ask a question about my
# BigQuery/Snowflake data" case below (requested_ids == ["original"], no
# extra tables merged in, no specific sub-table forced) tries this path.
# Merging in other sources/saved versions still uses the general
# multi-table path a few lines down - broadening pushdown to that case is
# real future work, not this first slice. See the roadmap doc's own
# "Where to start" section for why this is deliberately the narrowest
# useful first step.

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


def _log_pushdown(db: Session, user_id: str, datasource_id: str, provider: str, sql_text: str,
                   bytes_scanned, status: str, error_message: str = None):
    """Records one pushdown attempt (BigQuery, Snowflake - any future
    warehouse the same way) to the audit log, success or not - see
    models.PushdownQueryLog. Best-effort only: a logging failure must
    never break the actual chat request, so any error here is swallowed
    (after being printed) rather than raised. Committed on its own right
    away rather than left pending on the shared session, so the audit row
    is durable even if something later in this same request has to roll
    back."""
    try:
        db.add(models.PushdownQueryLog(
            owner_id=user_id, datasource_id=datasource_id, provider=provider,
            sql_text=sql_text or "", bytes_scanned=bytes_scanned, status=status,
            error_message=error_message,
        ))
        db.commit()
    except Exception as e:
        print(f"[chat] Failed to write pushdown audit log (non-fatal): {e}")
        db.rollback()


def _todays_pushdown_bytes(db: Session, user_id: str) -> int:
    """Total bytes this person's pushdown queries (any provider - BigQuery
    and Snowflake share one combined daily cap) have made a warehouse scan
    since midnight UTC today - the running total the daily per-customer
    cost budget below is checked against. Read straight off the audit log
    rather than a separate running-totals table, so there is nothing else
    to keep in sync."""
    start_of_day = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    total = db.query(func.sum(models.PushdownQueryLog.bytes_scanned)).filter(
        models.PushdownQueryLog.owner_id == user_id,
        models.PushdownQueryLog.created_at >= start_of_day,
        models.PushdownQueryLog.status == "ok",
    ).scalar()
    return total or 0


def _try_bigquery_pushdown(db: Session, ds: models.DataSource, user_id: str, prompt: str):
    """Tries to answer `prompt` with one governed SQL query run directly
    inside BigQuery, instead of pulling rows into memory. Returns the
    small result as a DataFrame on success, or None on ANY failure -
    schema too sparse, this user's daily pushdown cost budget is already
    used up, the model couldn't write safe SQL, the query would scan more
    than this connection's per-query byte budget, or BigQuery rejected it
    outright. A None here must be treated exactly like "pushdown was
    never attempted": the caller falls through to the ordinary pull-and-
    pandas path, so a BigQuery question can only ever get faster/cheaper
    from this, never worse - nothing in this function is allowed to raise
    past it. Every real attempt (one that got far enough to have actual
    SQL) is written to the audit log via _log_pushdown, regardless of
    outcome - see models.PushdownQueryLog."""
    schema_text = _multi_table_schema_text(ds.schema_cache)
    if not schema_text.strip():
        return None

    already_scanned_today = _todays_pushdown_bytes(db, user_id)
    if already_scanned_today >= settings.PUSHDOWN_MAX_BYTES_SCANNED_PER_DAY_PER_USER:
        print(f"[chat] BigQuery pushdown skipped, daily cost budget already used: {already_scanned_today} bytes")
        _log_pushdown(db, user_id, ds.id, "bigquery", "", None, "rejected_daily_budget")
        return None

    try:
        sql = ai_engine.generate_bigquery_sql(prompt, schema_text)
    except Exception as e:
        print(f"[chat] BigQuery pushdown SQL generation failed, falling back: {e}")
        return None

    if not sql or sql.strip().upper() == "NOT_POSSIBLE":
        return None

    try:
        service_account_json = security.decrypt_secret(ds.encrypted_secret)
        info = ds.connection_info
        connector = BigQueryConnector(info["project_id"], info["dataset_id"], service_account_json)
        df, bytes_scanned = connector.run_pushdown_query(sql, max_bytes=settings.BIGQUERY_MAX_BYTES_SCANNED_PER_QUERY)
        _log_pushdown(db, user_id, ds.id, "bigquery", sql, bytes_scanned, "ok")
        return df
    except ReadOnlyViolation as e:
        # The AI wrote something unsafe - don't retry with a worse query,
        # just fall back this one time like any other pushdown failure.
        print(f"[chat] BigQuery pushdown query rejected (unsafe), falling back: {e}")
        _log_pushdown(db, user_id, ds.id, "bigquery", sql, None, "rejected_unsafe", str(e))
        return None
    except QueryTooExpensive as e:
        print(f"[chat] BigQuery pushdown query rejected (too expensive), falling back: {e}")
        _log_pushdown(db, user_id, ds.id, "bigquery", sql, e.estimated_bytes, "rejected_too_expensive", str(e))
        return None
    except Exception as e:
        print(f"[chat] BigQuery pushdown query failed, falling back: {e}")
        _log_pushdown(db, user_id, ds.id, "bigquery", sql, None, "error", str(e))
        return None


def _try_snowflake_pushdown(db: Session, ds: models.DataSource, user_id: str, prompt: str):
    """Tries to answer `prompt` with one governed SQL query run directly
    inside Snowflake, instead of pulling rows into memory - the same idea
    as _try_bigquery_pushdown above, with one real difference: Snowflake
    bills by warehouse compute-time, not bytes scanned, so there is no
    free pre-flight "how much would this cost" check the way BigQuery's
    dry run gives. Safety instead comes from a strict per-query statement
    timeout (settings.SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS - Snowflake
    itself cancels the query once it's hit, capping the worst case) plus
    the same daily cumulative byte budget every pushdown provider shares
    (see _todays_pushdown_bytes): Snowflake's own actual bytes_scanned for
    a completed query (read back from its QUERY_HISTORY_BY_SESSION, see
    SnowflakeConnector.run_pushdown_query) still counts toward that budget
    - just recorded after the query runs rather than estimated before it
    does. Returns the small result as a DataFrame on success, or None on
    ANY failure, matching _try_bigquery_pushdown's exact fallback
    contract - see that function's docstring for the full list of ways
    this can (harmlessly) fail through to the normal pull-and-pandas path."""
    schema_text = _multi_table_schema_text(ds.schema_cache)
    if not schema_text.strip():
        return None

    already_scanned_today = _todays_pushdown_bytes(db, user_id)
    if already_scanned_today >= settings.PUSHDOWN_MAX_BYTES_SCANNED_PER_DAY_PER_USER:
        print(f"[chat] Snowflake pushdown skipped, daily cost budget already used: {already_scanned_today} bytes")
        _log_pushdown(db, user_id, ds.id, "snowflake", "", None, "rejected_daily_budget")
        return None

    try:
        sql = ai_engine.generate_snowflake_sql(prompt, schema_text)
    except Exception as e:
        print(f"[chat] Snowflake pushdown SQL generation failed, falling back: {e}")
        return None

    if not sql or sql.strip().upper() == "NOT_POSSIBLE":
        return None

    try:
        creds = json.loads(security.decrypt_secret(ds.encrypted_secret))
        info = ds.connection_info
        connector = SnowflakeConnector(
            account=info["account"], warehouse=info["warehouse"], database=info["database"],
            db_schema=info.get("db_schema"), role=info.get("role"),
            username=creds["username"], password=creds["password"],
        )
        df, bytes_scanned = connector.run_pushdown_query(
            sql, statement_timeout_seconds=settings.SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS
        )
        _log_pushdown(db, user_id, ds.id, "snowflake", sql, bytes_scanned, "ok")
        return df
    except ReadOnlyViolation as e:
        print(f"[chat] Snowflake pushdown query rejected (unsafe), falling back: {e}")
        _log_pushdown(db, user_id, ds.id, "snowflake", sql, None, "rejected_unsafe", str(e))
        return None
    except Exception as e:
        print(f"[chat] Snowflake pushdown query failed, falling back: {e}")
        _log_pushdown(db, user_id, ds.id, "snowflake", sql, None, "error", str(e))
        return None


@router.post("", response_model=schemas.ChatResponse)
def chat(payload: ChatRequestFull, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _check_rate_limit(user.id)

    ds = db.query(models.DataSource).filter(
        models.DataSource.id == payload.datasource_id, models.DataSource.owner_id == user.id
    ).first()
    if not ds:
        raise HTTPException(404, "Datasource not found.")
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

    # Warehouse pushdown (see the Enterprise Scale Roadmap doc): only the
    # plain "ask about my warehouse data" case - a single source, its own
    # original data, no forced sub-table - tries running SQL directly
    # inside the warehouse before falling back to the normal path below.
    # See _try_bigquery_pushdown/_try_snowflake_pushdown's own docstrings
    # for the full fallback contract.
    pushdown_df = None
    if requested_ids == ["original"] and not payload.table:
        if ds.kind == "bigquery":
            pushdown_df = _try_bigquery_pushdown(db, ds, user.id, payload.prompt)
        elif ds.kind == "snowflake":
            pushdown_df = _try_snowflake_pushdown(db, ds, user.id, payload.prompt)

    if pushdown_df is not None:
        tables = {"Original data": pushdown_df}
        source_versions = []
        original_df = pushdown_df
        sources_manifest = [{
            "kind": "original", "label": "Original data", "datasource_id": ds.id,
            "version_id": None, "sheet": None,
        }]
    else:
        try:
            tables, source_versions, original_df, sources_manifest = _load_selected_tables(
                db, user, ds, requested_ids, table=payload.table
            )
        except NeedsTableSelection as e:
            available_list = ", ".join(e.available)
            reply = f"This datasource has multiple tables/collections: {available_list}. Which one would you like to analyze?"
            return _persist_and_respond(db, conversation.id, reply, needs_clarification=True)

    if original_df is None:
        # The person is working on a derived table, not the original data -
        # load the original too (best-effort only, never blocks the main
        # request on failure) so a prep step can pull in a column that
        # table is missing straight from there, instead of the person
        # having to notice the gap, switch WORKING ON by hand, and ask
        # again from scratch - see ai_engine._schema_with_fallback.
        try:
            original_df = load_dataframe(ds, table=payload.table, version="original", db=db)
        except Exception as e:
            print(f"[chat] Could not load original data as a merge fallback: {e}")
            original_df = None

    history = _recent_history(db, conversation.id)

    try:
        result = ai_engine.analyze(
            payload.prompt, tables, history=history, chart_override=payload.chart_override, intent=payload.intent,
            guided=(payload.analysis_mode == "guided"), skip_prep=payload.skip_prep, original_df=original_df,
        )
    except Exception as e:
        print(f"[chat] AI analysis failed: {e}")
        raise HTTPException(502, ai_engine.friendly_ai_error(e))

    # A "transform" always persists its result as a new saved table; so
    # does an "analyze" that had to prepare its own table first (see
    # ai_engine._run_analyze_with_prep) - either way, cleaned_df being set
    # is what means a real, executed table exists to save, regardless of
    # which action produced it.
    new_version = None
    if result.get("cleaned_df") is not None:
        new_version = _save_cleaning_result(db, ds, source_versions, payload.prompt, result)

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
    )


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
        other_ds = db.query(models.DataSource).filter(
            models.DataSource.id == other_id, models.DataSource.owner_id == user.id
        ).first()
        if not other_ds:
            raise HTTPException(404, "One of the added data sources no longer exists or is not yours.")
        other_ds_cache[other_id] = other_ds
        return other_ds

    for source_id in ordered_ids:
        if source_id == "original":
            try:
                original_df = load_dataframe(ds, table=table, version="original", db=db)
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
            .filter(models.DatasetVersion.id == source_id, models.DataSource.owner_id == user.id)
            .first()
        )
        if not version:
            raise HTTPException(404, "One of the selected tables no longer exists. Please update your selection and try again.")
        label = version.name
        if version.datasource_id != ds.id:
            other_ds = _get_other_ds(version.datasource_id)
            label = f"{other_ds.name} — {version.name}"
        try:
            tables[_unique_key(label)] = load_version_dataframe(version)
        except Exception as e:
            raise HTTPException(400, f"Could not load data: {e}")
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

    conversation = db.query(models.Conversation).filter(
        models.Conversation.id == msg.conversation_id, models.Conversation.owner_id == user.id
    ).first()
    if not conversation:
        raise HTTPException(404, "Message not found.")

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
    try:
        tables, source_versions, original_df, sources_manifest = _load_selected_tables(
            db, user, ds, requested_ids, table=None
        )
    except NeedsTableSelection as e:
        available_list = ", ".join(e.available)
        raise HTTPException(400, f"This datasource has multiple tables/collections ({available_list}); please pick one before verifying.")

    if original_df is None:
        try:
            original_df = load_dataframe(ds, table=None, version="original", db=db)
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


def _save_cleaning_result(
    db: Session, ds: models.DataSource, source_versions: list[models.DatasetVersion], prompt: str, result: dict
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
    )
    db.add(version)
    db.commit()
    db.refresh(version)
    return version


def _get_or_create_conversation(
    db: Session, user: models.User, conversation_id: str | None, datasource_id: str, first_prompt: str
) -> models.Conversation:
    if conversation_id:
        conv = db.query(models.Conversation).filter(
            models.Conversation.id == conversation_id, models.Conversation.owner_id == user.id
        ).first()
        if conv:
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
    sources=None,
) -> schemas.ChatResponse:
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
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    return schemas.ChatResponse(
        conversation_id=conversation_id,
        message_id=msg.id,
        action=action,
        reply_text=reply_text,
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
    )
