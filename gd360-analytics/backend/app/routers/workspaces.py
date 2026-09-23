"""
Real workspaces: create one, rename it, see who's in it, and invite people
to it via a single shareable link (no transactional email sending exists
in this app yet - see the 2026-09-23 build notes - so joining works by
someone opening /invite/<token> and signing in, not by an emailed invite).

Every account gets one non-deletable "Personal Workspace" automatically
(created at registration - see routers/auth.py - or backfilled for
pre-existing accounts by database._ensure_personal_workspaces). Anything
else here is a workspace the account owner created on request.

Scope note (2026-09-23): this round makes workspace membership and
shareable-link joining fully real, and lets each account organize ITS OWN
data sources/projects by workspace. It deliberately does not yet let a
workspace's OTHER members see or open each other's data sources/projects -
every read/write on a data source or conversation is still scoped to
`owner_id == the signed-in user`, exactly as before. Opening that up is a
security-sensitive change (who can see which customer's data) that touches
the access checks in routers/datasources.py, routers/conversations.py and
routers/chat.py, and deserves its own careful, audited pass rather than
being folded into this one - flagged clearly rather than silently left
half-done.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user

router = APIRouter(tags=["workspaces"])


def _workspace_out(db: Session, ws: models.Workspace, user_id: str) -> schemas.WorkspaceOut:
    member = (
        db.query(models.WorkspaceMember)
        .filter(models.WorkspaceMember.workspace_id == ws.id, models.WorkspaceMember.user_id == user_id)
        .first()
    )
    member_count = db.query(models.WorkspaceMember).filter(models.WorkspaceMember.workspace_id == ws.id).count()
    datasource_count = db.query(models.DataSource).filter(models.DataSource.workspace_id == ws.id).count()
    return schemas.WorkspaceOut(
        id=ws.id,
        name=ws.name,
        is_personal=ws.is_personal,
        role=member.role if member else "member",
        member_count=member_count,
        datasource_count=datasource_count,
        invite_token=ws.invite_token,
        created_at=ws.created_at,
    )


def _get_membership(db: Session, workspace_id: str, user_id: str) -> models.WorkspaceMember:
    """404 (not 403) for a workspace the caller isn't a member of - a
    workspace's existence/name is not something a non-member should be
    able to probe for by ID."""
    member = (
        db.query(models.WorkspaceMember)
        .filter(models.WorkspaceMember.workspace_id == workspace_id, models.WorkspaceMember.user_id == user_id)
        .first()
    )
    if not member:
        raise HTTPException(404, "Workspace not found.")
    return member


@router.get("/workspaces", response_model=list[schemas.WorkspaceOut])
def list_workspaces(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    memberships = db.query(models.WorkspaceMember).filter(models.WorkspaceMember.user_id == user.id).all()
    ws_ids = [m.workspace_id for m in memberships]
    if not ws_ids:
        return []
    workspaces = db.query(models.Workspace).filter(models.Workspace.id.in_(ws_ids)).all()
    out = [_workspace_out(db, ws, user.id) for ws in workspaces]
    # Personal workspace always first, then newest-created.
    out.sort(key=lambda w: w.created_at, reverse=True)
    out.sort(key=lambda w: not w.is_personal)
    return out


@router.post("/workspaces", response_model=schemas.WorkspaceOut, status_code=201)
def create_workspace(
    payload: schemas.WorkspaceCreate, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    ws = models.Workspace(name=payload.name.strip()[:80] or "Untitled workspace", owner_id=user.id, is_personal=False)
    db.add(ws)
    db.flush()
    db.add(models.WorkspaceMember(workspace_id=ws.id, user_id=user.id, role="owner"))
    db.commit()
    db.refresh(ws)
    return _workspace_out(db, ws, user.id)


@router.patch("/workspaces/{workspace_id}", response_model=schemas.WorkspaceOut)
def rename_workspace(
    workspace_id: str,
    payload: schemas.WorkspaceRenameRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    member = _get_membership(db, workspace_id, user.id)
    if member.role != "owner":
        raise HTTPException(403, "Only the workspace owner can rename it.")
    ws = db.query(models.Workspace).filter(models.Workspace.id == workspace_id).first()
    ws.name = payload.name.strip()[:80] or ws.name
    db.commit()
    db.refresh(ws)
    return _workspace_out(db, ws, user.id)


@router.get("/workspaces/{workspace_id}", response_model=schemas.WorkspaceDetailOut)
def get_workspace(workspace_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _get_membership(db, workspace_id, user.id)
    ws = db.query(models.Workspace).filter(models.Workspace.id == workspace_id).first()
    if not ws:
        raise HTTPException(404, "Workspace not found.")
    rows = (
        db.query(models.WorkspaceMember, models.User)
        .join(models.User, models.User.id == models.WorkspaceMember.user_id)
        .filter(models.WorkspaceMember.workspace_id == workspace_id)
        .all()
    )
    members = [
        schemas.WorkspaceMemberOut(
            user_id=u.id, email=u.email, full_name=u.full_name, role=m.role, created_at=m.created_at
        )
        for m, u in rows
    ]
    members.sort(key=lambda m: m.created_at)
    base = _workspace_out(db, ws, user.id)
    return schemas.WorkspaceDetailOut(**base.model_dump(), members=members)


@router.post("/workspaces/{workspace_id}/invite/regenerate", response_model=schemas.WorkspaceOut)
def regenerate_invite(workspace_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Invalidates the old shareable link and issues a new one - for when
    an old link was shared somewhere it shouldn't have been."""
    member = _get_membership(db, workspace_id, user.id)
    if member.role != "owner":
        raise HTTPException(403, "Only the workspace owner can reset the invite link.")
    ws = db.query(models.Workspace).filter(models.Workspace.id == workspace_id).first()
    ws.invite_token = models.gen_uuid()
    db.commit()
    db.refresh(ws)
    return _workspace_out(db, ws, user.id)


