"""
Phase 5, Batch A (2026-09-28, "Data governance & quality" roadmap): the
workspace owner's own governance surface - "Mark reviewed" on one data
source, an access-review overview of every data source in a workspace (who
can see it, when it was last reviewed), and that workspace's real, persisted
audit log. See models.AuditEvent's own docstring for why this table is
genuinely different from /admin's live-computed "Recent activity" feed, and
services/workspace_access.py's own module docstring for the 404-vs-403
convention this file follows below.

mark_reviewed is nested under /datasources/... (same "editable" tier as
every other write on a data source's own row - see
services/workspace_access.can_edit_datasource); the audit-log and
governance-overview reads are nested under /workspaces/{workspace_id}/... and
gated strictly to that workspace's own OWNER (current_user.id ==
workspace.owner_id) - not just any member with "editable" access, since a
workspace's activity history and access roster are more sensitive than any
one data source's own content. A workspace that doesn't exist, or exists but
the caller isn't a member of at all, 404s (matching
routers/workspaces.py's own _get_membership - a non-member should not be
able to tell "no such workspace" apart from "not yours"); a workspace the
caller CAN see but doesn't own 403s, same as every other owner-only action
in routers/workspaces.py (rename, delete, regenerate invite, change a
member's role) - they already know this workspace and its roster exist, so
there's nothing left to hide by pretending otherwise.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..services import audit, workspace_access
from datetime import datetime

router = APIRouter(tags=["governance"])


def _get_editable_datasource(db: Session, user: models.User, datasource_id: str) -> models.DataSource:
    ds = db.query(models.DataSource).filter(models.DataSource.id == datasource_id).first()
    if not ds or not workspace_access.can_access_datasource(db, ds, user):
        raise HTTPException(404, "Datasource not found.")
    if not workspace_access.can_edit_datasource(db, ds, user):
        raise HTTPException(403, "You have view-only access to this data source.")
    return ds


def _get_owned_workspace(db: Session, user: models.User, workspace_id: str) -> models.Workspace:
    """404s for a workspace the caller isn't even a member of (can't tell
    it exists at all); 403s for one they can see but don't own - see this
    file's own module docstring for the full reasoning."""
    ws = db.query(models.Workspace).filter(models.Workspace.id == workspace_id).first()
    is_member = (
        db.query(models.WorkspaceMember)
        .filter(models.WorkspaceMember.workspace_id == workspace_id, models.WorkspaceMember.user_id == user.id)
        .first()
        is not None
    )
    if not ws or not is_member:
        raise HTTPException(404, "Workspace not found.")
    if ws.owner_id != user.id:
        raise HTTPException(403, "Only the workspace owner can see this page.")
    return ws


