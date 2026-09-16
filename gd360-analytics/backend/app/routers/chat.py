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
import time
from collections import defaultdict, deque
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, schemas
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..schemas_extra import ChatRequestFull
from ..services import ai_engine
from ..services.data_loader import (
    load_dataframe, load_version_dataframe, dataframe_to_csv_bytes, ensure_legacy_migrated, NeedsTableSelection,
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
    # the untouched data, anything else is a DatasetVersion.id. Picking more
    # than one lets a single prompt compare or combine several tables at
    # once; each entry is only loaded once even if listed twice.
    requested_ids = payload.source_version_ids or ["original"]
    ordered_ids: list[str] = []
    for raw_id in requested_ids:
        key = raw_id or "original"
        if key not in ordered_ids:
            ordered_ids.append(key)

    tables: dict[str, object] = {}
    used_names: set[str] = set()
    source_versions: list[models.DatasetVersion] = []

    def _unique_key(name: str) -> str:
        key, n = name, 2
        while key in used_names:
            key = f"{name} ({n})"
            n += 1
        used_names.add(key)
        return key

    for source_id in ordered_ids:
        if source_id == "original":
            try:
                tables[_unique_key("Original data")] = load_dataframe(ds, table=payload.table, version="original")
            except NeedsTableSelection as e:
                available_list = ", ".join(e.available)
                reply = f"This datasource has multiple tables/collections: {available_list}. Which one would you like to analyze?"
                return _persist_and_respond(db, conversation.id, reply, needs_clarification=True)
            except Exception as e:
                raise HTTPException(400, f"Could not load data: {e}")
            continue

        version = db.query(models.DatasetVersion).filter(
            models.DatasetVersion.id == source_id, models.DatasetVersion.datasource_id == ds.id,
        ).first()
        if not version:
            raise HTTPException(404, "One of the selected tables no longer exists. Please update your selection and try again.")
        try:
            tables[_unique_key(version.name)] = load_version_dataframe(version)
        except Exception as e:
            raise HTTPException(400, f"Could not load data: {e}")
        source_versions.append(version)

    history = _recent_history(db, conversation.id)

    try:
        result = ai_engine.analyze(payload.prompt, tables, history=history, chart_override=payload.chart_override, intent=payload.intent)
    except Exception as e:
        raise HTTPException(502, f"AI analysis failed: {e}")

    new_version = None
    if result.get("action") == "transform" and result.get("cleaned_df") is not None:
        new_version = _save_cleaning_result(db, ds, source_versions, payload.prompt, result)

    reply_text = result.get("clarifying_question") or result.get("narrative") or "Done."
    if result.get("action") == "transform" and result.get("rows_before") is not None:
        rows_before = result.get("rows_before")
        rows_after = result.get("rows_after")
        nulls_before = result.get("nulls_before")
        nulls_after = result.get("nulls_after")
        arrow = "→"
        reply_text += f" ({rows_before} {arrow} {rows_after} rows, {nulls_before} {arrow} {nulls_after} missing values)"

    return _persist_and_respond(
        db, conversation.id, reply_text,
        action=result.get("action", "analyze"),
        chart_spec=result.get("chart_spec"),
        insight=result.get("insight"),
        suggestions={"charts": result.get("suggested_charts"), "stats": result.get("suggested_stats")},
        needs_clarification=result.get("needs_clarification", False),
        rows_before=result.get("rows_before"),
        rows_after=result.get("rows_after"),
        nulls_before=result.get("nulls_before"),
        nulls_after=result.get("nulls_after"),
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
        name=f"Version {max_position + 1}",
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
    return [{"role": m.role, "content": m.content} for m in reversed(msgs)]


def _persist_and_respond(
    db: Session, conversation_id: str, reply_text: str, action: str = "analyze",
    chart_spec=None, insight=None, suggestions=None, needs_clarification=False,
    rows_before=None, rows_after=None, nulls_before=None, nulls_after=None,
    new_version_id=None, new_version_name=None,
) -> schemas.ChatResponse:
    msg = models.Message(
        conversation_id=conversation_id,
        role="assistant",
        content=reply_text,
        chart_spec=chart_spec,
        insight=insight,
        suggestions=suggestions,
        needs_clarification=needs_clarification,
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
        insight=insight,
        suggested_charts=(suggestions or {}).get("charts"),
        suggested_stats=(suggestions or {}).get("stats"),
        needs_clarification=needs_clarification,
        rows_before=rows_before,
        rows_after=rows_after,
        nulls_before=nulls_before,
        nulls_after=nulls_after,
        new_version_id=new_version_id,
        new_version_name=new_version_name,
    )
