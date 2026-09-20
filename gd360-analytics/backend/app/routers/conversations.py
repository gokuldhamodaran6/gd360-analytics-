"""
List and resume past chat conversations. Powers two things:
  1. The home pages "Recent conversations" panel, so a person can see and
     jump back into their last few analysis sessions without hunting for
     the right data source first.
  2. The workspace resuming a prior conversation (via a `conversation`
     query param) with its full message + chart history restored, instead
     of always starting from a blank chat.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("")
def list_conversations(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    conversations = (
        db.query(models.Conversation)
        .filter(models.Conversation.owner_id == user.id)
        .all()
    )

    datasource_names: dict[str, str] = {}
    ds_ids = {c.datasource_id for c in conversations if c.datasource_id}
    if ds_ids:
        rows = db.query(models.DataSource).filter(models.DataSource.id.in_(ds_ids)).all()
        datasource_names = {row.id: row.name for row in rows}

    out = []
    for c in conversations:
        messages = sorted(c.messages, key=lambda m: m.created_at)
        if not messages:
            continue
        last = messages[-1]

        last_chart_type = None
        for m in reversed(messages):
            spec = m.chart_spec
            if spec:
                data = spec.get("data") if isinstance(spec, dict) else None
                if data and isinstance(data, list) and data:
                    last_chart_type = data[0].get("type")
                break

        out.append({
            "id": c.id,
            "title": c.title or "Untitled analysis",
            "datasource_id": c.datasource_id,
            "datasource_name": datasource_names.get(c.datasource_id) if c.datasource_id else None,
            "message_count": len(messages),
            "last_message": last.content,
            "last_chart_type": last_chart_type,
            "created_at": c.created_at,
            "updated_at": last.created_at,
        })

    out.sort(key=lambda row: row["updated_at"], reverse=True)
    return out


@router.patch("/{conversation_id}")
def rename_conversation(
    conversation_id: str,
    payload: schemas.RenameConversationRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Lets a person give a conversation their own name (rather than living
    forever with the auto-generated title from its first question) - shown
    everywhere a conversation is listed: the homepage's Recent
    conversations, a data source's own conversation list, and the
    Workspace page's own Recent conversations panel. All three read the
    same title from here, so a rename made in any one of them is instantly
    the title everywhere else too, the next time each is loaded."""
    conv = db.query(models.Conversation).filter(
        models.Conversation.id == conversation_id, models.Conversation.owner_id == user.id
    ).first()
    if not conv:
        raise HTTPException(404, "Conversation not found.")
    conv.title = payload.title.strip()[:80] or conv.title
    db.commit()
    return {"id": conv.id, "title": conv.title}


@router.get("/{conversation_id}/messages")
def get_conversation_messages(
    conversation_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    conv = db.query(models.Conversation).filter(
        models.Conversation.id == conversation_id, models.Conversation.owner_id == user.id
    ).first()
    if not conv:
        raise HTTPException(404, "Conversation not found.")

    messages = sorted(conv.messages, key=lambda m: m.created_at)
    return {
        "id": conv.id,
        "title": conv.title,
        "datasource_id": conv.datasource_id,
        "messages": [
            {
                "id": m.id,
                "role": m.role,
                "content": m.content,
                "chart_spec": m.chart_spec,
                "insight": m.insight,
                "suggestions": m.suggestions,
                "needs_clarification": m.needs_clarification,
                # Which kind of turn this was - needed so a resumed
                # conversation can show the "Double-check this" action on
                # the same messages a live one does (only analyze/transform
                # turns that actually computed something).
                "action": m.action,
                "created_at": m.created_at,
            }
            for m in messages
        ],
    }
