"""
List and resume past chat conversations. Powers two things:
  1. The home pages "Recent conversations" panel, so a person can see and
     jump back into their last few analysis sessions without hunting for
     the right data source first.
  2. The workspace resuming a prior conversation (via a `conversation`
     query param) with its full message + chart history restored, instead
     of always starting from a blank chat.

Since 2026-09-23, a Project (Conversation) built on a data source that's
been shared into a team workspace is visible to every member of that
workspace, not just whoever started it - see services/workspace_access.py
for the shared access model this file, routers/datasources.py and
routers/chat.py all now use. Renaming/pinning it needs editable-tier
access (any role except a workspace "viewer"); deleting it is narrower
still - only its own creator, or the data source's owner
(workspace_access.can_delete_conversation), independent of role. Every
Project returned here also carries created_by_*/is_own/can_edit/can_delete
so the frontend can show who made it and which actions to offer without
re-deriving the role logic itself.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import workspace_access

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("")
def list_conversations(
    workspace_id: str | None = None,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    if workspace_id:
        # A Project's workspace is its data source's workspace - there is
        # no separate workspace_id on Conversation itself, so this is
        # exactly the same NULL-means-personal-workspace rule
        # routers/datasources.py list_datasources uses, applied through the
        # join instead of directly. Must actually belong to the requested
        # workspace to see anything in it.
        member = (
            db.query(models.WorkspaceMember)
            .filter(models.WorkspaceMember.workspace_id == workspace_id, models.WorkspaceMember.user_id == user.id)
            .first()
        )
        if not member:
            return []
        ds_ids_in_workspace = workspace_access.accessible_datasource_ids_in_workspace(db, user, workspace_id)
        query = db.query(models.Conversation).filter(models.Conversation.datasource_id.in_(ds_ids_in_workspace))
    else:
        query = db.query(models.Conversation).filter(workspace_access.conversation_access_filter(db, user))
    conversations = query.all()

    datasource_names: dict[str, str] = {}
    ds_ids = {c.datasource_id for c in conversations if c.datasource_id}
    if ds_ids:
        rows = db.query(models.DataSource).filter(models.DataSource.id.in_(ds_ids)).all()
        datasource_names = {row.id: row.name for row in rows}

    # Who created each Project - batched into one lookup rather than a
    # query per row (2026-09-23, roles & attribution round) - so a shared
    # workspace's Projects list can show "by <name>" instead of every
    # teammate's Projects looking anonymous/like they came from whoever's
    # looking at the list right now.
    creator_ids = {c.owner_id for c in conversations}
    creators = {
        u.id: u for u in db.query(models.User).filter(models.User.id.in_(creator_ids)).all()
    } if creator_ids else {}

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

        creator = creators.get(c.owner_id)
        out.append({
            "id": c.id,
            "title": c.title or "Untitled analysis",
            "datasource_id": c.datasource_id,
            "datasource_name": datasource_names.get(c.datasource_id) if c.datasource_id else None,
            "message_count": len(messages),
            "last_message": last.content,
            "last_chart_type": last_chart_type,
            "pinned": bool(c.pinned),
            # 2026-09-23 (folders round): which Folder this Project is
            # filed into, if any - NULL/omitted means "unfiled", the
            # Projects page's default view. See routers/folders.py.
            "folder_id": c.folder_id,
            "created_at": c.created_at,
            "updated_at": last.created_at,
            "created_by_id": c.owner_id,
            "created_by_name": creator.full_name if creator else None,
            "created_by_email": creator.email if creator else None,
            "is_own": c.owner_id == user.id,
            # Server-computed, so the frontend never has to re-derive the
            # role logic itself: a workspace "viewer" (or anyone else
            # without editable-tier access) gets both flags false here and
            # simply doesn't render the rename/pin/delete affordances.
            "can_edit": workspace_access.can_edit_conversation(db, c, user),
            "can_delete": workspace_access.can_delete_conversation(db, c, user),
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


@router.patch("/bulk-move")
def bulk_move_conversations(
    payload: schemas.BulkMoveConversationsRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Files (or unfiles, if folder_id is None) several Projects into a
    folder at once - the "select some or all, move to folder" bulk action
    on the Projects page (2026-09-23, folders round). Registered ABOVE the
    "/{conversation_id}" route below so "bulk-move" is never swallowed by
    it as a literal conversation id - route order matters here.

    Each conversation is moved only if this user has editable-tier access
    to it (same check update_conversation uses below) - anything else in
    the list is silently skipped rather than failing the whole batch, since
    a stale selection (something deleted or re-shared out from under the
    person a moment ago) shouldn't block moving everything else they
    legitimately can. The response says exactly which ids landed and which
    didn't, so the frontend can tell the person if anything was skipped."""
    target_folder = None
    if payload.folder_id is not None:
        target_folder = db.query(models.Folder).filter(models.Folder.id == payload.folder_id).first()
        if not target_folder:
            raise HTTPException(404, "Folder not found.")
        role = workspace_access.member_role(db, user.id, target_folder.workspace_id)
        is_edit_role = role in {"owner", "member"} or target_folder.owner_id == user.id
        if role is None and target_folder.owner_id != user.id:
            raise HTTPException(404, "Folder not found.")
        if not is_edit_role:
            raise HTTPException(403, "You have view-only access to this workspace.")

    moved: list[str] = []
    skipped: list[str] = []
    conversations = (
        db.query(models.Conversation)
        .filter(models.Conversation.id.in_(payload.conversation_ids))
        .all()
    )
    found_by_id = {c.id: c for c in conversations}
    for conv_id in payload.conversation_ids:
        conv = found_by_id.get(conv_id)
        if not conv or not workspace_access.can_edit_conversation(db, conv, user):
            skipped.append(conv_id)
            continue
        conv.folder_id = target_folder.id if target_folder else None
        moved.append(conv_id)
    db.commit()
    return {"moved": moved, "skipped": skipped, "folder_id": target_folder.id if target_folder else None}


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
    each is loaded. Editable-tier: the data source's owner, or a workspace
    member whose role isn't "viewer", can rename/pin it - not just whoever
    started it, but a read-only workspace member cannot (2026-09-23)."""
    conv = db.query(models.Conversation).filter(models.Conversation.id == conversation_id).first()
    if not conv or not workspace_access.can_access_conversation(db, conv, user):
        raise HTTPException(404, "Conversation not found.")
    if not workspace_access.can_edit_conversation(db, conv, user):
        raise HTTPException(403, "You have view-only access to this Project.")
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
    conversation had simply been left alone.

    Narrower than viewing/renaming (see workspace_access.
    can_delete_conversation): only this Project's own creator, or the data
    source's owner, can delete it - a shared workspace lets teammates work
    together on a Project, not wipe out each other's chat history."""
    conv = db.query(models.Conversation).filter(models.Conversation.id == conversation_id).first()
    if not conv or not workspace_access.can_delete_conversation(db, conv, user):
        raise HTTPException(404, "Conversation not found.")
    db.delete(conv)
    db.commit()
    return {"id": conversation_id, "deleted": True}


@router.get("/{conversation_id}/messages")
def get_conversation_messages(
    conversation_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    conv = db.query(models.Conversation).filter(models.Conversation.id == conversation_id).first()
    if not conv or not workspace_access.can_access_conversation(db, conv, user):
        raise HTTPException(404, "Conversation not found.")

    messages = sorted(conv.messages, key=lambda m: m.created_at)
    creator = db.query(models.User).filter(models.User.id == conv.owner_id).first()
    return {
        "id": conv.id,
        "title": conv.title,
        "datasource_id": conv.datasource_id,
        "created_by_id": conv.owner_id,
        "created_by_name": creator.full_name if creator else None,
        "created_by_email": creator.email if creator else None,
        "is_own": conv.owner_id == user.id,
        "can_edit": workspace_access.can_edit_conversation(db, conv, user),
        "can_delete": workspace_access.can_delete_conversation(db, conv, user),
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
