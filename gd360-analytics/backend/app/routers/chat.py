"""
The core AI analytics endpoint. Given a prompt + a datasource, it:
  1. Loads the relevant data (read-only).
  2. Asks the AI engine to plan + (safely) execute pandas code.
  3. Persists the conversation turn.
  4. Returns chart spec + insight + follow-up suggestions, or a
     clarifying question if the AI/system needs more info.
"""
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..schemas_extra import ChatRequestFull
from ..services import ai_engine
from ..services.data_loader import load_dataframe, NeedsTableSelection

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
        raise HTTPException(429, "You're sending requests a bit fast for the free AI tier - please wait a few seconds and try again.")
    window.append(now)


@router.post("", response_model=schemas.ChatResponse)
def chat(payload: ChatRequestFull, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _check_rate_limit(user.id)

    ds = db.query(models.DataSource).filter(
        models.DataSource.id == payload.datasource_id, models.DataSource.owner_id == user.id
    ).first()
    if not ds:
        raise HTTPException(404, "Datasource not found.")

    conversation = _get_or_create_conversation(db, user, payload.conversation_id, ds.id)

    user_msg = models.Message(conversation_id=conversation.id, role="user", content=payload.prompt)
    db.add(user_msg)
    db.commit()

    try:
        df = load_dataframe(ds, table=payload.table)
    except NeedsTableSelection as e:
        reply = f"This datasource has multiple tables/collections: {', '.join(e.available)}. Which one would you like to analyze?"
        return _persist_and_respond(db, conversation.id, reply, needs_clarification=True)
    except Exception as e:
        raise HTTPException(400, f"Could not load data: {e}")

    history = _recent_history(db, conversation.id)

    try:
        result = ai_engine.analyze(payload.prompt, df, history=history, chart_override=payload.chart_override)
    except Exception as e:
        raise HTTPException(502, f"AI analysis failed: {e}")

    reply_text = result.get("clarifying_question") or result.get("narrative") or "Done."

    return _persist_and_respond(
        db, conversation.id, reply_text,
        chart_spec=result.get("chart_spec"),
        insight=result.get("insight"),
        suggestions={"charts": result.get("suggested_charts"), "stats": result.get("suggested_stats")},
        needs_clarification=result.get("needs_clarification", False),
    )


def _get_or_create_conversation(db: Session, user: models.User, conversation_id: str | None, datasource_id: str) -> models.Conversation:
    if conversation_id:
        conv = db.query(models.Conversation).filter(
            models.Conversation.id == conversation_id, models.Conversation.owner_id == user.id
        ).first()
        if conv:
            return conv
    conv = models.Conversation(owner_id=user.id, datasource_id=datasource_id, title="New analysis")
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


def _persist_and_respond(db: Session, conversation_id: str, reply_text: str, chart_spec=None, insight=None, suggestions=None, needs_clarification=False) -> schemas.ChatResponse:
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
        reply_text=reply_text,
        chart_spec=chart_spec,
        insight=insight,
        suggested_charts=(suggestions or {}).get("charts"),
        suggested_stats=(suggestions or {}).get("stats"),
        needs_clarification=needs_clarification,
    )
