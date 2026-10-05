"""
Shared cost-governance for every warehouse pushdown query this app runs
directly inside a customer's BigQuery/Snowflake connection - the chat
"ask a question, run it as one real query instead of pulling rows"
path (routers/chat.py's `_try_bigquery_pushdown`/`_try_snowflake_pushdown`)
and, as of 2026-10-05, the Data tab's full-table column profiling
(services/profiling.py + routers/datasources.py's `/profile` endpoint)
both spend from the SAME per-user daily scanned-bytes budget, logged to
the SAME audit table (models.PushdownQueryLog) - a person's profiling
calls and their chat questions are both "warehouse usage," and a single
shared budget is what actually bounds what one person can cost in a day,
not two budgets that each look individually safe but double the real
exposure together.

Pulled out of routers/chat.py (which still imports and uses these two
functions unchanged, under their original names) into its own module
specifically so a SECOND caller (routers/datasources.py) does not have to
import a router's own private helpers - one source of truth in a service
module, not duplicated logic that could quietly drift between the two
call sites over time.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models


def log_pushdown(db: Session, user_id: str, datasource_id: str, provider: str, sql_text: str,
                  bytes_scanned, status: str, error_message: str = None):
    """Records one pushdown/profiling attempt (BigQuery, Snowflake - any
    future warehouse the same way) to the audit log, success or not - see
    models.PushdownQueryLog. Best-effort only: a logging failure must
    never break the actual caller's request, so any error here is
    swallowed (after being printed) rather than raised. Committed on its
    own right away rather than left pending on the shared session, so the
    audit row is durable even if something later in this same request has
    to roll back."""
    try:
        db.add(models.PushdownQueryLog(
            owner_id=user_id, datasource_id=datasource_id, provider=provider,
            sql_text=sql_text or "", bytes_scanned=bytes_scanned, status=status,
            error_message=error_message,
        ))
        db.commit()
    except Exception as e:
        print(f"[pushdown_budget] Failed to write pushdown audit log (non-fatal): {e}")
        db.rollback()


def todays_pushdown_bytes(db: Session, user_id: str) -> int:
    """Total bytes this person's pushdown/profiling queries (any provider,
    any caller - chat questions and Data-tab profiling both count) have
    made a warehouse scan since midnight UTC today - the running total the
    daily per-customer cost budget is checked against. Read straight off
    the audit log rather than a separate running-totals table, so there is
    nothing else to keep in sync."""
    start_of_day = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    total = db.query(func.sum(models.PushdownQueryLog.bytes_scanned)).filter(
        models.PushdownQueryLog.owner_id == user_id,
        models.PushdownQueryLog.created_at >= start_of_day,
        models.PushdownQueryLog.status == "ok",
    ).scalar()
    return total or 0
