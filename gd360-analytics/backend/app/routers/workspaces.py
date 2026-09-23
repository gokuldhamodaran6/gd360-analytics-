"""
Real workspaces: create one, rename it, see who's in it, and invite people
to it via a single shareable link (no transactional email sending exists
in this app yet - see the 2026-09-23 build notes - so joining works by
someone opening /invite/<token> and signing in, not by an emailed invite).

Every account gets one non-deletable "Personal Workspace" automatically
(created at registration - see routers/auth.py - or backfilled for
pre-existing accounts by database._ensure_personal_workspaces). Anything
else here is a workspace the account owner created on request.

Scope history:
  - 2026-09-23 (workspaces v1): workspace membership and shareable-link
    joining made fully real, and each account can organize its own data
    sources/projects by workspace. At that point, a workspace's OTHER
    members could NOT yet see or open each other's data sources/projects -
    every read/write on a data source or conversation was still scoped to
    `owner_id == the signed-in user`, regardless of workspace roster.
  - 2026-09-23 (sharing v1, same day, later round): that gap closed. A
    data source assigned into a shared (non-personal) workspace - see
    routers/datasources.py assign_datasource_workspace and the
    DataSource.workspace_id column - is now visible and usable by every
    member of that workspace, on a two-tier model (see services/
    workspace_access.py for the full contract):
      - "collaborate" tier (the data source's owner OR any workspace
        member): view schema/preview/versions/flow/distinct-values/export,
        run chat/analysis, create/continue conversations (including
        resuming a teammate's), view/rename/pin any conversation on the
        shared data source, create/rename/delete saved views, rename/
        delete saved table versions.
      - "admin" tier (owner_id-only, unchanged): rename/delete the data
        source row itself, reassign which workspace it lives in.
      - Conversation DELETION is its own special case, narrower than the
        rest of collaborate tier: only the conversation's own creator or
        the data source's owner, so one teammate can never wipe another's
        chat history.
    Goku (routers/goku.py) broadened the same way for which data sources
    it can be opened on, but its message history stays intentionally
    per-person (a personal guided walkthrough, not a shared team thread).
    routers/connections.py (the OAuth connect-a-new-source flow) and
    routers/dashboards.py (saved dashboards) were left unchanged - neither
    is a "viewing something already shared" concern, and dashboards are
    not yet tied to a workspace or data source in the schema at all.
  - 2026-09-23 (roles & attribution v1, same day, third round): the flat
    "collaborate" tier above split into "view" and "editable" (see
    services/workspace_access.py's module docstring for the exact rule),
    and WorkspaceMember.role gained a third value, "viewer", alongside the
    existing "owner"/"member" - a viewer can see everything a member can
    (schema/preview/versions/flow/conversations/messages/saved views) but
    can't create or change any of it (no chat/analyze, no saved views, no
    renaming/pinning a conversation, no saved-table edits). Set via the new
    PATCH /workspaces/{id}/members/{user_id}/role (owner-only; a brand new
    member who joins via invite link still defaults to full "member" access
    exactly as before - downgrading to viewer is a deliberate action the
    owner takes afterward, not a separate invite flow). This round also
    added creator attribution (SavedViewOut.created_by_* and the equivalent
    fields on a listed/opened conversation) so a shared Project or saved
    view shows who actually made it, not just whoever's looking at it now.
  - 2026-09-23 (shared dashboards v1, same day, fourth round): dashboards
    (routers/dashboards.py - previously called out above as left
    untouched) can now be shared into a workspace the same way, on the
    same view/editable split, so a team can pin a curated set of charts
    onto one board everyone sees instead of only ever seeing their own.
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


@router.patch("/workspaces/{workspace_id}/members/{member_user_id}/role", response_model=schemas.WorkspaceMemberOut)
def update_member_role(
    workspace_id: str,
    member_user_id: str,
    payload: schemas.WorkspaceMemberRoleUpdate,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Promotes/demotes an existing member between full access ("member")
    and read-only ("viewer") - see services/workspace_access.py for
    exactly what each can do. Owner-only, and the owner's own role (set
    once at workspace creation) can never be changed here, including by
    themselves - an owner who wants to stop being the owner transfers the
    workspace a different way (not built yet) or just deletes it."""
    acting_member = _get_membership(db, workspace_id, user.id)
    if acting_member.role != "owner":
        raise HTTPException(403, "Only the workspace owner can change a member's role.")
    if payload.role not in ("member", "viewer"):
        raise HTTPException(400, "role must be 'member' or 'viewer'.")
    if member_user_id == user.id:
        raise HTTPException(400, "You can't change your own role.")
    target = (
        db.query(models.WorkspaceMember)
        .filter(models.WorkspaceMember.workspace_id == workspace_id, models.WorkspaceMember.user_id == member_user_id)
        .first()
    )
    if not target:
        raise HTTPException(404, "That person isn't in this workspace.")
    if target.role == "owner":
        raise HTTPException(400, "The workspace owner's role can't be changed.")
    target.role = payload.role
    db.commit()
    db.refresh(target)
    target_user = db.query(models.User).filter(models.User.id == member_user_id).first()
    return schemas.WorkspaceMemberOut(
        user_id=target_user.id, email=target_user.email, full_name=target_user.full_name,
        role=target.role, created_at=target.created_at,
    )


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
