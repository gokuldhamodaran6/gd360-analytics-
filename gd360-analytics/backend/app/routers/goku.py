"""
Goku: the guided, beginner-friendly AI helper that lives only inside the
Workspace page (never the main Ask GD360 analysis chat, and never anywhere
else in the app). Its whole purpose is to take someone who has just
uploaded data - possibly with zero data-analytics background - and walk
them, in plain language, one concrete step at a time, from "I have this
data" to the result they are actually after: what needs cleaning first,
what to explore next, and what question to ask the main analysis chat to
get there. Goku never runs code or computes anything itself; every "here
is the real answer" moment still happens in the main chat, which actually
executes pandas against the data. See services/ai_engine.py goku_chat for
exactly what Goku is given and how it decides what to say.

There is only ever ONE Goku conversation per (datasource, owner) - unlike
the main analysis chat, which can have several separate conversations for
the same data source, reopening Goku always picks back up exactly where
the person left off on that data source.

Since 2026-09-23: opening Goku on a data source uses the same collaborate-
tier access check as the main chat/datasources endpoints (see services/
workspace_access.py) - a workspace member can open Goku on a shared data
source, not just its owner. Its actual message HISTORY stays deliberately
per-person (GokuMessage.owner_id == the signed-in user, untouched below):
Goku is a personal, guided walkthrough for whoever is looking at the data
right now, not a shared team thread, so two teammates each get their own
"ONE Goku conversation per (datasource, owner)" on the very same shared
data source rather than reading each other's beginner Q&A.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..schemas_extra import GokuChatRequest
from ..services import ai_engine, workspace_access
from ..services.data_loader import ensure_legacy_migrated, NeedsTableSelection
from .chat import _load_selected_tables

router = APIRouter(prefix="/goku", tags=["goku"])

# Fixed, deterministic (never AI-generated) opening line - instant, free,
# and guaranteed identical every single time a person first opens Goku on
# a given data source, exactly as specified.
_GOKU_GREETING = "Hi, I am Goku! How can I help you with this data today?"


def _get_accessible_datasource(db: Session, datasource_id: str, user: models.User) -> models.DataSource:
    ds = db.query(models.DataSource).filter(models.DataSource.id == datasource_id).first()
    if not ds or not workspace_access.can_access_datasource(db, ds, user):
        raise HTTPException(404, "Datasource not found.")
    return ds


def _serialize(m: models.GokuMessage) -> dict:
    return {
        "id": m.id,
        "role": m.role,
        "content": m.content,
        "action_prompts": m.action_prompts,
        "created_at": m.created_at,
    }


@router.get("/{datasource_id}/messages")
def get_goku_messages(
    datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    _get_accessible_datasource(db, datasource_id, user)

    messages = (
        db.query(models.GokuMessage)
        .filter(models.GokuMessage.datasource_id == datasource_id, models.GokuMessage.owner_id == user.id)
        .order_by(models.GokuMessage.created_at)
        .all()
    )

    if not messages:
        greeting = models.GokuMessage(
            datasource_id=datasource_id, owner_id=user.id, role="assistant", content=_GOKU_GREETING,
        )
        db.add(greeting)
        db.commit()
        db.refresh(greeting)
        messages = [greeting]

    return {"messages": [_serialize(m) for m in messages]}


@router.post("/chat")
def goku_chat(
    payload: GokuChatRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    ds = _get_accessible_datasource(db, payload.datasource_id, user)
    ensure_legacy_migrated(db, ds)

    message = (payload.message or "").strip()
    if not message:
        raise HTTPException(400, "Message cannot be empty.")

    requested_ids = payload.source_version_ids or ["original"]
    try:
        tables, _, _, _ = _load_selected_tables(db, user, ds, requested_ids, table=None)
    except NeedsTableSelection as e:
        available_list = ", ".join(e.available)
        raise HTTPException(
            400, f"This datasource has multiple tables/collections ({available_list}); please pick one first."
        )

    goku_history_rows = (
        db.query(models.GokuMessage)
        .filter(models.GokuMessage.datasource_id == ds.id, models.GokuMessage.owner_id == user.id)
        .order_by(models.GokuMessage.created_at.desc())
        .limit(16)
        .all()
    )
    goku_history = [{"role": m.role, "content": m.content} for m in reversed(goku_history_rows)]

    main_chat_history = _latest_main_chat_history(db, ds.id, user.id)
    main_chat_status = _latest_main_chat_status(db, ds.id, user.id)

    user_msg = models.GokuMessage(datasource_id=ds.id, owner_id=user.id, role="user", content=message)
    db.add(user_msg)
    db.commit()

    try:
        result = ai_engine.goku_chat(message, tables, goku_history, main_chat_history, main_chat_status=main_chat_status)
    except Exception as e:
        print(f"[goku] Goku could not respond: {e}")
        raise HTTPException(502, ai_engine.friendly_ai_error(e))

    assistant_msg = models.GokuMessage(
        datasource_id=ds.id, owner_id=user.id, role="assistant",
        content=result["reply"], action_prompts=result.get("action_prompts") or None,
    )
    db.add(assistant_msg)
    db.commit()
    db.refresh(assistant_msg)

    return _serialize(assistant_msg)


def _latest_main_chat_history(db: Session, datasource_id: str, owner_id: str, limit: int = 10) -> list[dict]:
    """Finds the most RECENTLY ACTIVE Ask GD360 conversation for this data
    source (by its latest message, not when the conversation itself was
    first created - a resumed older conversation that just got a new
    message is "more recent" than a newer conversation nobody has touched
    since), so Goku can see what the person has already tried there and
    avoid repeating advice they have already acted on. Only plain
    role/content is needed here - unlike the main chat own history-building
    (chat._recent_history), Goku has no use for the embedded code markers,
    since it never replays or writes code itself."""
    latest_message = (
        db.query(models.Message)
        .join(models.Conversation, models.Message.conversation_id == models.Conversation.id)
        .filter(models.Conversation.datasource_id == datasource_id, models.Conversation.owner_id == owner_id)
        .order_by(models.Message.created_at.desc())
        .first()
    )
    if not latest_message:
        return []

    msgs = (
        db.query(models.Message)
        .filter(models.Message.conversation_id == latest_message.conversation_id)
        .order_by(models.Message.created_at.desc())
        .limit(limit)
        .all()
    )
    return [{"role": m.role, "content": m.content} for m in reversed(msgs)]


def _latest_main_chat_status(db: Session, datasource_id: str, owner_id: str) -> str | None:
    """A small, deterministic fact - read straight off the real database
    row, never inferred from chat text - about whether the most recent
    main-chat step genuinely just completed. This is what lets Goku open
    with a real "Done" confirmation and hand over exactly one clear "Next:"
    step (see GOKU_SYSTEM_PROMPT), instead of only guessing that from prose,
    which is the same "ground it in a real fact" approach the rest of this
    app already uses. Returns None when there is nothing to report yet: no
    main-chat activity at all, the latest turn was a clarifying question, or
    it was a failed attempt that produced no real result (no code saved)."""
    latest_message = (
        db.query(models.Message)
        .join(models.Conversation, models.Message.conversation_id == models.Conversation.id)
        .filter(models.Conversation.datasource_id == datasource_id, models.Conversation.owner_id == owner_id)
        .order_by(models.Message.created_at.desc())
        .first()
    )
    if not latest_message or latest_message.role != "assistant":
        return None
    if latest_message.needs_clarification or not latest_message.code:
        return None
    if latest_message.action == "transform":
        return (
            "The most recent step in the main analysis chat just completed successfully - it created a NEW "
            "table, now saved as a version the person can keep building on."
        )
    if latest_message.action == "analyze":
        return (
            "The most recent step in the main analysis chat just completed successfully - it produced a "
            "chart and an insight."
        )
    return None