@router.post("/datasources/{datasource_id}/mark-reviewed", response_model=schemas.MarkReviewedOut)
def mark_reviewed(
    datasource_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Records that a real person on this data source's team just looked
    it over - a manual attestation only, never inferred (see
    models.DataSource's own docstring on these two columns)."""
    ds = _get_editable_datasource(db, user, datasource_id)
    now = datetime.utcnow()
    ds.governance_last_reviewed_at = now
    ds.governance_last_reviewed_by_id = user.id
    audit.log_audit_event(
        db, actor=user, action="governance_review_marked", workspace_id=ds.workspace_id,
        target_type="datasource", target_id=ds.id,
    )
    db.commit()
    db.refresh(ds)
    return schemas.MarkReviewedOut(
        datasource_id=ds.id,
        governance_last_reviewed_at=ds.governance_last_reviewed_at,
        governance_last_reviewed_by_id=ds.governance_last_reviewed_by_id,
        governance_last_reviewed_by_name=user.full_name,
        governance_last_reviewed_by_email=user.email,
    )


@router.get("/workspaces/{workspace_id}/governance-overview", response_model=schemas.GovernanceOverviewOut)
def governance_overview(
    workspace_id: str, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Owner-only. Every data source visible in this workspace - anything
    actually tagged with this workspace_id, PLUS, when this happens to be
    the caller's own personal workspace, their own still-NULL/legacy rows
    too (a brand-new upload's workspace_id stays NULL until someone
    explicitly shares it into a team workspace - see
    routers/datasources.py's own `ds.workspace_id = payload.workspace_id`).
    Reuses workspace_access.accessible_datasource_ids_in_workspace, the
    exact same helper routers/datasources.py's own list endpoint already
    relies on for this identical NULL-means-personal-workspace rule,
    rather than a naive equality filter that would silently show an empty
    table for the overwhelmingly common case of a founder's own,
    never-explicitly-shared data - each with who can see it (this
    workspace's own member roster - reusing the exact member-listing query
    routers/workspaces.py get_workspace already uses, rather than writing a
    second one) and when it was last marked reviewed."""
    _get_owned_workspace(db, user, workspace_id)

    member_rows = (
        db.query(models.WorkspaceMember, models.User)
        .join(models.User, models.User.id == models.WorkspaceMember.user_id)
        .filter(models.WorkspaceMember.workspace_id == workspace_id)
        .all()
    )
    member_access = [
        schemas.GovernanceMemberAccessOut(user_id=u.id, name=u.full_name, email=u.email, role=m.role)
        for m, u in member_rows
    ]
    member_access.sort(key=lambda m: (m.role != "owner", (m.name or m.email or "").lower()))

    visible_ids = workspace_access.accessible_datasource_ids_in_workspace(db, user, workspace_id)
    datasources = (
        db.query(models.DataSource).filter(models.DataSource.id.in_(visible_ids)).all()
        if visible_ids else []
    )
    reviewer_ids = {ds.governance_last_reviewed_by_id for ds in datasources if ds.governance_last_reviewed_by_id}
    reviewers = {
        u.id: u for u in db.query(models.User).filter(models.User.id.in_(reviewer_ids)).all()
    } if reviewer_ids else {}

    out = []
    for ds in datasources:
        reviewer = reviewers.get(ds.governance_last_reviewed_by_id) if ds.governance_last_reviewed_by_id else None
        out.append(
            schemas.GovernanceDataSourceOut(
                id=ds.id,
                name=ds.name,
                kind=ds.kind,
                member_access=member_access,
                governance_last_reviewed_at=ds.governance_last_reviewed_at,
                governance_last_reviewed_by=(reviewer.full_name or reviewer.email) if reviewer else None,
            )
        )
    out.sort(key=lambda d: d.name.lower())
    return schemas.GovernanceOverviewOut(datasources=out)


@router.get("/workspaces/{workspace_id}/audit-log", response_model=schemas.AuditLogPageOut)
def get_audit_log(
    workspace_id: str,
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Owner-only, newest first, paginated. Reads straight from the real,
    persisted models.AuditEvent table - see that model's own docstring.

    Same NULL-means-personal-workspace rule as governance_overview above:
    an event logged against a still-personal data source/dashboard (see
    e.g. routers/datasources.py's `workspace_id=ds.workspace_id`, which is
    None until something is explicitly shared) is stored with
    AuditEvent.workspace_id=None, not this workspace's own id - so a plain
    equality filter would silently hide almost every real event on a
    founder's own personal workspace. When `workspace_id` is the caller's
    personal workspace (confirmed by _get_owned_workspace's own membership/
    ownership check just above), also include every NULL-workspace event
    whose actor is this same owner - there is no other user it could
    belong to on this page, since only the owner can ever reach it."""
    ws = _get_owned_workspace(db, user, workspace_id)
    page = max(1, page)
    page_size = max(1, min(page_size, 100))

    if ws.is_personal:
        base_query = db.query(models.AuditEvent).filter(
            or_(
                models.AuditEvent.workspace_id == workspace_id,
                and_(models.AuditEvent.workspace_id.is_(None), models.AuditEvent.actor_user_id == user.id),
            )
        )
    else:
        base_query = db.query(models.AuditEvent).filter(models.AuditEvent.workspace_id == workspace_id)
    total = base_query.count()
    rows = (
        base_query.order_by(models.AuditEvent.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    actor_ids = {r.actor_user_id for r in rows}
    actors = {u.id: u for u in db.query(models.User).filter(models.User.id.in_(actor_ids)).all()} if actor_ids else {}

    events = [
        schemas.AuditEventOut(
            id=r.id,
            workspace_id=r.workspace_id,
            action=r.action,
            target_type=r.target_type,
            target_id=r.target_id,
            event_metadata=r.event_metadata,
            created_at=r.created_at,
            actor_name=(actors[r.actor_user_id].full_name if r.actor_user_id in actors else None),
            actor_email=(actors[r.actor_user_id].email if r.actor_user_id in actors else None),
        )
        for r in rows
    ]
    return schemas.AuditLogPageOut(events=events, total=total, page=page, page_size=page_size)
