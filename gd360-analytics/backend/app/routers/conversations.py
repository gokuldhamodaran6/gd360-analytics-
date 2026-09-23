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
def list_conversations(
    workspace_id: str | None = None,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    query = db.query(models.Conversation).filter(models.Conversation.owner_id == user.id)
    if workspace_id:
        # A Project's workspace is its data source's workspace - there is
        # no separate workspace_id on Conversation itself, so this is
        # exactly the same NULL-means-personal-workspace rule
        # routers/datasources.py list_datasources uses, applied through the
        # join instead of directly.
        member = (
            db.query(models.WorkspaceMember)
            .filter(models.WorkspaceMember.workspace_id == workspace_id, models.WorkspaceMember.user_id == user.id)
            .first()
        )
        ws = db.query(models.Workspace).filter(models.Workspace.id == workspace_id).first() if member else None
        ds_query = db.query(models.DataSource.id).filter(models.DataSource.owner_id == user.id)
        if ws and ws.is_personal:
            ds_query = ds_query.filter(
                (models.DataSource.workspace_id == workspace_id) | (models.DataSource.workspace_id.is_(None))
            )
        else:
            ds_query = ds_query.filter(models.DataSource.workspace_id == workspace_id)
        ds_ids_in_workspace = {row[0] for row in ds_query.all()}
        query = query.filter(models.Conversation.datasource_id.in_(ds_ids_in_workspace))
    conversations = query.all()

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
            "pinned": bool(c.pinned),
            "created_at": c.created_at,
            "updated_at": last.created_at,
        })

    # Pinned conversations always float to the top (the same convention as
    # every mainstream chat app), newest-first within each of the two
    # groups - so pinning something is immediately visible as "moved up",
    # not just a quiet badge easy to miss. Python's sort is stable, so
    # sorting by updated_at first and then, separately, by pinned keeps
    # each group in updated_at order without needing a combined key.
    out.sort(key=lambda row: row["updated_at"], reverse=True)
    out.sort(key=lambda row: row["pinned"], reverse=True)
    return out


@router.patch("/{conversation_id}")
def update_conversation(
    conversation_id: str,
    payload: schemas.UpdateConversationRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Updates a conversation's title and/or pinned state - either or both,
    whichever the caller actually sent. Shown everywhere a conversation is
    listed: the homepage's Recent conversations, a data source's own
    conversation list, and the Workspace page's own Recent conversations
    panel. All three read the same row from here, so a change made in any
    one of them is instantly reflected everywhere else too, the next time
    each is loaded."""
    conv = db.query(models.Conversation).filter(
        models.Conversation.id == conversation_id, models.Conversation.owner_id == user.id
    ).first()
    if not conv:
        raise HTTPException(404, "Conversation not found.")
    if payload.title is not None:
        conv.title = payload.title.strip()[:80] or conv.title
    if payload.pinned is not None:
        conv.pinned = payload.pinned
    db.commit()
    return {"id": conv.id, "title": conv.title, "pinned": bool(conv.pinned)}


@router.delete("/{conversation_id}")
def delete_conversation(
    conversation_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Permanently removes a conversation and every message in it (the
    ORM relationship's cascade="all, delete-orphan" takes care of the
    messages once the parent row is deleted through the session, so this
    never leaves orphaned rows behind). This only ever deletes the saved
    chat/analysis history itself - any table version it produced along the
    way stays in the data source's Data tab exactly as it would if the
    conversation had simply been left alone."""
    conv = db.query(models.Conversation).filter(
        models.Conversation.id == conversation_id, models.Conversation.owner_id == user.id
    ).first()
    if not conv:
        raise HTTPException(404, "Conversation not found.")
    db.delete(conv)
    db.commit()
    return {"id": conversation_id, "deleted": True}


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
                # The chart type + tidy underlying rows this chart was built
                # from (see chart_builder.result_to_tidy) - resuming a saved
                # conversation needs these too, not just a live turn, so the
                # Explore panel keeps working (instant, client-side chart
                # type/axis/filter changes) after a page reload.
                "chart_type": m.chart_type,
                "result_columns": m.result_columns,
                "result_rows": m.result_rows,
                "result_truncated": m.result_truncated,
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
