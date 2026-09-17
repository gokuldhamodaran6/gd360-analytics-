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
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..deps import get_current_user
from ..schemas_extra import GokuChatRequest
from ..services import ai_engine
from ..services.data_loader import ensure_legacy_migrated, NeedsTableSelection
from .chat import _load_selected_tables

router = APIRouter(prefix="/goku", tags=["goku"])

# Fixed, deterministic (never AI-generated) opening line - instant, free,
# and guaranteed identical every single time a person first opens Goku on
# a given data source, exactly as specified.
_GOKU_GREETING = "Hi, I am Goku! How can I help you with this data today?"


def _get_owned_datasource(db: Session, datasource_id: str, user: models.User) -> models.DataSource:
    ds = db.query(models.DataSource).filter(
        models.DataSource.id == datasource_id, models.DataSource.owner_id == user.id
    ).first()
    if not ds:
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
    _get_owned_datasource(db, datasource_id, user)

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
    ds = _get_owned_datasource(db, payload.datasource_id, user)
    ensure_legacy_migrated(db, ds)

    message = (payload.message or "").strip()
    if not message:
        raise HTTPException(400, "Message cannot be empty.")

    requested_ids = payload.source_version_ids or ["original"]
    try:
        tables, _ = _load_selected_tables(db, ds, requested_ids, table=None)
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

    user_msg = models.GokuMessage(datasource_id=ds.id, owner_id=user.id, role="user", content=message)
    db.add(user_msg)
    db.commit()

    try:
        result = ai_engine.goku_chat(message, tables, goku_history, main_chat_history)
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
