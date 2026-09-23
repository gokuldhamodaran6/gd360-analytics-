"""
Folders for organizing Projects (Conversations) on the home page.

2026-09-23 (folders round, part of the "world-class UI/UX" redesign - see
pages/Dashboard.tsx on the frontend for the select-all/bulk-move UI this
powers): a Folder is purely a grouping label scoped to one workspace - see
models.Folder. It carries no data of its own beyond a name; a Conversation
either has a folder_id pointing at one, or NULL ("unfiled" - the Projects
page's default view).

Access follows the same view/editable split used everywhere else a
workspace shares something (see services/workspace_access.py for the
canonical version of this rule, applied here directly against
Folder.workspace_id since a folder isn't reached through a data source):
  - "view" tier (any workspace member, any role, viewer included): see the
    folder exists, see which Projects are filed into it.
  - "editable" tier (the folder's own creator, always, OR a workspace
    member whose role isn't "viewer"): rename it, delete it, file/unfile
    Projects into or out of it. There is no narrower "delete" tier the way
    Dashboard has - deleting a folder never destroys anything (see
    delete_folder below, which unfiles its Projects rather than touching
    them), so it does not need the same "only the workspace owner" caution
    a truly destructive delete does.

Moving a Project into or out of a folder is done from routers/conversations.py
(bulk_move_conversations) rather than here, since it is fundamentally a
write on the Conversation row - this file owns the folder row itself.

Every "not accessible at all" case here 404s; a workspace member who CAN
see a folder but lacks edit rights gets a 403 - same info-non-leak
convention as workspaces.py/dashboards.py.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import workspace_access

router = APIRouter(prefix="/folders", tags=["folders"])

_EDIT_ROLES = {"owner", "member"}


def _can_view(db: Session, folder: models.Folder, user: models.User) -> bool:
    if folder.owner_id == user.id:
        return True
    return workspace_access.member_role(db, user.id, folder.workspace_id) is not None


def _can_edit(db: Session, folder: models.Folder, user: models.User) -> bool:
    if folder.owner_id == user.id:
        return True
    return workspace_access.member_role(db, user.id, folder.workspace_id) in _EDIT_ROLES


def _get_viewable(db: Session, user: models.User, folder_id: str) -> models.Folder:
    f = db.query(models.Folder).filter(models.Folder.id == folder_id).first()
    if not f or not _can_view(db, f, user):
        raise HTTPException(404, "Folder not found.")
    return f


def _folder_out(db: Session, folder: models.Folder, user: models.User) -> dict:
    count = (
        db.query(func.count(models.Conversation.id))
        .filter(models.Conversation.folder_id == folder.id)
        .scalar()
        or 0
    )
    return {
        "id": folder.id,
        "name": folder.name,
        "workspace_id": folder.workspace_id,
        "created_at": folder.created_at,
        "project_count": count,
        "can_edit": _can_edit(db, folder, user),
    }


@router.get("")
def list_folders(
    workspace_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Every folder in one workspace - a listing endpoint, so a caller who
    isn't even a member of that workspace just sees an empty list rather
    than a 404 (matches GET /conversations?workspace_id= right next door)."""
    if workspace_access.member_role(db, user.id, workspace_id) is None:
        return []
    folders = (
        db.query(models.Folder)
        .filter(models.Folder.workspace_id == workspace_id)
        .order_by(models.Folder.created_at.asc())
        .all()
    )
    return [_folder_out(db, f, user) for f in folders]


@router.post("")
def create_folder(
    payload: schemas.FolderCreate,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    role = workspace_access.member_role(db, user.id, payload.workspace_id)
    if role is None:
        raise HTTPException(404, "Workspace not found.")
    if role not in _EDIT_ROLES:
        raise HTTPException(403, "You have view-only access to this workspace.")
    folder = models.Folder(
        owner_id=user.id,
        workspace_id=payload.workspace_id,
        name=payload.name.strip()[:80] or "New folder",
    )
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return _folder_out(db, folder, user)


@router.patch("/{folder_id}")
def rename_folder(
    folder_id: str,
    payload: schemas.FolderRenameRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    folder = _get_viewable(db, user, folder_id)
    if not _can_edit(db, folder, user):
        raise HTTPException(403, "You have view-only access to this workspace.")
    folder.name = payload.name.strip()[:80] or folder.name
    db.commit()
    return _folder_out(db, folder, user)


@router.delete("/{folder_id}")
def delete_folder(
    folder_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Deletes the folder ITSELF only - every Project filed into it is
    unfiled (folder_id set back to NULL, its own default), never deleted.
    A folder is an organizing label, not a container; removing the label
    should never take anyone's chat history down with it."""
    folder = _get_viewable(db, user, folder_id)
    if not _can_edit(db, folder, user):
        raise HTTPException(403, "You have view-only access to this workspace.")
    db.query(models.Conversation).filter(models.Conversation.folder_id == folder.id).update(
        {models.Conversation.folder_id: None}
    )
    db.delete(folder)
    db.commit()
    return {"id": folder_id, "deleted": True}