@router.delete("/workspaces/{workspace_id}")
def delete_workspace(workspace_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    member = _get_membership(db, workspace_id, user.id)
    if member.role != "owner":
        raise HTTPException(403, "Only the workspace owner can delete it.")
    ws = db.query(models.Workspace).filter(models.Workspace.id == workspace_id).first()
    if ws.is_personal:
        raise HTTPException(400, "Your personal workspace can't be deleted.")
    datasource_count = db.query(models.DataSource).filter(models.DataSource.workspace_id == ws.id).count()
    if datasource_count:
        raise HTTPException(
            400,
            f"This workspace still has {datasource_count} data source(s) in it. Move or delete them first.",
        )
    db.delete(ws)
    db.commit()
    return {"id": workspace_id, "deleted": True}


@router.delete("/workspaces/{workspace_id}/members/{member_user_id}")
def remove_member(
    workspace_id: str,
    member_user_id: str,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """The owner can remove anyone else; anyone can remove themselves
    (leave) unless they're the owner - an owner leaves by deleting the
    whole workspace instead, so a workspace is never left ownerless."""
    acting_member = _get_membership(db, workspace_id, user.id)
    is_self = member_user_id == user.id
    if not is_self and acting_member.role != "owner":
        raise HTTPException(403, "Only the workspace owner can remove other members.")
    if is_self and acting_member.role == "owner":
        raise HTTPException(400, "The workspace owner can't leave their own workspace - delete it instead.")
    target = (
        db.query(models.WorkspaceMember)
        .filter(models.WorkspaceMember.workspace_id == workspace_id, models.WorkspaceMember.user_id == member_user_id)
        .first()
    )
    if not target:
        raise HTTPException(404, "That person isn't in this workspace.")
    db.delete(target)
    db.commit()
    return {"user_id": member_user_id, "removed": True}


@router.get("/invites/{token}", response_model=schemas.InvitePreviewOut)
def preview_invite(token: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = db.query(models.Workspace).filter(models.Workspace.invite_token == token).first()
    if not ws:
        raise HTTPException(404, "This invite link is invalid or has been reset.")
    member_count = db.query(models.WorkspaceMember).filter(models.WorkspaceMember.workspace_id == ws.id).count()
    already_member = (
        db.query(models.WorkspaceMember)
        .filter(models.WorkspaceMember.workspace_id == ws.id, models.WorkspaceMember.user_id == user.id)
        .first()
        is not None
    )
    return schemas.InvitePreviewOut(
        workspace_id=ws.id, workspace_name=ws.name, member_count=member_count, already_member=already_member
    )


@router.post("/invites/{token}/join", response_model=schemas.WorkspaceOut)
def join_via_invite(token: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ws = db.query(models.Workspace).filter(models.Workspace.invite_token == token).first()
    if not ws:
        raise HTTPException(404, "This invite link is invalid or has been reset.")
    existing = (
        db.query(models.WorkspaceMember)
        .filter(models.WorkspaceMember.workspace_id == ws.id, models.WorkspaceMember.user_id == user.id)
        .first()
    )
    if not existing:
        db.add(models.WorkspaceMember(workspace_id=ws.id, user_id=user.id, role="member"))
        db.commit()
    return _workspace_out(db, ws, user.id)
